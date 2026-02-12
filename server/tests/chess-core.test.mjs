import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const core = require('../../chess-core.js');

function play(state, from, to, promotion = null) {
  const legalMoves = core.generateLegalMoves(state.board, state.turn, state.enPassant);
  const move = legalMoves.find((candidate) => {
    const sameFrom = candidate.from.r === from.r && candidate.from.c === from.c;
    const sameTo = candidate.to.r === to.r && candidate.to.c === to.c;
    if (!sameFrom || !sameTo) {
      return false;
    }
    if (promotion == null) {
      return candidate.promotion == null;
    }
    return candidate.promotion === promotion;
  });

  assert.ok(move, `Expected legal move ${JSON.stringify(from)} -> ${JSON.stringify(to)}`);
  const outcome = core.applyMove(state.board, move, state.enPassant);
  state.board = outcome.board;
  state.enPassant = outcome.enPassant;
  if (outcome.captured || move.piece.type === 'P') {
    state.halfMoveClock = 0;
  } else {
    state.halfMoveClock += 1;
  }
  state.turn = core.otherColor(state.turn);
  core.recordCurrentPosition(state);
}

test('checkmate terminal text marks the side to move as checkmated', () => {
  const state = core.createInitialState();

  play(state, { r: 6, c: 5 }, { r: 5, c: 5 }); // f3
  play(state, { r: 1, c: 4 }, { r: 3, c: 4 }); // ...e5
  play(state, { r: 6, c: 6 }, { r: 4, c: 6 }); // g4
  play(state, { r: 0, c: 3 }, { r: 4, c: 7 }); // ...Qh4#

  const terminal = core.evaluateTerminalState(state);
  assert.equal(terminal.isTerminal, true);
  assert.equal(terminal.winner, 'Black');
  assert.equal(terminal.eventText, 'White is checkmated.');
});

test('threefold and fifty-move conditions do not auto-end the game', () => {
  const state = core.createInitialState();
  state.halfMoveClock = 100;
  const key = core.positionKey(state.board, state.turn, state.enPassant);
  state.positionCounts[key] = 3;

  const terminal = core.evaluateTerminalState(state);
  assert.equal(terminal.isTerminal, false);
});
