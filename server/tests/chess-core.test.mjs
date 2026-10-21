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

function fromFen(fen) {
  const [placement, turn, castling, ep] = fen.split(' ');
  const board = Array.from({ length: 8 }, () => Array(8).fill(null));
  placement.split('/').forEach((row, r) => {
    let c = 0;
    for (const ch of row) {
      if (/\d/.test(ch)) {
        c += Number(ch);
        continue;
      }
      board[r][c] = { type: ch.toUpperCase(), color: ch === ch.toUpperCase() ? 'w' : 'b', hasMoved: true };
      c += 1;
    }
  });
  const unmoved = (r, c) => {
    if (board[r][c]) board[r][c].hasMoved = false;
  };
  if (castling.includes('K')) { unmoved(7, 4); unmoved(7, 7); }
  if (castling.includes('Q')) { unmoved(7, 4); unmoved(7, 0); }
  if (castling.includes('k')) { unmoved(0, 4); unmoved(0, 7); }
  if (castling.includes('q')) { unmoved(0, 4); unmoved(0, 0); }
  const enPassant = ep === '-' ? null : { r: 8 - Number(ep[1]), c: 'abcdefgh'.indexOf(ep[0]) };
  return { board, turn, enPassant };
}

function perft(board, color, enPassant, depth) {
  const moves = core.generateLegalMoves(board, color, enPassant);
  if (depth === 1) return moves.length;
  let nodes = 0;
  for (const move of moves) {
    const next = core.applyMove(board, move, enPassant);
    nodes += perft(next.board, core.otherColor(color), next.enPassant, depth - 1);
  }
  return nodes;
}

// Standard perft suite positions (chessprogramming.org/Perft_Results).
const PERFT_CASES = [
  ['start', 'rnbqkbnr/pppppppp/8/8/8/8/PPPPPPPP/RNBQKBNR w KQkq -', 3, 8902],
  ['kiwipete', 'r3k2r/p1ppqpb1/bn2pnp1/3PN3/1p2P3/2N2Q1p/PPPBBPPP/R3K2R w KQkq -', 3, 97862],
  ['position 3', '8/2p5/3p4/KP5r/1R3p1k/8/4P1P1/8 w - -', 4, 43238],
  ['position 4', 'r3k2r/Pppp1ppp/1b3nbN/nP6/BBP1P3/q4N2/Pp1P2PP/R2Q1RK1 w kq -', 3, 9467],
  ['position 5', 'rnbq1k1r/pp1Pbppp/2p5/8/2B5/8/PPP1NnPP/RNBQK2R w KQ -', 3, 62379],
];

for (const [name, fen, depth, expected] of PERFT_CASES) {
  test(`perft ${name} depth ${depth}`, () => {
    const { board, turn, enPassant } = fromFen(fen);
    assert.equal(perft(board, turn, enPassant, depth), expected);
  });
}

test('insufficient material only flags dead positions', () => {
  const dead = ['8/8/8/8/8/2k5/8/K7 w - -', '8/8/8/8/8/2k5/8/KN6 w - -', '8/8/8/8/8/2k5/8/KB6 w - -', '8/8/8/8/8/2k1b3/8/K1B5 w - -'];
  const alive = ['8/8/8/8/8/2k5/8/K1N1b3 w - -', '8/8/8/8/8/2k5/8/KNN5 w - -', '8/8/8/8/8/2k2b2/8/K1B5 w - -', '8/8/8/8/8/2k5/8/KP6 w - -'];
  for (const fen of dead) assert.equal(core.isInsufficientMaterial(fromFen(fen).board), true, fen);
  for (const fen of alive) assert.equal(core.isInsufficientMaterial(fromFen(fen).board), false, fen);
});

test('checkDirections names every checking line', () => {
  assert.deepEqual(core.checkDirections(fromFen('4k3/8/8/8/8/8/8/4R1K1 b - -').board, 'b'), ['file']);
  assert.deepEqual(core.checkDirections(fromFen('R3k3/8/8/8/8/8/8/6K1 b - -').board, 'b'), ['rank']);
  assert.deepEqual(core.checkDirections(fromFen('4k3/3P4/8/8/8/8/8/6K1 b - -').board, 'b'), ['diagonal']);
  assert.deepEqual(core.checkDirections(fromFen('4k3/8/3N4/8/8/8/8/4R1K1 b - -').board, 'b').sort(), ['file', 'knight']);
  assert.deepEqual(core.checkDirections(core.createInitialBoard(), 'w'), []);
});

test('plausible moves only respect the mover’s own pieces', () => {
  const { board } = fromFen('4k3/8/8/3p4/8/8/8/R3K2R w KQ -');
  // White sees only its own pieces; the black pawn on d5 is unknown, so the rook may "slide through" it.
  const whiteOnly = board.map((row) => row.map((piece) => (piece && piece.color === 'w' ? piece : null)));
  const rookTargets = core.generatePlausibleMovesForPiece(whiteOnly, 7, 0).map((move) => core.squareName(move.to));
  assert.ok(rookTargets.includes('a8'));
  assert.ok(rookTargets.includes('d1'));
  assert.ok(!rookTargets.includes('e1'));
  const kingMoves = core.generatePlausibleMovesForPiece(whiteOnly, 7, 4);
  assert.deepEqual(kingMoves.filter((move) => move.castling).map((move) => move.castling).sort(), ['kingside', 'queenside']);

  const pawnBoard = core.createInitialBoard().map((row) => row.map((piece) => (piece && piece.color === 'w' ? piece : null)));
  const pawnTargets = core.generatePlausibleMovesForPiece(pawnBoard, 6, 4).map((move) => core.squareName(move.to)).sort();
  assert.deepEqual(pawnTargets, ['d3', 'e3', 'e4', 'f3']);
});
