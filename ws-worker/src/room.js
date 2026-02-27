import { DurableObject } from 'cloudflare:workers';

const core = globalThis.ChessCore;
if (!core) throw new Error('chess-core.js must load before room.js');

const protocol = globalThis.BlendChessProtocol;
if (!protocol) throw new Error('shared/protocol.js must load before room.js');

const rl = globalThis.BlendChessRoomLogic;
if (!rl) throw new Error('shared/room-logic.js must load before room.js');

const { TYPES, ERROR_CODES, PROTOCOL_VERSION, createMessage, createError } = protocol;

const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const ROOM_CODE_LENGTH = 6;
const ROOM_TTL_MS = 1000 * 60 * 60;
const RESUME_TOKEN_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';
const RESUME_TOKEN_LENGTH = 24;

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

function makeResumeToken() {
  const randomValues = new Uint32Array(RESUME_TOKEN_LENGTH);
  crypto.getRandomValues(randomValues);
  let token = '';
  for (const value of randomValues) {
    token += RESUME_TOKEN_ALPHABET[value % RESUME_TOKEN_ALPHABET.length];
  }
  return token;
}

function normalizeRoomState(room) {
  if (!room || typeof room !== 'object') return room;
  room.players = room.players || {};
  room.playerOrder = Array.isArray(room.playerOrder) ? room.playerOrder : [];
  room.spectators = room.spectators || {};
  room.spectatorOrder = Array.isArray(room.spectatorOrder) ? room.spectatorOrder : [];
  room.hardMode = Boolean(room.hardMode);
  return room;
}

function isResumeTokenValid(room, playerId, resumeToken) {
  const player = room.players[playerId];
  if (!player || !player.resumeToken) return false;
  return player.resumeToken === resumeToken;
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
        const normalized = normalizeRoomState(room);
        for (const playerId of normalized.playerOrder) {
          if (normalized.players[playerId]) {
            normalized.players[playerId].connected = false;
          }
        }
        for (const spectatorId of normalized.spectatorOrder || []) {
          if (normalized.spectators?.[spectatorId]) {
            normalized.spectators[spectatorId].connected = false;
          }
        }
        normalized.waitingForStart = true;
        this.rooms.set(roomCode, normalized);
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
      if (!rl.hasConnectedMembers(room) && now - room.lastActivity > ROOM_TTL_MS) {
        this.rooms.delete(roomCode);
      }
    }
  }

  findConnectionByPlayerId(playerId) {
    for (const connection of this.connections.values()) {
      if (connection.playerId === playerId) return connection;
    }
    return null;
  }

  sendRaw(ws, message) {
    if (!ws || ws.readyState !== 1) return;
    ws.send(JSON.stringify(message));
  }

  sendToConnection(connectionId, message) {
    const connection = this.connections.get(connectionId);
    if (!connection) return;
    this.sendRaw(connection.ws, message);
  }

  sendToPlayer(playerId, message) {
    const connection = this.findConnectionByPlayerId(playerId);
    if (!connection) return;
    this.sendRaw(connection.ws, message);
  }

  sendErrorToConnection(connectionId, roomCode, playerId, errorCode, message) {
    this.sendToConnection(connectionId, createError(roomCode, playerId, errorCode, message));
  }

  broadcast(room, makeMessage) {
    for (const playerId of room.playerOrder) {
      const player = room.players[playerId];
      if (!player || !player.connected) continue;
      const message = makeMessage(playerId, 'player');
      if (message) this.sendToPlayer(playerId, message);
    }

    for (const spectatorId of room.spectatorOrder || []) {
      const spectator = room.spectators[spectatorId];
      if (!spectator || !spectator.connected) continue;
      const message = makeMessage(spectatorId, 'spectator');
      if (!message) continue;
      this.sendToConnection(spectator.connectionId, message);
    }
  }

  assignPlayerToRoom(room, connection, nickname) {
    const currentPlayer = connection.playerId ? room.players[connection.playerId] : null;
    if (currentPlayer) {
      currentPlayer.connected = true;
      currentPlayer.nickname = nickname || currentPlayer.nickname;
      currentPlayer.connectionId = connection.id;
      currentPlayer.resumeToken = makeResumeToken();
      connection.color = currentPlayer.color;
      connection.role = 'player';
      room.waitingForStart = !rl.isReady(room);
      return { ok: true, player: currentPlayer };
    }

    if (rl.isFull(room)) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    const color = rl.isColorConnected(room, 'w') ? 'b' : 'w';
    rl.cleanupDisconnectedColor(room, color);

    if (rl.isColorConnected(room, color)) {
      return { ok: false, reason: ERROR_CODES.ROOM_FULL };
    }

    const playerId = connection.id;
    const player = {
      id: playerId,
      color,
      nickname: nickname || 'Player',
      connected: true,
      connectionId: connection.id,
      resumeToken: makeResumeToken(),
    };

    room.players[playerId] = player;
    room.playerOrder.push(playerId);
    room.waitingForStart = !rl.isReady(room);

    connection.playerId = playerId;
    connection.color = color;
    connection.role = 'player';

    return { ok: true, player };
  }

  assignSpectatorToRoom(room, connection, nickname) {
    const spectatorId = connection.id;
    const existing = room.spectators[spectatorId];
    if (existing) {
      existing.connected = true;
      existing.nickname = nickname || existing.nickname;
      existing.connectionId = connection.id;
    } else {
      room.spectators[spectatorId] = {
        id: spectatorId,
        nickname: nickname || 'Spectator',
        connected: true,
        connectionId: connection.id,
      };
      if (!room.spectatorOrder) room.spectatorOrder = [];
      room.spectatorOrder.push(spectatorId);
    }

    connection.role = 'spectator';
    connection.playerId = '';
    connection.color = null;
    return room.spectators[spectatorId];
  }

  ensureRoom(roomCode) {
    const existing = this.rooms.get(roomCode);
    if (existing) return normalizeRoomState(existing);
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
      return { ok: false, reason: ERROR_CODES.VERSION_MISMATCH, message: `Unsupported protocol version. Expected ${PROTOCOL_VERSION}.` };
    }

    if (envelope.type !== TYPES.CREATE_ROOM) {
      const roomCode = normalizeRoomCode(envelope.roomCode);
      if (!roomCode) {
        return { ok: false, reason: ERROR_CODES.INVALID_PAYLOAD, message: 'roomCode is required.' };
      }
      envelope.roomCode = roomCode;
    }

    if (connection.roomCode && envelope.roomCode && envelope.roomCode !== connection.roomCode) {
      return { ok: false, reason: ERROR_CODES.WRONG_COLOR, message: 'No active membership in this room.' };
    }

    return { ok: true, envelope };
  }

  async handleMessage(connectionId, payloadText) {
    await this.ready;
    const connection = this.connections.get(connectionId);
    if (!connection) return;

    const parsed = this.validateEnvelope(connection, payloadText);
    if (!parsed.ok) {
      this.sendErrorToConnection(connectionId, connection.roomCode || '', connection.playerId || '', parsed.reason, parsed.message);
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
      const room = rl.createRoomState(roomCode);
      room.hardMode = Boolean(payload.hardMode);
      this.rooms.set(roomCode, room);

      connection.roomCode = roomCode;
      const assigned = this.assignPlayerToRoom(room, connection, payload.nickname || 'Player');
      if (!assigned.ok) {
        this.sendErrorToConnection(connectionId, roomCode, connection.playerId || '', assigned.reason, 'Could not join created room.');
        return;
      }

      rl.touchState(room);

      this.sendToConnection(connectionId, createMessage(TYPES.ROOM_CREATED, roomCode, connection.playerId, {
        roomCode,
        role: 'player',
        playerColor: assigned.player.color,
        playerId: connection.playerId,
        players: rl.getSeatAssignments(room),
        spectators: rl.getSpectatorAssignments(room),
        resumeToken: assigned.player.resumeToken,
        gameStarted: !room.waitingForStart,
        game: rl.createGameSnapshot(room),
      }));

      this.sendToConnection(connectionId, createMessage(TYPES.PLAYER_ASSIGNED, roomCode, connection.playerId, {
        playerId: connection.playerId,
        color: assigned.player.color,
        nickname: assigned.player.nickname,
        resumeToken: assigned.player.resumeToken,
      }));

      this.sendToConnection(connectionId, createMessage(TYPES.GAME_STATE, roomCode, connection.playerId, {
        game: rl.createGameSnapshot(room),
      }));

      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.ROOM_JOINED, roomCode, targetRole === 'player' ? targetId : '', {
          roomCode,
          role: targetRole === 'spectator' ? 'spectator' : 'player',
          players: rl.getSeatAssignments(room),
          spectators: rl.getSpectatorAssignments(room),
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

      if (payload.spectator) {
        if (connection.playerId && room.players[connection.playerId]) {
          this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', ERROR_CODES.WRONG_COLOR, 'Already joined as player in this room. Leave first to spectate.');
          return;
        }

        connection.roomCode = envelope.roomCode;
        const spectator = this.assignSpectatorToRoom(room, connection, payload.nickname || 'Spectator');
        rl.touchState(room);

        this.sendToConnection(connectionId, createMessage(TYPES.ROOM_JOINED, room.roomCode, '', {
          roomCode: room.roomCode,
          role: 'spectator',
          spectatorId: spectator.id,
          players: rl.getSeatAssignments(room),
          spectators: rl.getSpectatorAssignments(room),
          gameStarted: !room.waitingForStart,
        }));

        this.sendToConnection(connectionId, createMessage(TYPES.GAME_STATE, room.roomCode, '', {
          game: rl.createGameSnapshot(room),
        }));

        this.broadcast(room, (targetId, targetRole) =>
          createMessage(TYPES.ROOM_JOINED, room.roomCode, targetRole === 'player' ? targetId : '', {
            roomCode: room.roomCode,
            role: targetRole === 'spectator' ? 'spectator' : 'player',
            players: rl.getSeatAssignments(room),
            spectators: rl.getSpectatorAssignments(room),
            gameStarted: !room.waitingForStart,
          }),
        );

        this.pruneRooms();
        await this.persist();
        return;
      }

      const requestedPlayerId = typeof envelope.playerId === 'string' ? envelope.playerId.trim() : '';
      const wantsResume = Boolean(payload && payload.resume);
      const resumeToken = typeof payload.resumeToken === 'string' ? payload.resumeToken.trim() : '';
      const hasDisconnectedSeat = room.playerOrder.some((seatId) => {
        const seatPlayer = room.players[seatId];
        return seatPlayer && seatPlayer.connected === false;
      });
      const gameInProgress = !room.gameOver && (room.movePairs.length > 0 || room.boardVersion > 0);

      if (wantsResume) {
        if (!requestedPlayerId || !resumeToken || !isResumeTokenValid(room, requestedPlayerId, resumeToken)) {
          this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', ERROR_CODES.PLAYER_NOT_FOUND, 'Saved player seat not found in this room.');
          return;
        }

        const previousConnection = this.findConnectionByPlayerId(requestedPlayerId);
        if (previousConnection && previousConnection.id !== connectionId) {
          previousConnection.roomCode = '';
          previousConnection.playerId = '';
          previousConnection.color = null;
          this.connections.delete(previousConnection.id);
          try { previousConnection.ws.close(1000, 'Session resumed from another connection.'); } catch { /* no-op */ }
        }

        connection.playerId = requestedPlayerId;
      }

      if (!wantsResume && hasDisconnectedSeat && gameInProgress) {
        this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', ERROR_CODES.PLAYER_NOT_FOUND, 'A player seat is reserved for reconnect. Resume your previous session to rejoin this game.');
        return;
      }

      connection.roomCode = envelope.roomCode;
      const assigned = this.assignPlayerToRoom(room, connection, payload.nickname || 'Player');
      if (!assigned.ok) {
        this.sendErrorToConnection(connectionId, envelope.roomCode, connection.playerId || '', assigned.reason, 'Could not join room.');
        return;
      }

      rl.touchState(room);

      this.sendToConnection(connectionId, createMessage(TYPES.ROOM_JOINED, room.roomCode, connection.playerId, {
        roomCode: room.roomCode,
        role: 'player',
        players: rl.getSeatAssignments(room),
        spectators: rl.getSpectatorAssignments(room),
        gameStarted: !room.waitingForStart,
      }));

      this.sendToConnection(connectionId, createMessage(TYPES.PLAYER_ASSIGNED, room.roomCode, connection.playerId, {
        playerId: connection.playerId,
        color: assigned.player.color,
        nickname: assigned.player.nickname,
        resumeToken: assigned.player.resumeToken,
      }));

      this.sendToConnection(connectionId, createMessage(TYPES.GAME_STATE, room.roomCode, connection.playerId, {
        game: rl.createGameSnapshot(room),
      }));

      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.ROOM_JOINED, room.roomCode, targetRole === 'player' ? targetId : '', {
          roomCode: room.roomCode,
          role: targetRole === 'spectator' ? 'spectator' : 'player',
          players: rl.getSeatAssignments(room),
          spectators: rl.getSpectatorAssignments(room),
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

    if (connection.role === 'spectator') {
      rl.touchState(room);
      if (type === TYPES.GAME_STATE) {
        this.sendToConnection(connectionId, createMessage(TYPES.GAME_STATE, room.roomCode, '', { game: rl.createGameSnapshot(room) }));
        await this.persist();
        return;
      }
      this.sendErrorToConnection(connectionId, room.roomCode, '', ERROR_CODES.WRONG_COLOR, 'Spectators cannot perform that action.');
      return;
    }

    const player = connection.playerId ? room.players[connection.playerId] : null;
    if (!player || !player.connected) {
      this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId || '', ERROR_CODES.WRONG_COLOR, 'No active membership in this room.');
      return;
    }

    rl.touchState(room);

    if (type === TYPES.GAME_STATE) {
      this.sendToConnection(connectionId, createMessage(TYPES.GAME_STATE, room.roomCode, connection.playerId, { game: rl.createGameSnapshot(room) }));
      await this.persist();
      return;
    }

    if (type === TYPES.NEW_GAME) {
      if (player.color !== 'w') {
        this.sendErrorToConnection(connectionId, room.roomCode, connection.playerId, ERROR_CODES.WRONG_COLOR, 'Only White may request new game.');
        return;
      }
      rl.resetGame(room);
      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.GAME_STATE, room.roomCode, targetRole === 'player' ? targetId : '', { game: rl.createGameSnapshot(room) }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.SET_HARD_MODE) {
      rl.setHardMode(room, Boolean(payload.enabled), core.colorName(player.color));
      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.GAME_STATE, room.roomCode, targetRole === 'player' ? targetId : '', { game: rl.createGameSnapshot(room) }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.CLAIM_DRAW) {
      const result = rl.claimDraw(room, player, payload);
      if (!result.ok) {
        if (result.drawOffered) {
          this.broadcast(room, (targetId, targetRole) =>
            createMessage(TYPES.DRAW_OFFERED, room.roomCode, targetRole === 'player' ? targetId : '', { offeredBy: result.offeredBy }),
          );
          await this.persist();
        } else {
          this.sendToConnection(connectionId, createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, { reasonCode: result.reason, moveIntent: payload }));
        }
        return;
      }
      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.DRAW_RESULT, room.roomCode, targetRole === 'player' ? targetId : '', { reason: result.reason, winner: null, game: rl.createGameSnapshot(room) }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.RESIGN) {
      const result = rl.resign(room, player);
      if (!result.ok) {
        this.sendToConnection(connectionId, createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, { reasonCode: result.reason, moveIntent: payload }));
        return;
      }
      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.RESIGN_RESULT, room.roomCode, targetRole === 'player' ? targetId : '', { winner: result.winner, game: rl.createGameSnapshot(room) }),
      );
      this.pruneRooms();
      await this.persist();
      return;
    }

    if (type === TYPES.MOVE_INTENT) {
      if (!rl.isReady(room)) {
        this.sendToConnection(connectionId, createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, { reasonCode: ERROR_CODES.ROOM_NOT_READY, moveIntent: payload }));
        return;
      }

      const result = rl.applyMove(room, player, payload);
      if (!result.ok) {
        this.sendToConnection(connectionId, createMessage(TYPES.MOVE_REJECTED, room.roomCode, connection.playerId, {
          reasonCode: result.reason,
          forfeited: Boolean(result.forfeited),
          game: result.forfeited ? rl.createGameSnapshot(room) : undefined,
          moveIntent: payload,
        }));
        if (result.forfeited || result.reason === ERROR_CODES.ILLEGAL_MOVE) {
          this.broadcast(room, (targetId, targetRole) => {
            if (targetRole === 'player' && targetId === connection.playerId) return null;
            return createMessage(TYPES.GAME_STATE, room.roomCode, targetRole === 'player' ? targetId : '', { game: rl.createGameSnapshot(room) });
          });
          this.pruneRooms();
          await this.persist();
        }
        return;
      }

      this.broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.MOVE_APPLIED, room.roomCode, targetRole === 'player' ? targetId : '', {
          move: result.move,
          san: result.san,
          nextTurn: result.nextTurn,
          game: rl.createGameSnapshot(room),
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
    if (!connection) return;

    if (connection.roomCode) {
      const room = this.ensureRoom(connection.roomCode);
      if (room) {
        if (connection.role === 'spectator') {
          const spectator = room.spectators?.[connection.id];
          if (spectator) spectator.connected = false;
          room.spectatorOrder = (room.spectatorOrder || []).filter((id) => id !== connection.id);
          delete room.spectators?.[connection.id];
        } else if (connection.playerId && room.players[connection.playerId]) {
          room.players[connection.playerId].connected = false;
          room.waitingForStart = !rl.isReady(room);
        }
        rl.touchState(room);
        this.broadcast(room, (targetId, targetRole) =>
          createMessage(TYPES.ROOM_JOINED, room.roomCode, targetRole === 'player' ? targetId : '', {
            roomCode: room.roomCode,
            role: targetRole === 'spectator' ? 'spectator' : 'player',
            players: rl.getSeatAssignments(room),
            spectators: rl.getSpectatorAssignments(room),
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
      role: 'player',
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

    return new Response(null, { status: 101, webSocket: client });
  }
}
