import '../../chess-core.js';
import '../../shared/protocol.js';
import '../../shared/engine-facade.js';
import '../../shared/room-logic.js';
import '../../shared/room-session.js';
import '../../shared/rating.js';
import '../../shared/lobby-logic.js';
import '../../shared/lobby-session.js';
import '../../shared/account-api.js';
import { GameHub } from './room.js';
import { LobbyHub } from './lobby.js';

const { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, normalizeRoomCode } = globalThis.BlendChessProtocol;
const { sha256Hex, networkKey } = globalThis.BlendChessLobbyLogic;
const accountApi = globalThis.BlendChessAccountApi;
const CREATE_ATTEMPTS = 5;

// SITE_ORIGINS only changes with a deploy: parse it once per isolate.
let siteOrigins = null;
function originsOf(env) {
  if (!siteOrigins || siteOrigins.raw !== env.SITE_ORIGINS) {
    siteOrigins = { raw: env.SITE_ORIGINS, list: accountApi.parseOrigins(env.SITE_ORIGINS) };
  }
  return siteOrigins.list;
}

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
  // One network is an IPv4 address or an IPv6 /64; loopback (local development) is 'unknown'.
  const network = networkKey(request.headers.get('CF-Connecting-IP'));
  if (network === 'unknown') return network;
  return (await sha256Hex(network)).slice(0, 32);
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

// /api/* goes to the lobby, which owns accounts, profiles, game records and the live list.
// /leaderboard is the pre-accounts path, kept so older clients keep working.
async function handleApi(request, env, ctx, url) {
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: accountApi.preflightHeaders(request.headers.get('Origin') || '', originsOf(env)) });
  }
  const tooLarge = () => new Response(JSON.stringify({ error: 'TOO_LARGE' }), { status: 413, headers: { 'Content-Type': 'application/json' } });
  if (Number(request.headers.get('Content-Length') || 0) > accountApi.MAX_BODY_BYTES) return tooLarge();

  // The edge cache only exists on a custom domain; on workers.dev these calls are no-ops.
  const { path, cacheKey: key } = accountApi.routeOf(request.method, url.pathname, url.searchParams);
  const cache = key && typeof caches !== 'undefined' ? caches.default : null;
  const keyUrl = new URL(key || '/', url.origin);
  keyUrl.searchParams.set('dataVersion', String(globalThis.BlendChessProtocol.DATA_VERSION));
  const cacheKey = cache ? new Request(keyUrl, { method: 'GET' }) : null;
  if (cache) {
    try {
      const hit = await cache.match(cacheKey);
      if (hit) return hit;
    } catch {
      // cache unavailable: answer from the lobby
    }
  }

  // Content-Length can be absent (chunked uploads), so the body itself is measured too.
  const body = request.method === 'POST' ? await request.text() : undefined;
  if (body !== undefined && body.length > accountApi.MAX_BODY_BYTES) return tooLarge();

  let response;
  try {
    const target = new URL(request.url);
    target.pathname = path;
    const headers = new Headers(request.headers);
    // Only writes are rate limited per network; reads skip the hashing.
    headers.set('X-IP-Hash', request.method === 'GET' ? 'unknown' : await networkHash(request));
    response = await lobbyStub(env).fetch(new Request(target.toString(), { method: request.method, headers, body }));
  } catch {
    const fallback = path === '/api/leaderboard' ? { players: [], total: 0 } : { error: 'UNAVAILABLE' };
    return new Response(JSON.stringify(fallback), {
      status: 503,
      headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
    });
  }
  if (cache && response.status === 200) {
    try {
      ctx.waitUntil(cache.put(cacheKey, response.clone()));
    } catch {
      // not cached this time
    }
  }
  return response;
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (url.pathname === '/health') {
      return new Response('ok', { status: 200 });
    }

    if (accountApi.isApiPath(url.pathname)) {
      return handleApi(request, env, ctx, url);
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
