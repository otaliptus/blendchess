import { DurableObject } from 'cloudflare:workers';

const core = globalThis.ChessCore;
if (!core) {
  throw new Error('chess-core.js must load before room.js');
}

const {
  createInitialState,
  generateLegalMoves,
  applyMove,
  isInCheck,
  colorName,
  squareName,
  otherColor,
  moveToSAN,
  cloneBoard,
  recordCurrentPosition,
  isThreefoldRepetition,
  isFivefoldRepetition,
  isFiftyMoveRule,
  isSeventyFiveMoveRule,
  isInsufficientMaterial,
  evaluateTerminalState,
  PROMOTION_OPTIONS,
} = core;

const PROTOCOL_VERSION = '1.0.0';
const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_MS = 1000 * 60 * 60;

const TYPES = {
  CREATE_ROOM: 'create_room',
  ROOM_CREATED: 'room_created',
  JOIN_ROOM: 'join_room',
  ROOM_JOINED: 'room_joined',
  PLAYER_ASSIGNED: 'player_assigned',
  GAME_STATE: 'game_state',
  MOVE_INTENT: 'move_intent',
  MOVE_APPLIED: 'move_applied',
  MOVE_REJECTED: 'move_rejected',
  SET_HARD_MODE: 'set_hard_mode',
  CLAIM_DRAW: 'claim_draw',
  DRAW_RESULT: 'draw_result',
  RESIGN: 'resign',
  RESIGN_RESULT: 'resign_result',
  NEW_GAME: 'new_game',
  ERROR: 'error',
  PING: 'ping',
  PONG: 'pong',
};

const ERROR_CODES = {
  INVALID_PAYLOAD: 'INVALID_PAYLOAD',
  UNKNOWN_ROOM: 'UNKNOWN_ROOM',
  ROOM_FULL: 'ROOM_FULL',
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  WRONG_COLOR: 'WRONG_COLOR',
  ILLEGAL_MOVE: 'ILLEGAL_MOVE',
  GAME_OVER: 'GAME_OVER',
  ROOM_NOT_READY: 'ROOM_NOT_READY',
  RATE_LIMIT: 'RATE_LIMIT',
  PLAYER_NOT_FOUND: 'PLAYER_NOT_FOUND',
  INVALID_DRAW_CLAIM: 'INVALID_DRAW_CLAIM',
  VERSION_MISMATCH: 'VERSION_MISMATCH',
};

const DRAW_REASON_ALIASES = {
  threefold: 'threefold',
  fiftymove: 'fiftyMove',
  fiftymoverule: 'fiftyMove',
  seventyfivemove: 'seventyFiveMove',
  seventyfivemoverule: 'seventyFiveMove',
  fivefold: 'fivefold',
  insufficientmaterial: 'insufficientMaterial',
};

function createMessage(type, roomCode, playerId, payload = {}) {
  return {
    type,
    roomCode,
    playerId,
    payload,
    version: PROTOCOL_VERSION,
  };
}

function createError(roomCode, playerId, errorCode, message) {
  return createMessage(TYPES.ERROR, roomCode, playerId, {
    errorCode,
    message,
  });
}

function normalizeRoomCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_LENGTH);
}

function makeRoomCode(rooms) {
  let next = '';
  do {
    next = '';
    for (let i = 0; i < ROOM_CODE_LENGTH; i += 1) {
      const index = Math.floor(Math.random() * ROOM_CODE_ALPHABET.length);
      next += ROOM_CODE_ALPHABET[index];
    }
  } while (rooms.has(next));
  return next;
}

function createRoomState(roomCode) {
  const base = createInitialState();
  return {
    roomCode,
    players: {},
    playerOrder: [],
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
    waitingForStart: true,
    hardMode: false,
    createdAt: Date.now(),
    lastActivity: Date.now(),
  };
}

function touchRoom(room) {
  room.lastActivity = Date.now();
}

function addEvent(room, text) {
  const time = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
  room.events.unshift(`[${time}] ${text}`);
  room.events = room.events.slice(0, 20);
}

function addMoveRecord(room, color, san) {
  if (color === 'w') {
    room.movePairs.push({
      num: room.moveNumber,
      white: san,
      black: '',
    });
    return;
  }

  const last = room.movePairs[room.movePairs.length - 1];
  if (!last || last.black) {
    room.movePairs.push({
      num: room.moveNumber,
      white: '',
      black: san,
    });
  } else {
    last.black = san;
  }
  room.moveNumber += 1;
}

function connectedPlayerCount(room) {
  return room.playerOrder.reduce((count, playerId) => {
    const player = room.players[playerId];
    return player && player.connected ? count + 1 : count;
  }, 0);
}

function isRoomReady(room) {
  return connectedPlayerCount(room) === 2;
}

function isColorConnected(room, color) {
  return room.playerOrder.some((playerId) => {
    const player = room.players[playerId];
    return player && player.connected && player.color === color;
  });
}

function cleanupDisconnectedColor(room, color) {
  const stale = room.playerOrder.filter((playerId) => {
    const player = room.players[playerId];
    return player && player.color === color && !player.connected;
  });

  if (!stale.length) {
    return;
  }

  room.playerOrder = room.playerOrder.filter((playerId) => !stale.includes(playerId));
  for (const playerId of stale) {
    delete room.players[playerId];
  }
}

function getSeatAssignments(room) {
  return room.playerOrder.map((playerId) => {
    const player = room.players[playerId];
    return {
      playerId: player.id,
      color: player.color,
      nickname: player.nickname,
      connected: player.connected,
    };
  });
}

function createGameSnapshot(room) {
  return {
    roomCode: room.roomCode,
    turn: room.turn,
    board: cloneBoard(room.board),
    enPassant: room.enPassant ? { ...room.enPassant } : null,
    moveNumber: room.moveNumber,
    movePairs: room.movePairs.map((movePair) => ({ ...movePair })),
    events: room.events.slice(),
    captured: { ...room.captured },
    winner: room.winner,
    result: room.result,
    gameOver: room.gameOver,
    boardVersion: room.boardVersion,
    halfMoveClock: room.halfMoveClock,
    positionCounts: { ...room.positionCounts },
    waitingForStart: room.waitingForStart,
    hardMode: Boolean(room.hardMode),
    players: getSeatAssignments(room),
  };
}

function normalizeDrawReason(value) {
  if (typeof value !== 'string') {
    return '';
  }
  const key = value.trim().toLowerCase().replace(/[^a-z]/g, '');
  return DRAW_REASON_ALIASES[key] || '';
}

function evaluateDrawEligibility(room, requestedReason = '') {
  const claims = {
    fivefold: isFivefoldRepetition(room),
    seventyFiveMove: isSeventyFiveMoveRule(room),
    threefold: isThreefoldRepetition(room),
    fiftyMove: isFiftyMoveRule(room),
    insufficientMaterial: isInsufficientMaterial(room.board),
  };

  if (requestedReason) {
    return claims[requestedReason] ? requestedReason : '';
  }

  if (claims.fivefold) return 'fivefold';
  if (claims.seventyFiveMove) return 'seventyFiveMove';
  if (claims.threefold) return 'threefold';
  if (claims.fiftyMove) return 'fiftyMove';
  if (claims.insufficientMaterial) return 'insufficientMaterial';
  return '';
}

function normalizeMoveIntent(payload) {
  if (!payload || !payload.from || !payload.to) {
    return null;
  }

  const from = {
    r: Number(payload.from.r),
    c: Number(payload.from.c),
  };
  const to = {
    r: Number(payload.to.r),
    c: Number(payload.to.c),
  };

  const validSquare = (value) => Number.isInteger(value) && value >= 0 && value < 8;
  if (!validSquare(from.r) || !validSquare(from.c) || !validSquare(to.r) || !validSquare(to.c)) {
    return null;
  }

  const promotion = payload.promotion ? String(payload.promotion).toUpperCase() : null;
  if (promotion && !PROMOTION_OPTIONS.includes(promotion)) {
    return null;
  }

  return {
    from,
    to,
    promotion,
  };
}

function createResetRoom(room) {
  const fresh = createRoomState(room.roomCode);
  fresh.players = room.players;
  fresh.playerOrder = room.playerOrder;
  fresh.waitingForStart = connectedPlayerCount(fresh) < 2;
  fresh.hardMode = Boolean(room.hardMode);
  return fresh;
}

export class GameHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.rooms = new Map();
    this.connections = new Map();
    this.ready = this.restore();
  }

  async restore() {
    const persisted = await this.ctx.storage.get('rooms');
    if (persisted && typeof persisted === 'object') {
      for (const [roomCode, room] of Object.entries(persisted)) {
        this.rooms.set(roomCode, room);
      }
    }
  }

  async persist() {
    const serialized = Object.fromEntries(this.rooms.entries());
    await this.ctx.storage.put('rooms', serialized);
  }

  pruneRooms() {
    const now = Date.now();
    for (const [roomCode, room] of this.rooms.entries()) {
      const hasConnected = room.playerOrder.some((playerId) => {
        const player = room.players[playerId];
        return player && player.connected;
      });
      if (!hasConnected && now - room.lastActivity > ROOM_TTL_MS) {
        this.rooms.delete(roomCode);
      }
    }
  }

  findConnectionByPlayerId(playerId) {
    for (const connection of this.connections.values()) {
      if (connection.playerId === playerId) {
        return connection;
      }
    }
    return null;
  }

  sendRaw(ws, message) {
    if (!ws || ws.readyState !== 1) {
      return;
    }
    ws.send(JSON.stringify(message));
  }

  sendToConnection(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }
    this.sendRaw(connection.ws, message);
  }

  sendToPlayer(playerId, message) {
    const connection = this.findConnectionByPlayerId(playerId);
    if (!connection) {
      return;
    }
    this.sendRaw(connection.ws, message);
  }

  sendErrorToConnection(connectionId, roomCode, playerId, errorCode, message) {
    this.sendToConnection(connectionId, createError(roomCode, playerId, errorCode, message));
  }

  broadcast(room, makeMessage) {
    for (const playerId of room.playerOrder) {
      const player = room.players[playerId];
      if (!player || !player.connected) {
        continue;
      }
      this.sendToPlayer(playerId, makeMessage(playerId));
    }
  }

  assignPlayer(room, connection, nickname = 'Player') {
    const currentPlayer = connection.playerId ? room.players[connection.playerId] : null;
    if (currentPlayer) {
      currentPlayer.connected = true;
      currentPlayer.nickname = nickname || currentPlayer.nickname;
      currentPlayer.connectionId = connection.id;
      connection.color = currentPlayer.color;
      return { ok: true, player: currentPlayer };
    }

    if (connectedPlayerCount(room) >= 2) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    const color = isColorConnected(room, 'w') ? 'b' : 'w';
    cleanupDisconnectedColor(room, color);

    const playerId = connection.id;
    const player = {
      id: playerId,
      color,
      nickname: nickname || 'Player',
      connected: true,
      connectionId: connection.id,
    };

    room.players[playerId] = player;
    room.playerOrder.push(playerId);
    room.waitingForStart = connectedPlayerCount(room) < 2;

    connection.playerId = playerId;
    connection.color = color;

    return { ok: true, player };
  }

  ensureRoom(roomCode) {
    const existing = this.rooms.get(roomCode);
    if (existing) {
      return existing;
    }
    return null;
  }

  validateEnvelope(connection, payloadText) {
    let envelope;
    try {
      envelope = JSON.parse(String(payloadText));
    } catch {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD, message: 'Invalid JSON payload.' };
    }

    if (!envelope || typeof envelope !== 'object' || typeof envelope.type !== 'string') {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD, message: 'Invalid message envelope.' };
    }

    const isKnownType = Object.values(TYPES).includes(envelope.type);
    if (!isKnownType) {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD, message: `Unsupported message type: ${envelope.type}` };
    }

    if (envelope.version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        reason: ERROR_CODES.VERSION_MISMATCH,
        message: `Unsupported protocol version. Expected ${PROTOCOL_VERSION}.`,
      };
    }

    if (envelope.type !== TYPES.CREATE_ROOM) {
      const roomCode = normalizeRoomCode(envelope.roomCode);
      if (!roomCode) {
        return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD, message: 'roomCode is required.' };
      }
      envelope.roomCode = roomCode;
    }

    if (connection.roomCode && envelope.roomCode && envelope.roomCode !== connection.roomCode) {
      return {
        ok: false,
        reason: ERROR_CODES.WRONG_COLOR,
        message: 'No active membership in this room.',
      };
    }

    return { ok: true, envelope };
  }

  applyMove(room, player, payload) {
    const normalized = normalizeMoveIntent(payload);
    if (!normalized) {
      return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD };
    }

    if (room.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }

    if (room.turn !== player.color) {
      return { ok: false, reason: ERROR_CODES.NOT_YOUR_TURN };
    }

    const legal = generateLegalMoves(room.board, player.color, room.enPassant);
    const candidate = legal.find((move) => {
      const sameFrom = move.from.r === normalized.from.r && move.from.c === normalized.from.c;
      const sameTo = move.to.r === normalized.to.r && move.to.c === normalized.to.c;
      if (!sameFrom || !sameTo) {
        return false;
      }
      if (normalized.promotion == null) {
        return move.promotion == null;
      }
      return move.promotion === normalized.promotion;
    });

    if (!candidate) {
      if (room.hardMode) {
        room.turn = otherColor(player.color);
        room.boardVersion += 1;
        addEvent(
          room,
          `${colorName(player.color)} attempted illegal move ${squareName(normalized.from)} to ${squareName(normalized.to)}. Turn forfeited by hard mode.`,
        );
        const terminal = evaluateTerminalState(room);
        if (terminal.isTerminal) {
          room.gameOver = true;
          room.result = terminal.result;
          room.winner = terminal.winner;
          if (terminal.eventText) {
            addEvent(room, terminal.eventText);
          }
        }
        return {
          ok: false,
          reason: ERROR_CODES.ILLEGAL_MOVE,
          forfeited: true,
          boardVersion: room.boardVersion,
          nextTurn: room.turn,
        };
      }
      return { ok: false, reason: ERROR_CODES.ILLEGAL_MOVE };
    }

    const beforeBoard = cloneBoard(room.board);
    const beforeEnPassant = room.enPassant ? { ...room.enPassant } : null;
    const outcome = applyMove(room.board, candidate, room.enPassant);

    room.board = outcome.board;
    room.enPassant = outcome.enPassant;

    if (outcome.captured) {
      room.captured[outcome.captured.color] += 1;
      addEvent(room, `${colorName(outcome.captured.color)} piece was taken.`);
    }

    if (outcome.captured || candidate.piece.type === 'P') {
      room.halfMoveClock = 0;
    } else {
      room.halfMoveClock += 1;
    }

    const san = moveToSAN(beforeBoard, beforeEnPassant, candidate, room.board, room.enPassant);
    addMoveRecord(room, player.color, san);

    room.turn = otherColor(player.color);
    room.boardVersion += 1;
    const repetitionCount = recordCurrentPosition(room);

    const terminal = evaluateTerminalState(room);
    if (terminal.isTerminal) {
      room.gameOver = true;
      room.result = terminal.result;
      room.winner = terminal.winner;
      if (terminal.eventText) {
        addEvent(room, terminal.eventText);
      }
    } else if (isInCheck(room.board, room.turn)) {
      addEvent(room, `${colorName(room.turn)} is in check.`);
    }

    return {
      ok: true,
      move: {
        from: candidate.from,
        to: candidate.to,
        piece: candidate.piece.type,
        capture: candidate.capture,
        castling: candidate.castling,
        enPassant: candidate.enPassant,
        promotion: candidate.promotion,
      },
      san,
      moveNumber: room.moveNumber,
      boardVersion: room.boardVersion,
      repetitionCount,
      nextTurn: room.turn,
    };
  }

  claimDraw(room, player, payload = {}) {
    if (room.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }

    if (!isRoomReady(room)) {
      return { ok: false, reason: ERROR_CODES.ROOM_NOT_READY };
    }

    const requestedReason = normalizeDrawReason(payload.reason);
    const drawReason = evaluateDrawEligibility(room, requestedReason);
    if (!drawReason) {
      return { ok: false, reason: ERROR_CODES.INVALID_DRAW_CLAIM };
    }

    room.gameOver = true;
    room.winner = null;
    room.result = drawReason;
    addEvent(room, `${colorName(player.color)} claimed a draw (${drawReason}).`);

    return { ok: true, reason: drawReason };
  }

  resign(room, player) {
    if (room.gameOver) {
      return { ok: false, reason: ERROR_CODES.GAME_OVER };
    }

    if (!isRoomReady(room)) {
      return { ok: false, reason: ERROR_CODES.ROOM_NOT_READY };
    }

    const winnerColor = otherColor(player.color);
    room.gameOver = true;
    room.winner = colorName(winnerColor);
    room.result = 'resign';
    addEvent(room, `${colorName(player.color)} resigned. ${room.winner} wins.`);

    return { ok: true, winner: room.winner };
  }

  async handleMessage(connectionId, payloadText) {
    await this.ready;
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    const parsed = this.validateEnvelope(connection, payloadText);
    if (!parsed.ok) {
      this.sendErrorToConnection(
        connectionId,
        connection.roomCode || '',
        connection.playerId || '',
        parsed.reason,
        parsed.message,
      );
      return;
    }

    const { envelope } = parsed;
    const payload = envelope.payload || {};
    const type = envelope.type;

    if (type === TYPES.PING) {
      this.sendToConnection(connectionId, createMessage(TYPES.PONG, connection.roomCode || '', connection.playerId || '', payload));
      return;
    }

    if (type === TYPES.CREATE_ROOM) {
      const roomCode = makeRoomCode(this.rooms);
      const room = createRoomState(roomCode);
      room.hardMode = Boolean(payload.hardMode);
      this.rooms.set(roomCode, room);

      connection.roomCode = roomCode;
      const assigned = this.assignPlayer(room, connection, payload.nickname || 'Player');
      if (!assigned.ok) {
        this.sendErrorToConnection(connectionId, roomCode, connection.playerId || '', assigned.reason, 'Could not join created room.');
        return;
      }

      touchRoom(room);
      room.waitingForStart = !isRoomReady(room);

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.ROOM_CREATED, roomCode, connection.playerId, {
          roomCode,
          playerColor: assigned.player.color,
          playerId: connection.playerId,
          players: getSeatAssignments(room),
          gameStarted: !room.waitingForStart,
          game: createGameSnapshot(room),
        }),
      );

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.PLAYER_ASSIGNED, roomCode, connection.playerId, {
          playerId: connection.playerId,
          color: assigned.player.color,
          nickname: assigned.player.nickname,
        }),
      );

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.GAME_STATE, roomCode, connection.playerId, {
          game: createGameSnapshot(room),
        }),
      );

      this.broadcast(room, (targetId) =>
        createMessage(TYPES.ROOM_JOINED, roomCode, targetId, {
          roomCode,
          players: getSeatAssignments(room),
          gameStarted: !room.waitingForStart,
        }),
      );

      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.JOIN_ROOM) {
      const room = this.ensureRoom(envelope.roomCode);
      if (!room) {
        this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.');
        return;
      }

      const requestedPlayerId = typeof envelope.playerId === 'string'
        ? envelope.playerId.trim()
        : '';
      const wantsResume = Boolean(payload && payload.resume);
      if (wantsResume && requestedPlayerId) {
        const existingSeat = room.players[requestedPlayerId];
        if (!existingSeat) {
          this.sendErrorToConnection(
            connectionId,
            envelope.roomCode,
            connection.playerId || '',
            ERROR_CODES.PLAYER_NOT_FOUND,
            'Saved player seat not found in this room.',
          );
          return;
        }

        const previousConnection = this.findConnectionByPlayerId(requestedPlayerId);
        if (previousConnection && previousConnection.id !== connectionId) {
          previousConnection.roomCode = '';
          previousConnection.playerId = '';
          previousConnection.color = null;
          this.connections.delete(previousConnection.id);
          try {
            previousConnection.ws.close(1000, 'Session resumed from another connection.');
          } catch {
            // no-op
          }
        }

        connection.playerId = requestedPlayerId;
      }

      connection.roomCode = envelope.roomCode;
      const assigned = this.assignPlayer(room, connection, payload.nickname || 'Player');
      if (!assigned.ok) {
        this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', assigned.reason, 'Could not join room.');
        return;
      }

      touchRoom(room);
      room.waitingForStart = !isRoomReady(room);

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.ROOM_JOINED, room.roomCode, connection.playerId, {
          roomCode: room.roomCode,
          players: getSeatAssignments(room),
          gameStarted: !room.waitingForStart,
        }),
      );

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.PLAYER_ASSIGNED, room.roomCode, connection.playerId, {
          playerId: connection.playerId,
          color: assigned.player.color,
          nickname: assigned.player.nickname,
        }),
      );

      this.sendToConnection(
        connectionId,
        createMessage(TYPES.GAME_STATE, room.roomCode, connection.playerId, {
          game: createGameSnapshot(room),
        }),
      );

      this.broadcast(room, (targetId) =>
        createMessage(TYPES.ROOM_JOINED, room.roomCode, targetId, {
          roomCode: room.roomCode,
          players: getSeatAssignments(room),
          gameStarted: !room.waitingForStart,
        }),
      );

      this.pruneRooms();
      await this.persist();
      return;
    }

    const room = connection.roomCode ? this.ensureRoom(connection.roomCode) : null;
    if (!room) {
      this.sendErrorToConnection(connectionId, envelope.roomCode || '', connection.playerId || '', ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.');
      return;
    }

    const player = connection.playerId ? room.players[connection.playerId] : null;
    if (!player || !player.connected) {
      this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId || '', ERROR_CODES.WRONG_COLOR, 'No active membership in this room.');
      return;
    }

    touchRoom(room);

    if (type === TYPES.GAME_STATE) {
      this.sendToConnection(
        connectionId,
        createMessage(TYPES.GAME_STATE, room.roomCode, connection.playerId, {
          game: createGameSnapshot(room),
        }),
      );
      await this.persist();
      return;
    }

    if (type === TYPES.NEW_GAME) {
      if (player.color !== 'w') {
        this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId, ERROR_CODES.WRONG_COLOR, 'Only White may request new game.');
        return;
      }

      const reset = createResetRoom(room);
      this.rooms.set(room.roomCode, reset);
      this.broadcast(reset, (targetId) =>
        createMessage(TYPES.GAME_STATE, reset.roomCode, targetId, {
          game: createGameSnapshot(reset),
        }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.SET_HARD_MODE) {
      if (player.color !== 'w') {
        this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId, ERROR_CODES.WRONG_COLOR, 'Only White may set hard mode.');
        return;
      }

      room.hardMode = Boolean(payload.enabled);
      addEvent(room, `Hard mode ${room.hardMode ? 'enabled' : 'disabled'} by White.`);
      this.broadcast(room, (targetId) =>
        createMessage(TYPES.GAME_STATE, room.roomCode, targetId, {
          game: createGameSnapshot(room),
        }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.CLAIM_DRAW) {
      const result = this.claimDraw(room, player, payload);
      if (!result.ok) {
        this.sendToConnection(
          connectionId,
          createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, {
            reasonCode: result.reason,
            moveIntent: payload,
          }),
        );
        return;
      }

      this.broadcast(room, (targetId) =>
        createMessage(TYPES.DRAW_RESULT, room.roomCode, targetId, {
          reason: result.reason,
          winner: null,
          game: createGameSnapshot(room),
        }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.RESIGN) {
      const result = this.resign(room, player);
      if (!result.ok) {
        this.sendToConnection(
          connectionId,
          createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, {
            reasonCode: result.reason,
            moveIntent: payload,
          }),
        );
        return;
      }

      this.broadcast(room, (targetId) =>
        createMessage(TYPES.RESIGN_RESULT, room.roomCode, targetId, {
          winner: result.winner,
          game: createGameSnapshot(room),
        }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.MOVE_INTENT) {
      if (!isRoomReady(room)) {
        this.sendToConnection(
          connectionId,
          createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, {
            reasonCode: ERROR_CODES.ROOM_NOT_READY,
            moveIntent: payload,
          }),
        );
        return;
      }

      const result = this.applyMove(room, player, payload);
      if (!result.ok) {
        this.sendToConnection(
          connectionId,
          createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, {
            reasonCode: result.reason,
            forfeited: Boolean(result.forfeited),
            game: result.forfeited ? createGameSnapshot(room) : undefined,
            moveIntent: payload,
          }),
        );
        if (result.forfeited) {
          for (const targetId of room.playerOrder) {
            if (targetId === connection.playerId) {
              continue;
            }
            const targetPlayer = room.players[targetId];
            if (!targetPlayer || !targetPlayer.connected) {
              continue;
            }
            this.sendToPlayer(
              targetId,
              createMessage(TYPES.GAME_STATE, room.roomCode, targetId, {
                game: createGameSnapshot(room),
              }),
            );
          }
          this.pruneRooms();
          await this.persist();
        }
        return;
      }

      this.broadcast(room, (targetId) =>
        createMessage(TYPES.MOVE_APPLIED, room.roomCode, targetId, {
          move: result.move,
          san: result.san,
          nextTurn: result.nextTurn,
          game: createGameSnapshot(room),
          moveNumber: result.moveNumber,
          boardVersion: result.boardVersion,
          repetitionCount: result.repetitionCount,
        }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId, ERROR_CODES.INVALID_PAYLOAD, `Unsupported message type: ${type}`);
  }

  async handleClose(connectionId) {
    await this.ready;
    const connection = this.connections.get(connectionId);
    if (!connection) {
      return;
    }

    if (connection.roomCode) {
      const room = this.ensureRoom(connection.roomCode);
      if (room && connection.playerId && room.players[connection.playerId]) {
        room.players[connection.playerId].connected = false;
        room.waitingForStart = !isRoomReady(room);
        touchRoom(room);
        this.broadcast(room, (targetId) =>
          createMessage(TYPES.ROOM_JOINED, room.roomCode, targetId, {
            roomCode: room.roomCode,
            players: getSeatAssignments(room),
            gameStarted: !room.waitingForStart,
          }),
        );
      }
    }

    this.connections.delete(connectionId);
    this.pruneRooms();
    await this.persist();
  }

  async fetch(request) {
    await this.ready;

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Expected WebSocket Upgrade', { status: 426 });
    }

    const pair = new WebSocketPair();
    const client = pair[0];
    const server = pair[1];

    const connectionId = crypto.randomUUID();
    server.accept();

    this.connections.set(connectionId, {
      id: connectionId,
      ws: server,
      roomCode: '',
      playerId: '',
      color: null,
    });

    server.addEventListener('message', (event) => {
      this.handleMessage(connectionId, event.data).catch(() => {
        this.handleClose(connectionId);
      });
    });

    server.addEventListener('close', () => {
      this.handleClose(connectionId).catch(() => {});
    });

    server.addEventListener('error', () => {
      this.handleClose(connectionId).catch(() => {});
    });

    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }
}
