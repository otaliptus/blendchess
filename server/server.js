import http from 'node:http';
import { customAlphabet } from 'nanoid';
import { WebSocketServer } from 'ws';
import * as webauthn from '@simplewebauthn/server';
import { protocol, rl, session, lobbyLogic, lobbySession, accountApi } from './shared.js';

const { TYPES, ERROR_CODES, createError, parseEnvelope } = protocol;

const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 1000 * 60 * 60;
const MAX_ROOMS = 10_000;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 40;
const LOBBY_RATE_LIMIT_MAX_MESSAGES = 30;
const TICK_MS = 500;
// Sites allowed to call the account routes (localhost is always allowed).
const SITE_ORIGINS = accountApi.parseOrigins(process.env.SITE_ORIGINS);

const makeRoomCode = customAlphabet(protocol.ROOM_CODE_ALPHABET, protocol.ROOM_CODE_LENGTH);
const makeConnectionId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);
const makeResumeToken = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 24);

// roomCode -> { state, members: Set<conn> }
const rooms = new Map();
// Ranked matchmaking lives in this process; the Worker keeps the same store in its Durable Object.
const lobbyStore = lobbyLogic.createMemoryStore();
const lobbyConnections = new Set();

// One network is an IPv4 address or an IPv6 /64. Loopback is not a shared network: two tabs on the
// dev machine are different people.
function networkOf(req) {
  return lobbyLogic.networkKey(req.socket.remoteAddress);
}

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

function lobbyHooks() {
  return {
    connections: () => [...lobbyConnections].filter((conn) => conn.ws.readyState === 1),
    send,
    close: (conn, code, reason) => {
      try {
        conn.ws.close(code, reason);
      } catch {
        // already closing
      }
    },
    save: () => {},
    createRatedRoom,
    newPlayerLimit: process.env.NEW_PLAYER_LIMIT,
  };
}

function pruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms) {
    if (room.members.size === 0 && now - room.state.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
      releaseRated(room).catch((error) => console.error('release failed', error));
    }
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

function playerIdentitiesOf(state) {
  return rl.playerIdentities(state);
}

// Called by the lobby when two players are paired: reserve both seats in a fresh room.
function createRatedRoom(match) {
  const spec = lobbyLogic.controlOf(match.control);
  if (!spec) return null;
  const room = createRoom();
  if (!room) return null;
  const tickets = { w: lobbyLogic.makeToken(), b: lobbyLogic.makeToken() };
  const seats = match.seats.map((seat) => ({ ...seat, ticket: tickets[seat.color] || '' }));
  if (!seats.every((seat) => seat.ticket)) {
    rooms.delete(room.state.roomCode);
    return null;
  }
  rl.applyReservation(room.state, {
    rated: match.rated,
    control: spec.id,
    clock: { baseMs: spec.baseMs, incMs: spec.incMs },
    seats,
  });
  return { roomCode: room.state.roomCode, tickets };
}

// Each new game in a lobby room (rematches included) goes back on the live list, and a ranked one
// keeps the lobby's "you are in a game" marker.
async function registerActive(room) {
  const state = room.state;
  if (!rl.isLobbyRoom(state) || state.gameOver) return;
  const gameKey = rl.lobbyGameKey(state);
  if (state.activeGameKey === gameKey) return;
  state.activeGameKey = gameKey;
  const result = await lobbySession.registerActive(lobbyStore, rl.lobbyActiveMessage(state));
  if (!result.ok) state.activeGameKey = '';
}

// After a lobby game ends, the room sends the result to the lobby exactly once, then re-broadcasts
// the views with the rating changes and the record id attached.
async function reportResult(room) {
  const state = room.state;
  if (!rl.isLobbyRoom(state) || !state.gameOver || state.reported || room.reporting) return false;
  const players = playerIdentitiesOf(state).map((player) => player.playerId);
  if (state.noContest) {
    // Nobody gets rated for an opponent who never arrived; just free both players.
    if (!state.released) {
      state.released = true;
      await lobbySession.release(lobbyStore, { roomCode: state.roomCode, players });
    }
    return false;
  }
  // `reported` turns true only once the lobby has the result (a rematch waits for it);
  // `room.reporting` keeps a second change from sending the same report meanwhile.
  room.reporting = true;
  let result;
  try {
    result = await lobbySession.report(lobbyStore, lobbyHooks(), rl.lobbyReportMessage(state));
  } finally {
    room.reporting = false;
  }
  if (!result.ok) {
    // A final rejection (a game the lobby never arranged) is not retried.
    if (result.final) state.reported = true;
    return false;
  }
  state.reported = true;
  state.ratingUpdates = result.updates || null;
  state.recordId = result.gameId || null;
  session.broadcastViews(state, hooksFor(room));
  return true;
}

async function afterRoomChange(room) {
  await registerActive(room);
  await reportResult(room);
}

async function releaseRated(room) {
  const state = room.state;
  if (!rl.isLobbyRoom(state)) return;
  await reportResult(room);
  const players = playerIdentitiesOf(state).map((player) => player.playerId);
  if (players.length) await lobbySession.release(lobbyStore, { roomCode: state.roomCode, players });
}

// Clocks and no-shows: rated games must end even when nobody is sending messages.
async function tickRatedGames() {
  const now = Date.now();
  for (const room of rooms.values()) {
    const state = room.state;
    if (!rl.isLobbyRoom(state) || state.gameOver) continue;

    if (state.clock && state.clock.startedAt) {
      if (rl.clockRemainingMs(state, now) <= 0) {
        rl.chargeClock(state, now);
        rl.finishByTimeout(state);
        session.broadcastViews(state, hooksFor(room));
        await afterRoomChange(room);
        continue;
      }
    }

    const waitingForSeat = !rl.isReady(state) && state.log.length === 0;
    if (waitingForSeat && now - state.reservedAt >= rl.JOIN_DEADLINE_MS) {
      if (rl.connectedPlayerCount(state) >= 1) {
        rl.finishByAbandon(state);
        session.broadcastViews(state, hooksFor(room));
        await afterRoomChange(room);
      } else {
        // Nobody ever arrived: free both players and drop the room.
        await releaseRated(room);
        rooms.delete(state.roomCode);
        continue;
      }
    }

    if (state.gameOver && !state.reported) await reportResult(room);
  }
}

function leaveRoom(conn) {
  const room = conn.roomCode ? rooms.get(conn.roomCode) : null;
  conn.roomCode = null;
  if (!room) return;
  room.members.delete(conn);
  session.handleClose(room.state, hooksFor(room), conn);
}

function isRateLimited(conn, limit = RATE_LIMIT_MAX_MESSAGES) {
  const now = Date.now();
  conn.recentMessages = conn.recentMessages.filter((timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS);
  if (conn.recentMessages.length >= limit) return true;
  conn.recentMessages.push(now);
  return false;
}

async function handleRaw(conn, rawData) {
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
      await afterRoomChange(room);
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
  await afterRoomChange(room);
}

async function handleLobbyMessage(conn, rawData) {
  const sendError = (code, message) => send(conn, createError('', '', code, message));
  if (rawData.length > MAX_MESSAGE_BYTES) {
    sendError(ERROR_CODES.INVALID_PAYLOAD, 'Message exceeds size limit.');
    return;
  }
  if (isRateLimited(conn, LOBBY_RATE_LIMIT_MAX_MESSAGES)) {
    sendError(ERROR_CODES.RATE_LIMIT, 'Too many requests. Slow down.');
    return;
  }
  const parsed = parseEnvelope(rawData);
  if (!parsed.ok) {
    sendError(parsed.code, parsed.message);
    return;
  }
  await lobbySession.handleMessage(lobbyStore, lobbyHooks(), conn, parsed.envelope);
}

// Signed-out sessions lose their seats in lobby rooms: tickets and resume tokens stop working and
// their game sockets close.
async function revokeSeats(list) {
  for (const { roomCode, sessions } of list) {
    const room = rooms.get(roomCode);
    if (room && session.revokeSessions(room.state, hooksFor(room), sessions)) await afterRoomChange(room);
  }
}

// Reads a request body as text, giving up past the API's size limit.
function readBody(req) {
  return new Promise((resolve) => {
    let size = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > accountApi.MAX_BODY_BYTES) {
        resolve({ text: '', tooLarge: true });
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), tooLarge: false }));
    req.on('error', () => resolve({ text: '', tooLarge: true }));
  });
}

let apiContext = null;

// /api/*: accounts, profiles, game records, live games, leaderboard. Same handler as the Worker.
async function handleApi(req, res) {
  const origin = req.headers.origin || '';
  if (req.method === 'OPTIONS') {
    res.writeHead(204, accountApi.preflightHeaders(origin, SITE_ORIGINS));
    res.end();
    return;
  }
  const body = req.method === 'POST' ? await readBody(req) : { text: '', tooLarge: false };
  apiContext = apiContext || { origins: SITE_ORIGINS, webauthn, hooks: lobbyHooks(), revokeSeats };
  const result = await accountApi.handleHttp(lobbyStore, apiContext, {
    method: req.method,
    url: req.url,
    origin,
    authorization: req.headers.authorization || '',
    ipHash: networkOf(req),
    bodyText: body.text,
    bodyTooLarge: body.tooLarge,
  });
  res.writeHead(result.status, accountApi.responseHeaders(origin, result, SITE_ORIGINS));
  res.end(JSON.stringify(result.body));
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  if (url.pathname === '/health') {
    res.writeHead(200, { 'Content-Type': 'text/plain' });
    res.end('ok');
    return;
  }
  if (accountApi.isApiPath(url.pathname)) {
    handleApi(req, res).catch((error) => {
      console.error('api failed', error);
      if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'SERVER_ERROR' }));
    });
    return;
  }
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Blendchess multiplayer server. Use a WebSocket upgrade.');
});

const wss = new WebSocketServer({ server, maxPayload: MAX_MESSAGE_BYTES });

wss.on('connection', (ws, req) => {
  const url = new URL(req.url || '/', 'http://localhost');
  const conn = {
    id: makeConnectionId(),
    ws,
    roomCode: null,
    role: null,
    playerId: '',
    ipHash: networkOf(req),
    recentMessages: [],
  };

  // A protocol error on one socket (an oversized frame, say) must not take the whole process down:
  // without a listener, ws re-throws it as an uncaught exception. The socket closes on its own.
  ws.on('error', (error) => console.warn('socket error:', error.message));

  if (url.searchParams.get('lobby') === '1') {
    lobbyConnections.add(conn);
    // Messages from one socket are handled strictly in order: a rename must land before a queue.
    conn.chain = Promise.resolve();
    ws.on('message', (rawData) => {
      conn.chain = conn.chain.then(() => handleLobbyMessage(conn, rawData)).catch((error) => {
        console.error('lobby message failed', error);
        send(conn, createError('', '', ERROR_CODES.INVALID_PAYLOAD, 'Server error.'));
      });
    });
    ws.on('close', () => {
      lobbyConnections.delete(conn);
      lobbySession.handleClose(lobbyStore, lobbyHooks(), conn);
    });
    return;
  }

  conn.chain = Promise.resolve();
  ws.on('message', (rawData) => {
    conn.chain = conn.chain.then(() => handleRaw(conn, rawData)).catch((error) => {
      console.error('message handling failed', error);
      send(conn, createError(conn.roomCode || '', conn.playerId || '', ERROR_CODES.INVALID_PAYLOAD, 'Server error.'));
    });
  });

  ws.on('close', () => leaveRoom(conn));
});

setInterval(pruneRooms, 60_000).unref();
setInterval(() => tickRatedGames().catch((error) => console.error('rated tick failed', error)), TICK_MS).unref();

server.listen(PORT, () => {
  console.log(`Blendchess server listening on ws://localhost:${PORT}`);
});
