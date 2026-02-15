(function installChessCore() {
  const FILES = 'abcdefgh';
  const PROMOTION_OPTIONS = ['Q', 'R', 'B', 'N'];

  function createInitialBoard() {
    const board = Array.from({ length: 8 }, () => Array(8).fill(null));

    function place(r, c, type, color) {
      board[r][c] = { type, color, hasMoved: false };
    }

    place(0, 0, 'R', 'b');
    place(0, 1, 'N', 'b');
    place(0, 2, 'B', 'b');
    place(0, 3, 'Q', 'b');
    place(0, 4, 'K', 'b');
    place(0, 5, 'B', 'b');
    place(0, 6, 'N', 'b');
    place(0, 7, 'R', 'b');

    for (let c = 0; c < 8; c += 1) {
      place(1, c, 'P', 'b');
      place(6, c, 'P', 'w');
    }

    place(7, 0, 'R', 'w');
    place(7, 1, 'N', 'w');
    place(7, 2, 'B', 'w');
    place(7, 3, 'Q', 'w');
    place(7, 4, 'K', 'w');
    place(7, 5, 'B', 'w');
    place(7, 6, 'N', 'w');
    place(7, 7, 'R', 'w');

    return board;
  }

  function createInitialState() {
    const state = {
      board: createInitialBoard(),
      turn: 'w',
      enPassant: null,
      selected: null,
      hardMode: false,
      gameOver: false,
      winner: null,
      result: null,
      moveNumber: 1,
      movePairs: [],
      events: [],
      captured: { w: 0, b: 0 },
      halfMoveClock: 0,
      positionCounts: {},
    };
    state.positionCounts[positionKey(state.board, state.turn, state.enPassant)] = 1;
    return state;
  }

  function cloneBoard(board) {
    return board.map((row) => row.map((cell) => (cell ? { ...cell } : null)));
  }

  function inBounds(r, c) {
    return r >= 0 && r < 8 && c >= 0 && c < 8;
  }

  function otherColor(color) {
    return color === 'w' ? 'b' : 'w';
  }

  function colorName(color) {
    return color === 'w' ? 'White' : 'Black';
  }

  function squareName(pos) {
    return `${FILES[pos.c]}${8 - pos.r}`;
  }

  function createMove(from, to, options = {}) {
    return {
      from: { ...from },
      to: { ...to },
      capture: false,
      castling: null,
      enPassant: false,
      promotion: null,
      ...options,
    };
  }

  function isCapturableTarget(target, color) {
    return Boolean(target && target.color !== color && target.type !== 'K');
  }

  function findKing(board, color) {
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = board[r][c];
        if (piece && piece.color === color && piece.type === 'K') {
          return { r, c };
        }
      }
    }
    return null;
  }

  function squareIsAttacked(board, r, c, attackerColor) {
    const pawnDir = attackerColor === 'w' ? -1 : 1;
    for (let sr = 0; sr < 8; sr += 1) {
      for (let sc = 0; sc < 8; sc += 1) {
        const piece = board[sr][sc];
        if (!piece || piece.color !== attackerColor) continue;

        if (piece.type === 'P') {
          const attacks = [
            [pawnDir, -1],
            [pawnDir, 1],
          ];
          for (const [dr, dc] of attacks) {
            const tr = sr + dr;
            const tc = sc + dc;
            if (tr === r && tc === c) return true;
          }
        } else if (piece.type === 'N') {
          const offsets = [
            [-2, -1],
            [-2, 1],
            [-1, -2],
            [-1, 2],
            [1, -2],
            [1, 2],
            [2, -1],
            [2, 1],
          ];
          for (const [dr, dc] of offsets) {
            if (sr + dr === r && sc + dc === c) return true;
          }
        } else if (piece.type === 'B' || piece.type === 'R' || piece.type === 'Q') {
          const dirs = piece.type === 'B'
            ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
            : piece.type === 'R'
              ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
              : [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]];

          for (const [dr, dc] of dirs) {
            let tr = sr + dr;
            let tc = sc + dc;
            while (inBounds(tr, tc)) {
              if (tr === r && tc === c) return true;
              if (board[tr][tc]) break;
              tr += dr;
              tc += dc;
            }
          }
        } else if (piece.type === 'K') {
          for (let dr = -1; dr <= 1; dr += 1) {
            for (let dc = -1; dc <= 1; dc += 1) {
              if (dr === 0 && dc === 0) continue;
              if (sr + dr === r && sc + dc === c) return true;
            }
          }
        }
      }
    }
    return false;
  }

  function isInCheck(board, color) {
    const king = findKing(board, color);
    if (!king) return false;
    return squareIsAttacked(board, king.r, king.c, otherColor(color));
  }

  function pieceToKeySymbol(piece) {
    if (!piece) return '.';
    const symbol = piece.type;
    return piece.color === 'w' ? symbol : symbol.toLowerCase();
  }

  function castlingRightsFromBoard(board) {
    let rights = '';

    const blackKing = board[0][4];
    if (blackKing && blackKing.type === 'K' && !blackKing.hasMoved) {
      if (board[0][7] && board[0][7].type === 'R' && !board[0][7].hasMoved) rights += 'k';
      if (board[0][0] && board[0][0].type === 'R' && !board[0][0].hasMoved) rights += 'q';
    }

    const whiteKing = board[7][4];
    if (whiteKing && whiteKing.type === 'K' && !whiteKing.hasMoved) {
      if (board[7][7] && board[7][7].type === 'R' && !board[7][7].hasMoved) rights += 'K';
      if (board[7][0] && board[7][0].type === 'R' && !board[7][0].hasMoved) rights += 'Q';
    }

    return rights || '-';
  }

  function positionKey(board, turn, enPassant) {
    const boardKey = board
      .map((row) => row.map((piece) => pieceToKeySymbol(piece)).join(''))
      .join('/');
    const castleKey = castlingRightsFromBoard(board);
    const epKey = enPassant ? squareName(enPassant) : '-';
    return `${turn}|${castleKey}|${epKey}|${boardKey}`;
  }

  function recordCurrentPosition(state) {
    const key = positionKey(state.board, state.turn, state.enPassant);
    state.positionCounts[key] = (state.positionCounts[key] || 0) + 1;
    return state.positionCounts[key];
  }

  function isThreefoldRepetition(state) {
    const key = positionKey(state.board, state.turn, state.enPassant);
    return (state.positionCounts[key] || 0) >= 3;
  }

  function isFivefoldRepetition(state) {
    const key = positionKey(state.board, state.turn, state.enPassant);
    return (state.positionCounts[key] || 0) >= 5;
  }

  function isFiftyMoveRule(state) {
    return state.halfMoveClock >= 100;
  }

  function isSeventyFiveMoveRule(state) {
    return state.halfMoveClock >= 150;
  }

  function isInsufficientMaterial(board) {
    const white = [];
    const black = [];

    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = board[r][c];
        if (!piece || piece.type === 'K') continue;
        if (piece.type === 'P' || piece.type === 'R' || piece.type === 'Q') return false;
        if (piece.color === 'w') white.push(piece);
        else black.push(piece);
      }
    }

    const total = white.length + black.length;
    if (total === 0) return true;
    if (total > 2) return false;
    if (total === 1) return true;

    const whiteOnlyTwoBishops = white.length === 2 && white.every((piece) => piece.type === 'B');
    const blackOnlyTwoBishops = black.length === 2 && black.every((piece) => piece.type === 'B');
    if (whiteOnlyTwoBishops || blackOnlyTwoBishops) return false;

    return true;
  }

  function generatePseudoMovesForPiece(board, r, c, enPassant) {
    const piece = board[r][c];
    if (!piece) return [];
    const moves = [];
    const color = piece.color;

    if (piece.type === 'P') {
      const dir = color === 'w' ? -1 : 1;
      const oneRow = r + dir;
      const twoRow = r + 2 * dir;
      const startRow = color === 'w' ? 6 : 1;

      if (inBounds(oneRow, c) && !board[oneRow][c]) {
        if (oneRow === 0 || oneRow === 7) {
          for (const promotion of PROMOTION_OPTIONS) {
            moves.push(createMove({ r, c }, { r: oneRow, c }, { promotion }));
          }
        } else {
          moves.push(createMove({ r, c }, { r: oneRow, c }));
        }

        if (r === startRow && !board[twoRow][c]) {
          moves.push(createMove({ r, c }, { r: twoRow, c }));
        }
      }

      for (const dc of [-1, 1]) {
        const tc = c + dc;
        if (!inBounds(oneRow, tc)) continue;
        const target = board[oneRow][tc];
        if (isCapturableTarget(target, color)) {
          if (oneRow === 0 || oneRow === 7) {
            for (const promotion of PROMOTION_OPTIONS) {
              moves.push(createMove({ r, c }, { r: oneRow, c: tc }, { capture: true, promotion }));
            }
          } else {
            moves.push(createMove({ r, c }, { r: oneRow, c: tc }, { capture: true }));
          }
        }
        if (enPassant && enPassant.r === oneRow && enPassant.c === tc) {
          moves.push(createMove({ r, c }, { r: oneRow, c: tc }, { enPassant: true, capture: true }));
        }
      }
    } else if (piece.type === 'N') {
      const offsets = [
        [-2, -1],
        [-2, 1],
        [-1, -2],
        [-1, 2],
        [1, -2],
        [1, 2],
        [2, -1],
        [2, 1],
      ];
      for (const [dr, dc] of offsets) {
        const tr = r + dr;
        const tc = c + dc;
        if (!inBounds(tr, tc)) continue;
        const target = board[tr][tc];
        if (!target || isCapturableTarget(target, color)) {
          moves.push(createMove({ r, c }, { r: tr, c: tc }, { capture: Boolean(target) }));
        }
      }
    } else if (piece.type === 'B' || piece.type === 'R' || piece.type === 'Q') {
      const dirs =
        piece.type === 'B'
          ? [[-1, -1], [-1, 1], [1, -1], [1, 1]]
          : piece.type === 'R'
            ? [[-1, 0], [1, 0], [0, -1], [0, 1]]
            : [[-1, -1], [-1, 1], [1, -1], [1, 1], [-1, 0], [1, 0], [0, -1], [0, 1]];

      for (const [dr, dc] of dirs) {
        let tr = r + dr;
        let tc = c + dc;
        while (inBounds(tr, tc)) {
          const target = board[tr][tc];
          if (!target) {
            moves.push(createMove({ r, c }, { r: tr, c: tc }));
          } else {
            if (isCapturableTarget(target, color)) {
              moves.push(createMove({ r, c }, { r: tr, c: tc }, { capture: true }));
            }
            break;
          }
          tr += dr;
          tc += dc;
        }
      }
    } else if (piece.type === 'K') {
      for (let dr = -1; dr <= 1; dr += 1) {
        for (let dc = -1; dc <= 1; dc += 1) {
          if (dr === 0 && dc === 0) continue;
          const tr = r + dr;
          const tc = c + dc;
          if (!inBounds(tr, tc)) continue;
          const target = board[tr][tc];
          if (!target || isCapturableTarget(target, color)) {
            moves.push(createMove({ r, c }, { r: tr, c: tc }, { capture: Boolean(target) }));
          }
        }
      }

      if (!piece.hasMoved && !isInCheck(board, color)) {
        const row = color === 'w' ? 7 : 0;
        const rookK = board[row][7];
        const rookQ = board[row][0];
        const kingClearKingside = !board[row][5] && !board[row][6];
        const kingClearQueenside = !board[row][1] && !board[row][2] && !board[row][3];

        if (
          rookK &&
          rookK.type === 'R' &&
          rookK.color === color &&
          !rookK.hasMoved &&
          kingClearKingside &&
          !squareIsAttacked(board, row, 5, otherColor(color)) &&
          !squareIsAttacked(board, row, 6, otherColor(color))
        ) {
          moves.push(createMove({ r, c }, { r: row, c: 6 }, { castling: 'kingside' }));
        }

        if (
          rookQ &&
          rookQ.type === 'R' &&
          rookQ.color === color &&
          !rookQ.hasMoved &&
          kingClearQueenside &&
          !squareIsAttacked(board, row, 3, otherColor(color)) &&
          !squareIsAttacked(board, row, 2, otherColor(color))
        ) {
          moves.push(createMove({ r, c }, { r: row, c: 2 }, { castling: 'queenside' }));
        }
      }
    }

    return moves;
  }

  function generatePseudoMoves(board, color, enPassant) {
    const moves = [];
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = board[r][c];
        if (!piece || piece.color !== color) continue;
        const pieceMoves = generatePseudoMovesForPiece(board, r, c, enPassant);
        for (const move of pieceMoves) {
          move.piece = piece;
          moves.push(move);
        }
      }
    }
    return moves;
  }

  function applyMove(board, move, enPassant) {
    const next = cloneBoard(board);
    const piece = next[move.from.r][move.from.c];
    const moving = { ...piece, hasMoved: true };
    let captured = null;
    let nextEnPassant = null;
    const moverColor = moving.color;

    next[move.from.r][move.from.c] = null;

    if (move.castling === 'kingside' || move.castling === 'queenside') {
      const row = moverColor === 'w' ? 7 : 0;
      if (move.castling === 'kingside') {
        next[row][6] = moving;
        const rook = { ...next[row][7], hasMoved: true };
        next[row][5] = rook;
        next[row][7] = null;
      } else {
        next[row][2] = moving;
        const rook = { ...next[row][0], hasMoved: true };
        next[row][3] = rook;
        next[row][0] = null;
      }
      next[row][4] = null;
    } else {
      if (move.enPassant) {
        const capturedRow = moverColor === 'w' ? move.to.r + 1 : move.to.r - 1;
        captured = next[capturedRow][move.to.c];
        next[capturedRow][move.to.c] = null;
      } else {
        captured = next[move.to.r][move.to.c];
      }
      next[move.to.r][move.to.c] = moving;
      if (move.promotion) next[move.to.r][move.to.c].type = move.promotion;
    }

    if (piece.type === 'P' && Math.abs(move.to.r - move.from.r) === 2) {
      const skipped = (move.from.r + move.to.r) / 2;
      nextEnPassant = { r: skipped, c: move.from.c };
    }

    return { board: next, enPassant: nextEnPassant, captured };
  }

  function generateLegalMoves(board, color, enPassant) {
    const legal = [];
    const pseudo = generatePseudoMoves(board, color, enPassant);
    for (const move of pseudo) {
      const applied = applyMove(board, move, enPassant);
      if (!isInCheck(applied.board, color)) legal.push(move);
    }
    return legal;
  }

  function hasLegalMoves(board, color, enPassant) {
    return generateLegalMoves(board, color, enPassant).length > 0;
  }

  function isCheckmate(board, color, enPassant) {
    return isInCheck(board, color) && !hasLegalMoves(board, color, enPassant);
  }

  function isStalemate(board, color, enPassant) {
    return !isInCheck(board, color) && !hasLegalMoves(board, color, enPassant);
  }

  function evaluateTerminalState(state) {
    const whiteKing = findKing(state.board, 'w');
    const blackKing = findKing(state.board, 'b');
    if (!whiteKing && blackKing) {
      return {
        isTerminal: true,
        winner: 'Black',
        result: 'kingCaptured',
        eventText: 'White king was captured. Black wins.',
      };
    }
    if (!blackKing && whiteKing) {
      return {
        isTerminal: true,
        winner: 'White',
        result: 'kingCaptured',
        eventText: 'Black king was captured. White wins.',
      };
    }
    if (!whiteKing && !blackKing) {
      return {
        isTerminal: true,
        winner: null,
        result: 'kingCaptured',
        eventText: 'Both kings are missing. Game over.',
      };
    }

    if (isCheckmate(state.board, state.turn, state.enPassant)) {
      return {
        isTerminal: true,
        winner: colorName(otherColor(state.turn)),
        result: null,
        eventText: `${colorName(state.turn)} is checkmated.`,
      };
    }

    if (isStalemate(state.board, state.turn, state.enPassant)) {
      return {
        isTerminal: true,
        winner: null,
        result: 'stalemate',
        eventText: 'Game ended in stalemate.',
      };
    }

    if (isSeventyFiveMoveRule(state)) {
      return {
        isTerminal: true,
        winner: null,
        result: 'seventyFiveMove',
        eventText: 'Game ended in a 75-move draw.',
      };
    }

    if (isFivefoldRepetition(state)) {
      return {
        isTerminal: true,
        winner: null,
        result: 'fivefold',
        eventText: 'Game ended in a fivefold repetition draw.',
      };
    }

    if (isInsufficientMaterial(state.board)) {
      return {
        isTerminal: true,
        winner: null,
        result: 'insufficientMaterial',
        eventText: 'Game ended in an insufficient material draw.',
      };
    }

    return { isTerminal: false };
  }

  function getDisambiguation(beforeBoard, beforeEnPassant, move) {
    const color = move.piece.color;
    const candidates = generateLegalMoves(beforeBoard, color, beforeEnPassant).filter((candidate) => {
      return (
        candidate.piece.type === move.piece.type &&
        candidate.piece.color === color &&
        candidate.to.r === move.to.r &&
        candidate.to.c === move.to.c &&
        !(candidate.from.r === move.from.r && candidate.from.c === move.from.c)
      );
    });

    if (!candidates.length) return '';

    const sameFile = candidates.some((candidate) => candidate.from.c === move.from.c);
    const sameRank = candidates.some((candidate) => candidate.from.r === move.from.r);
    if (!sameFile) return FILES[move.from.c];
    if (!sameRank) return String(8 - move.from.r);
    return `${FILES[move.from.c]}${8 - move.from.r}`;
  }

  function moveToSAN(beforeBoard, beforeEnPassant, move, afterBoard, afterEnPassant) {
    let text = '';
    if (move.castling) {
      text = move.castling === 'kingside' ? 'O-O' : 'O-O-O';
    } else if (move.piece.type === 'P') {
      if (move.capture) {
        text = `${FILES[move.from.c]}x${squareName(move.to)}`;
      } else {
        text = squareName(move.to);
      }
      if (move.promotion) text += `=${move.promotion}`;
    } else {
      const disambiguation = getDisambiguation(beforeBoard, beforeEnPassant, move);
      text = `${move.piece.type}${disambiguation}`;
      if (move.capture) text += 'x';
      text += squareName(move.to);
    }

    const opponent = otherColor(move.piece.color);
    if (isCheckmate(afterBoard, opponent, afterEnPassant)) text += '#';
    else if (isInCheck(afterBoard, opponent)) text += '+';

    return text;
  }

  function moveRejectionReason(state, from, to) {
    const piece = state.board[from.r][from.c];
    if (!piece) return 'No piece selected.';

    const pieceMovesToTarget = generatePseudoMovesForPiece(state.board, from.r, from.c, state.enPassant).filter((candidate) => {
      return candidate.to.r === to.r && candidate.to.c === to.c;
    });

    if (!pieceMovesToTarget.length) {
      if (piece.type === 'P') {
        const direction = piece.color === 'w' ? -1 : 1;
        const tcLeft = from.c - 1;
        const tcRight = from.c + 1;
        const forward = from.r + direction;

        if (inBounds(to.r, to.c) && (to.r !== forward || ![from.c, tcLeft, tcRight].includes(to.c))) {
          return 'Pawn can only move straight or one square diagonally when capturing.';
        }

        if (inBounds(forward, to.c)) {
          const target = state.board[forward][to.c];
          if (to.c === from.c && target) return 'Pawns cannot move forward into occupied squares.';
          if ((to.c === tcLeft || to.c === tcRight) && target && target.color === piece.color) {
            return 'That square has your own piece.';
          }
          if (
            Math.abs(to.c - from.c) === 1 &&
            Math.abs(to.r - from.r) === 1 &&
            !target &&
            !(state.enPassant && state.enPassant.r === to.r && state.enPassant.c === to.c)
          ) {
            return 'Nothing to capture on that square.';
          }
        }
      }

      if (piece.type === 'N') {
        const dr = Math.abs(to.r - from.r);
        const dc = Math.abs(to.c - from.c);
        if (!((dr === 2 && dc === 1) || (dr === 1 && dc === 2))) {
          return 'Knights move in an L-shape.';
        }
      }

      if (piece.type === 'R' || piece.type === 'B' || piece.type === 'Q') {
        const dr = to.r - from.r;
        const dc = to.c - from.c;
        const lineR = dr === 0;
        const lineC = dc === 0;
        const diag = Math.abs(dr) === Math.abs(dc);

        if (piece.type === 'R' && !(lineR || lineC)) {
          return 'Rooks move only horizontally or vertically.';
        }
        if (piece.type === 'B' && !diag) {
          return 'Bishops move only diagonally.';
        }
        if (piece.type === 'Q' && !(lineR || lineC || diag)) {
          return 'Queens move only horizontally, vertically, or diagonally.';
        }

        const stepR = Math.sign(dr);
        const stepC = Math.sign(dc);
        let r = from.r + stepR;
        let c = from.c + stepC;
        while (r !== to.r || c !== to.c) {
          if (state.board[r][c]) {
            return 'Path is blocked by another piece.';
          }
          r += stepR;
          c += stepC;
        }
      }

      if (piece.type === 'K') {
        const dr = Math.abs(to.r - from.r);
        const dc = Math.abs(to.c - from.c);
        if (dr <= 1 && dc <= 1) {
          if (state.board[to.r] && state.board[to.r][to.c] && state.board[to.r][to.c].color === piece.color) {
            return 'That square is occupied by your own piece.';
          }
        } else {
          return 'Kings move one square at a time.';
        }
      }
      return 'That destination is not a legal move for this piece.';
    }

    const targetMove = pieceMovesToTarget[0];
    const applied = applyMove(state.board, targetMove, state.enPassant);
    if (isInCheck(applied.board, piece.color)) {
      return 'This move is legal in movement terms but would leave your king in check.';
    }
    return 'Unknown rule conflict; move should normally be legal.';
  }

  const coreExports = {
    PROMOTION_OPTIONS,
    createInitialState,
    createInitialBoard,
    cloneBoard,
    inBounds,
    otherColor,
    colorName,
    squareName,
    createMove,
    findKing,
    squareIsAttacked,
    isInCheck,
    pieceToKeySymbol,
    castlingRightsFromBoard,
    positionKey,
    recordCurrentPosition,
    isThreefoldRepetition,
    isFivefoldRepetition,
    isFiftyMoveRule,
    isSeventyFiveMoveRule,
    isInsufficientMaterial,
    generatePseudoMovesForPiece,
    generatePseudoMoves,
    applyMove,
    generateLegalMoves,
    hasLegalMoves,
    isCheckmate,
    isStalemate,
    evaluateTerminalState,
    getDisambiguation,
    moveToSAN,
    moveRejectionReason,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = coreExports;
  } else if (typeof window !== 'undefined') {
    window.ChessCore = coreExports;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.ChessCore = coreExports;
  }
})();
