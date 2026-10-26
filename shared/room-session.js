(function installRoomSession() {
  const protocol = globalThis.BlendChessProtocol;
  const rl = globalThis.BlendChessRoomLogic;

  if (!protocol) throw new Error('shared/protocol.js must be loaded before room-session.js');
  if (!rl) throw new Error('shared/room-logic.js must be loaded before room-session.js');

  const { TYPES, ERROR_CODES, createMessage, createError } = protocol;

  // Message handling for one room, shared by the Node server and the Durable Object.
  //
  // A conn is the transport's per-socket record: { id, role, playerId, roomCode }.
  // hooks = {
  //   connections(): conns attached to this room,
  //   send(conn, message), close(conn, code, reason),
  //   save(conn): persist conn changes (a no-op unless the transport serializes them),
  //   makeResumeToken(),
  // }

  function isMember(state, conn) {
    if (conn.role === 'spectator') return Boolean(state.spectators[conn.id]);
    return conn.role === 'player' && Boolean(rl.getPlayer(state, conn.playerId));
  }

  function viewerOf(state, conn) {
    if (conn.role !== 'player') return { role: 'spectator', color: null };
    const player = rl.getPlayer(state, conn.playerId);
    return { role: 'player', color: player ? player.color : null };
  }

  function sendView(state, hooks, conn, type = TYPES.GAME_STATE, extra = {}) {
    hooks.send(conn, createMessage(type, state.roomCode, conn.playerId || '', {
      ...extra,
      game: rl.createView(state, viewerOf(state, conn)),
    }));
  }

  function broadcastViews(state, hooks, skipConnId = null) {
    for (const conn of hooks.connections()) {
      if (conn.id !== skipConnId && isMember(state, conn)) sendView(state, hooks, conn);
    }
  }

  function sendError(state, hooks, conn, errorCode, message) {
    hooks.send(conn, createError(state.roomCode, conn.playerId || '', errorCode, message));
  }

  function identityPayload(state, player) {
    return {
      roomCode: state.roomCode,
      role: 'player',
      playerId: player.id,
      color: player.color,
      resumeToken: player.resumeToken,
    };
  }

  function seatConn(state, hooks, conn, player) {
    conn.role = 'player';
    conn.playerId = player.id;
    conn.roomCode = state.roomCode;
    hooks.save(conn);
  }

  function createRoom(state, hooks, conn, payload = {}) {
    state.hardMode = Boolean(payload.hardMode);
    state.spectatorView = payload.spectatorView === 'open' ? 'open' : 'fog';
    const assigned = rl.assignPlayer(state, conn.id, payload.nickname, hooks.makeResumeToken);
    if (!assigned.ok) {
      sendError(state, hooks, conn, assigned.reason, 'Could not join the new room.');
      return false;
    }
    seatConn(state, hooks, conn, assigned.player);
    hooks.send(conn, createMessage(TYPES.ROOM_CREATED, state.roomCode, conn.playerId, identityPayload(state, assigned.player)));
    sendView(state, hooks, conn);
    return true;
  }

  function joinAsSpectator(state, hooks, conn, payload) {
    if (conn.role === 'player' && rl.getPlayer(state, conn.playerId)) {
      sendError(state, hooks, conn, ERROR_CODES.WRONG_COLOR, 'You already have a seat in this room.');
      return false;
    }
    rl.assignSpectator(state, conn.id, payload.nickname);
    conn.role = 'spectator';
    conn.playerId = '';
    conn.roomCode = state.roomCode;
    hooks.save(conn);
    hooks.send(conn, createMessage(TYPES.ROOM_JOINED, state.roomCode, '', {
      roomCode: state.roomCode,
      role: 'spectator',
      spectatorId: conn.id,
    }));
    broadcastViews(state, hooks);
    return true;
  }

  function joinRoom(state, hooks, conn, envelope) {
    const payload = envelope.payload || {};
    if (payload.spectator) return joinAsSpectator(state, hooks, conn, payload);

    let seatId = conn.id;
    if (payload.resume) {
      const requestedId = typeof envelope.playerId === 'string' ? envelope.playerId.trim() : '';
      const resumeToken = typeof payload.resumeToken === 'string' ? payload.resumeToken.trim() : '';
      if (!rl.isResumeTokenValid(state, requestedId, resumeToken)) {
        sendError(state, hooks, conn, ERROR_CODES.PLAYER_NOT_FOUND, 'Saved seat not found in this room.');
        return false;
      }
      // An older socket for the same seat (stale tab, half-dead connection) gets detached first,
      // so its eventual close doesn't mark the seat as disconnected.
      for (const other of hooks.connections()) {
        if (other.id !== conn.id && other.role === 'player' && other.playerId === requestedId) {
          other.role = null;
          other.playerId = '';
          hooks.save(other);
          hooks.close(other, 4000, 'Session resumed from another connection.');
        }
      }
      seatId = requestedId;
    } else if (conn.role === 'player' && rl.getPlayer(state, conn.playerId)) {
      seatId = conn.playerId;
    } else if (rl.hasReservedSeat(state)) {
      sendError(state, hooks, conn, ERROR_CODES.PLAYER_NOT_FOUND, 'A seat is reserved for a player who is reconnecting.');
      return false;
    }

    if (conn.role === 'spectator') rl.removeSpectator(state, conn.id);

    const assigned = rl.assignPlayer(state, seatId, payload.nickname, hooks.makeResumeToken);
    if (!assigned.ok) {
      sendError(state, hooks, conn, assigned.reason, 'Could not join the room.');
      return false;
    }

    seatConn(state, hooks, conn, assigned.player);
    hooks.send(conn, createMessage(TYPES.ROOM_JOINED, state.roomCode, conn.playerId, identityPayload(state, assigned.player)));
    broadcastViews(state, hooks);
    return true;
  }

  // Returns true when room state changed and should be persisted.
  function handleMessage(state, hooks, conn, envelope) {
    const { type } = envelope;
    const payload = envelope.payload || {};

    if (type === TYPES.PING) {
      hooks.send(conn, createMessage(TYPES.PONG, state.roomCode, conn.playerId || '', payload));
      return false;
    }

    if (!isMember(state, conn)) {
      sendError(state, hooks, conn, ERROR_CODES.WRONG_COLOR, 'Join the room first.');
      return false;
    }

    if (type === TYPES.GAME_STATE) {
      sendView(state, hooks, conn);
      return false;
    }

    if (conn.role === 'spectator') {
      sendError(state, hooks, conn, ERROR_CODES.WRONG_COLOR, 'Spectators cannot do that.');
      return false;
    }

    const player = rl.getPlayer(state, conn.playerId);
    rl.touchState(state);

    if (type === TYPES.MOVE_INTENT) {
      const result = rl.applyMove(state, player, payload);
      if (result.ok) {
        broadcastViews(state, hooks);
        return true;
      }
      sendView(state, hooks, conn, TYPES.MOVE_REJECTED, {
        reasonCode: result.reason,
        forfeited: Boolean(result.forfeited),
      });
      if (result.reason === ERROR_CODES.ILLEGAL_MOVE) {
        // Everyone hears the umpire say "illegal"; only the mover learns which squares.
        broadcastViews(state, hooks, conn.id);
        return true;
      }
      return false;
    }

    let result;
    if (type === TYPES.NEW_GAME) result = rl.newGame(state, player);
    else if (type === TYPES.SET_OPTIONS) result = rl.setOptions(state, player, payload);
    else if (type === TYPES.RESIGN) result = rl.resign(state, player);
    else if (type === TYPES.CLAIM_DRAW) {
      result = rl.claimDraw(state, player, payload);
      if (result.drawOffered && !result.alreadyOffered) result = { ok: true };
      else if (result.alreadyOffered) return false;
    } else {
      sendError(state, hooks, conn, ERROR_CODES.INVALID_PAYLOAD, `Unsupported message type: ${type}`);
      return false;
    }

    if (!result.ok) {
      sendView(state, hooks, conn, TYPES.MOVE_REJECTED, { reasonCode: result.reason, action: type });
      return false;
    }
    broadcastViews(state, hooks);
    return true;
  }

  // Returns true when room state changed.
  function handleClose(state, hooks, conn) {
    if (conn.role === 'spectator') {
      rl.removeSpectator(state, conn.id);
    } else if (conn.role === 'player' && rl.getPlayer(state, conn.playerId)) {
      rl.removePlayer(state, conn.playerId);
    } else {
      return false;
    }
    const closedId = conn.id;
    conn.role = null;
    conn.playerId = '';
    broadcastViews(state, hooks, closedId);
    return true;
  }

  const roomSessionExports = {
    isMember,
    viewerOf,
    createRoom,
    joinRoom,
    handleMessage,
    handleClose,
    broadcastViews,
  };

  globalThis.BlendChessRoomSession = roomSessionExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = roomSessionExports;
  }
})();
