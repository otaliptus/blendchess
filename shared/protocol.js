(function installBlendChessProtocol() {
  const PROTOCOL_VERSION = '1.0.0';

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
    DRAW_OFFERED: 'draw_offered',
    RESIGN: 'resign',
    RESIGN_RESULT: 'resign_result',
    NEW_GAME: 'new_game',
    ERROR: 'error',
    PING: 'ping',
    PONG: 'pong',
    GAME_OVER: 'game_over',
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

  const ROOM_LESS_TYPES = new Set([TYPES.CREATE_ROOM]);

  const DRAW_REASON_ALIASES = {
    threefold: 'threefold',
    fiftymove: 'fiftyMove',
    fiftymoverule: 'fiftyMove',
    seventyfivemove: 'seventyFiveMove',
    seventyfivemoverule: 'seventyFiveMove',
    fivefold: 'fivefold',
    insufficientmaterial: 'insufficientMaterial',
  };

  function createMessage(type, roomCode, playerId, payload) {
    return {
      type,
      roomCode,
      playerId,
      payload: payload || {},
      version: PROTOCOL_VERSION,
    };
  }

  function validateEnvelope(message) {
    if (!message || typeof message !== 'object') return false;
    if (typeof message.type !== 'string') return false;
    var type = message.type;
    if (!Object.values(TYPES).includes(type)) return false;

    if (!ROOM_LESS_TYPES.has(type)) {
      if (typeof message.roomCode !== 'string' || message.roomCode.length === 0) return false;
    }

    return true;
  }

  function createError(roomCode, playerId, errorCode, message) {
    return createMessage(TYPES.ERROR, roomCode, playerId, {
      errorCode: errorCode,
      message: message,
    });
  }

  var exports = {
    PROTOCOL_VERSION: PROTOCOL_VERSION,
    TYPES: TYPES,
    ERROR_CODES: ERROR_CODES,
    ROOM_LESS_TYPES: ROOM_LESS_TYPES,
    DRAW_REASON_ALIASES: DRAW_REASON_ALIASES,
    createMessage: createMessage,
    validateEnvelope: validateEnvelope,
    createError: createError,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = exports;
  } else if (typeof window !== 'undefined') {
    window.BlendChessProtocol = exports;
  } else if (typeof globalThis !== 'undefined') {
    globalThis.BlendChessProtocol = exports;
  }
})();
