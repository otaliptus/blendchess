import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const require = createRequire(import.meta.url);
const PROTOCOL_VERSION = '1.0.0';
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOM_MODULE_PATH = path.resolve(__dirname, '../src/room.js');
const CHESS_CORE_PATH = path.resolve(__dirname, '../src/chess-core.js');

// Load shared IIFE modules via CJS require and bridge to globalThis
await import(CHESS_CORE_PATH);
globalThis.BlendChessProtocol = globalThis.BlendChessProtocol || require('../../shared/protocol.js');
globalThis.BlendChessEngineFacade = globalThis.BlendChessEngineFacade || require('../../shared/engine-facade.js');
globalThis.BlendChessRoomLogic = globalThis.BlendChessRoomLogic || require('../../shared/room-logic.js');

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
    Uint32Array,
    setTimeout,
    clearTimeout,
    setInterval,
    clearInterval,
    WebSocketPair: class WebSocketPair {},
    Response: class Response { constructor(body, init) { this.body = body; this.status = init?.status; } },
  });
  context.globalThis = context;
  context.ChessCore = globalThis.ChessCore;
  context.BlendChessProtocol = globalThis.BlendChessProtocol;
  context.BlendChessEngineFacade = globalThis.BlendChessEngineFacade;
  context.BlendChessRoomLogic = globalThis.BlendChessRoomLogic;

  const module = new vm.SourceTextModule(source, {
    context,
    identifier: ROOM_MODULE_PATH,
  });

  await module.link(async (specifier) => {
    if (specifier === 'cloudflare:workers') {
      return new vm.SyntheticModule(['DurableObject'], function init() {
        this.setExport('DurableObject', class DurableObject {
          constructor(ctx, env) {
            this.ctx = ctx;
            this.env = env;
          }
        });
      }, { context });
    }
    throw new Error(`Unhandled import: ${specifier}`);
  });

  await module.evaluate();
  return module.namespace.GameHub;
}

const GameHub = await loadGameHubClass();

function createStorageContext() {
  const state = new Map();
  return {
    storage: {
      async get(key) {
        return state.get(key);
      },
      async put(key, value) {
        state.set(key, value);
      },
    },
  };
}

function createFakeSocket() {
  return {
    readyState: 1,
    sent: [],
    send(raw) {
      this.sent.push(JSON.parse(String(raw)));
    },
    close() {
      this.readyState = 3;
    },
  };
}

async function createHub() {
  const hub = new GameHub(createStorageContext(), {});
  await hub.ready;
  return hub;
}

function addConnection(hub, id) {
  const ws = createFakeSocket();
  hub.connections.set(id, {
    id,
    ws,
    roomCode: '',
    playerId: '',
    role: 'player',
    color: null,
  });
  return ws;
}

async function sendEnvelope(hub, connectionId, envelope) {
  const message = {
    ...envelope,
    version: PROTOCOL_VERSION,
  };
  await hub.handleMessage(connectionId, JSON.stringify(message));
}

function messageByType(socket, type) {
  return socket.sent.find((message) => message.type === type) || null;
}

test('join room emits player_assigned with resume token', async () => {
  const hub = await createHub();
  const hostSocket = addConnection(hub, 'host-conn');

  await sendEnvelope(hub, 'host-conn', {
    type: 'create_room',
    payload: { nickname: 'Host' },
  });

  const created = messageByType(hostSocket, 'room_created');
  assert.ok(created, 'room_created should be emitted');
  const roomCode = created.payload.roomCode;
  assert.ok(roomCode, 'room code should exist');

  const joinerSocket = addConnection(hub, 'joiner-conn');
  await sendEnvelope(hub, 'joiner-conn', {
    type: 'join_room',
    roomCode,
    payload: { nickname: 'Joiner' },
  });

  const assigned = messageByType(joinerSocket, 'player_assigned');
  assert.ok(assigned, 'player_assigned should be emitted');
  assert.equal(typeof assigned.payload.resumeToken, 'string');
  assert.ok(assigned.payload.resumeToken.length >= 12, 'resumeToken should be non-trivial');
});

test('plain join is rejected when disconnected seat is reserved during active game', async () => {
  const hub = await createHub();
  const hostSocket = addConnection(hub, 'host-conn');
  const guestSocket = addConnection(hub, 'guest-conn');

  await sendEnvelope(hub, 'host-conn', {
    type: 'create_room',
    payload: { nickname: 'Host' },
  });
  const created = messageByType(hostSocket, 'room_created');
  const roomCode = created?.payload?.roomCode;
  assert.ok(roomCode, 'room code should exist');

  await sendEnvelope(hub, 'guest-conn', {
    type: 'join_room',
    roomCode,
    payload: { nickname: 'Guest' },
  });

  await sendEnvelope(hub, 'host-conn', {
    type: 'move_intent',
    roomCode,
    payload: {
      from: { r: 6, c: 4 },
      to: { r: 4, c: 4 },
    },
  });
  assert.ok(messageByType(hostSocket, 'move_applied'), 'host should receive move_applied');

  await hub.handleClose('guest-conn');

  const intruderSocket = addConnection(hub, 'intruder-conn');
  await sendEnvelope(hub, 'intruder-conn', {
    type: 'join_room',
    roomCode,
    payload: { nickname: 'Intruder' },
  });

  const error = messageByType(intruderSocket, 'error');
  assert.ok(error, 'error should be emitted');
  assert.equal(error.payload.errorCode, 'PLAYER_NOT_FOUND');
});

test('resume join reclaims disconnected seat using player id and token', async () => {
  const hub = await createHub();
  const hostSocket = addConnection(hub, 'host-conn');
  const guestSocket = addConnection(hub, 'guest-conn');

  await sendEnvelope(hub, 'host-conn', {
    type: 'create_room',
    payload: { nickname: 'Host' },
  });
  const roomCode = messageByType(hostSocket, 'room_created')?.payload?.roomCode;
  assert.ok(roomCode, 'room code should exist');

  await sendEnvelope(hub, 'guest-conn', {
    type: 'join_room',
    roomCode,
    payload: { nickname: 'Guest' },
  });

  const initialAssigned = messageByType(guestSocket, 'player_assigned');
  assert.ok(initialAssigned, 'initial join should assign player seat');
  const seatPlayerId = initialAssigned.payload.playerId;
  const seatResumeToken = initialAssigned.payload.resumeToken;
  assert.ok(seatPlayerId, 'seat player id should exist');
  assert.ok(seatResumeToken, 'seat resume token should exist');

  await sendEnvelope(hub, 'host-conn', {
    type: 'move_intent',
    roomCode,
    payload: {
      from: { r: 6, c: 4 },
      to: { r: 4, c: 4 },
    },
  });
  await hub.handleClose('guest-conn');

  const resumeSocket = addConnection(hub, 'resume-conn');
  await sendEnvelope(hub, 'resume-conn', {
    type: 'join_room',
    roomCode,
    playerId: seatPlayerId,
    payload: {
      nickname: 'Guest',
      resume: true,
      resumeToken: seatResumeToken,
    },
  });

  const resumedAssigned = messageByType(resumeSocket, 'player_assigned');
  assert.ok(resumedAssigned, 'resumed player should receive player_assigned');
  assert.equal(resumedAssigned.payload.playerId, seatPlayerId, 'resume should reclaim prior seat id');
  assert.equal(typeof resumedAssigned.payload.resumeToken, 'string');
  assert.ok(resumedAssigned.payload.resumeToken.length >= 12, 'resume should issue/confirm token');
  assert.equal(messageByType(resumeSocket, 'error'), null, 'resume should not emit error');
});
