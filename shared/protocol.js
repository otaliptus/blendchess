(function installBlendChessProtocol() {
  // 2.x: the server sends every member its own redacted view of the game.
  const PROTOCOL_VERSION = '2.0.0';

  const TYPES = {
    CREATE_ROOM: 'create_room',
    ROOM_CREATED: 'room_created',
    JOIN_ROOM: 'join_room',
    ROOM_JOINED: 'room_joined',
    GAME_STATE: 'game_state',
    MOVE_INTENT: 'move_intent',
    MOVE_REJECTED: 'move_rejected',
    SET_OPTIONS: 'set_options',
    CLAIM_DRAW: 'claim_draw',
    RESIGN: 'resign',
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
    GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
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

  const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const ROOM_CODE_LENGTH = 6;

  function normalizeRoomCode(value) {
    return String(value || '')
      .trim()
      .toUpperCase()
      .replace(/[^A-Z0-9]/g, '')
      .slice(0, ROOM_CODE_LENGTH);
  }

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
    if (!Object.values(TYPES).includes(message.type)) return false;
    if (message.payload != null && typeof message.payload !== 'object') return false;

    if (!ROOM_LESS_TYPES.has(message.type)) {
      if (typeof message.roomCode !== 'string' || !normalizeRoomCode(message.roomCode)) return false;
    }

    return true;
  }

  // Shared by both backends: raw frame -> { ok, envelope } or { ok: false, code, message }.
  function parseEnvelope(raw) {
    let parsed;
    try {
      parsed = JSON.parse(String(raw));
    } catch {
      return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, message: 'Invalid JSON.' };
    }
    if (!validateEnvelope(parsed)) {
      return { ok: false, code: ERROR_CODES.INVALID_PAYLOAD, message: 'Invalid message envelope.' };
    }
    if (parsed.version !== PROTOCOL_VERSION) {
      return {
        ok: false,
        code: ERROR_CODES.VERSION_MISMATCH,
        message: `Unsupported protocol version. Expected ${PROTOCOL_VERSION}.`,
      };
    }
    parsed.payload = parsed.payload || {};
    if (!ROOM_LESS_TYPES.has(parsed.type)) parsed.roomCode = normalizeRoomCode(parsed.roomCode);
    return { ok: true, envelope: parsed };
  }

  function createError(roomCode, playerId, errorCode, message) {
    return createMessage(TYPES.ERROR, roomCode, playerId, {
      errorCode,
      message,
    });
  }

  const protocolExports = {
    PROTOCOL_VERSION,
    TYPES,
    ERROR_CODES,
    ROOM_LESS_TYPES,
    DRAW_REASON_ALIASES,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH,
    normalizeRoomCode,
    createMessage,
    validateEnvelope,
    parseEnvelope,
    createError,
  };

  globalThis.BlendChessProtocol = protocolExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = protocolExports;
  }
})();
