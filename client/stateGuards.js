(function initStateGuards(globalScope) {
  const VALID_COLORS = new Set(['w', 'b']);
  const VALID_PIECE_TYPES = new Set(['K', 'Q', 'R', 'B', 'N', 'P']);

  function hasKnownPieceType(pieceSymbols, color, type) {
    if (!pieceSymbols || typeof pieceSymbols !== 'object') {
      return VALID_PIECE_TYPES.has(type);
    }
    const colorMap = pieceSymbols[color];
    if (!colorMap || typeof colorMap !== 'object') {
      return false;
    }
    return Object.prototype.hasOwnProperty.call(colorMap, type);
  }

  function isValidHistoryPiece(piece, pieceSymbols = null) {
    if (!piece || typeof piece !== 'object') {
      return false;
    }
    if (!VALID_COLORS.has(piece.color) || typeof piece.type !== 'string') {
      return false;
    }
    if (!hasKnownPieceType(pieceSymbols, piece.color, piece.type)) {
      return false;
    }
    return typeof piece.hasMoved === 'boolean';
  }

  function isValidHistoryBoard(board, pieceSymbols = null) {
    if (!Array.isArray(board) || board.length !== 8) {
      return false;
    }
    return board.every((row) => (
      Array.isArray(row)
      && row.length === 8
      && row.every((piece) => piece === null || isValidHistoryPiece(piece, pieceSymbols))
    ));
  }

  function normalizeHistorySnapshot(rawSnapshot, cloneBoard, pieceSymbols = null) {
    if (!rawSnapshot || typeof rawSnapshot !== 'object') {
      return null;
    }
    if (typeof cloneBoard !== 'function') {
      return null;
    }
    if (!isValidHistoryBoard(rawSnapshot.board, pieceSymbols)) {
      return null;
    }
    return {
      ...rawSnapshot,
      board: cloneBoard(rawSnapshot.board),
    };
  }

  function shouldHydrateSnapshotVersion(incomingVersion, currentVersion) {
    if (Number.isInteger(incomingVersion) && Number.isInteger(currentVersion)) {
      return incomingVersion >= currentVersion;
    }
    return true;
  }

  const api = {
    isValidHistoryPiece,
    isValidHistoryBoard,
    normalizeHistorySnapshot,
    shouldHydrateSnapshotVersion,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  globalScope.BlendChessStateGuards = api;
})(typeof globalThis !== 'undefined' ? globalThis : window);
