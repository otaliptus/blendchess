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
        storageMap.delete(key);
      },
      async deleteAll() {
        storageMap.clear();
      },
      async list(options = {}) {
        const result = new Map();
        for (const [key, value] of storageMap) {
          if (!options.prefix || key.startsWith(options.prefix)) result.set(key, structuredClone(value));
        }
        return result;
      },
      async setAlarm(time) {
        this.alarmAt = time;
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
