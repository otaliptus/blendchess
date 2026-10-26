import '../../chess-core.js';
import '../../shared/protocol.js';
import '../../shared/engine-facade.js';
import '../../shared/room-logic.js';
import '../../shared/room-session.js';
import { GameHub } from './room.js';

const { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } = globalThis.BlendChessProtocol;
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

function forwardToRoom(env, request, roomCode, create) {
  const headers = new Headers(request.headers);
  headers.set('X-Room-Code', roomCode);
  headers.set('X-Room-Create', create ? '1' : '0');
  const stub = env.GAME_HUB.get(env.GAME_HUB.idFromName(roomCode));
  return stub.fetch(new Request(request, { headers }));
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (!isWebSocketUpgrade(request)) {
      return new Response('Blendchess multiplayer worker. Connect a WebSocket with ?create=1 or ?room=CODE.', { status: 200 });
    }

    // Each room lives in its own Durable Object, addressed by the room code.
    if (url.searchParams.get('create') === '1') {
      for (let attempt = 0; attempt < CREATE_ATTEMPTS; attempt += 1) {
        const response = await forwardToRoom(env, request, makeRoomCode(), true);
        if (response.status !== 409) return response;
      }
      return new Response('Could not allocate a room code.', { status: 503 });
    }

    const roomCode = normalizeRoomCode(url.searchParams.get('room'));
    if (roomCode.length !== ROOM_CODE_LENGTH) {
      return new Response('Missing ?room=CODE or ?create=1.', { status: 400 });
    }
    return forwardToRoom(env, request, roomCode, false);
  },
};

export { GameHub };
