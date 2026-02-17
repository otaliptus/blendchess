import http from 'node:http';
import { customAlphabet } from 'nanoid';
import { WebSocketServer } from 'ws';
import {
  ERROR_CODES,
  PROTOCOL_VERSION,
  TYPES,
  createError,
  createMessage,
  validateEnvelope,
} from './protocol.js';
import { Room } from './roomManager.js';

const PORT = Number(process.env.PORT || 3000);
const ROOM_TTL_MS = 1000 * 60 * 60;
const MAX_MESSAGE_BYTES = 16 * 1024;
const RATE_LIMIT_WINDOW_MS = 1_000;
const RATE_LIMIT_MAX_MESSAGES = 40;
const rooms = new Map();
const playerConnections = new Map();
const ROOM_CODE_MAX_LENGTH = 6;

const makeRoomCode = customAlphabet('ABCDEFGHJKLMNPQRSTUVWXYZ23456789', 6);
const makePlayerId = customAlphabet('abcdefghijklmnopqrstuvwxyz0123456789', 12);

function newRoomCode() {
  let roomCode;
  do {
    roomCode = makeRoomCode();
  } while (rooms.has(roomCode));
  return roomCode;
}

function getRoom(roomCode) {
  return rooms.get(roomCode) || null;
}

function createRoom() {
  const roomCode = newRoomCode();
  const room = new Room(roomCode);
  rooms.set(roomCode, room);
  return room;
}

function normalizeRoomCode(value) {
  return String(value || '')
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, '')
    .slice(0, ROOM_CODE_MAX_LENGTH);
}

function maybePruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    if (!room.hasConnectedMembers() && now - room.state.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}

function broadcast(room, messageFactory) {
  for (const playerId of room.state.playerOrder) {
    const player = room.getPlayer(playerId);
    if (!player || !player.connected) {
      continue;
    }

    const conn = getConnectionForTargetId(playerId);
    if (!conn || conn.ws.readyState !== 1) {
      continue;
    }

    const message = messageFactory(playerId, 'player');
    if (!message) {
      continue;
    }
    conn.ws.send(JSON.stringify(message));
  }

  for (const spectatorId of room.state.spectatorOrder) {
    const spectator = room.state.spectators[spectatorId];
    if (!spectator || !spectator.connected) {
      continue;
    }

    const conn = getConnectionForTargetId(spectatorId);
    if (!conn || conn.ws.readyState !== 1) {
      continue;
    }

    const message = messageFactory(spectatorId, 'spectator');
    if (!message) {
      continue;
    }
    conn.ws.send(JSON.stringify(message));
  }
}

function getConnectionForTargetId(targetId) {
  const direct = playerConnections.get(targetId);
  if (direct) {
    return direct;
  }

  for (const conn of playerConnections.values()) {
    if (conn.seatId && conn.seatId === targetId) {
      return conn;
    }
  }

  return null;
}

function sendTo(playerId, message) {
  const conn = getConnectionForTargetId(playerId);
  if (!conn || conn.ws.readyState !== 1) {
    return;
  }
  conn.ws.send(JSON.stringify(message));
}

function sendError(playerId, roomCode, errorCode, message) {
  sendTo(playerId, createError(roomCode, playerId, errorCode, message));
}

function buildJoinSnapshot(room, playerId) {
  const snapshot = room.createGameSnapshot();
  return createMessage(TYPES.GAME_STATE, room.state.roomCode, playerId, {
    game: snapshot,
  });
}

function parsePayload(message) {
  let parsed;
  try {
    parsed = JSON.parse(message.toString());
  } catch {
    throw ERROR_CODES.INVALID_PAYLOAD;
  }

  if (!validateEnvelope(parsed)) {
    throw ERROR_CODES.INVALID_PAYLOAD;
  }

  if (parsed.version !== PROTOCOL_VERSION) {
    throw ERROR_CODES.VERSION_MISMATCH;
  }

  return parsed;
}

function getActivePlayerId(connectionMeta, fallbackPlayerId) {
  return connectionMeta && connectionMeta.seatId ? connectionMeta.seatId : fallbackPlayerId;
}

function findConnectionBySeatId(seatId) {
  if (!seatId) {
    return null;
  }
  if (playerConnections.has(seatId)) {
    return playerConnections.get(seatId);
  }
  for (const conn of playerConnections.values()) {
    if (conn.seatId === seatId) {
      return conn;
    }
  }
  return null;
}

function leaveCurrentRoom(connectionMeta) {
  if (!connectionMeta || !connectionMeta.roomCode) {
    return false;
  }

  const room = getRoom(connectionMeta.roomCode);
  if (!room) {
    connectionMeta.roomCode = null;
    connectionMeta.role = null;
    connectionMeta.seatId = connectionMeta.playerId;
    return false;
  }

  const activePlayerId = getActivePlayerId(connectionMeta, connectionMeta.playerId);
  if (connectionMeta.role === 'spectator') {
    room.removeSpectator(activePlayerId);
  } else {
    room.removePlayer(activePlayerId);
  }

  broadcast(room, (targetId, targetRole) =>
    createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
      roomCode: room.state.roomCode,
      role: targetRole === 'spectator' ? 'spectator' : 'player',
      players: room.getSeatAssignments(),
      spectators: room.getSpectatorAssignments(),
      gameStarted: !room.state.waitingForStart,
    }),
  );

  connectionMeta.roomCode = null;
  connectionMeta.role = null;
  connectionMeta.seatId = connectionMeta.playerId;
  return true;
}

function getMessageByteLength(rawData) {
  if (typeof rawData === 'string') {
    return Buffer.byteLength(rawData);
  }
  if (rawData && typeof rawData.length === 'number') {
    return rawData.length;
  }
  if (rawData && typeof rawData.byteLength === 'number') {
    return rawData.byteLength;
  }
  return 0;
}

function isRateLimited(connectionMeta) {
  const now = Date.now();
  connectionMeta.recentMessages = connectionMeta.recentMessages.filter(
    (timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS,
  );
  if (connectionMeta.recentMessages.length >= RATE_LIMIT_MAX_MESSAGES) {
    return true;
  }
  connectionMeta.recentMessages.push(now);
  return false;
}

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Blendchess multiplayer server');
});

const wss = new WebSocketServer({
  server,
  maxPayload: MAX_MESSAGE_BYTES,
});

wss.on('connection', (ws) => {
  const playerId = makePlayerId();
  playerConnections.set(playerId, {
    ws,
    roomCode: null,
    playerId,
    seatId: playerId,
    role: null,
    recentMessages: [],
  });

  ws.on('message', (rawData) => {
    const senderMeta = playerConnections.get(playerId);
    if (!senderMeta) {
      return;
    }

    if (getMessageByteLength(rawData) > MAX_MESSAGE_BYTES) {
      sendError(playerId, senderMeta.roomCode || '', ERROR_CODES.INVALID_PAYLOAD, 'Message exceeds size limit.');
      return;
    }

    if (isRateLimited(senderMeta)) {
      sendError(playerId, senderMeta.roomCode || '', ERROR_CODES.RATE_LIMIT, 'Too many requests. Slow down.');
      return;
    }

    let envelope;
    try {
      envelope = parsePayload(rawData);
    } catch (errorCode) {
      const code = typeof errorCode === 'string' ? errorCode : ERROR_CODES.INVALID_PAYLOAD;
      const message = code === ERROR_CODES.VERSION_MISMATCH
        ? `Unsupported protocol version. Expected ${PROTOCOL_VERSION}.`
        : 'Invalid message envelope.';
      sendTo(playerId, createError('', playerId, code, message));
      return;
    }

    const roomCode = normalizeRoomCode(envelope.roomCode);
    const payload = envelope.payload || {};
    const type = envelope.type;

    if (type === TYPES.CREATE_ROOM) {
      const room = createRoom();
      const connectionMeta = playerConnections.get(playerId);
      if (connectionMeta?.roomCode) {
        leaveCurrentRoom(connectionMeta);
      }
      if (typeof payload.hardMode !== 'undefined') {
        room.state.hardMode = Boolean(payload.hardMode);
      }

      const assigned = room.assignPlayer(playerId, payload.nickname);
      if (!assigned.ok) {
        sendError(playerId, room.state.roomCode, assigned.reason, 'Could not join created room.');
        return;
      }

      connectionMeta.roomCode = room.state.roomCode;
      connectionMeta.role = 'player';
      connectionMeta.seatId = assigned.player.id;
      rooms.set(room.state.roomCode, room);

      sendTo(
        playerId,
        createMessage(TYPES.ROOM_CREATED, room.state.roomCode, connectionMeta.seatId, {
          roomCode: room.state.roomCode,
          role: 'player',
          playerColor: assigned.player.color,
          playerId: connectionMeta.seatId,
          resumeToken: assigned.player.resumeToken,
          players: room.getSeatAssignments(),
          spectators: room.getSpectatorAssignments(),
          gameStarted: !room.state.waitingForStart,
          game: room.createGameSnapshot(),
        }),
      );
      sendTo(playerId, createMessage(TYPES.PLAYER_ASSIGNED, room.state.roomCode, connectionMeta.seatId, {
        playerId: connectionMeta.seatId,
        color: assigned.player.color,
        nickname: assigned.player.nickname,
        resumeToken: assigned.player.resumeToken,
      }));
      sendTo(playerId, buildJoinSnapshot(room, connectionMeta.seatId));
      broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
          roomCode: room.state.roomCode,
          role: targetRole === 'spectator' ? 'spectator' : 'player',
          players: room.getSeatAssignments(),
          spectators: room.getSpectatorAssignments(),
          gameStarted: !room.state.waitingForStart,
        }),
      );
      return;
    }

    if (type === TYPES.JOIN_ROOM) {
      const room = getRoom(roomCode);
      if (!room) {
        sendError(playerId, roomCode, ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.');
        return;
      }

      const connectionMeta = playerConnections.get(playerId);
      if (connectionMeta?.roomCode && connectionMeta.roomCode !== room.state.roomCode) {
        leaveCurrentRoom(connectionMeta);
      }

      const requestedPlayerId = typeof envelope.playerId === 'string' ? envelope.playerId.trim() : '';
      const wantsResume = Boolean(payload && payload.resume);
      const resumeToken = typeof payload.resumeToken === 'string' ? payload.resumeToken.trim() : '';
      const hasDisconnectedSeat = room.state.playerOrder.some((seatId) => {
        const seatPlayer = room.getPlayer(seatId);
        return seatPlayer && seatPlayer.connected === false;
      });
      const gameInProgress = !room.state.gameOver
        && (room.state.movePairs.length > 0 || room.state.boardVersion > 0);

      if (payload.spectator) {
        if (room.getPlayer(connectionMeta?.seatId || '')) {
          sendError(
            playerId,
            room.state.roomCode,
            ERROR_CODES.WRONG_COLOR,
            'Already joined as player in this room. Leave first to spectate.',
          );
          return;
        }

        connectionMeta.roomCode = room.state.roomCode;
        connectionMeta.role = 'spectator';
        const assigned = room.assignSpectator(playerId, payload.nickname);
        if (!assigned.ok) {
          sendError(playerId, room.state.roomCode, assigned.reason || ERROR_CODES.ROOM_NOT_READY, 'Could not join room.');
          return;
        }
        connectionMeta.seatId = assigned.spectator.id;

        sendTo(
          playerId,
          createMessage(TYPES.ROOM_JOINED, room.state.roomCode, '', {
            roomCode: room.state.roomCode,
            role: 'spectator',
            spectatorId: assigned.spectator.id,
            players: room.getSeatAssignments(),
            spectators: room.getSpectatorAssignments(),
            gameStarted: !room.state.waitingForStart,
          }),
        );
        sendTo(
          playerId,
          createMessage(TYPES.GAME_STATE, room.state.roomCode, '', {
            game: room.createGameSnapshot(),
          }),
        );
        broadcast(room, (targetId, targetRole) =>
          createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
            roomCode: room.state.roomCode,
            role: targetRole === 'spectator' ? 'spectator' : 'player',
            players: room.getSeatAssignments(),
            spectators: room.getSpectatorAssignments(),
            gameStarted: !room.state.waitingForStart,
          }),
        );
        return;
      }

      if (!wantsResume && hasDisconnectedSeat && gameInProgress) {
        sendError(
          playerId,
          room.state.roomCode,
          ERROR_CODES.PLAYER_NOT_FOUND,
          'A player seat is reserved for reconnect. Resume your previous session to rejoin this game.',
        );
        return;
      }

      const selectedPlayerId = wantsResume && requestedPlayerId ? requestedPlayerId : playerId;
      if (wantsResume && requestedPlayerId) {
        if (!resumeToken || !room.isResumeTokenValid(requestedPlayerId, resumeToken)) {
          sendError(
            playerId,
            room.state.roomCode,
            ERROR_CODES.PLAYER_NOT_FOUND,
            'Saved player seat not found in this room.',
          );
          return;
        }

        const existingConnection = findConnectionBySeatId(requestedPlayerId);
        if (existingConnection && existingConnection !== playerConnections.get(playerId)) {
          try {
            existingConnection.ws.close(1000, 'Session resumed from another connection.');
          } catch {
            // no-op
          }
          if (existingConnection.playerId && existingConnection.playerId !== playerId) {
            playerConnections.delete(existingConnection.playerId);
          }
        }
      } else if (wantsResume) {
        sendError(
          playerId,
          room.state.roomCode,
          ERROR_CODES.PLAYER_NOT_FOUND,
          'Resume request requires playerId and resumeToken.',
        );
        return;
      }

      const assigned = room.assignPlayer(selectedPlayerId, payload.nickname);
      if (!assigned.ok) {
        sendError(playerId, roomCode, assigned.reason, 'Could not join room.');
        return;
      }

      connectionMeta.roomCode = room.state.roomCode;
      connectionMeta.role = 'player';
      connectionMeta.seatId = assigned.player.id;

      const seatAssignments = room.getSeatAssignments();
      sendTo(
        playerId,
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, connectionMeta.seatId, {
          roomCode: room.state.roomCode,
          role: 'player',
          players: seatAssignments,
          spectators: room.getSpectatorAssignments(),
          gameStarted: !room.state.waitingForStart,
        }),
      );
      sendTo(
        playerId,
        createMessage(TYPES.PLAYER_ASSIGNED, room.state.roomCode, connectionMeta.seatId, {
          playerId: connectionMeta.seatId,
          color: assigned.player.color,
          nickname: assigned.player.nickname,
          resumeToken: assigned.player.resumeToken,
        }),
      );
      sendTo(playerId, buildJoinSnapshot(room, connectionMeta.seatId));
      broadcast(room, (targetId, targetRole) =>
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
          roomCode: room.state.roomCode,
          role: targetRole === 'spectator' ? 'spectator' : 'player',
          players: room.getSeatAssignments(),
          spectators: room.getSpectatorAssignments(),
          gameStarted: !room.state.waitingForStart,
        }),
      );
      return;
    }

    const room = getRoom(roomCode);
    if (!room) {
      sendError(playerId, roomCode, ERROR_CODES.UNKNOWN_ROOM, 'Room does not exist.');
      return;
    }

    const connectionMeta = playerConnections.get(playerId);
    if (!connectionMeta || connectionMeta.roomCode !== room.state.roomCode) {
      sendError(playerId, roomCode, ERROR_CODES.WRONG_COLOR, 'No active membership in this room.');
      return;
    }
    const activePlayerId = getActivePlayerId(connectionMeta, playerId);

    if (type === TYPES.PING) {
      const replyRecipientId = connectionMeta.role === 'spectator' ? '' : activePlayerId;
      sendTo(playerId, createMessage(TYPES.PONG, room.state.roomCode, replyRecipientId, payload));
      return;
    }

    if (type === TYPES.GAME_STATE) {
      const replyRecipientId = connectionMeta.role === 'spectator' ? '' : activePlayerId;
      sendTo(playerId, buildJoinSnapshot(room, replyRecipientId));
      return;
    }

    if (connectionMeta.role === 'spectator') {
      sendError(
        playerId,
        room.state.roomCode,
        ERROR_CODES.WRONG_COLOR,
        'Spectators cannot perform that action.',
      );
      return;
    }

    if (type === TYPES.NEW_GAME) {
      if (room.getPlayer(activePlayerId)?.color !== 'w') {
        sendError(playerId, room.state.roomCode, ERROR_CODES.WRONG_COLOR, 'Only White may request new game.');
        return;
      }

      room.resetGame(true);
      broadcast(room, (targetId, targetRole) => buildJoinSnapshot(room, targetRole === 'spectator' ? '' : targetId));
      sendTo(activePlayerId, buildJoinSnapshot(room, activePlayerId));
      return;
    }

    if (type === TYPES.SET_HARD_MODE) {
      const player = room.getPlayer(activePlayerId);
      if (!player) {
        sendError(playerId, room.state.roomCode, ERROR_CODES.WRONG_COLOR, 'No active membership in this room.');
        return;
      }

      room.setHardMode(Boolean(payload.enabled), player.color === 'w' ? 'White' : 'Black');
      broadcast(
        room,
        (targetId, targetRole) => createMessage(TYPES.GAME_STATE, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
          game: room.createGameSnapshot(),
        }),
      );
      return;
    }

    if (type === TYPES.CLAIM_DRAW) {
      const result = room.claimDraw(activePlayerId, payload);
      if (!result.ok) {
        if (result.drawOffered) {
          // Broadcast draw offer to all players/spectators
          broadcast(room, (targetId) =>
            createMessage(TYPES.DRAW_OFFERED, room.state.roomCode, targetId, {
              offeredBy: result.offeredBy,
            }),
          );
        } else {
          sendTo(
            activePlayerId,
            createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, activePlayerId, {
              reasonCode: result.reason,
              moveIntent: payload,
            }),
          );
        }
        return;
      }

      broadcast(room, (targetId) =>
        createMessage(TYPES.DRAW_RESULT, room.state.roomCode, targetId, {
          reason: result.reason,
          game: result.game,
          winner: null,
        }),
      );
      return;
    }

    if (type === TYPES.RESIGN) {
      const result = room.resign(activePlayerId);
      if (!result.ok) {
        sendTo(
          activePlayerId,
          createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, activePlayerId, {
            reasonCode: result.reason,
            moveIntent: payload,
          }),
        );
        return;
      }

      broadcast(room, (targetId) =>
        createMessage(TYPES.RESIGN_RESULT, room.state.roomCode, targetId, {
          winner: result.winner,
          game: result.game,
        }),
      );
      return;
    }

    if (type === TYPES.MOVE_INTENT) {
      const result = room.applyMove(activePlayerId, payload);
      if (!result.ok) {
        sendTo(activePlayerId, createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, activePlayerId, {
          reasonCode: result.reason,
          forfeited: Boolean(result.forfeited),
          game: result.forfeited ? room.createGameSnapshot() : undefined,
          moveIntent: payload,
        }));
        if (result.forfeited || result.reason === ERROR_CODES.ILLEGAL_MOVE) {
          broadcast(room, (targetId, targetRole) =>
            targetRole === 'player' && targetId === activePlayerId
              ? null
              : createMessage(TYPES.GAME_STATE, room.state.roomCode, targetRole === 'spectator' ? '' : targetId, {
                game: room.createGameSnapshot(),
              }),
          );
        }
        return;
      }

      broadcast(room, (targetId) =>
        createMessage(TYPES.MOVE_APPLIED, room.state.roomCode, targetId, {
          move: result.move,
          san: result.san,
          nextTurn: result.nextTurn,
          game: room.createGameSnapshot(),
          moveNumber: result.moveNumber,
          boardVersion: result.boardVersion,
          repetitionCount: result.repetitionCount,
        }),
      );
      return;
    }

    sendError(playerId, room.state.roomCode, ERROR_CODES.INVALID_PAYLOAD, `Unsupported message type: ${type}`);
  });

  ws.on('close', () => {
    const meta = playerConnections.get(playerId);
    if (!meta || !meta.roomCode) {
      playerConnections.delete(playerId);
      return;
    }

    const room = getRoom(meta.roomCode);
    if (room) {
      leaveCurrentRoom(meta);
    }

    playerConnections.delete(playerId);
  });
});

setInterval(maybePruneRooms, 10_000);

server.listen(PORT, () => {
  console.log(`Blendchess server listening on ws://localhost:${PORT}`);
});
