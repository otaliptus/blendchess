import http from 'node:http';
import { customAlphabet } from 'nanoid';
import { WebSocketServer } from 'ws';
import { protocol, rl, session } from './shared.js';

const { TYPES, ERROR_CODES, createError, parseEnvelope } = protocol;

const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 1000 * 60 * 60;
const MAX_ROOMS = 10_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 40;

const makeRoomCode = customAlphabet(protocol.ROOM_CODE_ALPHABET, protocol.ROOM_CODE_LENGTH);
const makeConnectionId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const makeResumeToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

// roomCode -> { state, members: Set<conn> }
const rooms = new Map();

function send(conn, message) {
  if (conn.ws.readyState === 1) conn.ws.send(JSON.stringify(message));
}

function hooksFor(room) {
  return {
    connections: () => [...room.members],
    send,
    close: (conn, code, reason) => {
      room.members.delete(conn);
      conn.roomCode = null;
      try {
        conn.ws.close(code, reason);
      } catch {
        // already closing
      }
    },
    save: () => {},
    makeResumeToken,
  };
}

function pruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.members.size === 0 && now - room.state.lastActivity > ROOM_TTL_MS) rooms.delete(code);
  }
}

function createRoom() {
  if (rooms.size >= MAX_ROOMS) pruneRooms();
  if (rooms.size >= MAX_ROOMS) return null;
  let code;
  do {
    code = makeRoomCode();
  } while (rooms.has(code));
  const room = { state: rl.createRoomState(code), members: new Set() };
  rooms.set(code, room);
  return room;
}

function leaveRoom(conn) {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  conn.roomCode = null;
  if (!room) return;
  room.members.delete(conn);
  session.handleClose(room.state, hooksFor(room), conn);
}

function isRateLimited(conn) {
  const now = Date.now();
  conn.recentMessages = conn.recentMessages.filter((timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS);
  if (conn.recentMessages.length >= RATE_LIMIT_MAX_MESSAGES) return true;
  conn.recentMessages.push(now);
  return false;
}

function handleRaw(conn, rawData) {
  const sendError = (code, message, roomCode = conn.roomCode || '') => send(conn, createError(roomCode, conn.playerId || '', code, message));

  if (rawData.length > MAX_MESSAGE_BYTES) {
    sendError(ERROR_CODES.INVALID_PAYLOAD, 'Message exceeds size limit.');
    return;
  }
  if (isRateLimited(conn)) {
    sendError(ERROR_CODES.RATE_LIMIT, 'Too many requests. Slow down.');
    return;
  }

  const parsed = parseEnvelope(rawData);
  if (!parsed.ok) {
    sendError(parsed.code, parsed.message);
    return;
  }
  const { envelope } = parsed;

  if (envelope.type === TYPES.CREATE_ROOM) {
    leaveRoom(conn);
    const room = createRoom();
    if (!room) {
      sendError(ERROR_CODES.RATE_LIMIT, 'Server is full. Try again later.');
      return;
    }
    room.members.add(conn);
    if (!session.createRoom(room.state, hooksFor(room), conn, envelope.payload)) {
      room.members.delete(conn);
      rooms.delete(room.state.roomCode);
    }
    return;
  }

  const room = rooms.get(envelope.roomCode);
  if (!room) {
    sendError(ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.', envelope.roomCode);
    return;
  }

  if (envelope.type === TYPES.JOIN_ROOM) {
    if (conn.roomCode && conn.roomCode !== envelope.roomCode) leaveRoom(conn);
    const wasMember = room.members.has(conn);
    room.members.add(conn);
    if (session.joinRoom(room.state, hooksFor(room), conn, envelope)) {
      conn.roomCode = room.state.roomCode;
    } else if (!wasMember) {
      room.members.delete(conn);
    }
    return;
  }

  if (conn.roomCode !== room.state.roomCode) {
    sendError(ERROR_CODES.WRONG_COLOR, 'Join the room first.', envelope.roomCode);
    return;
  }
  session.handleMessage(room.state, hooksFor(room), conn, envelope);
}

const server = http.createServer((req, res) => {
  if (req.url === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Blendchess multiplayer server. Use a WebSocket upgrade.');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws) => {
  const conn = {
    id: makeConnectionId(),
    ws,
    roomCode: null,
    role: null,
    playerId: '',
    recentMessages: [],
  };

  ws.on('message', (rawData) => {
    try {
      handleRaw(conn, rawData);
    } catch (error) {
      console.error('message handling failed', error);
      send(conn, createError(conn.roomCode || '', conn.playerId || '', ERROR_CODES.INVALID_PAYLOAD, 'Server error.'));
    }
  });

  ws.on('close', () => leaveRoom(conn));
});

setInterval(pruneRooms, 60_000).unref();

server.listen(PORT, () => {
  console.log(`Blendchess server listening on ws://localhost:${PORT}`);
});
