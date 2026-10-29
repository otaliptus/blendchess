(function installLobbySession() {
  const protocol = globalThis.BlendChessProtocol;
  const logic = globalThis.BlendChessLobbyLogic;
  const rating = globalThis.BlendChessRating;

  if (!protocol) throw new Error('shared/protocol.js must be loaded before lobby-session.js');
  if (!logic) throw new Error('shared/lobby-logic.js must be loaded before lobby-session.js');
  if (!rating) throw new Error('shared/rating.js must be loaded before lobby-session.js');

  const { TYPES, ERROR_CODES, createMessage } = protocol;

  // Matchmaking for one lobby, shared by the Node server and the Durable Object.
  //
  // conn is the transport's socket record: { id, playerId, ipHash }.
  // hooks = {
  //   connections(): live conns, send(conn, msg), close(conn, code, reason),
  //   save(conn), createRatedRoom(match) -> { roomCode, tickets: { w, b } } | null,
  // }
  // store = player/queue store. Every method may be async; the in-memory store is fast enough
  // that awaiting costs nothing.

  // One lobby per isolate, but several sockets can be mid-message at once. These locks keep
  // queue mutations, matchmaking, name allocation and result writes from interleaving.
  const locks = new Map();
  function withLock(key, work) {
    const previous = locks.get(key) || Promise.resolve();
    const task = previous.then(work);
    const guarded = task.catch(() => {});
    locks.set(key, guarded);
    guarded.then(() => {
      if (locks.get(key) === guarded) locks.delete(key);
    });
    return task;
  }

  function send(hooks, conn, type, payload) {
    if (!conn) return;
    hooks.send(conn, createMessage(type, '', conn.playerId || '', payload));
  }

  function fail(hooks, conn, errorCode, message) {
    send(hooks, conn, TYPES.LOBBY_ERROR, { errorCode, message });
  }

  function connFor(hooks, entry) {
    const conns = hooks.connections();
    return conns.find((conn) => conn.id === entry.connId && conn.playerId === entry.playerId)
      || conns.find((conn) => conn.playerId === entry.playerId)
      || null;
  }

  function waitingCount(entries, control) {
    return entries.filter((entry) => entry.control === control).length;
  }

  async function sendQueued(store, hooks, conn, control) {
    const entries = await store.getQueue();
    const mine = entries.find((entry) => entry.playerId === conn.playerId);
    if (!mine) return;
    const sameControl = entries
      .filter((entry) => entry.control === control)
      .sort((a, b) => a.joinedAt - b.joinedAt);
    send(hooks, conn, TYPES.LOBBY_QUEUED, {
      control,
      position: sameControl.findIndex((entry) => entry.playerId === conn.playerId) + 1,
      waiting: sameControl.length,
      queueSize: entries.length,
    });
  }

  async function helloNow(store, hooks, conn, payload = {}) {
    const token = typeof payload.token === 'string' ? payload.token.trim().slice(0, 200) : '';
    const wantedName = logic.cleanName(payload.nickname, '');
    const now = Date.now();

    let record = null;
    let freshToken = '';
    if (token) {
      const hash = await logic.sha256Hex(token);
      record = await store.playerByToken(hash);
    }

    if (!record) {
      const ipHash = conn.ipHash || 'unknown';
      const recent = await store.creationCount(ipHash, now - logic.NEW_PLAYER_WINDOW_MS);
      if (recent >= logic.NEW_PLAYER_LIMIT) {
        fail(hooks, conn, ERROR_CODES.RATE_LIMIT, 'Too many new players from this network. Try again in a while.');
        return false;
      }
      record = logic.newPlayerRecord(wantedName, now);
      record.name = await logic.uniqueNameAsync(store, record.name, record.id);
      freshToken = logic.makeToken();
      const hash = await logic.sha256Hex(freshToken);
      await store.savePlayer(record);
      await store.saveName(record.name.toLowerCase(), record.id);
      await store.saveToken(hash, record.id);
      await store.recordCreation(ipHash, now);
    } else if (wantedName && wantedName !== record.name) {
      const oldName = record.name.toLowerCase();
      record.name = await logic.uniqueNameAsync(store, wantedName, record.id);
      const newName = record.name.toLowerCase();
      if (newName !== oldName) {
        if (await store.nameOwner(oldName) === record.id) await store.removeName(oldName);
        await store.saveName(newName, record.id);
      }
    }

    record.lastSeen = now;
    await store.savePlayer(record);

    // A fresh socket for a player already waiting takes over the queue slot.
    const entries = await store.getQueue();
    const mine = entries.find((entry) => entry.playerId === record.id);
    if (mine) {
      mine.connId = conn.id;
      await store.saveQueue(entries);
    }

    conn.playerId = record.id;
    hooks.save(conn);

    send(hooks, conn, TYPES.LOBBY_READY, {
      player: logic.summary(record),
      token: freshToken || undefined,
      queued: mine ? { control: mine.control, since: mine.joinedAt, waiting: waitingCount(entries, mine.control) } : null,
    });
    return true;
  }

  async function queueNow(store, hooks, conn, payload = {}) {
    if (!conn.playerId) {
      fail(hooks, conn, ERROR_CODES.NOT_AUTHENTICATED, 'Say hello first.');
      return false;
    }
    const record = await store.getPlayer(conn.playerId);
    if (!record) {
      fail(hooks, conn, ERROR_CODES.NOT_AUTHENTICATED, 'Say hello first.');
      return false;
    }

    const control = (logic.controlOf(payload.control) || logic.controlOf(logic.DEFAULT_CONTROL)).id;
    const now = Date.now();

    let entries = (await store.getQueue()).filter((entry) => now - entry.joinedAt < logic.QUEUE_STALE_MS);
    const mine = entries.find((entry) => entry.playerId === record.id);
    if (mine) {
      if (mine.control === control) {
        mine.connId = conn.id;
        await store.saveQueue(entries);
        await sendQueued(store, hooks, conn, control);
        return false;
      }
      entries = entries.filter((entry) => entry.playerId !== record.id);
    }

    const active = await store.getActiveGame(record.id);
    if (active && now - active.at < logic.ACTIVE_GAME_TTL_MS) {
      fail(hooks, conn, ERROR_CODES.ALREADY_IN_GAME, 'Finish your current rated game first.');
      return false;
    }

    if (entries.length >= logic.MAX_QUEUE) {
      fail(hooks, conn, ERROR_CODES.QUEUE_FULL, 'The lobby is full right now. Try again in a minute.');
      return false;
    }
    const fromNetwork = entries.filter((entry) => entry.ipHash && entry.ipHash === conn.ipHash).length;
    if (fromNetwork >= logic.MAX_QUEUE_PER_NETWORK) {
      fail(hooks, conn, ERROR_CODES.RATE_LIMIT, 'Too many players from this network are queued.');
      return false;
    }

    entries.push({
      playerId: record.id,
      connId: conn.id,
      rating: record.rating,
      control,
      joinedAt: now,
      lastOpponent: record.lastOpponent || '',
      lastOpponentAt: record.lastOpponentAt || 0,
      ipHash: conn.ipHash || '',
    });
    await store.saveQueue(entries);
    await sendQueued(store, hooks, conn, control);
    await tryMatchNow(store, hooks);
    return true;
  }

  async function cancelNow(store, hooks, conn) {
    if (!conn.playerId) {
      fail(hooks, conn, ERROR_CODES.NOT_AUTHENTICATED, 'Say hello first.');
      return false;
    }
    const entries = await store.getQueue();
    const next = entries.filter((entry) => entry.playerId !== conn.playerId);
    if (next.length !== entries.length) await store.saveQueue(next);
    send(hooks, conn, TYPES.LOBBY_CANCELLED, {});
    return next.length !== entries.length;
  }

  // Pairs whoever can be paired and starts a room for each pair.
  async function tryMatchNow(store, hooks) {
    const now = Date.now();
    const all = await store.getQueue();
    const conns = hooks.connections();
    const connected = new Set(conns.filter((conn) => conn.playerId).map((conn) => conn.playerId));

    // Drop seats whose socket is gone or that have waited far too long.
    const live = all.filter((entry) => connected.has(entry.playerId) && now - entry.joinedAt < logic.QUEUE_STALE_MS);
    if (live.length !== all.length) await store.saveQueue(live);
    if (live.length < 2) return 0;

    const { pairs, remaining } = logic.takeMatches(live, now);
    if (remaining.length !== live.length) await store.saveQueue(remaining);

    let started = 0;
    for (const [first, second] of pairs) {
      const sameNetwork = Boolean(first.ipHash) && first.ipHash !== 'unknown' && first.ipHash === second.ipHash;
      const order = Math.random() < 0.5 ? [first, second] : [second, first];
      const [whiteEntry, blackEntry] = order;
      const whiteRecord = await store.getPlayer(whiteEntry.playerId);
      const blackRecord = await store.getPlayer(blackEntry.playerId);
      if (!whiteRecord || !blackRecord) continue;

      const seats = [
        { color: 'w', playerId: whiteRecord.id, nickname: whiteRecord.name, rating: whiteRecord.rating, ipHash: whiteEntry.ipHash || '' },
        { color: 'b', playerId: blackRecord.id, nickname: blackRecord.name, rating: blackRecord.rating, ipHash: blackEntry.ipHash || '' },
      ];

      let room = null;
      try {
        room = await hooks.createRatedRoom({ control: first.control, rated: !sameNetwork, seats });
      } catch {
        room = null;
      }
      if (!room) {
        // Put both back and keep searching.
        const back = await store.getQueue();
        back.push(first, second);
        await store.saveQueue(back);
        for (const entry of [first, second]) {
          fail(hooks, connFor(hooks, entry), ERROR_CODES.RATE_LIMIT, 'Could not start a game. Still searching...');
        }
        continue;
      }

      // Practice games between two accounts on the same network do not block queueing.
      if (!sameNetwork) {
        const gameKey = `${room.roomCode}:1`;
        await store.saveActiveGame(first.playerId, { roomCode: room.roomCode, gameKey, at: now });
        await store.saveActiveGame(second.playerId, { roomCode: room.roomCode, gameKey, at: now });
      }

      whiteRecord.lastOpponent = blackRecord.id;
      whiteRecord.lastOpponentAt = now;
      blackRecord.lastOpponent = whiteRecord.id;
      blackRecord.lastOpponentAt = now;
      await store.savePlayer(whiteRecord);
      await store.savePlayer(blackRecord);

      const control = logic.controlOf(first.control);
      const tell = (entry, seat, opponentRecord, ticket) => {
        send(hooks, connFor(hooks, entry), TYPES.MATCH_FOUND, {
          roomCode: room.roomCode,
          ticket,
          color: seat.color,
          control: control.id,
          clock: { baseMs: control.baseMs, incMs: control.incMs },
          rated: !sameNetwork,
          opponent: {
            name: opponentRecord.name,
            rating: opponentRecord.rating,
            provisional: opponentRecord.games < rating.PROVISIONAL_GAMES,
          },
        });
      };
      tell(whiteEntry, seats[0], blackRecord, room.tickets.w);
      tell(blackEntry, seats[1], whiteRecord, room.tickets.b);
      started += 1;
    }
    return started;
  }

  // A room announces a new game (rematch), so the lobby keeps blocking ranked queueing.
  async function registerActiveNow(store, payload = {}) {
    const roomCode = String(payload.roomCode || '');
    const gameKey = String(payload.gameKey || '');
    const players = Array.isArray(payload.players) ? payload.players : [];
    if (!roomCode || !gameKey || players.length !== 2) return { ok: false, reason: 'INVALID' };
    for (const playerId of players) {
      const record = await store.getPlayer(String(playerId));
      if (!record) return { ok: false, reason: 'UNKNOWN_PLAYER' };
      await store.saveActiveGame(record.id, { roomCode, gameKey, at: Date.now() });
    }
    return { ok: true };
  }

  // The room died before the game could start: free both players without touching ratings.
  async function releaseNow(store, payload = {}) {
    const roomCode = String(payload.roomCode || '');
    const players = Array.isArray(payload.players) ? payload.players : [];
    let released = 0;
    for (const playerId of players) {
      const active = await store.getActiveGame(String(playerId));
      if (active && active.roomCode === roomCode) {
        await store.clearActiveGame(String(playerId));
        released += 1;
      }
    }
    return { ok: true, released };
  }

  // Called by a room once, when a rated game ends. Idempotent per gameKey.
  async function reportNow(store, hooks, payload = {}) {
    const roomCode = String(payload.roomCode || '');
    const gameKey = String(payload.gameKey || '');
    const players = Array.isArray(payload.players) ? payload.players : [];
    if (!roomCode || !gameKey || players.length !== 2) return { ok: false, reason: 'INVALID' };

    const cached = await store.getReport(gameKey);
    if (cached) return { ok: true, updates: cached.updates, duplicate: true };

    const white = players.find((player) => player.color === 'w');
    const black = players.find((player) => player.color === 'b');
    if (!white || !black) return { ok: false, reason: 'INVALID' };

    const whiteRecord = await store.getPlayer(String(white.playerId));
    const blackRecord = await store.getPlayer(String(black.playerId));
    if (!whiteRecord || !blackRecord) return { ok: false, reason: 'UNKNOWN_PLAYER' };

    // Only a game the lobby itself arranged may move ratings.
    for (const record of [whiteRecord, blackRecord]) {
      const active = await store.getActiveGame(record.id);
      if (!active || active.roomCode !== roomCode || active.gameKey !== gameKey) {
        return { ok: false, reason: 'UNKNOWN_GAME' };
      }
    }

    const winner = payload.winner === 'w' || payload.winner === 'White' ? 'w'
      : payload.winner === 'b' || payload.winner === 'Black' ? 'b'
        : null;
    const scoreWhite = winner === 'w' ? 1 : winner === 'b' ? 0 : 0.5;
    const whiteBefore = whiteRecord.rating;
    const blackBefore = blackRecord.rating;
    const whiteUpdate = rating.applyResult(whiteRecord, blackBefore, scoreWhite);
    const blackUpdate = rating.applyResult(blackRecord, whiteBefore, 1 - scoreWhite);

    await store.savePlayer(whiteRecord);
    await store.savePlayer(blackRecord);
    await store.bumpLeaderboard([whiteRecord, blackRecord]);

    await store.clearActiveGame(whiteRecord.id);
    await store.clearActiveGame(blackRecord.id);

    const updates = { w: whiteUpdate, b: blackUpdate };
    await store.saveReport(gameKey, {
      updates,
      roomCode,
      result: String(payload.result || ''),
      winner,
      at: Date.now(),
    });

    for (const record of [whiteRecord, blackRecord]) {
      for (const conn of hooks.connections()) {
        if (conn.playerId === record.id) {
          send(hooks, conn, TYPES.LOBBY_RATING, {
            player: logic.summary(record),
            update: updates[record.id === whiteRecord.id ? 'w' : 'b'],
          });
        }
      }
    }

    return { ok: true, updates };
  }

  function hello(store, hooks, conn, payload) {
    // Shares the queue lock because hello also adopts a waiting player's queue slot.
    return withLock('queue', () => helloNow(store, hooks, conn, payload));
  }

  function queue(store, hooks, conn, payload) {
    return withLock('queue', () => queueNow(store, hooks, conn, payload));
  }

  function cancel(store, hooks, conn) {
    return withLock('queue', () => cancelNow(store, hooks, conn));
  }

  function tryMatch(store, hooks) {
    return withLock('queue', () => tryMatchNow(store, hooks));
  }

  function handleClose(store, hooks, conn) {
    return withLock('queue', () => handleCloseNow(store, hooks, conn));
  }

  function report(store, hooks, payload) {
    return withLock('results', () => reportNow(store, hooks, payload));
  }

  function registerActive(store, payload) {
    return withLock('results', () => registerActiveNow(store, payload));
  }

  function release(store, payload) {
    return withLock('results', () => releaseNow(store, payload));
  }

  async function handleMessage(store, hooks, conn, envelope) {
    const payload = envelope.payload || {};
    switch (envelope.type) {
      case TYPES.PING:
        send(hooks, conn, TYPES.PONG, payload);
        return false;
      case TYPES.LOBBY_HELLO:
        return hello(store, hooks, conn, payload);
      case TYPES.LOBBY_QUEUE:
        return queue(store, hooks, conn, payload);
      case TYPES.LOBBY_CANCEL:
        return cancel(store, hooks, conn);
      default:
        fail(hooks, conn, ERROR_CODES.INVALID_PAYLOAD, `Unsupported lobby message: ${envelope.type}`);
        return false;
    }
  }

  async function handleCloseNow(store, hooks, conn) {
    const entries = await store.getQueue();
    const next = entries.filter((entry) => entry.connId !== conn.id);
    if (next.length === entries.length) return false;
    await store.saveQueue(next);
    return true;
  }

  const lobbySessionExports = {
    hello,
    queue,
    cancel,
    tryMatch,
    report,
    registerActive,
    release,
    handleMessage,
    handleClose,
    send,
    fail,
  };

  globalThis.BlendChessLobbySession = lobbySessionExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lobbySessionExports;
  }
})();
