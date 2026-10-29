import '../../chess-core.js';
import '../../shared/protocol.js';
import '../../shared/engine-facade.js';
import '../../shared/room-logic.js';
import '../../shared/room-session.js';
import '../../shared/rating.js';
import '../../shared/lobby-logic.js';
import '../../shared/lobby-session.js';
import { GameHub } from './room.js';
import { LobbyHub } from './lobby.js';

const { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } = globalThis.BlendChessProtocol;
const { sha256Hex } = globalThis.BlendChessLobbyLogic;
const CREATE_ATTEMPTS = 5;

function isWebSocketUpgrade(request) {
  const upgrade = request.headers.get('Upgrade');
  return typeof upgrade === 'string' && upgrade.toLowerCase() === 'websocket';
}

function makeRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

// The raw IP never leaves this function: Durable Objects only ever see a hash.
async function networkHash(request) {
  // Only the platform header is trustworthy; X-Forwarded-For is client-controlled.
  const ip = request.headers.get('CF-Connecting-IP');
  if (!ip) return 'unknown';
  const address = String(ip).split(',')[0].trim();
  // Local development: everything comes from loopback, which is not a shared network.
  if (['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(address)) return 'unknown';
  return (await sha256Hex(address)).slice(0, 32);
}

function lobbyStub(env) {
  return env.LOBBY_HUB.get(env.LOBBY_HUB.idFromName('lobby'));
}

function forwardToRoom(env, request, roomCode, create, ipHash) {
  const headers = new Headers(request.headers);
  headers.set('X-Room-Code', roomCode);
  headers.set('X-Room-Create', create ? '1' : '0');
  headers.set('X-IP-Hash', ipHash);
  const stub = env.GAME_HUB.get(env.GAME_HUB.idFromName(roomCode));
  return stub.fetch(new Request(request, { headers }));
}

async function forwardToLobby(env, request, ipHash) {
  const headers = new Headers(request.headers);
  headers.set('X-IP-Hash', ipHash);
  return lobbyStub(env).fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (url.pathname === '/leaderboard') {
      const limit = Math.min(100, Math.max(1, Number(url.searchParams.get('limit')) || 20));
      try {
        const response = await lobbyStub(env).fetch(`https://lobby.internal/leaderboard?limit=${limit}`);
        return new Response(response.body, {
          status: response.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
            'Cache-Control': 'public, max-age=5',
          },
        });
      } catch {
        return new Response(JSON.stringify({ players: [], total: 0 }), {
          status: 503,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }
    }

    // Only the root path routes: internal Durable Object paths must never be forwarded from here.
    if (url.pathname !== '/' && url.pathname !== '') {
      return new Response('Not found.', { status: 404 });
    }

    const ipHash = await networkHash(request);

    // Ranked lobby: one shared Durable Object for matchmaking and ratings.
    if (isWebSocketUpgrade(request) && url.searchParams.get('lobby') === '1') {
      return forwardToLobby(env, request, ipHash);
    }

    if (!isWebSocketUpgrade(request)) {
      return new Response('Blendchess multiplayer worker. Connect a WebSocket with ?lobby=1, ?create=1 or ?room=CODE.', { status: 200 });
    }

    // Each room lives in its own Durable Object, addressed by the room code.
    if (url.searchParams.get('create') === '1') {
      if (!(await createAllowed(env, ipHash))) {
        return new Response('Too many rooms from this network. Try again in a minute.', {
          status: 429,
          headers: { 'Retry-After': '60' },
        });
      }
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const response = await forwardToRoom(env, request, makeRoomCode(), true, ipHash);
        if (response.status !== 409) return response;
      }
      return new Response('Could not allocate a room code.', { status: 503 });
    }

    const roomCode = normalizeRoomCode(url.searchParams.get('room'));
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      return new Response('Missing ?room=CODE or ?create=1.', { status: 400 });
    }
    return forwardToRoom(env, request, roomCode, false, ipHash);
  },
};

// Fail open if the lobby cannot answer: private friend games should keep working.
async function createAllowed(env, ipHash) {
  try {
    const response = await lobbyStub(env).fetch('https://lobby.internal/limit/create', {
      headers: { 'X-IP-Hash': ipHash },
    });
    return response.status !== 429;
  } catch {
    return true;
  }
}

export { GameHub, LobbyHub };
