import { DurableObject } from 'cloudflare:workers';

const protocol = globalThis.BlendChessProtocol;
const rl = globalThis.BlendChessRoomLogic;
const session = globalThis.BlendChessRoomSession;
if (!protocol || !rl || !session) throw new Error('shared modules must load before room.js');

const { TYPES, ERROR_CODES, createError, parseEnvelope } = protocol;

const ROOM_TTL_MS = 1000 * 60 * 60;
const MAX_SOCKETS_PER_ROOM = 64;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 40;
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

// One Durable Object per room code. Sockets use the hibernation API: per-socket metadata
// lives in the socket attachment and the room in storage, so nothing depends on memory
// surviving between messages.
export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.room = null;
    this.closing = new Set();
    this.rates = new Map();
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

  async persist() {
    if (!this.room) return;
    await this.ctx.storage.put('room', this.room);
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async alarm() {
    if (!this.room) return;
    const idle = Date.now() - this.room.lastActivity >= ROOM_TTL_MS;
    if (this.ctx.getWebSockets().length === 0 && idle) {
      await this.ctx.storage.deleteAll();
      this.room = null;
      return;
    }
    await this.ctx.storage.setAlarm(Date.now() + ROOM_TTL_MS);
  }

  async fetch(request) {
    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket upgrade.', { status: 426 });
    }

    const roomCode = request.headers.get('X-Room-Code') || '';
    const create = request.headers.get('X-Room-Create') === '1';
    if (create && this.room) return new Response('Room code taken.', { status: 409 });
    if (this.ctx.getWebSockets().length >= MAX_SOCKETS_PER_ROOM) return new Response('Room is crowded.', { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), roomCode, create, role: null, playerId: '' });
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

  async webSocketMessage(ws, data) {
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
      if (session.createRoom(this.room, hooks, conn, envelope.payload)) await this.persist();
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
    if (changed) await this.persist();
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
