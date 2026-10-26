(function installEngineFacade() {
  var core = globalThis.ChessCore;
  var protocol = globalThis.BlendChessProtocol;

  if (!core) throw new Error('chess-core.js must be loaded before engine-facade.js');
  if (!protocol) throw new Error('shared/protocol.js must be loaded before engine-facade.js');

  var ERROR_CODES = protocol.ERROR_CODES;

  function isValidSquare(value) {
    return Number.isInteger(value) && value >= 0 && value < 8;
  }

  function normalizeMoveIntent(payload) {
    if (!payload || !payload.from || !payload.to) return null;

    var from = { r: Number(payload.from.r), c: Number(payload.from.c) };
    var to = { r: Number(payload.to.r), c: Number(payload.to.c) };

    if (!isValidSquare(from.r) || !isValidSquare(from.c) || !isValidSquare(to.r) || !isValidSquare(to.c)) {
      return null;
    }

    var promotion = payload.promotion ? String(payload.promotion).toUpperCase() : null;
    if (promotion && promotion.length !== 1) return null;

    return { from: from, to: to, promotion: promotion };
  }

  function evaluateMove(state, playerColor, payload) {
    var normalized = normalizeMoveIntent(payload);
    if (!normalized) {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD };
    }

    var requestedPromotion = normalized.promotion || null;
    if (requestedPromotion && !core.PROMOTION_OPTIONS.includes(requestedPromotion)) {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD };
    }

    if (state.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }

    if (state.turn !== playerColor) {
      return { ok: false, reason: ERROR_CODES.NOT_YOUR_TURN };
    }

    var legal = core.generateLegalMoves(state.board, playerColor, state.enPassant);
    var candidate = legal.find(function (move) {
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

    var outcome = core.applyMove(state.board, candidate, state.enPassant);
    var movingPiece = state.board[normalized.from.r][normalized.from.c];

    return {
      ok: true,
      move: candidate,
      board: outcome.board,
      enPassant: outcome.enPassant,
      captured: outcome.captured,
      movingPiece: movingPiece,
      isPawnMove: movingPiece && movingPiece.type === 'P',
    };
  }

  var exports = {
    evaluateMove: evaluateMove,
    normalizeMoveIntent: normalizeMoveIntent,
  };

  globalThis.BlendChessEngineFacade = exports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  }
})();
