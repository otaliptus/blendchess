(function installRoomLogic() {
  var core;
  if (typeof globalThis !== 'undefined' && globalThis.ChessCore) {
    core = globalThis.ChessCore;
  } else if (typeof window !== 'undefined' && window.ChessCore) {
    core = window.ChessCore;
  }

  var protocol;
  if (typeof globalThis !== 'undefined' && globalThis.BlendChessProtocol) {
    protocol = globalThis.BlendChessProtocol;
  } else if (typeof window !== 'undefined' && window.BlendChessProtocol) {
    protocol = window.BlendChessProtocol;
  }

  var facade;
  if (typeof globalThis !== 'undefined' && globalThis.BlendChessEngineFacade) {
    facade = globalThis.BlendChessEngineFacade;
  } else if (typeof window !== 'undefined' && window.BlendChessEngineFacade) {
    facade = window.BlendChessEngineFacade;
  }

  if (!core) throw new Error('chess-core.js must be loaded before room-logic.js');
  if (!protocol) throw new Error('shared/protocol.js must be loaded before room-logic.js');
  if (!facade) throw new Error('shared/engine-facade.js must be loaded before room-logic.js');

  var ERROR_CODES = protocol.ERROR_CODES;
  var evaluateMove = facade.evaluateMove;

  var MAX_PLAYERS_PER_ROOM = 2;
  var DRAW_REASON_PRIORITY = ['fivefold', 'seventyFiveMove', 'threefold', 'fiftyMove', 'insufficientMaterial'];
  var DRAW_REASON_ALIASES = protocol.DRAW_REASON_ALIASES;

  function createRoomState(roomCode) {
    var base = core.createInitialState();
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
      moveNumber: base.moveNumber,
      movePairs: base.movePairs,
      events: base.events,
      captured: base.captured,
      winner: base.winner,
      result: base.result,
      gameOver: base.gameOver,
      boardVersion: 0,
      pendingDrawOffer: null,
      waitingForStart: true,
      hardMode: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
    };
  }

  function touchState(state) {
    state.lastActivity = Date.now();
  }

  function addEvent(state, text) {
    var time = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
    state.events.unshift('[' + time + '] ' + text);
    state.events = state.events.slice(0, 20);
  }

  function addMoveRecord(state, color, san) {
    if (color === 'w') {
      state.movePairs.push({ num: state.moveNumber, white: san, black: '' });
      return;
    }

    var last = state.movePairs[state.movePairs.length - 1];
    if (!last || last.black) {
      state.movePairs.push({ num: state.moveNumber, white: '', black: san });
    } else {
      last.black = san;
    }
    state.moveNumber += 1;
  }

  function connectedPlayerCount(state) {
    return state.playerOrder.reduce(function (count, playerId) {
      var player = state.players[playerId];
      return player && player.connected ? count + 1 : count;
    }, 0);
  }

  function connectedSpectatorCount(state) {
    return (state.spectatorOrder || []).reduce(function (count, spectatorId) {
      var spectator = state.spectators[spectatorId];
      return spectator && spectator.connected ? count + 1 : count;
    }, 0);
  }

  function isColorConnected(state, color) {
    return state.playerOrder.some(function (playerId) {
      var player = state.players[playerId];
      return player && player.connected && player.color === color;
    });
  }

  function hasConnectedMembers(state) {
    return connectedPlayerCount(state) > 0 || connectedSpectatorCount(state) > 0;
  }

  function cleanupDisconnectedColor(state, color) {
    var stalePlayerIds = state.playerOrder.filter(function (playerId) {
      var player = state.players[playerId];
      return player && player.color === color && !player.connected;
    });

    if (!stalePlayerIds.length) return;

    state.playerOrder = state.playerOrder.filter(function (playerId) {
      return stalePlayerIds.indexOf(playerId) === -1;
    });
    for (var i = 0; i < stalePlayerIds.length; i++) {
      delete state.players[stalePlayerIds[i]];
    }
  }

  function isFull(state) {
    return connectedPlayerCount(state) >= MAX_PLAYERS_PER_ROOM;
  }

  function isReady(state) {
    return connectedPlayerCount(state) === MAX_PLAYERS_PER_ROOM;
  }

  function getPlayer(state, playerId) {
    return state.players[playerId] || null;
  }

  function getPlayerByColor(state, color) {
    for (var i = 0; i < state.playerOrder.length; i++) {
      var player = state.players[state.playerOrder[i]];
      if (player && player.color === color) return player;
    }
    return null;
  }

  function getSeatAssignments(state) {
    return state.playerOrder.map(function (id) {
      var player = state.players[id];
      return {
        playerId: player.id,
        color: player.color,
        nickname: player.nickname,
        connected: player.connected,
      };
    });
  }

  function getSpectatorAssignments(state) {
    return (state.spectatorOrder || []).map(function (spectatorId) {
      var spectator = state.spectators[spectatorId];
      return {
        spectatorId: spectator.id,
        nickname: spectator.nickname,
        connected: spectator.connected,
      };
    });
  }

  function assignPlayer(state, playerId, nickname, makeResumeTokenFn) {
    touchState(state);

    if (state.spectators[playerId]) {
      delete state.spectators[playerId];
      state.spectatorOrder = state.spectatorOrder.filter(function (id) { return id !== playerId; });
    }

    var existing = getPlayer(state, playerId);
    if (existing) {
      existing.connected = true;
      existing.nickname = nickname || existing.nickname;
      existing.resumeToken = makeResumeTokenFn();
      return { ok: true, player: existing };
    }

    var color = isColorConnected(state, 'w') ? 'b' : 'w';
    cleanupDisconnectedColor(state, color);

    if (isFull(state)) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    var newPlayer = {
      id: playerId,
      color: color,
      nickname: nickname || 'Player',
      connected: true,
      resumeToken: makeResumeTokenFn(),
    };
    state.players[playerId] = newPlayer;
    state.playerOrder.push(playerId);

    if (connectedPlayerCount(state) === MAX_PLAYERS_PER_ROOM) {
      state.waitingForStart = false;
    }

    return { ok: true, player: newPlayer };
  }

  function assignSpectator(state, spectatorId, nickname) {
    touchState(state);
    var existing = state.spectators[spectatorId];
    if (existing) {
      existing.connected = true;
      existing.nickname = nickname || existing.nickname;
      return { ok: true, spectator: existing };
    }

    var spectator = {
      id: spectatorId,
      nickname: nickname || 'Spectator',
      connected: true,
    };
    state.spectators[spectatorId] = spectator;
    if (!state.spectatorOrder) state.spectatorOrder = [];
    state.spectatorOrder.push(spectatorId);
    return { ok: true, spectator: spectator };
  }

  function removePlayer(state, playerId) {
    var player = getPlayer(state, playerId);
    if (player) {
      player.connected = false;
      state.waitingForStart = !isReady(state);
      touchState(state);
    }
  }

  function removeSpectator(state, spectatorId) {
    var spectator = state.spectators[spectatorId];
    if (spectator) {
      spectator.connected = false;
      state.spectatorOrder = (state.spectatorOrder || []).filter(function (id) { return id !== spectatorId; });
      delete state.spectators[spectatorId];
      touchState(state);
    }
  }

  function resetGame(state) {
    var previousPlayers = state.players;
    var previousOrder = state.playerOrder;
    var previousSpectators = state.spectators;
    var previousSpectatorOrder = state.spectatorOrder;
    var roomCode = state.roomCode;
    var hardMode = state.hardMode;

    var fresh = createRoomState(roomCode);
    fresh.players = previousPlayers;
    fresh.playerOrder = previousOrder;
    fresh.spectators = previousSpectators;
    fresh.spectatorOrder = previousSpectatorOrder;
    fresh.hardMode = hardMode;
    fresh.waitingForStart = connectedPlayerCount(fresh) < MAX_PLAYERS_PER_ROOM;

    // Copy all properties back onto state so callers keep their reference
    Object.keys(state).forEach(function (k) { delete state[k]; });
    Object.assign(state, fresh);
  }

  function createGameSnapshot(state) {
    return {
      roomCode: state.roomCode,
      turn: state.turn,
      board: core.cloneBoard(state.board),
      enPassant: state.enPassant ? { r: state.enPassant.r, c: state.enPassant.c } : null,
      moveNumber: state.moveNumber,
      movePairs: state.movePairs.map(function (movePair) { return Object.assign({}, movePair); }),
      events: state.events.slice(),
      captured: { w: state.captured.w, b: state.captured.b },
      winner: state.winner,
      result: state.result,
      gameOver: state.gameOver,
      boardVersion: state.boardVersion,
      hardMode: state.hardMode,
      halfMoveClock: state.halfMoveClock,
      positionCounts: Object.assign({}, state.positionCounts),
      waitingForStart: state.waitingForStart,
      players: getSeatAssignments(state),
      spectators: getSpectatorAssignments(state),
      spectatorCount: connectedSpectatorCount(state),
    };
  }

  function normalizeDrawReason(reason) {
    if (typeof reason !== 'string') return '';
    var normalized = reason.trim().toLowerCase().replace(/[^a-z]/g, '');
    return DRAW_REASON_ALIASES[normalized] || '';
  }

  function evaluateDrawEligibility(state, requestedReason) {
    var claims = {
      fivefold: core.isFivefoldRepetition(state),
      seventyFiveMove: core.isSeventyFiveMoveRule(state),
      threefold: core.isThreefoldRepetition(state),
      fiftyMove: core.isFiftyMoveRule(state),
      insufficientMaterial: core.isInsufficientMaterial(state.board),
    };

    if (requestedReason) {
      return claims[requestedReason] ? requestedReason : '';
    }

    for (var i = 0; i < DRAW_REASON_PRIORITY.length; i++) {
      if (claims[DRAW_REASON_PRIORITY[i]]) return DRAW_REASON_PRIORITY[i];
    }
    return '';
  }

  function squareText(position) {
    var r = Number(position && position.r);
    var c = Number(position && position.c);
    if (!Number.isInteger(r) || !Number.isInteger(c) || r < 0 || r > 7 || c < 0 || c > 7) {
      return 'unknown';
    }
    return core.squareName({ r: r, c: c });
  }

  function claimDraw(state, player, payload) {
    touchState(state);
    if (!player || !player.connected) {
      return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    }
    if (state.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }
    if (!isReady(state)) {
      return { ok: false, reason: ERROR_CODES.ROOM_NOT_READY };
    }

    var drawReason = evaluateDrawEligibility(state, normalizeDrawReason((payload || {}).reason));
    if (!drawReason) {
      if (state.pendingDrawOffer && state.pendingDrawOffer !== player.color) {
        state.pendingDrawOffer = null;
        state.gameOver = true;
        state.result = 'mutualDraw';
        state.winner = null;
        addEvent(state, 'Draw by mutual agreement.');
        return { ok: true, reason: 'mutualDraw', game: createGameSnapshot(state) };
      }
      state.pendingDrawOffer = player.color;
      addEvent(state, core.colorName(player.color) + ' offered a draw.');
      return {
        ok: false,
        reason: ERROR_CODES.INVALID_DRAW_CLAIM,
        drawOffered: true,
        offeredBy: player.color,
      };
    }

    state.gameOver = true;
    state.result = drawReason;
    state.winner = null;
    addEvent(state, core.colorName(player.color) + ' claimed a draw (' + drawReason + ').');
    return { ok: true, reason: drawReason, game: createGameSnapshot(state) };
  }

  function resign(state, player) {
    touchState(state);
    if (!player || !player.connected) {
      return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    }
    if (state.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }

    var winnerColor = core.otherColor(player.color);
    state.gameOver = true;
    state.winner = core.colorName(winnerColor);
    state.result = 'resign';
    addEvent(state, core.colorName(player.color) + ' resigned. ' + state.winner + ' wins.');
    return { ok: true, winner: state.winner, game: createGameSnapshot(state) };
  }

  function setHardMode(state, enabled, actorLabel) {
    state.hardMode = Boolean(enabled);
    addEvent(state, 'Hard mode ' + (state.hardMode ? 'enabled' : 'disabled') + ' by ' + actorLabel + '.');
  }

  function applyMoveToRoom(state, player, payload) {
    touchState(state);

    if (!player) {
      return { ok: false, reason: ERROR_CODES.WRONG_COLOR };
    }
    if (!isReady(state)) {
      return { ok: false, reason: ERROR_CODES.ROOM_NOT_READY };
    }
    if (state.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }
    if (state.turn !== player.color) {
      return { ok: false, reason: ERROR_CODES.NOT_YOUR_TURN };
    }

    var beforeBoard = core.cloneBoard(state.board);
    var beforeEnPassant = state.enPassant ? { r: state.enPassant.r, c: state.enPassant.c } : null;

    var outcome = evaluateMove(state, player.color, payload);
    if (!outcome.ok) {
      if (outcome.reason === ERROR_CODES.ILLEGAL_MOVE && state.hardMode) {
        var offenderInCheck = core.isInCheck(state.board, player.color);

        if (offenderInCheck) {
          addEvent(
            state,
            core.colorName(player.color) + ' attempted illegal move ' + squareText(payload.from) +
            ' to ' + squareText(payload.to) + ' while in check. Move rejected.',
          );
          return { ok: false, reason: ERROR_CODES.ILLEGAL_MOVE };
        }

        state.boardVersion += 1;
        state.turn = core.otherColor(player.color);
        addEvent(
          state,
          core.colorName(player.color) + ' attempted illegal move ' + squareText(payload.from) +
          ' to ' + squareText(payload.to) + '. Turn forfeited by hard mode.',
        );

        var terminal = core.evaluateTerminalState(state);
        if (terminal.isTerminal) {
          state.gameOver = true;
          state.result = terminal.result;
          state.winner = terminal.winner;
          if (terminal.eventText) addEvent(state, terminal.eventText);
        }

        return {
          ok: false,
          reason: ERROR_CODES.ILLEGAL_MOVE,
          forfeited: true,
          boardVersion: state.boardVersion,
          nextTurn: state.turn,
        };
      }

      if (outcome.reason === ERROR_CODES.ILLEGAL_MOVE) {
        addEvent(
          state,
          core.colorName(player.color) + ' attempted illegal move ' + squareText(payload.from) +
          ' to ' + squareText(payload.to) + '. Move rejected.',
        );
      }
      return outcome;
    }

    state.board = outcome.board;
    state.enPassant = outcome.enPassant;
    state.pendingDrawOffer = null;

    if (outcome.captured) {
      state.captured[outcome.captured.color] += 1;
      var capturedColorName = outcome.captured.color === 'w' ? 'White' : 'Black';
      addEvent(state, capturedColorName + ' piece was taken.');
    }

    if (outcome.isPawnMove || outcome.captured) {
      state.halfMoveClock = 0;
    } else {
      state.halfMoveClock += 1;
    }

    var san = core.moveToSAN(beforeBoard, beforeEnPassant, outcome.move, state.board, state.enPassant);
    addMoveRecord(state, player.color, san);

    state.turn = core.otherColor(player.color);
    state.boardVersion += 1;
    var repetitionCount = core.recordCurrentPosition(state);

    var terminalAfter = core.evaluateTerminalState(state);
    if (terminalAfter.isTerminal) {
      state.gameOver = true;
      state.result = terminalAfter.result;
      state.winner = terminalAfter.winner;
      if (terminalAfter.eventText) addEvent(state, terminalAfter.eventText);
    } else if (core.isInCheck(state.board, state.turn)) {
      addEvent(state, core.colorName(state.turn) + ' is in check.');
    }

    return {
      ok: true,
      move: {
        from: outcome.move.from,
        to: outcome.move.to,
        piece: outcome.move.piece.type,
        capture: outcome.move.capture,
        castling: outcome.move.castling,
        enPassant: outcome.move.enPassant,
        promotion: outcome.move.promotion,
      },
      san: san,
      moveNumber: state.moveNumber,
      boardVersion: state.boardVersion,
      snapshot: createGameSnapshot(state),
      repetitionCount: repetitionCount,
      terminal: terminalAfter,
      nextTurn: state.turn,
    };
  }

  var exports = {
    MAX_PLAYERS_PER_ROOM: MAX_PLAYERS_PER_ROOM,
    createRoomState: createRoomState,
    touchState: touchState,
    addEvent: addEvent,
    addMoveRecord: addMoveRecord,
    connectedPlayerCount: connectedPlayerCount,
    connectedSpectatorCount: connectedSpectatorCount,
    isColorConnected: isColorConnected,
    hasConnectedMembers: hasConnectedMembers,
    cleanupDisconnectedColor: cleanupDisconnectedColor,
    isFull: isFull,
    isReady: isReady,
    getPlayer: getPlayer,
    getPlayerByColor: getPlayerByColor,
    getSeatAssignments: getSeatAssignments,
    getSpectatorAssignments: getSpectatorAssignments,
    assignPlayer: assignPlayer,
    assignSpectator: assignSpectator,
    removePlayer: removePlayer,
    removeSpectator: removeSpectator,
    resetGame: resetGame,
    createGameSnapshot: createGameSnapshot,
    normalizeDrawReason: normalizeDrawReason,
    evaluateDrawEligibility: evaluateDrawEligibility,
    squareText: squareText,
    claimDraw: claimDraw,
    resign: resign,
    setHardMode: setHardMode,
    applyMove: applyMoveToRoom,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  } else if (typeof window !== 'undefined') {
    window.BlendChessRoomLogic = exports;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.BlendChessRoomLogic = exports;
  }
})();
