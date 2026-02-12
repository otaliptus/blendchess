import { createRequire } from 'node:module';
import { evaluateMove } from './chessEngineFacade.js';
import { ERROR_CODES } from './protocol.js';

const require = createRequire(import.meta.url);
const core = require('../chess-core.js');

const MAX_PLAYERS_PER_ROOM = 2;
const DRAW_REASON_PRIORITY = ['fivefold', 'seventyFiveMove', 'threefold', 'fiftyMove', 'insufficientMaterial'];
const DRAW_REASON_ALIASES = {
  threefold: 'threefold',
  fiftymove: 'fiftyMove',
  fiftymoverule: 'fiftyMove',
  seventyfivemove: 'seventyFiveMove',
  seventyfivemoverule: 'seventyFiveMove',
  fivefold: 'fivefold',
  insufficientmaterial: 'insufficientMaterial',
};

function createRoomState() {
  return {
    roomCode: '',
    players: {},
    playerOrder: [],
    board: null,
    turn: 'w',
    enPassant: null,
    halfMoveClock: 0,
    positionCounts: {},
    moveNumber: 1,
    movePairs: [],
    events: [],
    captured: { w: 0, b: 0 },
    winner: null,
    result: null,
    gameOver: false,
    boardVersion: 0,
    waitingForStart: true,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function touchState(state) {
  state.lastActivity = Date.now();
}

function addEvent(state, text) {
  const time = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
  state.events.unshift(`[${time}] ${text}`);
  state.events = state.events.slice(0, 20);
}

function addMoveRecord(state, color, san) {
  if (color === 'w') {
    state.movePairs.push({
      num: state.moveNumber,
      white: san,
      black: '',
    });
    return;
  }

  const last = state.movePairs[state.movePairs.length - 1];
  if (!last || last.black) {
    state.movePairs.push({
      num: state.moveNumber,
      white: '',
      black: san,
    });
  } else {
    last.black = san;
  }
  state.moveNumber += 1;
}

function normalizeDrawReason(reason) {
  if (typeof reason !== 'string') {
    return '';
  }
  const normalized = reason.trim().toLowerCase().replace(/[^a-z]/g, '');
  return DRAW_REASON_ALIASES[normalized] || '';
}

function evaluateDrawEligibility(state, requestedReason = '') {
  const claims = {
    fivefold: core.isFivefoldRepetition(state),
    seventyFiveMove: core.isSeventyFiveMoveRule(state),
    threefold: core.isThreefoldRepetition(state),
    fiftyMove: core.isFiftyMoveRule(state),
    insufficientMaterial: core.isInsufficientMaterial(state.board),
  };

  if (requestedReason) {
    return claims[requestedReason] ? requestedReason : '';
  }

  for (const reason of DRAW_REASON_PRIORITY) {
    if (claims[reason]) {
      return reason;
    }
  }
  return '';
}

export class Room {
  constructor(roomCode) {
    this.state = createRoomState();
    this.state.roomCode = roomCode;
    this.state = {
      ...this.state,
      ...core.createInitialState(),
    };
  }

  resetGame(keepAssignments = false) {
    const previousPlayers = keepAssignments ? this.state.players : {};
    const previousOrder = keepAssignments ? this.state.playerOrder : [];

    this.state = {
      ...createRoomState(),
      roomCode: this.state.roomCode,
      ...core.createInitialState(),
      players: previousPlayers,
      playerOrder: previousOrder,
    };
    this.state.waitingForStart = this.connectedPlayerCount() < MAX_PLAYERS_PER_ROOM;
  }

  get playerCount() {
    return this.state.playerOrder.length;
  }

  connectedPlayerCount() {
    return this.state.playerOrder.reduce((count, playerId) => {
      const player = this.state.players[playerId];
      return player && player.connected ? count + 1 : count;
    }, 0);
  }

  isColorConnected(color) {
    return this.state.playerOrder.some((playerId) => {
      const player = this.state.players[playerId];
      return player && player.connected && player.color === color;
    });
  }

  cleanupDisconnectedColor(color) {
    const stalePlayerIds = this.state.playerOrder.filter((playerId) => {
      const player = this.state.players[playerId];
      return player && player.color === color && !player.connected;
    });

    if (!stalePlayerIds.length) {
      return;
    }

    this.state.playerOrder = this.state.playerOrder.filter((playerId) => !stalePlayerIds.includes(playerId));
    for (const stalePlayerId of stalePlayerIds) {
      delete this.state.players[stalePlayerId];
    }
  }

  isFull() {
    return this.connectedPlayerCount() >= MAX_PLAYERS_PER_ROOM;
  }

  getPlayer(playerId) {
    return this.state.players[playerId] || null;
  }

  getPlayerByColor(color) {
    return Object.values(this.state.players).find((player) => player.color === color) || null;
  }

  getSeatAssignments() {
    return this.state.playerOrder.map((id) => {
      const player = this.state.players[id];
      return {
        playerId: player.id,
        color: player.color,
        nickname: player.nickname,
        connected: player.connected,
      };
    });
  }

  assignPlayer(playerId, nickname = 'Player') {
    touchState(this.state);

    const existing = this.getPlayer(playerId);
    if (existing) {
      existing.connected = true;
      existing.nickname = nickname || existing.nickname;
      return {
        ok: true,
        player: existing,
      };
    }

    if (this.isFull()) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    const color = this.isColorConnected('w') ? 'b' : 'w';
    this.cleanupDisconnectedColor(color);

    const player = {
      id: playerId,
      color,
      nickname: nickname || 'Player',
      connected: true,
    };
    this.state.players[playerId] = player;
    this.state.playerOrder.push(playerId);
    this.state.waitingForStart = this.connectedPlayerCount() < MAX_PLAYERS_PER_ROOM;

    return {
      ok: true,
      player,
    };
  }

  removePlayer(playerId) {
    const player = this.getPlayer(playerId);
    if (!player) {
      return;
    }

    player.connected = false;
    this.state.waitingForStart = this.connectedPlayerCount() < MAX_PLAYERS_PER_ROOM;
    touchState(this.state);
  }

  createGameSnapshot() {
    return {
      roomCode: this.state.roomCode,
      turn: this.state.turn,
      board: core.cloneBoard(this.state.board),
      enPassant: this.state.enPassant ? { ...this.state.enPassant } : null,
      moveNumber: this.state.moveNumber,
      movePairs: this.state.movePairs.map((movePair) => ({ ...movePair })),
      events: this.state.events.slice(),
      captured: { ...this.state.captured },
      winner: this.state.winner,
      result: this.state.result,
      gameOver: this.state.gameOver,
      boardVersion: this.state.boardVersion,
      halfMoveClock: this.state.halfMoveClock,
      positionCounts: { ...this.state.positionCounts },
      waitingForStart: this.state.waitingForStart,
      players: this.getSeatAssignments(),
    };
  }

  isReady() {
    return this.connectedPlayerCount() === MAX_PLAYERS_PER_ROOM;
  }

  claimDraw(playerId, payload = {}) {
    touchState(this.state);
    const player = this.getPlayer(playerId);
    if (!player || !player.connected) {
      return {
        ok: false,
        reason: ERROR_CODES.WRONG_COLOR,
      };
    }

    if (this.state.gameOver) {
      return {
        ok: false,
        reason: ERROR_CODES.GAME_OVER,
      };
    }

    if (!this.isReady()) {
      return {
        ok: false,
        reason: ERROR_CODES.ROOM_NOT_READY,
      };
    }

    const drawReason = evaluateDrawEligibility(this.state, normalizeDrawReason(payload.reason));
    if (!drawReason) {
      return {
        ok: false,
        reason: ERROR_CODES.INVALID_DRAW_CLAIM,
      };
    }

    this.state.gameOver = true;
    this.state.result = drawReason;
    this.state.winner = null;
    addEvent(this.state, `${core.colorName(player.color)} claimed a draw (${drawReason}).`);

    return {
      ok: true,
      reason: drawReason,
      game: this.createGameSnapshot(),
    };
  }

  resign(playerId) {
    touchState(this.state);
    const player = this.getPlayer(playerId);
    if (!player || !player.connected) {
      return {
        ok: false,
        reason: ERROR_CODES.WRONG_COLOR,
      };
    }

    if (this.state.gameOver) {
      return {
        ok: false,
        reason: ERROR_CODES.GAME_OVER,
      };
    }

    if (!this.isReady()) {
      return {
        ok: false,
        reason: ERROR_CODES.ROOM_NOT_READY,
      };
    }

    const winnerColor = core.otherColor(player.color);
    this.state.gameOver = true;
    this.state.winner = core.colorName(winnerColor);
    this.state.result = 'resign';
    addEvent(this.state, `${core.colorName(player.color)} resigned. ${this.state.winner} wins.`);

    return {
      ok: true,
      winner: this.state.winner,
      game: this.createGameSnapshot(),
    };
  }

  applyMove(playerId, payload) {
    touchState(this.state);

    const player = this.getPlayer(playerId);
    if (!player) {
      return {
        ok: false,
        reason: ERROR_CODES.WRONG_COLOR,
      };
    }

    if (!this.isReady()) {
      return {
        ok: false,
        reason: ERROR_CODES.ROOM_NOT_READY,
      };
    }

    if (this.state.gameOver) {
      return {
        ok: false,
        reason: ERROR_CODES.GAME_OVER,
      };
    }

    if (this.state.turn !== player.color) {
      return {
        ok: false,
        reason: ERROR_CODES.NOT_YOUR_TURN,
      };
    }

    const beforeBoard = core.cloneBoard(this.state.board);
    const beforeEnPassant = this.state.enPassant ? { ...this.state.enPassant } : null;

    const outcome = evaluateMove(this.state, player.color, payload);
    if (!outcome.ok) {
      return outcome;
    }

    this.state.board = outcome.board;
    this.state.enPassant = outcome.enPassant;

    if (outcome.captured) {
      this.state.captured[outcome.captured.color] += 1;
      const capturedColorName = outcome.captured.color === 'w' ? 'White' : 'Black';
      addEvent(this.state, `${capturedColorName} piece was taken.`);
    }

    if (outcome.isPawnMove || outcome.captured) {
      this.state.halfMoveClock = 0;
    } else {
      this.state.halfMoveClock += 1;
    }

    const san = core.moveToSAN(beforeBoard, beforeEnPassant, outcome.move, this.state.board, this.state.enPassant);
    addMoveRecord(this.state, player.color, san);

    this.state.turn = core.otherColor(player.color);
    this.state.boardVersion += 1;
    const repetitionCount = core.recordCurrentPosition(this.state);

    const terminal = core.evaluateTerminalState(this.state);
    if (terminal.isTerminal) {
      this.state.gameOver = true;
      this.state.result = terminal.result;
      this.state.winner = terminal.winner;
      if (terminal.eventText) {
        addEvent(this.state, terminal.eventText);
      }
    } else if (core.isInCheck(this.state.board, this.state.turn)) {
      addEvent(this.state, `${core.colorName(this.state.turn)} is in check.`);
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
      san,
      moveNumber: this.state.moveNumber,
      boardVersion: this.state.boardVersion,
      snapshot: this.createGameSnapshot(),
      repetitionCount,
      terminal,
      nextTurn: this.state.turn,
    };
  }
}
