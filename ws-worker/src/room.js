import { DurableObject } from 'cloudflare:workers';

const protocol = globalThis.BlendChessProtocol;
const rl = globalThis.BlendChessRoomLogic;
const session = globalThis.BlendChessRoomSession;
if (!protocol || !rl || !session) throw new Error('shared modules must load before room.js');

const { TYPES, ERROR_CODES, createError, parseEnvelope } = protocol;

const ROOM_TTL_MS = 1000 * 60 * 60;
const MAX_SOCKETS_PER_ROOM = 64;
const MAX_SOCKETS_PER_IP = 4;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 40;
const REPORT_RETRY_MS = 15_000;
const RESUME_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RESUME_TOKEN_LENGTH = 24;

function makeResumeToken() {
  // 252 is the largest multiple of 36 below 256: rejecting bytes above it keeps the alphabet unbiased.
  let token = '';
  while (token.length < RESUME_TOKEN_LENGTH) {
    const bytes = new Uint8Array(RESUME_TOKEN_LENGTH * 2);
    crypto.getRandomValues(bytes);
    for (const byte of bytes) {
      if (byte < 252 && token.length < RESUME_TOKEN_LENGTH) token += RESUME_TOKEN_ALPHABET[byte % 36];
    }
  }
  return token;
}

function messageByteLength(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

// A reservation arrives from the lobby's Durable Object, never from a browser. Tickets are
// random 43-character secrets; a valid pair is the only way into a ranked seat.
function readReservation(body) {
  if (!body || typeof body !== 'object') return null;
  const roomCode = typeof body.roomCode === 'string' ? body.roomCode.toUpperCase().slice(0, 6) : '';
  if (!/^[A-Z0-9]{6}$/.test(roomCode)) return null;
  const control = typeof body.control === 'string' ? body.control.slice(0, 12) : '';
  const clock = body.clock && typeof body.clock === 'object' ? body.clock : null;
  const baseMs = clock ? Number(clock.baseMs) : NaN;
  if (!Number.isFinite(baseMs) || baseMs <= 0 || baseMs > 60 * 60 * 1000) return null;
  const seats = Array.isArray(body.seats) ? body.seats : [];
  if (seats.length !== 2) return null;
  const seen = new Set();
  const cleaned = [];
  for (const seat of seats) {
    if (!seat || (seat.color !== 'w' && seat.color !== 'b') || seen.has(seat.color)) return null;
    seen.add(seat.color);
    const playerId = typeof seat.playerId === 'string' ? seat.playerId.slice(0, 64) : '';
    const ticket = typeof seat.ticket === 'string' ? seat.ticket.slice(0, 128) : '';
    if (!playerId || ticket.length < 20) return null;
    cleaned.push({
      color: seat.color,
      playerId,
      ticket,
      nickname: rl.cleanNickname(seat.nickname, seat.color === 'w' ? 'White' : 'Black'),
      rating: Number.isFinite(Number(seat.rating)) ? Number(seat.rating) : null,
      ipHash: typeof seat.ipHash === 'string' ? seat.ipHash.slice(0, 64) : '',
      session: typeof seat.session === 'string' ? seat.session.slice(0, 128) : '',
    });
  }
  return {
    roomCode,
    rated: Boolean(body.rated),
    control,
    clock: { baseMs, incMs: Math.max(0, Number(clock.incMs) || 0) },
    seats: cleaned,
  };
}

// One Durable Object per room code. Sockets use the hibernation API: per-socket metadata
// lives in the socket attachment and the room in storage, so nothing depends on memory
// surviving between messages.
export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.roomCode = '';
    this.closing = new Set();
    // Sockets closed to make way for a returning player; they no longer count against the caps.
    this.evicted = new Set();
    this.rates = new Map();
    this.chains = new Map();
    ctx.blockConcurrencyWhile(async () => {
      this.room = (await ctx.storage.get('room')) || null;
      this.reconcilePresence();
    });
  }

  conn(ws) {
    return { ...(ws.deserializeAttachment() || {}), ws };
  }

  liveConns() {
    return this.ctx.getWebSockets().map((ws) => this.conn(ws)).filter((conn) => !this.closing.has(conn.id) && !this.evicted.has(conn.id));
  }

  hooks() {
    return {
      connections: () => this.liveConns(),
      send: (conn, message) => {
        try {
          conn.ws.send(JSON.stringify(message));
        } catch {
          // socket already gone; its close handler cleans up
        }
      },
      close: (conn, code, reason) => {
        try {
          conn.ws.close(code, reason);
        } catch {
          // already closed
        }
      },
      save: (conn) => {
        const { ws, ...meta } = conn;
        try {
          ws.serializeAttachment(meta);
        } catch {
          // closed sockets can't take attachments
        }
      },
      makeResumeToken,
    };
  }

  // After an eviction the stored flags can be stale; trust only the sockets that are still open.
  reconcilePresence() {
    if (!this.room) return;
    const conns = this.liveConns();
    for (const playerId of this.room.playerOrder) {
      this.room.players[playerId].connected = conns.some((conn) => conn.role === 'player' && conn.playerId === playerId);
    }
    for (const spectatorId of [...this.room.spectatorOrder]) {
      if (!conns.some((conn) => conn.role === 'spectator' && conn.id === spectatorId)) rl.removeSpectator(this.room, spectatorId);
    }
    this.room.waitingForStart = !rl.isReady(this.room);
  }

  // The alarm has to wake for whichever comes first: the clock, a missing opponent, a report
  // retry, or plain idle cleanup.
  async persist() {
    if (!this.room) return;
    await this.ctx.storage.put('room', this.room);
    const now = Date.now();
    let next = now + ROOM_TTL_MS;
    const clockDeadline = rl.nextClockDeadline(this.room, now);
    if (clockDeadline) next = Math.min(next, clockDeadline + 100);
    if (this.room.reportRetryAt) next = Math.min(next, this.room.reportRetryAt);
    const waitingForSeat = rl.isLobbyRoom(this.room) && !this.room.gameOver && !rl.isReady(this.room) && this.room.log.length === 0;
    if (waitingForSeat) next = Math.min(next, this.room.reservedAt + rl.JOIN_DEADLINE_MS + 100);
    // Never schedule an alarm in the past: the runtime would re-fire it immediately and loop.
    await this.ctx.storage.setAlarm(Math.max(next, now + 1000));
  }

  lobby() {
    return this.env.LOBBY_HUB.get(this.env.LOBBY_HUB.idFromName('lobby'));
  }

  ratedPlayers() {
    return rl.playerIdentities(this.room);
  }

  // Each new game in a lobby room (rematches included) goes back on the lobby's live list, and a
  // ranked one keeps blocking the queue.
  async registerActive() {
    if (!this.room || !rl.isLobbyRoom(this.room) || this.room.gameOver) return;
    const gameKey = rl.lobbyGameKey(this.room);
    if (this.room.activeGameKey === gameKey) return;
    this.room.activeGameKey = gameKey;
    let ok = false;
    try {
      const response = await this.lobby().fetch('https://lobby.internal/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rl.lobbyActiveMessage(this.room)),
      });
      ok = Boolean((await response.json()).ok);
    } catch {
      ok = false;
    }
    // Not acknowledged: the next change in the room tries again.
    if (!ok && this.room) this.room.activeGameKey = '';
  }

  // Exactly one report per lobby game, retried by the alarm until the lobby acknowledges it.
  async reportResult() {
    if (!this.room || !rl.isLobbyRoom(this.room) || !this.room.gameOver || this.room.reported || this.reporting) return;
    if (this.room.noContest) {
      // Nobody gets rated for an opponent who never arrived; just free both players.
      if (this.room.released) return;
      this.room.released = true;
      try {
        await this.lobby().fetch('https://lobby.internal/release', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ roomCode: this.room.roomCode, players: this.ratedPlayers().map((player) => player.playerId) }),
        });
      } catch {
        this.room.released = false;
        this.room.reportRetryAt = Date.now() + REPORT_RETRY_MS;
        await this.persist();
      }
      return;
    }
    // `reported` turns true only once the lobby has the result, and a rematch waits for it, so the
    // game being reported cannot change underneath this request. `reporting` (memory only) keeps a
    // second change from sending the same report while this one is in flight.
    const room = this.room;
    const gameId = room.gameId;
    room.reportRetryAt = 0;
    let result = null;
    this.reporting = true;
    try {
      const response = await this.lobby().fetch('https://lobby.internal/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(rl.lobbyReportMessage(room)),
      });
      result = await response.json();
    } catch {
      result = null;
    } finally {
      this.reporting = false;
    }
    if (this.room !== room || room.gameId !== gameId) return;
    if (result && !result.ok && result.final) {
      // The lobby will never accept this game (it did not arrange it): stop retrying.
      room.reported = true;
      await this.persist();
      return;
    }
    if (!result || !result.ok) {
      room.reportRetryAt = Date.now() + REPORT_RETRY_MS;
      await this.persist();
      return;
    }
    room.reported = true;
    room.ratingUpdates = result.updates || null;
    room.recordId = result.gameId || null;
    await this.persist();
    session.broadcastViews(room, this.hooks());
  }

  async afterChange() {
    if (!this.room) return;
    await this.persist();
    await this.registerActive();
    await this.reportResult();
  }

  async releaseRated() {
    if (!this.room || !rl.isLobbyRoom(this.room)) return;
    // Reservation identities, not seated players: a room nobody joined still blocks both players.
    const players = rl.playerIdentities(this.room).map((player) => player.playerId);
    if (!players.length) return;
    try {
      await this.lobby().fetch('https://lobby.internal/release', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: this.room.roomCode, players }),
      });
    } catch {
      // the lobby clears stale games after two hours anyway
    }
  }

  async alarm() {
    if (!this.room) return;
    const now = Date.now();
    let changed = false;

    if (rl.isLobbyRoom(this.room) && !this.room.gameOver) {
      if (this.room.clock && this.room.clock.startedAt && rl.clockRemainingMs(this.room, now) <= 0) {
        rl.chargeClock(this.room, now);
        rl.finishByTimeout(this.room);
        changed = true;
      } else if (!rl.isReady(this.room) && this.room.log.length === 0
        && now - this.room.reservedAt >= rl.JOIN_DEADLINE_MS) {
        if (rl.connectedPlayerCount(this.room) >= 1) {
          rl.finishByAbandon(this.room);
          changed = true;
        } else {
          // Nobody ever arrived: free both players and drop the room instead of looping alarms.
          await this.releaseRated();
          await this.ctx.storage.deleteAll();
          this.room = null;
          return;
        }
      }
    }
    if (changed) {
      session.broadcastViews(this.room, this.hooks());
      await this.afterChange();
    } else if (rl.isLobbyRoom(this.room) && this.room.gameOver && !this.room.reported) {
      await this.reportResult();
    }

    const idle = now - this.room.lastActivity >= ROOM_TTL_MS;
    if (this.ctx.getWebSockets().length === 0 && idle) {
      await this.releaseRated();
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.persist();
  }

  // POST /reserve: the lobby reserves both seats before telling the players where to go.
  async reserve(request) {
    if (this.room) return json({ ok: false, reason: 'TAKEN' }, 409);
    let body;
    try {
      body = await request.json();
    } catch {
      return json({ ok: false, reason: 'INVALID' }, 400);
    }
    const reservation = readReservation(body);
    if (!reservation) return json({ ok: false, reason: 'INVALID' }, 400);
    if (request.headers.get('X-Room-Code') && request.headers.get('X-Room-Code').toUpperCase() !== reservation.roomCode) {
      return json({ ok: false, reason: 'INVALID' }, 400);
    }

    const room = rl.createRoomState(reservation.roomCode);
    rl.applyReservation(room, reservation);
    this.room = room;
    this.roomCode = reservation.roomCode;
    await this.persist();
    return json({ ok: true, roomCode: reservation.roomCode });
  }

  async fetch(request) {
    const url = new URL(request.url || 'https://room.internal/');
    if (url.pathname === '/reserve') {
      if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });

      return this.reserve(request);
    }
    // POST /revoke, from the lobby only: these sessions were signed out, so their seats go.
    if (url.pathname === '/revoke') {
      if (request.method !== 'POST') return new Response('Method not allowed.', { status: 405 });
      const body = await request.json().catch(() => null);
      const sessions = body && Array.isArray(body.sessions) ? body.sessions.slice(0, 32) : [];
      if (!this.room || !sessions.length) return json({ ok: true, revoked: false });
      const revoked = session.revokeSessions(this.room, this.hooks(), sessions);
      if (revoked) await this.afterChange();
      return json({ ok: true, revoked });
    }

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade.', { status: 426 });
    }

    const roomCode = request.headers.get('X-Room-Code') || '';
    const create = request.headers.get('X-Room-Create') === '1';
    const ipHash = request.headers.get('X-IP-Hash') || 'unknown';
    if (create && this.room) return new Response('Room code taken.', { status: 409 });
    const counted = this.ctx.getWebSockets().filter((ws) => !this.evicted.has((ws.deserializeAttachment() || {}).id));
    if (counted.length >= MAX_SOCKETS_PER_ROOM) {
      // Live lobby games are listed publicly, so watchers (or idle sockets) can fill a room. A player
      // coming back to a seat (the client marks those connections seat=1, and must then present a
      // ticket or resume token) makes room by dropping a socket that holds no seat.
      const victim = url.searchParams.get('seat') === '1' ? this.evictionCandidate(counted) : null;
      if (!victim) return new Response('Room is crowded.', { status: 429 });
      await this.evict(victim);
    }
    const sameIp = counted.filter((ws) => {
      const attachment = ws.deserializeAttachment();
      return attachment && attachment.ipHash === ipHash && !this.evicted.has(attachment.id);
    }).length;
    if (sameIp >= MAX_SOCKETS_PER_IP) return new Response('Too many connections from this network.', { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), roomCode, create, role: null, playerId: '', ipHash });
    return new Response(null, { status: 101, webSocket: client });
  }

  // Sockets that never joined go first, then the newest watcher.
  evictionCandidate(sockets) {
    const roleOf = (ws) => (ws.deserializeAttachment() || {}).role || null;
    return sockets.find((ws) => !roleOf(ws)) || [...sockets].reverse().find((ws) => roleOf(ws) === 'spectator') || null;
  }

  async evict(ws) {
    const id = (ws.deserializeAttachment() || {}).id;
    if (id) this.evicted.add(id);
    try {
      ws.close(1013, 'The room is full and a player needed the space.');
    } catch {
      // already closed
    }
    await this.handleDisconnect(ws);
  }

  isRateLimited(connId) {
    const now = Date.now();
    const recent = (this.rates.get(connId) || []).filter((timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS);
    const limited = recent.length >= RATE_LIMIT_MAX_MESSAGES;
    if (!limited) recent.push(now);
    this.rates.set(connId, recent);
    return limited;
  }

  // Each socket's messages are applied in arrival order; the room has at most a couple of them.
  webSocketMessage(ws, data) {
    const key = (ws.deserializeAttachment() || {}).id || 'anonymous';
    const previous = this.chains.get(key) || Promise.resolve();
    const task = previous.then(() => this.processMessage(ws, data));
    const guarded = task.catch((error) => console.error('room message failed', error));
    this.chains.set(key, guarded);
    guarded.then(() => {
      if (this.chains.get(key) === guarded) this.chains.delete(key);
    });
    return guarded;
  }

  async processMessage(ws, data) {
    const conn = this.conn(ws);
    const hooks = this.hooks();
    const sendError = (code, message) => hooks.send(conn, createError(conn.roomCode || '', conn.playerId || '', code, message));

    if (messageByteLength(data) > MAX_MESSAGE_BYTES) {
      sendError(ERROR_CODES.INVALID_PAYLOAD, 'Message exceeds size limit.');
      return;
    }
    if (this.isRateLimited(conn.id)) {
      sendError(ERROR_CODES.RATE_LIMIT, 'Too many requests. Slow down.');
      return;
    }

    const parsed = parseEnvelope(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (!parsed.ok) {
      sendError(parsed.code, parsed.message);
      return;
    }
    const { envelope } = parsed;

    if (envelope.type === TYPES.CREATE_ROOM) {
      if (!conn.create || this.room) {
        sendError(ERROR_CODES.INVALID_PAYLOAD, 'Open a new connection with ?create=1 to create a room.');
        return;
      }
      this.room = rl.createRoomState(conn.roomCode);
      conn.create = false;
      if (session.createRoom(this.room, hooks, conn, envelope.payload)) await this.afterChange();
      else this.room = null;
      return;
    }

    if (!this.room || envelope.roomCode !== this.room.roomCode) {
      sendError(ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.');
      return;
    }

    const changed = envelope.type === TYPES.JOIN_ROOM
      ? session.joinRoom(this.room, hooks, conn, envelope)
      : session.handleMessage(this.room, hooks, conn, envelope);
    if (changed) await this.afterChange();
  }

  async handleDisconnect(ws) {
    const conn = this.conn(ws);
    this.closing.add(conn.id);
    this.rates.delete(conn.id);
    try {
      if (this.room && session.handleClose(this.room, this.hooks(), conn)) await this.persist();
    } finally {
      this.closing.delete(conn.id);
    }
  }

  async webSocketClose(ws, code) {
    await this.handleDisconnect(ws);
    this.evicted.delete((ws.deserializeAttachment() || {}).id);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // the runtime may already have completed the close handshake
    }
  }

  async webSocketError(ws) {
    await this.handleDisconnect(ws);
  }
}
