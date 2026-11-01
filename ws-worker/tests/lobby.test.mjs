import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOBBY_MODULE_PATH = path.resolve(__dirname, '../src/lobby.js');

require('../../chess-core.js');
const protocol = require('../../shared/protocol.js');
require('../../shared/engine-facade.js');
require('../../shared/room-logic.js');
require('../../shared/room-session.js');
require('../../shared/rating.js');
const logic = require('../../shared/lobby-logic.js');
require('../../shared/lobby-session.js');
require('../../shared/account-api.js');

class MockSocket {
  constructor() {
    this.inbox = [];
    this.closed = false;
    this.attachment = null;
  }
  send(text) {
    if (this.closed) throw new Error('closed');
    this.inbox.push(JSON.parse(text));
  }
  close() {
    this.closed = true;
  }
  serializeAttachment(value) {
    this.attachment = structuredClone(value);
  }
  deserializeAttachment() {
    return structuredClone(this.attachment);
  }
}

class MockResponse {
  constructor(body, init = {}) {
    this.body = body;
    this.status = init.status || 200;
    this.headers = init.headers || {};
  }
  get ok() {
    return this.status >= 200 && this.status < 300;
  }
  async json() {
    return JSON.parse(this.body);
  }
  async text() {
    return String(this.body);
  }
}

class MockRequest {
  constructor(url, init = {}) {
    this.url = url;
    this.method = init.method || 'GET';
    this.headers = new Headers(init.headers || {});
    this._body = init.body;
  }
  async json() {
    return JSON.parse(this._body);
  }
  async text() {
    return this._body == null ? '' : String(this._body);
  }
}

async function loadLobbyHubClass() {
  const source = await readFile(LOBBY_MODULE_PATH, 'utf8');
  const context = vm.createContext({
    console,
    crypto,
    Date,
    JSON,
    Math,
    Object,
    Array,
    String,
    Number,
    Boolean,
    Set,
    Map,
    Promise,
    Uint8Array,
    TextEncoder,
    TextDecoder,
    URL,
    Headers,
    atob,
    btoa,
    Request: MockRequest,
    Response: MockResponse,
    WebSocketPair: class {
      constructor() {
        this[0] = new MockSocket();
        this[1] = new MockSocket();
      }
    },
    BlendChessProtocol: globalThis.BlendChessProtocol,
    BlendChessLobbyLogic: globalThis.BlendChessLobbyLogic,
    BlendChessLobbySession: globalThis.BlendChessLobbySession,
    BlendChessAccountApi: globalThis.BlendChessAccountApi,
  });
  context.globalThis = context;

  const module = new vm.SourceTextModule(source, { context, identifier: LOBBY_MODULE_PATH });
  await module.link(async (specifier) => {
    if (specifier === '@simplewebauthn/server') {
      // Passkey ceremonies are covered by the shared account tests; the Durable Object only routes.
      const names = ['generateRegistrationOptions', 'verifyRegistrationResponse', 'generateAuthenticationOptions', 'verifyAuthenticationResponse'];
      return new vm.SyntheticModule(names, function init() {
        for (const name of names) this.setExport(name, async () => ({ challenge: 'test-challenge', verified: false }));
      }, { context });
    }
    if (specifier !== 'cloudflare:workers') throw new Error(`Unhandled import: ${specifier}`);
    return new vm.SyntheticModule(['DurableObject'], function init() {
      this.setExport('DurableObject', class DurableObject {
        constructor(ctx, env) {
          this.ctx = ctx;
          this.env = env;
        }
      });
    }, { context });
  });
  await module.evaluate();
  return module.namespace.LobbyHub;
}

const LobbyHub = await loadLobbyHubClass();

function createCtx(storageMap = new Map()) {
  const sockets = [];
  let ready = Promise.resolve();
  return {
    sockets,
    storageMap,
    alarmAt: null,
    accepted: [],
    acceptWebSocket(ws) {
      sockets.push(ws);
    },
    getWebSockets() {
      return sockets.filter((ws) => !ws.closed);
    },
    blockConcurrencyWhile(fn) {
      ready = fn();
      return ready;
    },
    get ready() {
      return ready;
    },
    storage: {
      async get(key) {
        return structuredClone(storageMap.get(key));
      },
      async put(key, value) {
        storageMap.set(key, structuredClone(value));
      },
      async delete(key) {
        for (const item of Array.isArray(key) ? key : [key]) storageMap.delete(item);
      },
      async deleteAll() {
        storageMap.clear();
      },
      async list(options = {}) {
        const result = new Map();
        for (const key of [...storageMap.keys()].sort()) {
          if (options.prefix && !key.startsWith(options.prefix)) continue;
          if (options.end && key >= options.end) continue;
          if (options.startAfter && key <= options.startAfter) continue;
          if (options.limit && result.size >= options.limit) break;
          result.set(key, structuredClone(storageMap.get(key)));
        }
        return result;
      },
      async setAlarm(time) {
        this.alarmAt = time;
      },
      async getAlarm() {
        return this.alarmAt ?? null;
      },
      async deleteAlarm() {
        this.alarmAt = null;
      },
    },
  };
}

function createEnv(reserved = []) {
  const gameHub = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(url, init) {
        reserved.push({ code: name, url: String(url), body: JSON.parse(init.body) });
        return new MockResponse('{"ok":true}', { status: 200 });
      },
    }),
  };
  return { GAME_HUB: gameHub };
}

async function createLobby() {
  const ctx = createCtx();
  const env = createEnv();
  const hub = new LobbyHub(ctx, env);
  await ctx.ready;
  return { hub, ctx, env };
}

function upgradeRequest(ipHash = 'ip-a') {
  const headers = new Map([['upgrade', 'websocket'], ['x-ip-hash', ipHash]]);
  return { url: 'https://lobby.internal/?lobby=1', headers: { get: (name) => headers.get(name.toLowerCase()) || null } };
}

async function open(hub, ipHash = 'ip-a') {
  const response = await hub.fetch(upgradeRequest(ipHash));
  assert.equal(response.status, 101);
  const ws = hub.ctx.sockets.at(-1);
  return {
    ws,
    async send(type, payload = {}) {
      await hub.webSocketMessage(ws, JSON.stringify(protocol.createMessage(type, '', '', payload)));
    },
    last: (type) => ws.inbox.filter((message) => message.type === type).at(-1),
  };
}

test('the lobby refuses a flood of sockets from one network', async () => {
  const { hub } = await createLobby();
  for (let i = 0; i < 6; i += 1) {
    const response = await hub.fetch(upgradeRequest('same-ip'));
    assert.equal(response.status, 101);
  }
  const blocked = await hub.fetch(upgradeRequest('same-ip'));
  assert.equal(blocked.status, 429);
  const otherNetwork = await hub.fetch(upgradeRequest('other-ip'));
  assert.equal(otherNetwork.status, 101);
});

test('two queued players are matched and a room is reserved with tickets', async () => {
  const { hub, env } = await createLobby();
  const reserved = [];
  hub.env.GAME_HUB = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(url, init) {
        reserved.push({ code: name, body: JSON.parse(init.body) });
        return new MockResponse('{"ok":true}', { status: 200 });
      },
    }),
  };

  const a = await open(hub, 'ip-a');
  await a.send('lobby_hello', { nickname: 'Ann' });
  const aReady = a.last('lobby_ready');
  assert.equal(aReady.payload.player.rating, 1200);
  assert.ok(aReady.payload.token);

  const b = await open(hub, 'ip-b');
  await b.send('lobby_hello', { nickname: 'Bob' });
  await a.send('lobby_queue', { control: '5+3' });
  assert.equal(a.last('lobby_queued').payload.waiting, 1);
  await b.send('lobby_queue', { control: '5+3' });

  const aMatch = a.last('match_found');
  const bMatch = b.last('match_found');
  assert.ok(aMatch && bMatch);
  assert.equal(aMatch.payload.roomCode, bMatch.payload.roomCode);
  assert.equal(aMatch.payload.rated, true);
  assert.ok(aMatch.payload.ticket.length > 20);

  assert.equal(reserved.length, 1);
  const reservation = reserved[0].body;
  assert.equal(reservation.roomCode, aMatch.payload.roomCode);
  assert.equal(reservation.seats.length, 2);
  assert.equal(reservation.clock.baseMs, 300_000);
  assert.equal(reservation.clock.incMs, 3_000);
  assert.equal(reservation.rated, true);
  assert.ok(reservation.seats.every((seat) => seat.ticket.length > 20));
  assert.equal(reservation.seats.find((seat) => seat.color === aMatch.payload.color).ticket, aMatch.payload.ticket);

  // The identity and its rating survive an eviction.
  const revived = new LobbyHub(hub.ctx, env);
  await hub.ctx.ready;
  const stored = await revived.store.getPlayer(aReady.payload.player.id);
  assert.equal(stored.name, 'Ann');
});

test('a reported game updates the stored rating and the leaderboard endpoint', async () => {
  const { hub } = await createLobby();
  const reserved = [];
  hub.env.GAME_HUB = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(url, init) {
        reserved.push({ code: name, body: JSON.parse(init.body) });
        return new MockResponse('{"ok":true}', { status: 200 });
      },
    }),
  };

  const a = await open(hub, 'ip-a');
  const b = await open(hub, 'ip-b');
  await a.send('lobby_hello', { nickname: 'Ann' });
  await b.send('lobby_hello', { nickname: 'Bob' });
  const aPlayer = a.last('lobby_ready').payload.player;
  const bPlayer = b.last('lobby_ready').payload.player;
  await a.send('lobby_queue', { control: '10+0' });
  await b.send('lobby_queue', { control: '10+0' });
  const match = a.last('match_found');
  const gameKey = `${match.payload.roomCode}:1`;
  const players = [
    { playerId: aPlayer.id, color: 'w' },
    { playerId: bPlayer.id, color: 'b' },
  ];

  const report = await hub.fetch(new MockRequest('https://lobby.internal/report', {
    method: 'POST',
    body: JSON.stringify({ roomCode: match.payload.roomCode, gameKey, players, winner: 'b', result: 'checkmate' }),
  }));
  const body = await report.json();
  assert.equal(body.ok, true);
  assert.equal(body.updates.w.delta, -20);
  assert.equal(body.updates.b.delta, 20);

  const duplicate = await hub.fetch(new MockRequest('https://lobby.internal/report', {
    method: 'POST',
    body: JSON.stringify({ roomCode: match.payload.roomCode, gameKey, players, winner: 'w', result: 'resign' }),
  }));
  const duplicateBody = await duplicate.json();
  assert.equal(duplicateBody.duplicate, true);
  assert.equal(duplicateBody.updates.b.delta, 20);

  // Both are guests: rated, counted, but not listed until they secure their account.
  const api = (path, init = {}) => hub.fetch(new MockRequest(`https://lobby.internal${path}`, init));
  let board = await (await api('/api/leaderboard?limit=10')).json();
  assert.equal(board.total, 2);
  assert.equal(board.players.length, 0);

  const bobToken = b.last('lobby_ready').payload.token;
  const secured = await api('/api/auth/key/create', {
    method: 'POST',
    headers: { Origin: 'https://blendchess.com', Authorization: `Bearer ${bobToken}`, 'X-IP-Hash': 'ip-b' },
    body: '{}',
  });
  assert.equal(secured.status, 200);
  assert.equal(secured.headers['Access-Control-Allow-Origin'], 'https://blendchess.com');
  const securedBody = await secured.json();
  assert.match(securedBody.key, /^BLND(-[0-9A-Z]{4}){6}$/);
  assert.equal(securedBody.player.secured, true);

  board = await (await api('/leaderboard?limit=10')).json();
  assert.equal(board.players.length, 1);
  assert.equal(board.players[0].name, 'Bob');
  assert.equal(board.players[0].rating, 1220);

  // The game is on Bob's public profile and can be replayed; it has left the live list.
  const profile = await api('/api/players/bob');
  assert.equal(profile.headers['Access-Control-Allow-Origin'], '*');
  const profileBody = await profile.json();
  assert.equal(profileBody.player.name, 'Bob');
  assert.equal(profileBody.games.length, 1);
  assert.equal(profileBody.games[0].outcome, 'win');
  assert.equal(profileBody.games[0].delta, 20);
  assert.equal(profileBody.games[0].id, body.gameId);
  const game = await (await api(`/api/games/${body.gameId}`)).json();
  assert.equal(game.game.result, 'checkmate');
  assert.equal(game.game.black.name, 'Bob');
  assert.deepEqual((await (await api('/api/live')).json()).games, []);

  // Account routes refuse other sites.
  const foreign = await api('/api/me', { headers: { Origin: 'https://evil.example', Authorization: `Bearer ${bobToken}` } });
  assert.equal(foreign.status, 403);

  // A report for a game the lobby never reserved is refused.
  const forged = await hub.fetch(new MockRequest('https://lobby.internal/report', {
    method: 'POST',
    body: JSON.stringify({ roomCode: 'ZZZZZZ', gameKey: 'ZZZZZZ:1', players, winner: 'w' }),
  }));
  assert.equal((await forged.json()).ok, false);
});

test('room creation is capped per network', async () => {
  const { hub } = await createLobby();
  const request = (ip) => ({ url: 'https://lobby.internal/limit/create', method: 'GET', headers: new Headers({ 'X-IP-Hash': ip }) });
  for (let i = 0; i < 12; i += 1) {
    assert.equal((await hub.fetch(request('busy'))).status, 200);
  }
  assert.equal((await hub.fetch(request('busy'))).status, 429);
  assert.equal((await hub.fetch(request('quiet'))).status, 200);
});

test('the queue survives an eviction but drops sockets that are gone', async () => {
  const { hub, env } = await createLobby();
  const a = await open(hub, 'ip-a');
  await a.send('lobby_hello', { nickname: 'Ann' });
  await a.send('lobby_queue', { control: '10+0' });
  assert.equal((await hub.store.getQueue()).length, 1);

  const revived = new LobbyHub(hub.ctx, env);
  await hub.ctx.ready;
  assert.equal((await revived.store.getQueue()).length, 1, 'a live socket keeps its queue slot');

  a.ws.closed = true;
  const again = new LobbyHub(hub.ctx, env);
  await hub.ctx.ready;
  assert.equal((await again.store.getQueue()).length, 0);
});

test('a passkey challenge survives the lobby hibernating mid-prompt, and expired ones are swept', async () => {
  const storageMap = new Map();
  const first = new LobbyHub(createCtx(storageMap), createEnv());
  const api = (hub, path, body) => hub.fetch(new MockRequest(`https://lobby.internal${path}`, {
    method: 'POST',
    headers: { Origin: 'https://blendchess.com', 'X-IP-Hash': 'ip-a' },
    body: JSON.stringify(body),
  }));
  // An expired challenge left over from earlier.
  storageMap.set('chal:000000001-old', { kind: 'login', challenge: 'x', expiresAt: 1 });

  const options = await (await api(first, '/api/auth/passkey/login/options', {})).json();
  assert.ok(options.challengeId);
  assert.ok(storageMap.has(`chal:${options.challengeId}`), 'stored, not only in memory');
  assert.ok(!storageMap.has('chal:000000001-old'), 'the expired challenge was swept');

  // The object is evicted and recreated over the same storage while the person uses their passkey.
  const second = new LobbyHub(createCtx(storageMap), createEnv());
  const verify = await api(second, '/api/auth/passkey/login/verify', {
    challengeId: options.challengeId,
    response: { id: 'unknown-credential', response: {} },
  });
  const body = await verify.json();
  assert.equal(body.error, 'PASSKEY_UNKNOWN', 'the challenge was still there; only the credential is unknown');
  assert.ok(!storageMap.has(`chal:${options.challengeId}`), 'used challenges are deleted');
});

test('guests stored on the leaderboard before accounts are not listed, and leave on the next update', async () => {
  const storageMap = new Map([
    ['top', [
      { id: 'old-guest', name: 'OldGuest', rating: 1300, games: 4, wins: 3, losses: 1, draws: 0, provisional: true },
    ]],
    ['stats', { ranked: 1 }],
  ]);
  const hub = new LobbyHub(createCtx(storageMap), createEnv());
  const read = async () => (await hub.fetch(new MockRequest('https://lobby.internal/api/leaderboard?limit=10'))).json();
  assert.deepEqual((await read()).players, []);
  assert.equal((await read()).total, 1);

  const record = { ...logic.newPlayerRecord('Secured'), games: 1, keyHash: 'k' };
  await hub.store.bumpLeaderboard([record]);
  assert.deepEqual(storageMap.get('top').map((entry) => entry.name), ['Secured']);
});

test('a seat revocation the room does not acknowledge is kept and retried until it is', async () => {
  const storageMap = new Map();
  const ctx = createCtx(storageMap);
  const hub = new LobbyHub(ctx, createEnv());
  await ctx.ready;
  const a = await open(hub, 'ip-a');
  const b = await open(hub, 'ip-b');
  await a.send('lobby_hello', { nickname: 'Ann' });
  await b.send('lobby_hello', { nickname: 'Bob' });
  await a.send('lobby_queue', { control: '10+0' });
  await b.send('lobby_queue', { control: '10+0' });
  const roomCode = a.last('match_found').payload.roomCode;
  const annToken = a.last('lobby_ready').payload.token;

  // The room is unreachable when Ann signs her other devices out.
  const revokeCalls = [];
  let healthy = false;
  hub.env.GAME_HUB = {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch(url, init) {
        revokeCalls.push({ room: name, url: String(url), body: JSON.parse(init.body) });
        return healthy ? new MockResponse('{"ok":true,"revoked":true}', { status: 200 }) : new MockResponse('{"error":"busy"}', { status: 503 });
      },
    }),
  };
  const api = (path, token) => hub.fetch(new MockRequest(`https://lobby.internal${path}`, {
    method: 'POST',
    headers: { Origin: 'https://blendchess.com', Authorization: `Bearer ${token}`, 'X-IP-Hash': 'ip-a' },
    body: '{}',
  }));
  const { key } = await (await api('/api/auth/key/create', annToken)).json();
  const login = await hub.fetch(new MockRequest('https://lobby.internal/api/auth/key/login', {
    method: 'POST',
    headers: { Origin: 'https://blendchess.com', 'X-IP-Hash': 'ip-c' },
    body: JSON.stringify({ key }),
  }));
  const secondToken = (await login.json()).token;
  assert.equal((await api('/api/auth/logout-others', secondToken)).status, 200);
  assert.equal(revokeCalls.length, 1);
  assert.equal(revokeCalls[0].room, roomCode);
  assert.equal(storageMap.get('revocations').length, 1, 'the failed revocation is stored');
  assert.ok(ctx.storage.alarmAt - Date.now() <= 15_000, 'and a retry is scheduled');

  // Still failing when the retry comes due: kept. Then the room answers: cleared.
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    clock += 16_000;
    await hub.alarm();
    assert.equal(storageMap.get('revocations').length, 1);
    assert.ok(storageMap.get('revocations')[0].nextAttemptAt > clock, 'the next attempt has a fixed time');
    healthy = true;
    clock += 16_000;
    await hub.alarm();
    assert.deepEqual(storageMap.get('revocations'), []);
  } finally {
    Date.now = realNow;
  }
  assert.deepEqual(revokeCalls.at(-1).body.sessions, revokeCalls[0].body.sessions);
  assert.equal(revokeCalls.at(-1).url, 'https://room.internal/revoke');
});

test('steady lobby traffic cannot postpone a revocation retry or a match tick', async () => {
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  try {
    const ctx = createCtx(new Map());
    const hub = new LobbyHub(ctx, createEnv());
    await ctx.ready;
    // Stand-in for the runtime: an alarm that comes due is cleared and its handler runs.
    const advance = async (ms) => {
      clock += ms;
      if (ctx.storage.alarmAt !== null && ctx.storage.alarmAt <= clock) {
        ctx.storage.alarmAt = null;
        await hub.alarm();
      }
    };
    const pinger = await open(hub, 'ip-p');
    await pinger.send('lobby_hello', { nickname: 'Pinger' });
    const token = pinger.last('lobby_ready').payload.token;
    // Ordinary traffic: a valid message the lobby fully processes (and that changes nothing).
    const chatter = async () => {
      const before = pinger.ws.inbox.length;
      await pinger.send('lobby_hello', { token, nickname: 'Pinger' });
      assert.equal(pinger.ws.inbox[before].type, 'lobby_ready', 'the message was accepted');
    };

    // A match tick: someone waits alone; a message every 2 s must not push the 5 s tick back.
    await pinger.send('lobby_queue', { control: '10+0' });
    const tick = ctx.storage.alarmAt;
    assert.ok(tick <= clock + 5_000);
    await advance(2_000);
    await chatter();
    assert.equal(ctx.storage.alarmAt, tick, 'the match tick stayed put');
    await pinger.send('lobby_cancel', {});
    await advance(4_000);

    // A revocation the room refuses, then a room that recovers at once.
    const calls = [];
    let healthy = false;
    hub.env.GAME_HUB = {
      idFromName: (name) => name,
      get: () => ({
        async fetch() {
          calls.push(clock);
          return healthy ? new MockResponse('{"ok":true}', { status: 200 }) : new MockResponse('{}', { status: 503 });
        },
      }),
    };
    await hub.revokeSeats([{ roomCode: 'ROOM01', sessions: ['session-1'] }]);
    assert.equal(calls.length, 1);
    const retryAt = hub.ctx.storage.alarmAt;
    assert.ok(retryAt <= clock + 15_000);
    healthy = true;

    // Two minutes of a valid message every 10 seconds.
    for (let i = 0; i < 12; i += 1) {
      await advance(10_000);
      await chatter();
      if (i === 0) assert.equal(ctx.storage.alarmAt, retryAt, 'traffic did not move the retry');
    }
    assert.ok(calls.length >= 2, 'the retry ran');
    assert.ok(calls[1] <= retryAt + 10_000, 'on time, not after the traffic stopped');
    assert.equal((await hub.store.read('revocations')).length, 0);
  } finally {
    Date.now = realNow;
  }
});
