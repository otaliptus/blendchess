(function installRoomLogic() {
  const core = globalThis.ChessCore;
  const protocol = globalThis.BlendChessProtocol;
  const facade = globalThis.BlendChessEngineFacade;

  if (!core) throw new Error('chess-core.js must be loaded before room-logic.js');
  if (!protocol) throw new Error('shared/protocol.js must be loaded before room-logic.js');
  if (!facade) throw new Error('shared/engine-facade.js must be loaded before room-logic.js');

  const ERROR_CODES = protocol.ERROR_CODES;
  const MAX_PLAYERS_PER_ROOM = 2;
  const MAX_EVENTS = 40;
  const NICKNAME_MAX_LENGTH = 16;
  const DRAW_REASON_PRIORITY = ['fivefold', 'seventyFiveMove', 'threefold', 'fiftyMove', 'insufficientMaterial'];

  function cleanNickname(value, fallback) {
    const text = String(value || '')
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .trim()
      .slice(0, NICKNAME_MAX_LENGTH);
    return text || fallback;
  }

  function normalizeSpectatorView(value) {
    return value === 'open' ? 'open' : 'fog';
  }

  function createRoomState(roomCode, options = {}) {
    const base = core.createInitialState();
    const now = Date.now();
    return {
      roomCode: roomCode || '',
      players: {},
      playerOrder: [],
      spectators: {},
      spectatorOrder: [],
      board: base.board,
      turn: base.turn,
      enPassant: base.enPassant,
      halfMoveClock: base.halfMoveClock,
      positionCounts: base.positionCounts,
      // One entry per ply, including forfeited turns, so colours always alternate.
      log: [],
      events: [],
      eventSeq: 0,
      captured: { w: 0, b: 0 },
      winner: null,
      result: null,
      gameOver: false,
      gameId: 1,
      // Never reset, not even by a new game, so clients can always drop stale snapshots.
      boardVersion: 0,
      pendingDrawOffer: null,
      waitingForStart: true,
      hardMode: Boolean(options.hardMode),
      spectatorView: normalizeSpectatorView(options.spectatorView),
      createdAt: now,
      lastActivity: now,
    };
  }

  function touchState(state) {
    state.lastActivity = Date.now();
  }

  // scope.only: visible to that colour alone. scope.owner + scope.secret: extra fields only the owner sees.
  // Everything becomes visible once the game is over.
  function addEvent(state, kind, data = {}, scope = {}) {
    state.eventSeq += 1;
    const event = { id: state.eventSeq, at: Date.now(), kind, ...data };
    if (scope.only) event.only = scope.only;
    if (scope.owner) {
      event.owner = scope.owner;
      event.secret = { ...scope.secret };
    }
    state.events.push(event);
    if (state.events.length > MAX_EVENTS) state.events.splice(0, state.events.length - MAX_EVENTS);
    return event;
  }

  function connectedPlayerCount(state) {
    return state.playerOrder.reduce((count, playerId) => {
      const player = state.players[playerId];
      return player && player.connected ? count + 1 : count;
    }, 0);
  }

  function connectedSpectatorCount(state) {
    return state.spectatorOrder.reduce((count, spectatorId) => {
      const spectator = state.spectators[spectatorId];
      return spectator && spectator.connected ? count + 1 : count;
    }, 0);
  }

  function isColorConnected(state, color) {
    return state.playerOrder.some((playerId) => {
      const player = state.players[playerId];
      return player && player.connected && player.color === color;
    });
  }

  function hasConnectedMembers(state) {
    return connectedPlayerCount(state) > 0 || connectedSpectatorCount(state) > 0;
  }

  function isGameInProgress(state) {
    return !state.gameOver && state.log.length > 0;
  }

  function hasReservedSeat(state) {
    if (!isGameInProgress(state)) return false;
    return state.playerOrder.some((playerId) => state.players[playerId] && !state.players[playerId].connected);
  }

  function cleanupDisconnectedColor(state, color) {
    const stale = state.playerOrder.filter((playerId) => {
      const player = state.players[playerId];
      return player && player.color === color && !player.connected;
    });
    if (!stale.length) return;
    state.playerOrder = state.playerOrder.filter((playerId) => !stale.includes(playerId));
    for (const playerId of stale) delete state.players[playerId];
  }

  function isFull(state) {
    return connectedPlayerCount(state) >= MAX_PLAYERS_PER_ROOM;
  }

  function isReady(state) {
    return connectedPlayerCount(state) === MAX_PLAYERS_PER_ROOM;
  }

  function getPlayer(state, playerId) {
    return (playerId && state.players[playerId]) || null;
  }

  function getPlayerByColor(state, color) {
    for (const playerId of state.playerOrder) {
      const player = state.players[playerId];
      if (player && player.color === color) return player;
    }
    return null;
  }

  function isResumeTokenValid(state, playerId, resumeToken) {
    const player = getPlayer(state, playerId);
    return Boolean(player && player.resumeToken && resumeToken && player.resumeToken === resumeToken);
  }

  function getSeatAssignments(state) {
    return state.playerOrder.map((playerId) => {
      const player = state.players[playerId];
      return {
        color: player.color,
        nickname: player.nickname,
        connected: player.connected,
      };
    });
  }

  function assignPlayer(state, playerId, nickname, makeResumeTokenFn) {
    touchState(state);

    if (state.spectators[playerId]) removeSpectator(state, playerId);

    const existing = getPlayer(state, playerId);
    if (existing) {
      const wasConnected = existing.connected;
      existing.connected = true;
      existing.nickname = cleanNickname(nickname, existing.nickname);
      existing.resumeToken = makeResumeTokenFn();
      state.waitingForStart = !isReady(state);
      if (!wasConnected) addEvent(state, 'presence', { color: existing.color, nickname: existing.nickname, online: true });
      return { ok: true, player: existing };
    }

    if (isFull(state)) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    const color = isColorConnected(state, 'w') ? 'b' : 'w';
    cleanupDisconnectedColor(state, color);

    const player = {
      id: playerId,
      color,
      nickname: cleanNickname(nickname, 'Player'),
      connected: true,
      resumeToken: makeResumeTokenFn(),
    };
    state.players[playerId] = player;
    state.playerOrder.push(playerId);
    state.waitingForStart = !isReady(state);
    addEvent(state, 'presence', { color, nickname: player.nickname, online: true });

    return { ok: true, player };
  }

  function assignSpectator(state, spectatorId, nickname) {
    touchState(state);
    const existing = state.spectators[spectatorId];
    if (existing) {
      existing.connected = true;
      existing.nickname = cleanNickname(nickname, existing.nickname);
      return { ok: true, spectator: existing };
    }

    const spectator = { id: spectatorId, nickname: cleanNickname(nickname, 'Spectator'), connected: true };
    state.spectators[spectatorId] = spectator;
    state.spectatorOrder.push(spectatorId);
    return { ok: true, spectator };
  }

  function removePlayer(state, playerId) {
    const player = getPlayer(state, playerId);
    if (!player) return;
    const wasConnected = player.connected;
    player.connected = false;
    state.waitingForStart = !isReady(state);
    touchState(state);
    if (wasConnected) addEvent(state, 'presence', { color: player.color, nickname: player.nickname, online: false });
  }

  function removeSpectator(state, spectatorId) {
    if (!state.spectators[spectatorId]) return;
    state.spectatorOrder = state.spectatorOrder.filter((id) => id !== spectatorId);
    delete state.spectators[spectatorId];
    touchState(state);
  }

  // Starts the next game in the same room. Players trade colours after a finished game.
  function resetGame(state, options = {}) {
    const fresh = createRoomState(state.roomCode, state);
    const keep = ['players', 'playerOrder', 'spectators', 'spectatorOrder', 'events', 'eventSeq', 'createdAt'];
    for (const key of keep) fresh[key] = state[key];
    fresh.gameId = state.gameId + 1;
    fresh.boardVersion = state.boardVersion + 1;
    fresh.waitingForStart = !isReady(state);

    if (options.swapColors) {
      for (const playerId of fresh.playerOrder) {
        const player = fresh.players[playerId];
        player.color = core.otherColor(player.color);
      }
    }

    Object.keys(state).forEach((key) => { delete state[key]; });
    Object.assign(state, fresh);
  }

  function newGame(state, player) {
    touchState(state);
    if (!player || !player.connected) return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    if (isGameInProgress(state)) return { ok: false, reason: ERROR_CODES.GAME_IN_PROGRESS };

    const swapColors = state.gameOver;
    resetGame(state, { swapColors });
    addEvent(state, 'new_game', { gameId: state.gameId, swapped: swapColors });
    return { ok: true };
  }

  function setOptions(state, player, options = {}) {
    touchState(state);
    if (!player || !player.connected) return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    if (isGameInProgress(state)) return { ok: false, reason: ERROR_CODES.GAME_IN_PROGRESS };

    if (typeof options.hardMode === 'boolean') state.hardMode = options.hardMode;
    if (typeof options.spectatorView === 'string') state.spectatorView = normalizeSpectatorView(options.spectatorView);
    addEvent(state, 'options', {
      color: player.color,
      hardMode: state.hardMode,
      spectatorView: state.spectatorView,
    });
    return { ok: true };
  }

  function normalizeDrawReason(reason) {
    if (typeof reason !== 'string') return '';
    const normalized = reason.trim().toLowerCase().replace(/[^a-z]/g, '');
    return protocol.DRAW_REASON_ALIASES[normalized] || '';
  }

  function evaluateDrawEligibility(state, requestedReason) {
    const claims = {
      fivefold: core.isFivefoldRepetition(state),
      seventyFiveMove: core.isSeventyFiveMoveRule(state),
      threefold: core.isThreefoldRepetition(state),
      fiftyMove: core.isFiftyMoveRule(state),
      insufficientMaterial: core.isInsufficientMaterial(state.board),
    };

    if (requestedReason) return claims[requestedReason] ? requestedReason : '';
    return DRAW_REASON_PRIORITY.find((reason) => claims[reason]) || '';
  }

  function finishGame(state, winner, result) {
    state.gameOver = true;
    state.winner = winner;
    state.result = result;
    state.pendingDrawOffer = null;
    addEvent(state, 'game_over', { winner, result });
  }

  function guardPlayerAction(state, player) {
    if (!player || !player.connected) return ERROR_CODES.WRONG_COLOR;
    if (state.gameOver) return ERROR_CODES.GAME_OVER;
    return '';
  }

  function claimDraw(state, player, payload) {
    touchState(state);
    const blocked = guardPlayerAction(state, player) || (isReady(state) ? '' : ERROR_CODES.ROOM_NOT_READY);
    if (blocked) return { ok: false, reason: blocked };

    const drawReason = evaluateDrawEligibility(state, normalizeDrawReason((payload || {}).reason));
    if (drawReason) {
      finishGame(state, null, drawReason);
      return { ok: true, reason: drawReason };
    }

    if (state.pendingDrawOffer && state.pendingDrawOffer !== player.color) {
      finishGame(state, null, 'mutualDraw');
      return { ok: true, reason: 'mutualDraw' };
    }

    if (state.pendingDrawOffer === player.color) {
      return { ok: false, reason: ERROR_CODES.INVALID_DRAW_CLAIM, drawOffered: true, alreadyOffered: true };
    }

    state.pendingDrawOffer = player.color;
    addEvent(state, 'draw_offer', { color: player.color });
    return { ok: false, reason: ERROR_CODES.INVALID_DRAW_CLAIM, drawOffered: true, offeredBy: player.color };
  }

  function resign(state, player) {
    touchState(state);
    const blocked = guardPlayerAction(state, player);
    if (blocked) return { ok: false, reason: blocked };

    addEvent(state, 'resign', { color: player.color });
    finishGame(state, core.colorName(core.otherColor(player.color)), 'resign');
    return { ok: true, winner: state.winner };
  }

  function squareText(position) {
    const r = Number(position && position.r);
    const c = Number(position && position.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 7 || c < 0 || c > 7) return 'unknown';
    return core.squareName({ r, c });
  }

  function attemptSecret(payload) {
    const normalized = facade.normalizeMoveIntent(payload);
    if (!normalized) return {};
    return { from: normalized.from, to: normalized.to, fromSquare: squareText(normalized.from), toSquare: squareText(normalized.to) };
  }

  // Bookkeeping shared by real moves and forfeited turns.
  function completePly(state, moverColor, ply) {
    state.log.push(ply);
    state.turn = core.otherColor(moverColor);
    state.boardVersion += 1;
    core.recordCurrentPosition(state);

    // Moving without answering is how a draw offer gets declined.
    if (state.pendingDrawOffer && state.pendingDrawOffer !== moverColor) {
      addEvent(state, 'draw_declined', { color: state.pendingDrawOffer });
      state.pendingDrawOffer = null;
    }

    const terminal = core.evaluateTerminalState(state);
    if (terminal.isTerminal) {
      finishGame(state, terminal.winner, terminal.result);
      return terminal;
    }

    if (core.isInCheck(state.board, state.turn)) {
      addEvent(state, 'check', { color: state.turn, directions: core.checkDirections(state.board, state.turn) }, { only: state.turn });
    }
    return terminal;
  }

  function applyMoveToRoom(state, player, payload) {
    touchState(state);

    if (!player) return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    if (!isReady(state)) return { ok: false, reason: ERROR_CODES.ROOM_NOT_READY };
    if (state.gameOver) return { ok: false, reason: ERROR_CODES.GAME_OVER };
    if (state.turn !== player.color) return { ok: false, reason: ERROR_CODES.NOT_YOUR_TURN };

    const outcome = facade.evaluateMove(state, player.color, payload);
    if (!outcome.ok) {
      if (outcome.reason !== ERROR_CODES.ILLEGAL_MOVE) return outcome;

      const secret = attemptSecret(payload);
      const inCheck = core.isInCheck(state.board, player.color);
      if (!state.hardMode || inCheck) {
        addEvent(state, 'illegal', { color: player.color }, { owner: player.color, secret });
        return { ok: false, reason: ERROR_CODES.ILLEGAL_MOVE };
      }

      // Hard mode: the turn passes. A double-step can't be answered en passant by a turn that never happened.
      addEvent(state, 'forfeit', { color: player.color }, { owner: player.color, secret });
      state.enPassant = null;
      state.halfMoveClock += 1;
      completePly(state, player.color, {
        color: player.color,
        san: '--',
        forfeit: true,
        from: secret.from || null,
        to: secret.to || null,
        promotion: null,
        capture: null,
      });
      return { ok: false, reason: ERROR_CODES.ILLEGAL_MOVE, forfeited: true, nextTurn: state.turn };
    }

    const beforeBoard = core.cloneBoard(state.board);
    const beforeEnPassant = state.enPassant ? { ...state.enPassant } : null;
    const move = outcome.move;

    state.board = outcome.board;
    state.enPassant = outcome.enPassant;

    let capture = null;
    if (outcome.captured) {
      state.captured[outcome.captured.color] += 1;
      const square = move.enPassant ? { r: move.from.r, c: move.to.c } : { ...move.to };
      capture = { r: square.r, c: square.c, square: core.squareName(square), color: outcome.captured.color };
    }

    state.halfMoveClock = outcome.isPawnMove || outcome.captured ? 0 : state.halfMoveClock + 1;

    const san = core.moveToSAN(beforeBoard, beforeEnPassant, move, state.board, state.enPassant);
    const ply = state.log.length + 1;
    addEvent(state, 'move', { color: player.color, ply }, {
      owner: player.color,
      secret: { san: stripCheckMarks(san), from: move.from, to: move.to },
    });
    if (capture) {
      addEvent(state, 'capture', { color: player.color, captured: capture.color, square: capture.square, r: capture.r, c: capture.c });
    }

    const terminal = completePly(state, player.color, {
      color: player.color,
      san,
      forfeit: false,
      from: { ...move.from },
      to: { ...move.to },
      promotion: move.promotion || null,
      capture,
    });

    return { ok: true, san, ply, terminal, nextTurn: state.turn };
  }

  // Check marks are the opponent's secret until the game ends.
  function stripCheckMarks(san) {
    return String(san || '').replace(/[+#]+$/, '');
  }

  function redactBoard(board, color) {
    return board.map((row) => row.map((piece) => (piece && piece.color === color ? { ...piece } : null)));
  }

  function viewEvent(event, color, reveal) {
    if (event.only && event.only !== color && !reveal) return null;
    const { only, owner, secret, ...visible } = event;
    if (secret && (reveal || owner === color)) Object.assign(visible, secret);
    return visible;
  }

  function viewPly(ply, index, color, reveal) {
    const mine = reveal || ply.color === color;
    return {
      ply: index + 1,
      color: ply.color,
      forfeit: Boolean(ply.forfeit),
      capture: ply.capture ? { square: ply.capture.square, r: ply.capture.r, c: ply.capture.c } : null,
      san: mine ? (reveal ? ply.san : stripCheckMarks(ply.san)) : null,
      from: mine && ply.from ? { ...ply.from } : null,
      to: mine && ply.to ? { ...ply.to } : null,
      promotion: mine ? ply.promotion : null,
    };
  }

  // What one member is allowed to know. viewer: { role: 'player' | 'spectator', color }.
  function createView(state, viewer = {}) {
    const role = viewer.role === 'player' ? 'player' : 'spectator';
    const color = role === 'player' && (viewer.color === 'w' || viewer.color === 'b') ? viewer.color : null;
    const reveal = state.gameOver || (role === 'spectator' && state.spectatorView === 'open');
    const inCheck = !state.gameOver && core.isInCheck(state.board, state.turn);

    return {
      roomCode: state.roomCode,
      gameId: state.gameId,
      boardVersion: state.boardVersion,
      you: { role, color },
      revealed: reveal,
      turn: state.turn,
      board: reveal ? core.cloneBoard(state.board) : redactBoard(state.board, color),
      moves: state.log.map((ply, index) => viewPly(ply, index, color, reveal)),
      events: state.events.map((event) => viewEvent(event, color, reveal)).filter(Boolean),
      captured: { w: state.captured.w, b: state.captured.b },
      check: inCheck && (reveal || state.turn === color)
        ? { color: state.turn, directions: core.checkDirections(state.board, state.turn) }
        : null,
      drawOffer: state.pendingDrawOffer,
      gameOver: state.gameOver,
      winner: state.winner,
      result: state.result,
      hardMode: state.hardMode,
      spectatorView: state.spectatorView,
      waitingForStart: state.waitingForStart,
      inProgress: isGameInProgress(state),
      players: getSeatAssignments(state),
      spectatorCount: connectedSpectatorCount(state),
    };
  }

  const PGN_TERMINATIONS = {
    checkmate: 'checkmate',
    resign: 'resignation',
    stalemate: 'stalemate',
    mutualDraw: 'draw agreed',
    threefold: 'threefold repetition',
    fivefold: 'fivefold repetition',
    fiftyMove: '50-move rule',
    seventyFiveMove: '75-move rule',
    insufficientMaterial: 'insufficient material',
    kingCaptured: 'king captured',
  };

  function pgnResult(winner, gameOver) {
    if (winner === 'White') return '1-0';
    if (winner === 'Black') return '0-1';
    return gameOver ? '1/2-1/2' : '*';
  }

  function pgnEscape(value) {
    return String(value || '').replace(/["\\]/g, '');
  }

  // Forfeited turns become null moves ("--") so colours keep alternating.
  function buildPgn(options) {
    const { moves = [], winner = null, gameOver = false, result = null } = options;
    const date = options.date ? new Date(options.date) : new Date();
    const dateTag = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    const resultTag = pgnResult(winner, gameOver);
    const headers = [
      ['Event', 'Blendchess game'],
      ['Site', options.site || 'Blendchess'],
      ['Date', dateTag],
      ['White', options.white || 'White'],
      ['Black', options.black || 'Black'],
      ['Result', resultTag],
      ['Variant', options.hardMode ? 'Blendchess (Kriegspiel, hard mode)' : 'Blendchess (Kriegspiel)'],
    ];
    if (result && PGN_TERMINATIONS[result]) headers.push(['Termination', PGN_TERMINATIONS[result]]);

    const tokens = [];
    moves.forEach((ply, index) => {
      if (index % 2 === 0) tokens.push(`${index / 2 + 1}.`);
      tokens.push(ply.forfeit ? '-- {turn forfeited}' : ply.san || '--');
    });
    tokens.push(resultTag);

    const lines = [];
    let line = '';
    for (const token of tokens) {
      if (line && line.length + token.length + 1 > 79) {
        lines.push(line);
        line = token;
      } else {
        line = line ? `${line} ${token}` : token;
      }
    }
    if (line) lines.push(line);

    return `${headers.map(([key, value]) => `[${key} "${pgnEscape(value)}"]`).join('\n')}\n\n${lines.join('\n')}\n`;
  }

  const roomLogicExports = {
    MAX_PLAYERS_PER_ROOM,
    cleanNickname,
    createRoomState,
    touchState,
    addEvent,
    connectedPlayerCount,
    connectedSpectatorCount,
    isColorConnected,
    hasConnectedMembers,
    isGameInProgress,
    hasReservedSeat,
    cleanupDisconnectedColor,
    isFull,
    isReady,
    getPlayer,
    getPlayerByColor,
    isResumeTokenValid,
    getSeatAssignments,
    assignPlayer,
    assignSpectator,
    removePlayer,
    removeSpectator,
    resetGame,
    newGame,
    setOptions,
    normalizeDrawReason,
    evaluateDrawEligibility,
    squareText,
    claimDraw,
    resign,
    applyMove: applyMoveToRoom,
    stripCheckMarks,
    createView,
    buildPgn,
  };

  globalThis.BlendChessRoomLogic = roomLogicExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = roomLogicExports;
  }
})();
