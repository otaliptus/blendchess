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

function maybePruneRooms() {
  const now = Date.now();
  for (const [code, room] of rooms.entries()) {
    const hasConnectedPlayers = room.state.playerOrder.some((id) => {
      const player = room.getPlayer(id);
      return player && player.connected;
    });

    if (!hasConnectedPlayers && now - room.state.lastActivity > ROOM_TTL_MS) {
      rooms.delete(code);
    }
  }
}

function broadcast(room, messageFactory) {
  for (const playerId of room.state.playerOrder) {
    const conn = playerConnections.get(playerId);
    if (!conn || conn.ws.readyState !== 1) {
      continue;
    }
    conn.ws.send(JSON.stringify(messageFactory(playerId)));
  }
}

function sendTo(playerId, message) {
  const conn = playerConnections.get(playerId);
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

    const roomCode = envelope.roomCode;
    const payload = envelope.payload || {};
    const type = envelope.type;

    if (type === TYPES.CREATE_ROOM) {
      const room = createRoom();
      const assigned = room.assignPlayer(playerId, payload.nickname);
      if (!assigned.ok) {
        sendError(playerId, room.state.roomCode, assigned.reason, 'Could not join created room.');
        return;
      }

      const connectionMeta = playerConnections.get(playerId);
      connectionMeta.roomCode = room.state.roomCode;
      rooms.set(room.state.roomCode, room);

      sendTo(
        playerId,
        createMessage(TYPES.ROOM_CREATED, room.state.roomCode, playerId, {
          roomCode: room.state.roomCode,
          playerColor: assigned.player.color,
          playerId,
          players: room.getSeatAssignments(),
          gameStarted: !room.state.waitingForStart,
          game: room.createGameSnapshot(),
        }),
      );
      sendTo(playerId, createMessage(TYPES.PLAYER_ASSIGNED, room.state.roomCode, playerId, {
        playerId,
        color: assigned.player.color,
        nickname: assigned.player.nickname,
      }));
      sendTo(playerId, buildJoinSnapshot(room, playerId));
      broadcast(room, (targetId) =>
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetId, {
          roomCode: room.state.roomCode,
          players: room.getSeatAssignments(),
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

      const assigned = room.assignPlayer(playerId, payload.nickname);
      if (!assigned.ok) {
        sendError(playerId, roomCode, assigned.reason, 'Could not join room.');
        return;
      }

      const connectionMeta = playerConnections.get(playerId);
      connectionMeta.roomCode = room.state.roomCode;

      const seatAssignments = room.getSeatAssignments();
      sendTo(
        playerId,
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, playerId, {
          roomCode: room.state.roomCode,
          players: seatAssignments,
          gameStarted: !room.state.waitingForStart,
        }),
      );
      sendTo(
        playerId,
        createMessage(TYPES.PLAYER_ASSIGNED, room.state.roomCode, playerId, {
          playerId,
          color: assigned.player.color,
          nickname: assigned.player.nickname,
        }),
      );
      sendTo(playerId, buildJoinSnapshot(room, playerId));
      broadcast(room, (targetId) =>
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetId, {
          roomCode: room.state.roomCode,
          players: seatAssignments,
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

    if (type === TYPES.PING) {
      sendTo(playerId, createMessage(TYPES.PONG, room.state.roomCode, playerId, payload));
      return;
    }

    if (type === TYPES.GAME_STATE) {
      sendTo(playerId, buildJoinSnapshot(room, playerId));
      return;
    }

    if (type === TYPES.NEW_GAME) {
      if (room.getPlayer(playerId)?.color !== 'w') {
        sendError(playerId, room.state.roomCode, ERROR_CODES.WRONG_COLOR, 'Only White may request new game.');
        return;
      }

      room.resetGame(true);
      broadcast(room, (targetId) => buildJoinSnapshot(room, targetId));
      sendTo(playerId, buildJoinSnapshot(room, playerId));
      return;
    }

    if (type === TYPES.CLAIM_DRAW) {
      const result = room.claimDraw(playerId, payload);
      if (!result.ok) {
        sendTo(
          playerId,
          createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, playerId, {
            reasonCode: result.reason,
            moveIntent: payload,
          }),
        );
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
      const result = room.resign(playerId);
      if (!result.ok) {
        sendTo(
          playerId,
          createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, playerId, {
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
      const result = room.applyMove(playerId, payload);
      if (!result.ok) {
        sendTo(
          playerId,
          createMessage(TYPES.MOVE_REJECTED, room.state.roomCode, playerId, {
            reasonCode: result.reason,
            moveIntent: payload,
          }),
        );
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
      room.removePlayer(playerId);
      broadcast(room, (targetId) =>
        createMessage(TYPES.ROOM_JOINED, room.state.roomCode, targetId, {
          roomCode: room.state.roomCode,
          players: room.getSeatAssignments(),
          gameStarted: !room.state.waitingForStart,
        }),
      );
    }

    playerConnections.delete(playerId);
  });
});

setInterval(maybePruneRooms, 10_000);

server.listen(PORT, () => {
  console.log(`Blendchess server listening on ws://localhost:${PORT}`);
});
