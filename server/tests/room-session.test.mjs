import test from 'node:test';
import assert from 'node:assert/strict';
import { protocol, rl, session } from '../shared.js';

const { TYPES, ERROR_CODES, createMessage } = protocol;
const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });

function createHarness() {
  const state = rl.createRoomState('ROOM01');
  const conns = [];
  let tokens = 0;
  const hooks = {
    connections: () => conns.filter((conn) => !conn.closed),
    send: (conn, message) => conn.inbox.push(message),
    close: (conn) => { conn.closed = true; },
    save: () => {},
    makeResumeToken: () => `token-${tokens += 1}`,
  };
  const connect = (id) => {
    const conn = { id, role: null, playerId: '', inbox: [] };
    conns.push(conn);
    return conn;
  };
  const envelope = (type, payload = {}, playerId = '') => createMessage(type, 'ROOM01', playerId, payload);
  const lastView = (conn) => conn.inbox.filter((message) => message.payload.game).at(-1).payload.game;
  return { state, hooks, connect, envelope, lastView };
}

function startGame() {
  const h = createHarness();
  const white = h.connect('w-conn');
  const black = h.connect('b-conn');
  session.createRoom(h.state, h.hooks, white, { nickname: 'Wendy' });
  session.joinRoom(h.state, h.hooks, black, h.envelope(TYPES.JOIN_ROOM, { nickname: 'Boris' }));
  return { ...h, white, black };
}

test('create and join hand out identities and per-viewer views', () => {
  const { white, black, lastView } = startGame();
  assert.equal(white.inbox[0].type, TYPES.ROOM_CREATED);
  assert.equal(white.inbox[0].payload.color, 'w');
  const joined = black.inbox.find((message) => message.type === TYPES.ROOM_JOINED);
  assert.equal(joined.payload.color, 'b');
  assert.ok(joined.payload.resumeToken);
  assert.equal(lastView(black).you.color, 'b');
  assert.equal(lastView(white).waitingForStart, false);
});

test('a move never reaches the opponent in readable form', () => {
  const { state, hooks, white, black, envelope } = startGame();
  black.inbox.length = 0;
  session.handleMessage(state, hooks, white, envelope(TYPES.MOVE_INTENT, { from: sq('g1'), to: sq('f3') }));
  const wire = JSON.stringify(black.inbox);
  assert.equal(wire.includes('Nf3'), false);
  assert.equal(wire.includes('"r":5,"c":5'), false);
  const view = black.inbox.at(-1).payload.game;
  assert.equal(view.board.flat().some((piece) => piece && piece.color === 'w'), false);
  assert.equal(view.turn, 'b');
});

test('illegal attempt: mover gets move_rejected, opponent only hears the umpire', () => {
  const { state, hooks, white, black, envelope } = startGame();
  black.inbox.length = 0;
  session.handleMessage(state, hooks, white, envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e5') }));
  const rejected = white.inbox.at(-1);
  assert.equal(rejected.type, TYPES.MOVE_REJECTED);
  assert.equal(rejected.payload.reasonCode, ERROR_CODES.ILLEGAL_MOVE);
  const event = black.inbox.at(-1).payload.game.events.at(-1);
  assert.equal(event.kind, 'illegal');
  assert.equal(JSON.stringify(black.inbox).includes('e5'), false);
});

test('fog spectators see no pieces; a player cannot also spectate on the same socket', () => {
  const { state, hooks, connect, white, envelope, lastView } = startGame();
  const watcher = connect('spec');
  session.joinRoom(state, hooks, watcher, envelope(TYPES.JOIN_ROOM, { spectator: true }));
  assert.equal(lastView(watcher).board.flat().some(Boolean), false);
  assert.equal(lastView(white).spectatorCount, 1);

  session.joinRoom(state, hooks, white, envelope(TYPES.JOIN_ROOM, { spectator: true }));
  assert.equal(white.inbox.at(-1).type, TYPES.ERROR);
});

test('resume detaches the stale socket and reclaims the seat', () => {
  const { state, hooks, connect, white, black, envelope } = startGame();
  session.handleMessage(state, hooks, white, envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  const joined = black.inbox.find((message) => message.type === TYPES.ROOM_JOINED).payload;

  const intruder = connect('intruder');
  session.handleClose(state, hooks, black);
  assert.equal(session.joinRoom(state, hooks, intruder, envelope(TYPES.JOIN_ROOM, {})), false);
  assert.equal(intruder.inbox.at(-1).payload.errorCode, ERROR_CODES.PLAYER_NOT_FOUND);

  const phone = connect('phone');
  const ok = session.joinRoom(state, hooks, phone, envelope(TYPES.JOIN_ROOM, { resume: true, resumeToken: joined.resumeToken }, joined.playerId));
  assert.equal(ok, true);
  assert.equal(phone.playerId, joined.playerId);
  assert.equal(rl.getPlayer(state, joined.playerId).connected, true);
});

test('resume with a live old socket closes it without dropping the seat', () => {
  const { state, hooks, connect, black, envelope } = startGame();
  const joined = black.inbox.find((message) => message.type === TYPES.ROOM_JOINED).payload;
  const tab2 = connect('tab2');
  session.joinRoom(state, hooks, tab2, envelope(TYPES.JOIN_ROOM, { resume: true, resumeToken: joined.resumeToken }, joined.playerId));
  assert.equal(black.closed, true);
  assert.equal(black.role, null);
  assert.equal(session.handleClose(state, hooks, black), false);
  assert.equal(rl.getPlayer(state, joined.playerId).connected, true);
});

test('options and new game errors come back as move_rejected with a reason', () => {
  const { state, hooks, white, black, envelope } = startGame();
  session.handleMessage(state, hooks, white, envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  session.handleMessage(state, hooks, black, envelope(TYPES.SET_OPTIONS, { hardMode: true }));
  assert.equal(black.inbox.at(-1).type, TYPES.MOVE_REJECTED);
  assert.equal(black.inbox.at(-1).payload.reasonCode, ERROR_CODES.GAME_IN_PROGRESS);
  session.handleMessage(state, hooks, white, envelope(TYPES.NEW_GAME));
  assert.equal(white.inbox.at(-1).payload.reasonCode, ERROR_CODES.GAME_IN_PROGRESS);
});

test('draw offer is broadcast once; repeated offers are ignored', () => {
  const { state, hooks, white, black, envelope, lastView } = startGame();
  assert.equal(session.handleMessage(state, hooks, white, envelope(TYPES.CLAIM_DRAW)), true);
  assert.equal(lastView(black).drawOffer, 'w');
  const before = black.inbox.length;
  assert.equal(session.handleMessage(state, hooks, white, envelope(TYPES.CLAIM_DRAW)), false);
  assert.equal(black.inbox.length, before);
});
