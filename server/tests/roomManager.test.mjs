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
