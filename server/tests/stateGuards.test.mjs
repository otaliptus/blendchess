import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  normalizeHistorySnapshot,
  shouldHydrateSnapshotVersion,
} = require('../../client/stateGuards.js');

function cloneBoard(board) {
  return board.map((row) => row.map((piece) => (piece ? { ...piece } : null)));
}

function createValidBoard() {
  const board = Array.from({ length: 8 }, () => Array.from({ length: 8 }, () => null));
  board[7][4] = { type: 'K', color: 'w', hasMoved: false };
  board[0][4] = { type: 'K', color: 'b', hasMoved: false };
  board[6][0] = { type: 'P', color: 'w', hasMoved: false };
  board[1][7] = { type: 'P', color: 'b', hasMoved: false };
  return board;
}

const PIECE_SYMBOLS = {
  w: { K: 'K', Q: 'Q', R: 'R', B: 'B', N: 'N', P: 'P' },
  b: { K: 'K', Q: 'Q', R: 'R', B: 'B', N: 'N', P: 'P' },
};

test('shouldHydrateSnapshotVersion rejects stale versions', () => {
  assert.equal(shouldHydrateSnapshotVersion(4, 5), false);
  assert.equal(shouldHydrateSnapshotVersion(5, 5), true);
  assert.equal(shouldHydrateSnapshotVersion(6, 5), true);
});

test('shouldHydrateSnapshotVersion allows unknown versions', () => {
  assert.equal(shouldHydrateSnapshotVersion(null, 5), true);
  assert.equal(shouldHydrateSnapshotVersion(3, null), true);
  assert.equal(shouldHydrateSnapshotVersion(undefined, undefined), true);
});

test('normalizeHistorySnapshot accepts valid 8x8 board and clones it', () => {
  const sourceBoard = createValidBoard();
  const snapshot = normalizeHistorySnapshot(
    { board: sourceBoard, turn: 'w', boardVersion: 7 },
    cloneBoard,
    PIECE_SYMBOLS,
  );

  assert.ok(snapshot);
  assert.notEqual(snapshot.board, sourceBoard);
  assert.notEqual(snapshot.board[7][4], sourceBoard[7][4]);
  assert.deepEqual(snapshot.board, sourceBoard);
});

test('normalizeHistorySnapshot rejects malformed board shapes', () => {
  const malformed = { board: Array.from({ length: 7 }, () => Array.from({ length: 8 }, () => null)) };
  const snapshot = normalizeHistorySnapshot(malformed, cloneBoard, PIECE_SYMBOLS);
  assert.equal(snapshot, null);
});

test('normalizeHistorySnapshot rejects malformed pieces', () => {
  const invalidBoard = createValidBoard();
  invalidBoard[3][3] = { type: 'X', color: 'w', hasMoved: false };
  assert.equal(normalizeHistorySnapshot({ board: invalidBoard }, cloneBoard, PIECE_SYMBOLS), null);

  invalidBoard[3][3] = { type: 'Q', color: 'w' };
  assert.equal(normalizeHistorySnapshot({ board: invalidBoard }, cloneBoard, PIECE_SYMBOLS), null);
});
