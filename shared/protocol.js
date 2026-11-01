(function installBlendChessProtocol() {
  // 2.x: the server sends every member its own redacted view of the game.
  const PROTOCOL_VERSION = '2.0.0';
  // Increase only for an intentional full data reset. Ordinary releases keep this unchanged.
  // Version 1 adopts all data written before release resets existed. Never decrease it.
  const DATA_VERSION = 1;
  const DATA_RESET_CLOSE_CODE = 4002;

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
    // Ranked lobby. Additive: a 2.0 room server ignores nothing, it just never sends these.
    LOBBY_HELLO: 'lobby_hello',
    LOBBY_READY: 'lobby_ready',
    LOBBY_QUEUE: 'lobby_queue',
    LOBBY_QUEUED: 'lobby_queued',
    LOBBY_CANCEL: 'lobby_cancel',
    LOBBY_CANCELLED: 'lobby_cancelled',
    LOBBY_ERROR: 'lobby_error',
    LOBBY_RATING: 'lobby_rating',
    MATCH_FOUND: 'match_found',
    // Playing a friend: an invite is a private place in the lobby, matched by its code.
    LOBBY_INVITE: 'lobby_invite',
    LOBBY_INVITED: 'lobby_invited',
    LOBBY_ACCEPT: 'lobby_accept',
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
    QUEUE_FULL: 'QUEUE_FULL',
    ALREADY_IN_GAME: 'ALREADY_IN_GAME',
    NOT_AUTHENTICATED: 'NOT_AUTHENTICATED',
    TICKET_INVALID: 'TICKET_INVALID',
    SPECTATOR_DISABLED: 'SPECTATOR_DISABLED',
    RATED_LOCKED: 'RATED_LOCKED',
    INVITE_NOT_FOUND: 'INVITE_NOT_FOUND',
  };

  // Lobby messages have no room code: the lobby is a single shared connection.
  const ROOM_LESS_TYPES = new Set([TYPES.CREATE_ROOM, TYPES.LOBBY_HELLO, TYPES.LOBBY_QUEUE, TYPES.LOBBY_CANCEL, TYPES.LOBBY_INVITE, TYPES.LOBBY_ACCEPT]);

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

  // base64url, for WebAuthn ids and keys. Browsers, Node and Workers all have btoa/atob.
  function toBase64Url(bytes) {
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    let binary = '';
    for (let i = 0; i < view.length; i += 1) binary += String.fromCharCode(view[i]);
    return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function fromBase64Url(text) {
    const base64 = String(text || '').replace(/-/g, '+').replace(/_/g, '/');
    const binary = atob(base64 + '='.repeat((4 - (base64.length % 4)) % 4));
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
    return bytes;
  }

  const protocolExports = {
    PROTOCOL_VERSION,
    DATA_VERSION,
    DATA_RESET_CLOSE_CODE,
    TYPES,
    ERROR_CODES,
    ROOM_LESS_TYPES,
    DRAW_REASON_ALIASES,
    ROOM_CODE_ALPHABET,
    ROOM_CODE_LENGTH,
    normalizeRoomCode,
    toBase64Url,
    fromBase64Url,
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
