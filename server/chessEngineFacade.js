import { createRequire } from 'node:module';
import { ERROR_CODES } from './protocol.js';

const require = createRequire(import.meta.url);
const core = require('../chess-core.js');

function isValidSquare(value) {
  return Number.isInteger(value) && value >= 0 && value < 8;
}

function normalizeMoveIntent(payload) {
  if (!payload || !payload.from || !payload.to) return null;

  const from = {
    r: Number(payload.from.r),
    c: Number(payload.from.c),
  };
  const to = {
    r: Number(payload.to.r),
    c: Number(payload.to.c),
  };

  if (!isValidSquare(from.r) || !isValidSquare(from.c) || !isValidSquare(to.r) || !isValidSquare(to.c)) {
    return null;
  }

  const promotion = payload.promotion ? String(payload.promotion).toUpperCase() : null;
  if (promotion && promotion.length !== 1) return null;

  return {
    from,
    to,
    promotion,
  };
}

export function evaluateMove(state, playerColor, payload) {
  const normalized = normalizeMoveIntent(payload);
  if (!normalized) {
    return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD };
  }

  const requestedPromotion = normalized.promotion || null;
  if (requestedPromotion && !core.PROMOTION_OPTIONS.includes(requestedPromotion)) {
    return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD };
  }

  if (state.gameOver) {
    return { ok: false, reason: ERROR_CODES.GAME_OVER };
  }

  if (state.turn !== playerColor) {
    return { ok: false, reason: ERROR_CODES.NOT_YOUR_TURN };
  }

  const legal = core.generateLegalMoves(state.board, playerColor, state.enPassant);
  const candidate = legal.find((move) => {
    if (
      move.from.r !== normalized.from.r ||
      move.from.c !== normalized.from.c ||
      move.to.r !== normalized.to.r ||
      move.to.c !== normalized.to.c
    ) {
      return false;
    }

    if (requestedPromotion == null) {
      return move.promotion == null;
    }

    return move.promotion === requestedPromotion;
  });

  if (!candidate) {
    return { ok: false, reason: ERROR_CODES.ILLEGAL_MOVE };
  }

  const outcome = core.applyMove(state.board, candidate, state.enPassant);
  const movingPiece = state.board[normalized.from.r][normalized.from.c];

  return {
    ok: true,
    move: candidate,
    board: outcome.board,
    enPassant: outcome.enPassant,
    captured: outcome.captured,
    movingPiece,
    isPawnMove: movingPiece && movingPiece.type === 'P',
  };
}
