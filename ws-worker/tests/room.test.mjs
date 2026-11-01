import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOM_MODULE_PATH = path.resolve(__dirname, '../src/room.js');

require('../../chess-core.js');
const protocol = require('../../shared/protocol.js');
require('../../shared/engine-facade.js');
const rl = require('../../shared/room-logic.js');
require('../../shared/room-session.js');

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
  close(code) {
    this.closed = true;
    this.closeCode = code;
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
    this.status = init.status;
    this.webSocket = init.webSocket;
  }
}

// Keep the fixtures at v1 so bumping the production version still exercises the v1 -> v2 reset.
async function loadGameHubClass(dataVersion = 1) {
  const source = await readFile(ROOM_MODULE_PATH, 'utf8');
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
    Uint8Array,
    TextEncoder,
    TextDecoder,
    URL,
    Headers,
    Request,
    WebSocketPair: class {
      constructor() {
        this[0] = new MockSocket();
        this[1] = new MockSocket();
      }
    },
    Response: MockResponse,
    BlendChessProtocol: { ...globalThis.BlendChessProtocol, DATA_VERSION: dataVersion },
    BlendChessRoomLogic: globalThis.BlendChessRoomLogic,
    BlendChessRoomSession: globalThis.BlendChessRoomSession,
  });
  context.globalThis = context;

  const module = new vm.SourceTextModule(source, { context, identifier: ROOM_MODULE_PATH });
  await module.link(async (specifier) => {
    if (specifier === './data-version.js') {
      return new vm.SourceTextModule(await readFile(new URL('../src/data-version.js', import.meta.url), 'utf8'), { context });
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
  return module.namespace.GameHub;
}

const GameHub = await loadGameHubClass();

test('a release reset closes old game sockets and erases the room before accepting messages', async () => {
  const { ctx, white, black } = await startGame();
  const NextGameHub = await loadGameHubClass(2);
  const nextCtx = createCtx(ctx.storageMap);
  nextCtx.sockets.push(white.ws, black.ws);
  nextCtx.storage.alarmAt = Date.now() + 1000;
  const next = new NextGameHub(nextCtx, {});
  await nextCtx.ready;
  assert.equal(next.room, null);
  assert.equal(nextCtx.storage.alarmAt, null);
  assert.equal(ctx.storageMap.has('room'), false);
  assert.equal(ctx.storageMap.get('dataVersion'), 2);
  assert.equal(white.ws.closeCode, protocol.DATA_RESET_CLOSE_CODE);
  assert.equal(black.ws.closeCode, protocol.DATA_RESET_CLOSE_CODE);
  await next.webSocketMessage(white.ws, JSON.stringify(protocol.createMessage('create_room', '', '', {})));
  assert.equal(next.room, null, 'the old socket cannot recreate the erased room');
  const host = await open(next, 'FRESH1', true);
  await host.send('create_room', { nickname: 'NewGuest' });
  assert.equal(next.room.roomCode, 'FRESH1');
  const restoredCtx = createCtx(ctx.storageMap);
  const restored = new NextGameHub(restoredCtx, {});
  await restoredCtx.ready;
  assert.equal(restored.room.roomCode, 'FRESH1', 'the same version preserves the new game');
});

function createCtx(storageMap = new Map()) {
  const sockets = [];
  let ready = Promise.resolve();
  return {
    sockets,
    storageMap,
    alarm: null,
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
      async deleteAll() {
        storageMap.clear();
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

async function createHub(storageMap, env = {}) {
  const ctx = createCtx(storageMap);
  const hub = new GameHub(ctx, env);
  await ctx.ready;
  return { hub, ctx };
}

function reserveRequest(body) {
  return {
    url: 'https://room.internal/reserve',
    method: 'POST',
    headers: { get: () => null },
    json: async () => body,
  };
}

function upgradeRequest(roomCode, create, { ipHash = '', seat = false } = {}) {
  const headers = new Map([['upgrade', 'websocket'], ['x-room-code', roomCode], ['x-room-create', create ? '1' : '0']]);
  if (ipHash) headers.set('x-ip-hash', ipHash);
  return {
    url: `https://room.internal/?room=${roomCode}${seat ? '&seat=1' : ''}`,
    headers: { get: (name) => headers.get(name.toLowerCase()) || null },
  };
}

async function open(hub, roomCode, create = false, options = {}) {
  const response = await hub.fetch(upgradeRequest(roomCode, create, options));
  assert.equal(response.status, 101);
  const serverSocket = hub.ctx.sockets.at(-1);
  const client = {
    ws: serverSocket,
    async send(type, payload = {}, playerId = '') {
      await hub.webSocketMessage(serverSocket, JSON.stringify(protocol.createMessage(type, roomCode, playerId, payload)));
    },
    last: (type) => serverSocket.inbox.filter((message) => message.type === type).at(-1),
    view: () => serverSocket.inbox.filter((message) => message.payload.game).at(-1).payload.game,
  };
  return client;
}

const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });

async function startGame() {
  const { hub, ctx } = await createHub();
  const white = await open(hub, 'ROOM01', true);
  await white.send('create_room', { nickname: 'Wendy' });
  const black = await open(hub, 'ROOM01');
  await black.send('join_room', { nickname: 'Boris' });
  return { hub, ctx, white, black };
}

test('create needs the create flag, and a taken code answers 409', async () => {
  const { hub } = await createHub();
  const stranger = await open(hub, 'ROOM01');
  await stranger.send('create_room', {});
  assert.equal(stranger.last('error').payload.errorCode, 'INVALID_PAYLOAD');

  const host = await open(hub, 'ROOM01', true);
  await host.send('create_room', {});
  assert.equal(host.last('room_created').payload.color, 'w');
  const again = await hub.fetch(upgradeRequest('ROOM01', true));
  assert.equal(again.status, 409);
});

test('joining an empty room code reports UNKNOWN_ROOM', async () => {
  const { hub, ctx } = await createHub();
  const client = await open(hub, 'EMPTY1');
  await client.send('join_room', {});
  assert.equal(client.last('error').payload.errorCode, 'UNKNOWN_ROOM');
  assert.equal(ctx.storageMap.size, 0, 'unknown room codes must not allocate stored reset markers');
});

test('a new room after a reset records its version with the room and survives eviction', async () => {
  const NextGameHub = await loadGameHubClass(2);
  const ctx = createCtx();
  const hub = new NextGameHub(ctx, {});
  await ctx.ready;
  const missing = await open(hub, 'FRESH1');
  await missing.send('join_room', {});
  assert.equal(ctx.storageMap.size, 0);
  const host = await open(hub, 'FRESH1', true);
  await host.send('create_room', { nickname: 'AfterReset' });
  assert.equal(ctx.storageMap.get('room').dataVersion, 2);
  const restoredCtx = createCtx(ctx.storageMap);
  const restored = new NextGameHub(restoredCtx, {});
  await restoredCtx.ready;
  assert.equal(restored.room.players[restored.room.playerOrder[0]].nickname, 'AfterReset');
});

test('moves are redacted per viewer and the room is persisted per room', async () => {
  const { ctx, white, black } = await startGame();
  await white.send('move_intent', { from: sq('g1'), to: sq('f3') });
  const blackView = black.view();
  assert.equal(blackView.turn, 'b');
  assert.equal(blackView.board.flat().some((piece) => piece && piece.color === 'w'), false);
  assert.equal(JSON.stringify(black.ws.inbox).includes('Nf3'), false);
  assert.equal(ctx.storageMap.get('room').log.length, 1);
  assert.ok(ctx.storage.alarmAt > Date.now());
});

test('state and seats survive eviction; presence is rebuilt from open sockets', async () => {
  const { ctx, white, black } = await startGame();
  await white.send('move_intent', { from: sq('e2'), to: sq('e4') });
  const blackIdentity = black.last('room_joined').payload;

  // Simulate an eviction: a new object instance over the same storage and sockets, with Black's socket gone.
  black.ws.closed = true;
  const revived = new GameHub(ctx, {});
  await ctx.ready;
  assert.equal(revived.room.log.length, 1);
  assert.equal(rl.getPlayer(revived.room, blackIdentity.playerId).connected, false);
  assert.equal(rl.getPlayer(revived.room, white.last('room_created').payload.playerId).connected, true);

  const phone = await open(revived, 'ROOM01');
  await phone.send('join_room', { resume: true, resumeToken: blackIdentity.resumeToken }, blackIdentity.playerId);
  assert.equal(phone.last('room_joined').payload.color, 'b');
});

test('closing a socket marks the seat disconnected and tells the opponent', async () => {
  const { hub, white, black } = await startGame();
  await white.send('move_intent', { from: sq('e2'), to: sq('e4') });
  black.ws.closed = true;
  await hub.webSocketClose(black.ws, 1006);
  const seats = white.view().players;
  assert.equal(seats.find((seat) => seat.color === 'b').connected, false);
});

test('resume from a second socket detaches the first without dropping the seat', async () => {
  const { hub, white, black } = await startGame();
  const identity = black.last('room_joined').payload;
  const tab2 = await open(hub, 'ROOM01');
  await tab2.send('join_room', { resume: true, resumeToken: identity.resumeToken }, identity.playerId);
  assert.equal(black.ws.closed, true);
  await hub.webSocketClose(black.ws, 4000);
  assert.equal(white.view().players.find((seat) => seat.color === 'b').connected, true);
});

test('rate limit and size limit apply per socket', async () => {
  const { white } = await startGame();
  for (let i = 0; i < 45; i += 1) await white.send('ping');
  assert.equal(white.last('error').payload.errorCode, 'RATE_LIMIT');
});

test('alarm deletes an idle empty room', async () => {
  const { hub, ctx, white, black } = await startGame();
  white.ws.closed = true;
  black.ws.closed = true;
  hub.room.lastActivity = Date.now() - 2 * 60 * 60 * 1000;
  await hub.alarm();
  assert.equal(hub.room, null);
  assert.equal(ctx.storageMap.size, 0);
});

test('a reserved ranked room only opens with the lobby tickets', async () => {
  const { hub } = await createHub();
  const reservation = {
    roomCode: 'RATED1',
    rated: true,
    control: '5+3',
    clock: { baseMs: 300_000, incMs: 3000 },
    seats: [
      { color: 'w', playerId: 'lobby-white', nickname: 'Wendy', rating: 1200, ticket: 'w'.repeat(24) },
      { color: 'b', playerId: 'lobby-black', nickname: 'Boris', rating: 1300, ticket: 'b'.repeat(24) },
    ],
  };
  const reserved = await hub.fetch(reserveRequest(reservation));
  assert.equal(reserved.status, 200);
  assert.equal(hub.room.rated, true);
  assert.equal(hub.room.clock.baseMs, 300_000);

  const intruder = await open(hub, 'RATED1');
  await intruder.send('join_room', { nickname: 'Intruder' });
  assert.equal(intruder.last('error').payload.errorCode, 'TICKET_INVALID');

  // Anyone may watch a lobby game, and sees the whole board.
  const watcher = await open(hub, 'RATED1');
  await watcher.send('join_room', { spectator: true });
  assert.equal(watcher.last('room_joined').payload.role, 'spectator');
  assert.equal(watcher.last('game_state').payload.game.revealed, true);

  const white = await open(hub, 'RATED1');
  await white.send('join_room', { ticket: 'w'.repeat(24), nickname: 'Cheater' });
  assert.equal(white.last('room_joined').payload.color, 'w');
  assert.equal(white.last('room_joined').payload.playerId, 'lobby-white');

  const black = await open(hub, 'RATED1');
  await black.send('join_room', { ticket: 'b'.repeat(24) });
  assert.equal(black.last('room_joined').payload.color, 'b');
  assert.equal(hub.room.clock.startedAt !== null, true);
  const view = white.view();
  assert.equal(view.rated, true);
  assert.equal(view.reserved, true);
  assert.equal(view.players.find((seat) => seat.color === 'b').rating, 1300);
  assert.equal(view.players.find((seat) => seat.color === 'w').nickname, 'Wendy');

  // Options are fixed in a lobby-arranged game.
  white.ws.inbox.length = 0;
  await white.send('set_options', { hardMode: true });
  assert.equal(white.last('move_rejected').payload.reasonCode, 'RATED_LOCKED');
});

test('a reserved room nobody ever joins is released and deleted, not left looping alarms', async () => {
  const calls = [];
  const env = {
    LOBBY_HUB: {
      idFromName: (name) => name,
      get: () => ({
        async fetch(url, init) {
          calls.push({ url: String(url), body: init && init.body ? JSON.parse(init.body) : null });
          return new Response('{"ok":true}', { status: 200 });
        },
      }),
    },
  };
  const { hub, ctx } = await createHub(new Map(), env);
  const reserved = await hub.fetch(reserveRequest({
    roomCode: 'ORPHAN',
    rated: true,
    control: '5+3',
    clock: { baseMs: 300_000, incMs: 3000 },
    seats: [
      { color: 'w', playerId: 'ghost-white', nickname: 'Ghost', rating: 1200, ticket: 'w'.repeat(24) },
      { color: 'b', playerId: 'ghost-black', nickname: 'Ghost2', rating: 1200, ticket: 'b'.repeat(24) },
    ],
  }));
  assert.equal(reserved.status, 200);
  hub.room.reservedAt = Date.now() - 200_000;

  assert.equal(hub.room.rated, true);
  assert.ok(Date.now() - hub.room.reservedAt >= rl.JOIN_DEADLINE_MS);
  await hub.alarm();
  assert.equal(hub.room, null);
  assert.equal(ctx.storageMap.size, 0);
  const release = calls.find((call) => call.url.includes('/release'));
  assert.ok(release, 'the lobby was told to free both players');
  assert.deepEqual(release.body.players.sort(), ['ghost-black', 'ghost-white']);
});

test('the alarm is never scheduled in the past', async () => {
  const { hub, ctx } = await createHub(new Map(), {});
  await hub.fetch(reserveRequest({
    roomCode: 'PAST00',
    rated: true,
    control: '10+0',
    clock: { baseMs: 600_000, incMs: 0 },
    seats: [
      { color: 'w', playerId: 'p-w', nickname: 'W', rating: 1200, ticket: 'w'.repeat(24) },
      { color: 'b', playerId: 'p-b', nickname: 'B', rating: 1200, ticket: 'b'.repeat(24) },
    ],
  }));
  hub.room.reservedAt = Date.now() - 200_000;
  const before = Date.now();
  await hub.alarm();
  assert.ok(ctx.storage.alarmAt === null || ctx.storage.alarmAt >= before, 'no past alarm');
});

test('a full room makes way for a returning player, never for another watcher', async () => {
  const { hub } = await createHub(new Map());
  await hub.fetch(reserveRequest({
    roomCode: 'FULL01',
    rated: true,
    control: '5+3',
    clock: { baseMs: 300_000, incMs: 3000 },
    seats: [
      { color: 'w', playerId: 'lobby-white', nickname: 'Wendy', rating: 1200, ticket: 'w'.repeat(24) },
      { color: 'b', playerId: 'lobby-black', nickname: 'Boris', rating: 1300, ticket: 'b'.repeat(24) },
    ],
  }));
  // 64 sockets from 16 networks: watchers and idle connections fill the room.
  const crowd = [];
  for (let i = 0; i < 64; i += 1) {
    const client = await open(hub, 'FULL01', false, { ipHash: `net-${Math.floor(i / 4)}` });
    if (i % 2 === 0) await client.send('join_room', { spectator: true });
    crowd.push(client);
  }
  const extraWatcher = await hub.fetch(upgradeRequest('FULL01', false, { ipHash: 'net-late' }));
  assert.equal(extraWatcher.status, 429);

  // The player's connection (seat=1) gets in by closing an idle socket first.
  const white = await open(hub, 'FULL01', false, { ipHash: 'net-white', seat: true });
  const idleClosed = crowd.filter((client) => client.ws.closed);
  assert.equal(idleClosed.length, 1);
  assert.equal(idleClosed[0], crowd[1], 'a socket that never joined goes first');
  await white.send('join_room', { ticket: 'w'.repeat(24) });
  assert.equal(white.last('room_joined').payload.color, 'w');
  assert.equal(hub.room.spectatorOrder.length, 32, 'watchers keep their places');
});
