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
    return this.ctx.getWebSockets().map((ws) => this.conn(ws)).filter((conn) => !this.closing.has(conn.id));
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
    const waitingForSeat = this.room.rated && !this.room.gameOver && !rl.isReady(this.room) && this.room.log.length === 0;
    if (waitingForSeat) next = Math.min(next, this.room.reservedAt + rl.JOIN_DEADLINE_MS + 100);
    await this.ctx.storage.setAlarm(next);
  }

  lobby() {
    return this.env.LOBBY_HUB.get(this.env.LOBBY_HUB.idFromName('lobby'));
  }

  ratedPlayers() {
    return rl.playerIdentities(this.room);
  }

  // The lobby blocks ranked queueing while a player has an unfinished game, rematches included.
  async registerActive() {
    if (!this.room || !this.room.rated || this.room.gameOver) return;
    const gameKey = `${this.room.roomCode}:${this.room.gameId}`;
    if (this.room.activeGameKey === gameKey) return;
    this.room.activeGameKey = gameKey;
    try {
      await this.lobby().fetch('https://lobby.internal/active', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ roomCode: this.room.roomCode, gameKey, players: this.ratedPlayers().map((player) => player.playerId) }),
      });
    } catch {
      this.room.activeGameKey = '';
    }
  }

  // Exactly one report per game, retried by the alarm until the lobby acknowledges it.
  async reportResult() {
    if (!this.room || !this.room.rated || !this.room.gameOver || this.room.reported) return;
    const gameKey = `${this.room.roomCode}:${this.room.gameId}`;
    this.room.reported = true;
    this.room.reportRetryAt = 0;
    const winner = this.room.winner === 'White' ? 'w' : this.room.winner === 'Black' ? 'b' : null;
    let result = null;
    try {
      const response = await this.lobby().fetch('https://lobby.internal/report', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          roomCode: this.room.roomCode,
          gameKey,
          players: this.ratedPlayers(),
          winner,
          result: this.room.result,
          plies: this.room.log.length,
          finishedAt: Date.now(),
        }),
      });
      result = await response.json();
    } catch {
      result = null;
    }
    if (!result || !result.ok) {
      this.room.reported = false;
      this.room.reportRetryAt = Date.now() + REPORT_RETRY_MS;
      await this.persist();
      return;
    }
    this.room.ratingUpdates = result.updates;
    await this.persist();
    session.broadcastViews(this.room, this.hooks());
  }

  async afterChange() {
    if (!this.room) return;
    await this.persist();
    await this.registerActive();
    await this.reportResult();
  }

  async releaseRated() {
    if (!this.room || !this.room.rated) return;
    const players = this.room.playerOrder.filter((playerId) => this.room.players[playerId]);
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

    if (this.room.rated && !this.room.gameOver) {
      if (this.room.clock && this.room.clock.startedAt && rl.clockRemainingMs(this.room, now) <= 0) {
        rl.chargeClock(this.room, now);
        rl.finishByTimeout(this.room);
        changed = true;
      } else if (!rl.isReady(this.room) && this.room.log.length === 0
        && rl.connectedPlayerCount(this.room) >= 1
        && now - this.room.reservedAt >= rl.JOIN_DEADLINE_MS) {
        rl.finishByAbandon(this.room);
        changed = true;
      }
    }
    if (changed) {
      session.broadcastViews(this.room, this.hooks());
      await this.afterChange();
    } else if (this.room.rated && this.room.gameOver && !this.room.reported) {
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

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade.', { status: 426 });
    }

    const roomCode = request.headers.get('X-Room-Code') || '';
    const create = request.headers.get('X-Room-Create') === '1';
    const ipHash = request.headers.get('X-IP-Hash') || 'unknown';
    if (create && this.room) return new Response('Room code taken.', { status: 409 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) return new Response('Room is crowded.', { status: 429 });
    const sameIp = this.ctx.getWebSockets().filter((ws) => {
      const attachment = ws.deserializeAttachment();
      return attachment && attachment.ipHash === ipHash;
    }).length;
    if (sameIp >= MAX_SOCKETS_PER_IP) return new Response('Too many connections from this network.', { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), roomCode, create, role: null, playerId: '', ipHash });
    return new Response(null, { status: 101, webSocket: client });
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
    const guarded = task.catch(() => {});
    this.chains.set(key, guarded);
    guarded.then(() => {
      if (this.chains.get(key) === guarded) this.chains.delete(key);
    });
    return task;
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
