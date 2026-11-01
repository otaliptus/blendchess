import test from 'node:test';
import assert from 'node:assert/strict';
import { protocol, rl, session } from '../shared.js';

const { TYPES, ERROR_CODES, createMessage } = protocol;
const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });
const WHITE_TICKET = 'w'.repeat(24);
const BLACK_TICKET = 'b'.repeat(24);

function createRatedHarness({ rated = true, clock = true, whiteNet = 'net-white', blackNet = 'net-black' } = {}) {
  const state = rl.createRoomState('RATED1');
  rl.applyReservation(state, {
    rated,
    control: '5+3',
    clock: clock ? { baseMs: 300_000, incMs: 3_000 } : null,
    seats: [
      { color: 'w', playerId: 'player-white', nickname: 'Wendy', rating: 1200, ticket: WHITE_TICKET, ipHash: whiteNet },
      { color: 'b', playerId: 'player-black', nickname: 'Boris', rating: 1250, ticket: BLACK_TICKET, ipHash: blackNet },
    ],
  });
  const conns = [];
  let tokens = 0;
  const hooks = {
    connections: () => conns.filter((conn) => !conn.closed),
    send: (conn, message) => conn.inbox.push(message),
    close: (conn) => { conn.closed = true; },
    save: () => {},
    makeResumeToken: () => `token-${tokens += 1}`,
  };
  const connect = (id, ipHash = '') => {
    const conn = { id, role: null, playerId: '', ipHash, inbox: [] };
    conns.push(conn);
    return conn;
  };
  const envelope = (type, payload = {}, playerId = '') => createMessage(type, 'RATED1', playerId, payload);
  const lastView = (conn) => conn.inbox.filter((message) => message.payload.game).at(-1).payload.game;
  const lastError = (conn) => conn.inbox.filter((message) => message.type === TYPES.ERROR).at(-1);
  return { state, hooks, connect, envelope, lastView, lastError };
}

function seatBoth(h, { whiteTicket = WHITE_TICKET, blackTicket = BLACK_TICKET } = {}) {
  const white = h.connect('conn-w');
  const black = h.connect('conn-b');
  session.joinRoom(h.state, h.hooks, white, h.envelope(TYPES.JOIN_ROOM, { ticket: whiteTicket }));
  session.joinRoom(h.state, h.hooks, black, h.envelope(TYPES.JOIN_ROOM, { ticket: blackTicket }));
  return { white, black };
}

test('a reserved seat needs its ticket and keeps its colour; watching needs nothing', () => {
  const h = createRatedHarness();
  const white = h.connect('conn-w');

  // Watching first, then taking the reserved seat with the ticket, moves the socket to the seat.
  session.joinRoom(h.state, h.hooks, white, h.envelope(TYPES.JOIN_ROOM, { spectator: true }));
  assert.equal(white.inbox.find((message) => message.type === TYPES.ROOM_JOINED).payload.role, 'spectator');

  const noTicket = h.connect('conn-x');
  session.joinRoom(h.state, h.hooks, noTicket, h.envelope(TYPES.JOIN_ROOM, { nickname: 'Intruder' }));
  assert.equal(h.lastError(noTicket).payload.errorCode, ERROR_CODES.TICKET_INVALID);

  const wrongTicket = h.connect('conn-y');
  session.joinRoom(h.state, h.hooks, wrongTicket, h.envelope(TYPES.JOIN_ROOM, { ticket: 'z'.repeat(24) }));
  assert.equal(h.lastError(wrongTicket).payload.errorCode, ERROR_CODES.TICKET_INVALID);

  // A valid ticket wins even if the client asks for another nickname or colour.
  session.joinRoom(h.state, h.hooks, white, h.envelope(TYPES.JOIN_ROOM, { ticket: WHITE_TICKET, nickname: 'Imposter' }));
  const joined = white.inbox.filter((message) => message.type === TYPES.ROOM_JOINED).at(-1);
  assert.equal(joined.payload.color, 'w');
  assert.equal(joined.payload.playerId, 'player-white');
  assert.equal(rl.getPlayer(h.state, 'player-white').nickname, 'Wendy');
  assert.equal(h.state.spectatorOrder.length, 0, 'the seat replaced the spectator entry');
});

test('watchers of a lobby game see the whole board live', () => {
  const h = createRatedHarness();
  const { white } = seatBoth(h);
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  const watcher = h.connect('conn-watch', 'net-elsewhere');
  assert.equal(session.joinRoom(h.state, h.hooks, watcher, h.envelope(TYPES.JOIN_ROOM, { spectator: true, nickname: 'Fan' })), true);
  const view = h.lastView(watcher);
  assert.equal(view.you.role, 'spectator');
  assert.equal(view.you.perspective, null);
  assert.equal(view.revealed, true);
  assert.equal(view.board.flat().filter(Boolean).length, 32, 'both armies are visible');
  assert.equal(view.moves[0].san, 'e4');

  // Watchers cannot act.
  session.handleMessage(h.state, h.hooks, watcher, h.envelope(TYPES.RESIGN));
  assert.equal(h.lastError(watcher).payload.errorCode, ERROR_CODES.WRONG_COLOR);
});

test("a watcher on a ranked player's own network sees the whole board too: players are trusted", () => {
  const h = createRatedHarness();
  const { white } = seatBoth(h);
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));

  const sameAsBlack = h.connect('conn-peek', 'net-black');
  session.joinRoom(h.state, h.hooks, sameAsBlack, h.envelope(TYPES.JOIN_ROOM, { spectator: true }));
  const view = h.lastView(sameAsBlack);
  assert.equal(view.you.role, 'spectator');
  assert.equal(view.you.perspective, null);
  assert.equal(view.revealed, true);
  assert.equal(view.board.flat().filter(Boolean).length, 32);
  assert.equal(view.moves[0].san, 'e4');
  assert.deepEqual(h.state.seatNetworks, {}, 'no player networks are collected');
});

test('practice games have nothing at stake: every watcher sees the full board', () => {
  const h = createRatedHarness({ rated: false, whiteNet: 'net-home', blackNet: 'net-home' });
  seatBoth(h);
  const watcher = h.connect('conn-watch', 'net-home');
  session.joinRoom(h.state, h.hooks, watcher, h.envelope(TYPES.JOIN_ROOM, { spectator: true }));
  assert.equal(h.lastView(watcher).you.perspective, null);
  assert.equal(h.lastView(watcher).revealed, true);
});

test('the game record keeps every ply in compact form', () => {
  const h = createRatedHarness();
  const { white, black } = seatBoth(h);
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  session.handleMessage(h.state, h.hooks, black, h.envelope(TYPES.MOVE_INTENT, { from: sq('d7'), to: sq('d5') }));
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e4'), to: sq('d5') }));
  const record = rl.gameRecord(h.state);
  assert.ok(record.startedAt > 0);
  assert.deepEqual(record.plies, [
    ['e2', 'e4', 'e4', '', '', 0],
    ['d7', 'd5', 'd5', '', '', 0],
    ['e4', 'd5', 'exd5', '', 'd5', 0],
  ]);
});

test('both reserved players seat; the clock starts and appears in the view', () => {
  const h = createRatedHarness();
  const { white, black } = seatBoth(h);
  assert.equal(rl.isReady(h.state), true);
  assert.ok(h.state.clock.startedAt);
  const view = h.lastView(black);
  assert.equal(view.rated, true);
  assert.equal(view.reserved, true);
  assert.equal(view.control, '5+3');
  assert.equal(view.clock.baseMs, 300_000);
  assert.equal(view.clock.incMs, 3_000);
  assert.equal(view.clock.running, true);
  assert.equal(view.players.find((seat) => seat.color === 'w').rating, 1200);
  assert.equal(view.you.color, 'b');
});

test('moves earn the increment and the opponent clock keeps ticking', () => {
  const h = createRatedHarness();
  const { white } = seatBoth(h);
  h.state.clock.lastTick = Date.now();
  h.state.clock.w = 300_000;
  h.state.clock.b = 300_000;

  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  assert.equal(h.state.turn, 'b');
  assert.ok(h.state.clock.w > 300_000, 'a played move earns the increment');
  assert.ok(h.state.clock.w <= 303_000);
  assert.equal(h.state.clock.b, 300_000);
});

test('a clock that runs out ends the game for the side to move', () => {
  const h = createRatedHarness();
  const { white } = seatBoth(h);
  h.state.clock.w = 50;
  h.state.clock.lastTick = Date.now() - 1000;

  const result = rl.applyMove(h.state, rl.getPlayer(h.state, 'player-white'), { from: sq('e2'), to: sq('e4') });
  assert.equal(result.timedOut, true);
  assert.equal(h.state.gameOver, true);
  assert.equal(h.state.result, 'timeout');
  assert.equal(h.state.winner, 'Black');
  assert.equal(h.state.clock.w, 0);
  assert.equal(h.state.log.length, 0, 'the late move is not played');
  assert.equal(rl.createView(h.state, { role: 'player', color: 'b' }).gameOver, true);
  assert.ok(white);
});

test('a reserved player who never shows up is a no contest, not a rated win', () => {
  const h = createRatedHarness();
  const white = h.connect('conn-w');
  session.joinRoom(h.state, h.hooks, white, h.envelope(TYPES.JOIN_ROOM, { ticket: WHITE_TICKET }));
  h.state.reservedAt = Date.now() - rl.JOIN_DEADLINE_MS - 1000;
  assert.equal(rl.isReady(h.state), false);

  rl.finishByAbandon(h.state);
  assert.equal(h.state.gameOver, true);
  assert.equal(h.state.result, 'abandon');
  assert.equal(h.state.noContest, true);
  assert.equal(h.state.winner, null, 'no rating points for an opponent who never arrived');
  assert.ok(white);
});

test('reporting identities come from the reservation even if one seat stayed empty', () => {
  const h = createRatedHarness();
  const white = h.connect('conn-w');
  session.joinRoom(h.state, h.hooks, white, h.envelope(TYPES.JOIN_ROOM, { ticket: WHITE_TICKET }));
  const identities = rl.playerIdentities(h.state);
  assert.deepEqual(identities.map((player) => player.color), ['w', 'b']);
  assert.equal(identities[1].playerId, 'player-black');
  rl.finishByAbandon(h.state);
  assert.equal(h.state.result, 'abandon');
  assert.equal(h.state.noContest, true);
  assert.equal(h.state.winner, null);
  assert.ok(white);
});

test('rated rooms refuse option changes', () => {
  const h = createRatedHarness();
  const { white } = seatBoth(h);
  const player = rl.getPlayer(h.state, 'player-white');
  assert.equal(rl.setOptions(h.state, player, { hardMode: true }).reason, ERROR_CODES.RATED_LOCKED);
  assert.equal(h.state.hardMode, false);
  assert.equal(h.state.spectatorView, 'open');
  assert.equal(rl.setOptions(h.state, player, { spectatorView: 'fog' }).reason, ERROR_CODES.RATED_LOCKED);
  assert.ok(white);
});

test('resume works for a reserved game with the resume token', () => {
  const h = createRatedHarness();
  const { white, black } = seatBoth(h);
  const identity = black.inbox.find((message) => message.type === TYPES.ROOM_JOINED).payload;
  black.closed = true;
  session.handleClose(h.state, h.hooks, black);

  const back = h.connect('conn-back');
  session.joinRoom(h.state, h.hooks, back, h.envelope(TYPES.JOIN_ROOM, { resume: true, resumeToken: identity.resumeToken }, identity.playerId));
  const joined = back.inbox.find((message) => message.type === TYPES.ROOM_JOINED);
  assert.equal(joined.payload.color, 'b');
  assert.equal(rl.getPlayer(h.state, 'player-black').connected, true);
  assert.ok(white);
});

test('a practice game reserved by the lobby still requires tickets and blocks options', () => {
  const h = createRatedHarness({ rated: false });
  const noTicket = h.connect('conn-x');
  session.joinRoom(h.state, h.hooks, noTicket, h.envelope(TYPES.JOIN_ROOM, { nickname: 'Intruder' }));
  assert.equal(h.lastError(noTicket).payload.errorCode, ERROR_CODES.TICKET_INVALID);

  const { white } = seatBoth(h);
  assert.equal(h.state.rated, false);
  assert.equal(h.state.reservedSeats !== null, true);
  const player = rl.getPlayer(h.state, 'player-white');
  assert.equal(rl.setOptions(h.state, player, { hardMode: true }).reason, ERROR_CODES.RATED_LOCKED);
  assert.ok(white);
});

test('a rated rematch needs both players present', () => {
  const h = createRatedHarness();
  const { white, black } = seatBoth(h);
  rl.finishByTimeout(h.state);
  const whitePlayer = rl.getPlayer(h.state, 'player-white');

  h.state.reported = true; // a real room reports before the rematch is allowed
  black.closed = true;
  session.handleClose(h.state, h.hooks, black);
  assert.equal(rl.newGame(h.state, whitePlayer).reason, ERROR_CODES.ROOM_NOT_READY);

  const back = h.connect('conn-back');
  const identity = black.inbox.find((message) => message.type === TYPES.ROOM_JOINED).payload;
  session.joinRoom(h.state, h.hooks, back, h.envelope(TYPES.JOIN_ROOM, { resume: true, resumeToken: identity.resumeToken }, identity.playerId));
  assert.equal(rl.newGame(h.state, whitePlayer).ok, true);
  assert.equal(h.state.gameId, 2);
  assert.equal(h.state.gameOver, false);
  assert.ok(h.state.clock.startedAt);
  assert.ok(white);
});

test('after a rematch the report colours follow the swapped seats', () => {
  const h = createRatedHarness();
  seatBoth(h);
  const whitePlayer = rl.getPlayer(h.state, 'player-white');
  rl.finishByTimeout(h.state);
  h.state.reported = true;
  assert.equal(rl.newGame(h.state, whitePlayer).ok, true);

  const identities = rl.playerIdentities(h.state);
  const byId = Object.fromEntries(identities.map((player) => [player.playerId, player.color]));
  assert.equal(byId['player-white'], 'b');
  assert.equal(byId['player-black'], 'w');
  const seats = rl.getSeatAssignments(h.state);
  assert.equal(seats.find((seat) => seat.playerId === 'player-white').color, 'b');
  assert.equal(seats.find((seat) => seat.playerId === 'player-black').color, 'w');
});

test('the opponent leaving mid-game does not freeze the player who stayed', () => {
  const h = createRatedHarness();
  const { white, black } = seatBoth(h);
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.MOVE_INTENT, { from: sq('e2'), to: sq('e4') }));
  black.closed = true;
  session.handleClose(h.state, h.hooks, black);
  assert.equal(rl.isReady(h.state), false);

  h.state.clock.b = 300_000;
  h.state.clock.lastTick = Date.now();
  const result = rl.applyMove(h.state, rl.getPlayer(h.state, 'player-black'), { from: sq('e7'), to: sq('e5') });
  assert.equal(result.ok, true, 'the remaining player can still move');
  assert.equal(h.state.log.length, 2);
});

test('a draw claim cannot rescue a flag that already fell', () => {
  const h = createRatedHarness();
  seatBoth(h);
  const player = rl.getPlayer(h.state, 'player-white');
  h.state.clock.w = 10;
  h.state.clock.lastTick = Date.now() - 500;

  const result = rl.claimDraw(h.state, player, {});
  assert.equal(result.timedOut, true);
  assert.equal(h.state.result, 'timeout');
  assert.equal(h.state.winner, 'Black');
});

test('PGN names a flag fall as a time forfeit', () => {
  const h = createRatedHarness();
  seatBoth(h);
  h.state.clock.w = 1;
  h.state.clock.lastTick = Date.now() - 10;
  rl.chargeClock(h.state);
  rl.finishByTimeout(h.state);
  const pgn = rl.buildPgn({ moves: [], winner: h.state.winner, gameOver: true, result: h.state.result });
  assert.match(pgn, /\[Termination "time forfeit"\]/);
  assert.match(pgn, /0-1/);
});

test('a practice rematch waits until the finished game is recorded', () => {
  const h = createRatedHarness({ rated: false });
  const { white, black } = seatBoth(h);
  session.handleMessage(h.state, h.hooks, white, h.envelope(TYPES.RESIGN));
  assert.equal(h.state.gameOver, true);
  const blackPlayer = rl.getPlayer(h.state, 'player-black');
  assert.equal(rl.newGame(h.state, blackPlayer).reason, ERROR_CODES.ROOM_NOT_READY, 'not before the report lands');
  h.state.reported = true;
  assert.equal(rl.newGame(h.state, blackPlayer).ok, true);
  assert.equal(h.state.gameId, 2);
  assert.ok(black);
});
