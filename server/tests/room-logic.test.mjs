import test from 'node:test';
import assert from 'node:assert/strict';
import { core, protocol, rl } from '../shared.js';

const { ERROR_CODES } = protocol;
const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });
let tokenCounter = 0;
const token = () => `token-${tokenCounter += 1}`;

function createReadyRoom(options = {}) {
  const state = rl.createRoomState('ROOM01', options);
  rl.assignPlayer(state, 'white-player', 'Wendy', token);
  rl.assignPlayer(state, 'black-player', 'Boris', token);
  return {
    state,
    white: rl.getPlayer(state, 'white-player'),
    black: rl.getPlayer(state, 'black-player'),
  };
}

function move(state, player, from, to, promotion) {
  return rl.applyMove(state, player, { from: sq(from), to: sq(to), promotion });
}

test('players get opposite colours and the room becomes ready', () => {
  const { state, white, black } = createReadyRoom();
  assert.equal(white.color, 'w');
  assert.equal(black.color, 'b');
  assert.equal(rl.isReady(state), true);
  assert.equal(state.waitingForStart, false);
});

test('third connected player is rejected', () => {
  const { state } = createReadyRoom();
  const result = rl.assignPlayer(state, 'third', 'Third', token);
  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ROOM_FULL);
});

test('reconnect keeps colour and rotates the resume token', () => {
  const { state, black } = createReadyRoom();
  const oldToken = black.resumeToken;
  rl.removePlayer(state, 'black-player');
  assert.equal(rl.isReady(state), false);
  const again = rl.assignPlayer(state, 'black-player', 'Boris', token);
  assert.equal(again.player.color, 'b');
  assert.notEqual(again.player.resumeToken, oldToken);
  assert.equal(rl.isResumeTokenValid(state, 'black-player', again.player.resumeToken), true);
  assert.equal(rl.isResumeTokenValid(state, 'black-player', oldToken), false);
});

test('seat is reserved for a disconnected player only while a game is in progress', () => {
  const { state, white } = createReadyRoom();
  assert.equal(rl.hasReservedSeat(state), false);
  move(state, white, 'e2', 'e4');
  rl.removePlayer(state, 'black-player');
  assert.equal(rl.hasReservedSeat(state), true);
  rl.resign(state, white);
  assert.equal(rl.hasReservedSeat(state), false);
});

test('soft mode: illegal attempt keeps the turn and only the mover sees the squares', () => {
  const { state, white } = createReadyRoom();
  const result = move(state, white, 'e2', 'e5');
  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ILLEGAL_MOVE);
  assert.equal(state.turn, 'w');

  const whiteEvent = rl.createView(state, { role: 'player', color: 'w' }).events.at(-1);
  const blackEvent = rl.createView(state, { role: 'player', color: 'b' }).events.at(-1);
  assert.equal(whiteEvent.kind, 'illegal');
  assert.equal(whiteEvent.fromSquare, 'e2');
  assert.equal(blackEvent.kind, 'illegal');
  assert.equal(blackEvent.fromSquare, undefined);
  assert.equal(JSON.stringify(blackEvent).includes('e2'), false);
});

test('hard mode forfeits the turn and records a null move', () => {
  const { state, white } = createReadyRoom({ hardMode: true });
  const result = move(state, white, 'e2', 'e5');
  assert.equal(result.forfeited, true);
  assert.equal(state.turn, 'b');
  assert.equal(state.log.length, 1);
  assert.equal(state.log[0].san, '--');
});

test('hard mode does not forfeit while the mover is in check', () => {
  const { state, white, black } = createReadyRoom();
  move(state, white, 'f2', 'f3');
  move(state, black, 'e7', 'e5');
  move(state, white, 'e2', 'e4');
  state.hardMode = true;
  move(state, black, 'd8', 'h4'); // check
  assert.equal(core.isInCheck(state.board, 'w'), true);
  const result = move(state, white, 'a2', 'a3');
  assert.equal(result.ok, false);
  assert.equal(Boolean(result.forfeited), false);
  assert.equal(state.turn, 'w');
});

test('hard mode forfeit clears the en passant square', () => {
  const { state, white, black } = createReadyRoom({ hardMode: true });
  move(state, white, 'e2', 'e4');
  assert.deepEqual(state.enPassant, sq('e3'));
  assert.equal(move(state, black, 'a8', 'a5').forfeited, true);
  assert.equal(state.enPassant, null);
  // Without the fix this "captured" en passant onto the empty e3 square.
  const sneaky = move(state, white, 'd2', 'e3');
  assert.equal(sneaky.ok, false);
});

test('new game keeps boardVersion monotonic and swaps colours after a finished game', () => {
  const { state, white, black } = createReadyRoom();
  move(state, white, 'f2', 'f3');
  move(state, black, 'e7', 'e5');
  move(state, white, 'g2', 'g4');
  move(state, black, 'd8', 'h4');
  assert.equal(state.gameOver, true);
  assert.equal(state.result, 'checkmate');
  const versionBefore = state.boardVersion;

  assert.equal(rl.newGame(state, white).ok, true);
  assert.ok(state.boardVersion > versionBefore);
  assert.equal(state.gameId, 2);
  assert.equal(state.log.length, 0);
  assert.equal(rl.getPlayer(state, 'white-player').color, 'b');
  assert.equal(rl.getPlayer(state, 'black-player').color, 'w');
});

test('new game is refused while a game is in progress', () => {
  const { state, white } = createReadyRoom();
  move(state, white, 'e2', 'e4');
  const result = rl.newGame(state, white);
  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.GAME_IN_PROGRESS);
});

test('options lock once the first move is played', () => {
  const { state, white, black } = createReadyRoom();
  assert.equal(rl.setOptions(state, black, { hardMode: true }).ok, true);
  assert.equal(state.hardMode, true);
  move(state, white, 'e2', 'e4');
  const locked = rl.setOptions(state, black, { hardMode: false, spectatorView: 'open' });
  assert.equal(locked.reason, ERROR_CODES.GAME_IN_PROGRESS);
  assert.equal(state.hardMode, true);
  assert.equal(state.spectatorView, 'fog');
});

test('draw offer survives the offerer’s own move and is declined by the opponent moving', () => {
  const { state, white, black } = createReadyRoom();
  const offer = rl.claimDraw(state, white, {});
  assert.equal(offer.drawOffered, true);
  move(state, white, 'e2', 'e4');
  assert.equal(state.pendingDrawOffer, 'w');
  move(state, black, 'e7', 'e5');
  assert.equal(state.pendingDrawOffer, null);
  assert.equal(state.events.some((event) => event.kind === 'draw_declined'), true);
});

test('draw offer accepted by the opponent ends the game', () => {
  const { state, white, black } = createReadyRoom();
  rl.claimDraw(state, white, {});
  move(state, white, 'e2', 'e4');
  const accepted = rl.claimDraw(state, black, {});
  assert.equal(accepted.ok, true);
  assert.equal(state.result, 'mutualDraw');
  assert.equal(state.gameOver, true);
});

test('fifty-move claim ends the game, unavailable explicit claim becomes an offer', () => {
  const { state, white } = createReadyRoom();
  const offer = rl.claimDraw(state, white, { reason: 'fiftymove' });
  assert.equal(offer.ok, false);
  assert.equal(offer.drawOffered, true);
  state.pendingDrawOffer = null;
  state.halfMoveClock = 100;
  const claim = rl.claimDraw(state, white, { reason: 'fiftymove' });
  assert.equal(claim.ok, true);
  assert.equal(state.result, 'fiftyMove');
});

test('player view hides opponent pieces, opponent moves, and check marks', () => {
  const { state, white, black } = createReadyRoom();
  move(state, white, 'e2', 'e4');
  move(state, black, 'f7', 'f6');
  move(state, white, 'd1', 'h5'); // check
  const blackView = rl.createView(state, { role: 'player', color: 'b' });
  const whiteView = rl.createView(state, { role: 'player', color: 'w' });

  assert.equal(blackView.board.flat().some((piece) => piece && piece.color === 'w'), false);
  assert.equal(blackView.moves[0].san, null);
  assert.equal(blackView.moves[0].from, null);
  assert.equal(blackView.moves[1].san, 'f6');
  assert.deepEqual(blackView.check, { color: 'b', directions: ['diagonal'] });
  assert.equal(JSON.stringify(blackView).includes('Qh5'), false);

  assert.equal(whiteView.moves[2].san, 'Qh5'); // '+' stripped for the checking side
  assert.equal(whiteView.check, null);
  assert.equal(whiteView.events.some((event) => event.kind === 'check'), false);
  assert.equal(whiteView.board.flat().some((piece) => piece && piece.color === 'b'), false);
});

test('captures are announced to both players with the square', () => {
  const { state, white, black } = createReadyRoom();
  move(state, white, 'e2', 'e4');
  move(state, black, 'd7', 'd5');
  move(state, white, 'e4', 'd5');
  const blackView = rl.createView(state, { role: 'player', color: 'b' });
  assert.deepEqual(blackView.moves[2].capture, { square: 'd5', r: 3, c: 3 });
  assert.equal(blackView.moves[2].san, null);
  assert.equal(blackView.captured.b, 1);
  const capture = blackView.events.find((event) => event.kind === 'capture');
  assert.equal(capture.square, 'd5');
});

test('spectators see fog unless the room is open, and everything after the game', () => {
  const { state, white } = createReadyRoom();
  move(state, white, 'e2', 'e4');
  const fog = rl.createView(state, { role: 'spectator' });
  assert.equal(fog.board.flat().some(Boolean), false);
  assert.equal(fog.moves[0].san, null);

  state.spectatorView = 'open';
  const open = rl.createView(state, { role: 'spectator' });
  assert.equal(open.board.flat().filter(Boolean).length, 32);
  assert.equal(open.moves[0].san, 'e4');

  state.spectatorView = 'fog';
  rl.resign(state, white);
  const after = rl.createView(state, { role: 'player', color: 'b' });
  assert.equal(after.revealed, true);
  assert.equal(after.moves[0].san, 'e4');
  assert.equal(after.board.flat().filter(Boolean).length, 32);
});

test('PGN uses null moves for forfeits and keeps alternating numbering', () => {
  const { state, white, black } = createReadyRoom({ hardMode: true });
  move(state, white, 'e2', 'e4');
  move(state, black, 'e7', 'e4'); // illegal -> forfeit
  move(state, white, 'd2', 'd4');
  rl.resign(state, black);
  const view = rl.createView(state, { role: 'player', color: 'w' });
  const pgn = rl.buildPgn({ ...view, white: 'Wendy', black: 'Boris', date: '2026-10-21T12:00:00Z' });
  assert.match(pgn, /\[Result "1-0"\]/);
  assert.match(pgn, /1\. e4 -- \{turn forfeited\} 2\. d4 1-0/);
  assert.match(pgn, /\[Termination "resignation"\]/);
});

test('nicknames are trimmed and stripped of markup', () => {
  const state = rl.createRoomState('ROOM01');
  const { player } = rl.assignPlayer(state, 'p1', '  <b>Very long nickname indeed</b> ', token);
  assert.equal(player.nickname, 'bVery long nickn');
});
