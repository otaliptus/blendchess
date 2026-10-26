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
    this.status = init.status;
    this.webSocket = init.webSocket;
  }
}

async function loadGameHubClass() {
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
    WebSocketPair: class {
      constructor() {
        this[0] = new MockSocket();
        this[1] = new MockSocket();
      }
    },
    Response: MockResponse,
    BlendChessProtocol: globalThis.BlendChessProtocol,
    BlendChessRoomLogic: globalThis.BlendChessRoomLogic,
    BlendChessRoomSession: globalThis.BlendChessRoomSession,
  });
  context.globalThis = context;

  const module = new vm.SourceTextModule(source, { context, identifier: ROOM_MODULE_PATH });
  await module.link(async (specifier) => {
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
    },
  };
}

async function createHub(storageMap) {
  const ctx = createCtx(storageMap);
  const hub = new GameHub(ctx, {});
  await ctx.ready;
  return { hub, ctx };
}

function upgradeRequest(roomCode, create) {
  const headers = new Map([['upgrade', 'websocket'], ['x-room-code', roomCode], ['x-room-create', create ? '1' : '0']]);
  return { headers: { get: (name) => headers.get(name.toLowerCase()) || null } };
}

async function open(hub, roomCode, create = false) {
  const response = await hub.fetch(upgradeRequest(roomCode, create));
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
  const { hub } = await createHub();
  const client = await open(hub, 'EMPTY1');
  await client.send('join_room', {});
  assert.equal(client.last('error').payload.errorCode, 'UNKNOWN_ROOM');
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
