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

function createEmptyBoard() {
  return Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
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

test('hard mode rejects illegal move without forfeit when mover is in check', () => {
  const room = createReadyRoom();
  room.state.hardMode = true;
  room.state.turn = 'w';
  room.state.boardVersion = 0;
  room.state.board = createEmptyBoard();
  room.state.board[7][4] = { type: 'K', color: 'w', hasMoved: true };
  room.state.board[0][4] = { type: 'K', color: 'b', hasMoved: true };
  room.state.board[6][4] = { type: 'R', color: 'b', hasMoved: true };

  const result = room.applyMove('white-player', {
    from: { r: 5, c: 0 },
    to: { r: 4, c: 0 },
  });

  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ILLEGAL_MOVE);
  assert.equal(result.forfeited, undefined);
  assert.equal(room.state.turn, 'w');
  assert.equal(room.state.gameOver, false);
  assert.equal(room.state.boardVersion, 0);
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

test('resign is allowed before room is fully ready', () => {
  const room = new Room('ABC123');
  room.assignPlayer('white-player', 'White');

  const result = room.resign('white-player');
  assert.equal(result.ok, true);
  assert.equal(result.winner, 'Black');
  assert.equal(room.state.result, 'resign');
  assert.equal(room.state.gameOver, true);
});

test('assignPlayer cleans stale seat before capacity check', () => {
  const room = new Room('ABC123');
  room.assignPlayer('white-player', 'White');
  room.assignPlayer('black-stale', 'Black');
  room.removePlayer('black-stale');

  const callOrder = [];
  const originalCleanupDisconnectedColor = room.cleanupDisconnectedColor.bind(room);
  const originalIsFull = room.isFull.bind(room);
  room.cleanupDisconnectedColor = (color) => {
    callOrder.push(`cleanup:${color}`);
    return originalCleanupDisconnectedColor(color);
  };
  room.isFull = () => {
    callOrder.push('isFull');
    return originalIsFull();
  };

  const result = room.assignPlayer('black-player', 'Black');
  assert.equal(result.ok, true);
  assert.equal(result.player.color, 'b');
  assert.equal(room.getPlayer('black-stale'), null);
  assert.equal(callOrder[0], 'cleanup:b');
  assert.equal(callOrder[1], 'isFull');
});

test('assignPlayer rejects additional connected player when room is full', () => {
  const room = createReadyRoom();

  const result = room.assignPlayer('third-player', 'Third');
  assert.equal(result.ok, false);
  assert.equal(result.reason, ERROR_CODES.ROOM_FULL);
});

test('assignPlayer reconnect keeps color and marks player connected', () => {
  const room = new Room('ABC123');
  const first = room.assignPlayer('player-1', 'First', 'token-1');
  assert.equal(first.ok, true);
  const firstColor = first.player.color;

  room.removePlayer('player-1');
  const reconnect = room.assignPlayer('player-1', 'First Again', 'token-2');
  assert.equal(reconnect.ok, true);
  assert.equal(reconnect.player.color, firstColor);
  assert.equal(reconnect.player.connected, true);
  assert.equal(reconnect.player.resumeToken, 'token-2');
});
