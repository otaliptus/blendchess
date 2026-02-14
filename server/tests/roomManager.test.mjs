import test from 'node:test';
import assert from 'node:assert/strict';
import { Room } from '../roomManager.js';
import { ERROR_CODES } from '../protocol.js';

function createReadyRoom() {
  const room = new Room('ABC123');
  room.assignPlayer('white-player', 'White');
  room.assignPlayer('black-player', 'Black');
  return room;
}

test('claimDraw accepts normalized reason aliases', () => {
  const room = createReadyRoom();
  room.state.halfMoveClock = 100;

  const result = room.claimDraw('white-player', { reason: 'fiftymove' });
  assert.equal(result.ok, true);
  assert.equal(result.reason, 'fiftyMove');
  assert.equal(room.state.result, 'fiftyMove');
  assert.equal(room.state.gameOver, true);
});

test('claimDraw rejects unavailable explicit reason', () => {
  const room = createReadyRoom();

  const result = room.claimDraw('white-player', { reason: 'fiftymove' });
  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.INVALID_DRAW_CLAIM);
});

test('spectators can join and be represented in game snapshots', () => {
  const room = new Room('ABC123');
  const assigned = room.assignSpectator('spectator-1', 'Spectator');

  assert.equal(assigned.ok, true);
  assert.equal(room.connectedSpectatorCount(), 1);
  assert.equal(room.createGameSnapshot().spectators.length, 1);
  assert.equal(room.createGameSnapshot().spectators[0].spectatorId, 'spectator-1');
});

test('spectator removal updates connected members', () => {
  const room = new Room('ABC123');
  room.assignPlayer('player-1', 'White');
  room.assignSpectator('spectator-1', 'Watcher');

  room.removeSpectator('spectator-1');
  assert.equal(room.connectedSpectatorCount(), 0);
  assert.equal(room.createGameSnapshot().spectators.length, 0);
});

test('hard mode forfeits illegal moves and advances turn', () => {
  const room = createReadyRoom();
  room.state.hardMode = true;

  const result = room.applyMove('white-player', {
    from: { r: 6, c: 0 },
    to: { r: 3, c: 0 },
    promotion: 'Q',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ILLEGAL_MOVE);
  assert.equal(result.forfeited, true);
  assert.equal(room.state.turn, 'b');
  assert.equal(room.state.boardVersion, 1);
});

test('soft mode keeps illegal moves for current player', () => {
  const room = createReadyRoom();
  room.state.hardMode = false;

  const result = room.applyMove('white-player', {
    from: { r: 6, c: 0 },
    to: { r: 3, c: 0 },
    promotion: 'Q',
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ILLEGAL_MOVE);
  assert.equal(result.forfeited, undefined);
  assert.equal(room.state.turn, 'w');
  assert.equal(room.state.boardVersion, 0);
});
