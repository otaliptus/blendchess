(() => {
  const core = window.ChessCore;
  if (!core) {
    throw new Error('Chess core is required. Load chess-core.js before app.js.');
  }

  const PIECE_SYMBOLS = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
  };

  // SVG piece set (Cburnett/Wikipedia style) — inline for zero dependencies
  const PIECE_SVG = {
    wK: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 11.63V6M20 8h5" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#fff" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#fff"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0"/></g></svg>`,
    wQ: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="#fff" stroke="#000" stroke-width="1.5" stroke-linejoin="round"><circle cx="6" cy="12" r="2"/><circle cx="14" cy="9" r="2"/><circle cx="22.5" cy="8" r="2"/><circle cx="31" cy="9" r="2"/><circle cx="39" cy="12" r="2"/><path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z" stroke-linecap="butt"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z" stroke-linecap="butt"/><path d="M11.5 30c3.5-1 18.5-1 22 0M12 33.5c6-1 15-1 21 0" fill="none"/></g></svg>`,
    wR: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="#fff" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 39h27v-3H9v3zm3-3v-4h21v4H12zm-1-22V9h4v2h5V9h5v2h5V9h4v5" stroke-linecap="butt"/><path d="M34 14l-3 3H14l-3-3"/><path d="M15 17v7h15v-7" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M14 29.5v2.5h17v-2.5" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M14 29.5L11 14h23l-3 15.5H14z" stroke-linecap="butt"/><path d="M14 17v-3h17v3H14z" fill="none" stroke-linejoin="miter"/></g></svg>`,
    wB: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="#fff" stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.354.49-2.323.47-3-.5 1.354-1.94 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" stroke-linejoin="miter"/></g></svg>`,
    wN: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21" fill="#fff"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3" fill="#fff"/><path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0zm5.433-9.75a.5 1.5 30 1 1-.866-.5.5 1.5 30 1 1 .866.5z" fill="#000"/></g></svg>`,
    wP: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03C15.41 27.09 11 31.58 11 39.5H34c0-7.92-4.41-12.41-7.41-13.47C28.06 24.84 29 23.03 29 21c0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" fill="#fff" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></svg>`,
    bK: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22.5 11.63V6" stroke-linejoin="miter"/><path d="M22.5 25s4.5-7.5 3-10.5c0 0-1-2.5-3-2.5s-3 2.5-3 2.5c-1.5 3 3 10.5 3 10.5" fill="#000" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M11.5 37c5.5 3.5 15.5 3.5 21 0v-7s9-4.5 6-10.5c-4-6.5-13.5-3.5-16 4V27v-3.5c-3.5-7.5-13-10.5-16-4-3 6 5 10 5 10V37z" fill="#000"/><path d="M20 8h5" stroke-linejoin="miter"/><path d="M32 29.5s8.5-4 6.03-9.65C34.15 14 25 18 22.5 24.5l.01 2.1-.01-2.1C20 18 9.906 14 6.997 19.85 4.5 25.5 11.85 29.5 11.85 29.5" fill="none" stroke="#fff"/><path d="M11.5 30c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0m-21 3.5c5.5-3 15.5-3 21 0" stroke="#fff"/></g></svg>`,
    bQ: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="#000" stroke="none"><circle cx="6" cy="12" r="2.75"/><circle cx="14" cy="9" r="2.75"/><circle cx="22.5" cy="8" r="2.75"/><circle cx="31" cy="9" r="2.75"/><circle cx="39" cy="12" r="2.75"/></g><path d="M9 26c8.5-1.5 21-1.5 27 0l2.5-12.5L31 25l-.3-14.1-5.2 13.6-3-14.5-3 14.5-5.2-13.6L14 25 6.5 13.5 9 26z" fill="#000" stroke-linecap="butt"/><path d="M9 26c0 2 1.5 2 2.5 4 1 1.5 1 1 .5 3.5-1.5 1-1.5 2.5-1.5 2.5-1.5 1.5.5 2.5.5 2.5 6.5 1 16.5 1 23 0 0 0 1.5-1 0-2.5 0 0 .5-1.5-1-2.5-.5-2.5-.5-2 .5-3.5 1-2 2.5-2 2.5-4-8.5-1.5-18.5-1.5-27 0z" fill="#000" stroke-linecap="butt"/><path d="M11 38.5a35 35 1 0 0 23 0" fill="none" stroke-linecap="butt"/><path d="M11 29a35 35 1 0 1 23 0m-21.5 2.5h20m-21 3h21" fill="none" stroke="#fff"/></g></svg>`,
    bR: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 39h27v-3H9v3zm3.5-7l1.5-2.5h17l1.5 2.5h-20zm-.5 4v-4h21v4H12z" stroke-linecap="butt"/><path d="M14 29.5v-13h17v13H14z" stroke-linecap="butt" stroke-linejoin="miter"/><path d="M14 16.5L11 14h23l-3 2.5H14zM11 14V9h4v2h5V9h5v2h5V9h4v5H11z" stroke-linecap="butt"/><path d="M12 35.5h21m-20-4h19m-18-2h17m-17-13h17M11 14h23" fill="none" stroke="#fff" stroke-width="1" stroke-linejoin="miter"/></g></svg>`,
    bB: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><g fill="#000" stroke-linecap="butt"><path d="M9 36c3.39-.97 10.11.43 13.5-2 3.39 2.43 10.11 1.03 13.5 2 0 0 1.65.54 3 2-.68.97-1.65.99-3 .5-3.39-.97-10.11.46-13.5-1-3.39 1.46-10.11.03-13.5 1-1.354.49-2.323.47-3-.5 1.354-1.94 3-2 3-2z"/><path d="M15 32c2.5 2.5 12.5 2.5 15 0 .5-1.5 0-2 0-2 0-2.5-2.5-4-2.5-4 5.5-1.5 6-11.5-5-15.5-11 4-10.5 14-5 15.5 0 0-2.5 1.5-2.5 4 0 0-.5.5 0 2z"/><path d="M25 8a2.5 2.5 0 1 1-5 0 2.5 2.5 0 1 1 5 0z"/></g><path d="M17.5 26h10M15 30h15m-7.5-14.5v5M20 18h5" stroke="#fff" stroke-linejoin="miter"/></g></svg>`,
    bN: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><g fill="none" fill-rule="evenodd" stroke="#000" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M22 10c10.5 1 16.5 8 16 29H15c0-9 10-6.5 8-21" fill="#000"/><path d="M24 18c.38 2.91-5.55 7.37-8 9-3 2-2.82 4.34-5 4-1.042-.94 1.41-3.04 0-3-1 0 .19 1.23-1 2-1 0-4.003 1-4-4 0-2 6-12 6-12s1.89-1.9 2-3.5c-.73-.994-.5-2-.5-3 1-1 3 2.5 3 2.5h2s.78-1.992 2.5-3c1 0 1 3 1 3" fill="#000"/><path d="M9.5 25.5a.5.5 0 1 1-1 0 .5.5 0 1 1 1 0z" fill="#fff" stroke="#fff"/><circle cx="14.5" cy="15.5" r="1" fill="#fff" stroke="none"/><path d="M24.55 10.4l-.45 1.45.5.15c3.15 1 5.65 2.49 7.9 6.75M24.55 10.4z" fill="none" stroke="#fff" stroke-width=".75"/></g></svg>`,
    bP: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 45 45"><path d="M22.5 9c-2.21 0-4 1.79-4 4 0 .89.29 1.71.78 2.38C17.33 16.5 16 18.59 16 21c0 2.03.94 3.84 2.41 5.03C15.41 27.09 11 31.58 11 39.5H34c0-7.92-4.41-12.41-7.41-13.47C28.06 24.84 29 23.03 29 21c0-2.41-1.33-4.5-3.28-5.62.49-.67.78-1.49.78-2.38 0-2.21-1.79-4-4-4z" fill="#000" stroke="#000" stroke-width="1.5" stroke-linecap="round"/></svg>`,
  };

  function getPieceSvgKey(color, type) {
    return `${color}${type}`;
  }

  function createPieceSvgElement(color, type) {
    const key = getPieceSvgKey(color, type);
    const svgStr = PIECE_SVG[key];
    if (!svgStr) return null;
    const wrapper = document.createElement('span');
    wrapper.innerHTML = svgStr;
    const svg = wrapper.firstChild;
    if (svg) {
      svg.classList.add('piece-svg');
      svg.setAttribute('aria-label', `${color === 'w' ? 'White' : 'Black'} ${type}`);
    }
    return svg;
  }
  const stateGuards = window.BlendChessStateGuards;
  if (!stateGuards) {
    throw new Error('State guards are required. Load client/stateGuards.js before app.js.');
  }
  const {
    normalizeHistorySnapshot: normalizeStateHistorySnapshot,
    shouldHydrateSnapshotVersion,
  } = stateGuards;

  const WEBSOCKET_TYPES = {
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
  };

  const PROTOCOL_VERSION = '1.0.0';

  const ERROR_TEXT = {
    INVALID_PAYLOAD: 'Server could not parse that move request.',
    UNKNOWN_ROOM: 'Room does not exist.',
    ROOM_FULL: 'That room already has two players.',
    NOT_YOUR_TURN: 'It is not your turn.',
    WRONG_COLOR: 'Your connection is not mapped to this room.',
    ILLEGAL_MOVE: 'That move is illegal.',
    GAME_OVER: 'The game is already over.',
    ROOM_NOT_READY: 'Waiting for the second player.',
    RATE_LIMIT: 'Server is throttling requests.',
    PLAYER_NOT_FOUND: 'Could not find player in room.',
    INVALID_DRAW_CLAIM: 'Draw claim is not currently valid.',
    VERSION_MISMATCH: 'Client/server protocol mismatch. Refresh and reconnect.',
  };

  // Mirror of server ERROR_CODES for client-side comparisons
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

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const modeText = document.getElementById('modeText');
  const capturesEl = document.getElementById('captures');
  const eventsEl = document.getElementById('events');
  const moveListInlineEl = document.getElementById('moveListInline');
  const moveBody = moveListInlineEl; // backward compat alias
  const replayFirstEl = document.getElementById('replayFirst');
  const replayPrevEl = document.getElementById('replayPrev');
  const replayNextEl = document.getElementById('replayNext');
  const replayFinalEl = document.getElementById('replayFinal');
  const replayBannerEl = document.getElementById('replayBanner');
  const checkAlertEl = document.getElementById('checkAlert');
  const flashBannerEl = document.getElementById('flashBanner');
  const exportPgnEl = document.getElementById('exportPgn');
  const hardModeEl = document.getElementById('hardMode');
  const newGameEl = document.getElementById('newGame');
  const multiplayerStatusEl = document.getElementById('multiplayerStatus');
  const multiplayerInfoEl = document.getElementById('multiplayerInfo');
  const roomCodeBadge = document.getElementById('roomCodeBadge');
  const playerRoster = document.getElementById('playerRoster');
  const setupHintEl = document.getElementById('setupHint');
  const playModeEl = document.getElementById('playMode');
  const serverUrlEl = document.getElementById('serverUrl');
  const connectServerEl = document.getElementById('connectServer');
  const createRoomEl = document.getElementById('createRoom');
  const joinRoomCodeEl = document.getElementById('joinRoomCode');
  const joinRoomEl = document.getElementById('joinRoom');
  const spectateRoomEl = document.getElementById('spectateRoom');
  const copyRoomCodeEl = document.getElementById('copyRoomCode');
  const leaveRoomEl = document.getElementById('leaveRoom');
  const claimDrawEl = document.getElementById('claimDraw');
  const resignEl = document.getElementById('resign');
  const historyGamesEl = document.getElementById('historyGames');
  const loadHistoryGameEl = document.getElementById('loadHistoryGame');
  const clearHistoryGamesEl = document.getElementById('clearHistoryGames');
  const uiThemeEl = document.getElementById('uiTheme');
  const boardThemeEl = document.getElementById('boardTheme');
  const illegalOverlayEl = document.getElementById('illegalOverlay');

  // New UI elements
  const gameLobbyOverlay = document.getElementById('gameLobbyOverlay');
  const lobbyStep1 = document.getElementById('lobbyStep1');
  const lobbyStep2 = document.getElementById('lobbyStep2');
  const lobbyLocalBtn = document.getElementById('lobbyLocal');
  const lobbyOnlineBtn = document.getElementById('lobbyOnline');
  const lobbyBackBtn = document.getElementById('lobbyBack');
  const lobbyCloseBtn = document.getElementById('lobbyClose');
  const lobbyHardModeEl = document.getElementById('lobbyHardMode');
  const openLobbyBtn = document.getElementById('openLobby');
  const lobbyResumeSectionEl = document.getElementById('lobbyResumeSection');
  const lobbyResumeInfoEl = document.getElementById('lobbyResumeInfo');
  const lobbyResumeBtnEl = document.getElementById('lobbyResumeBtn');
  const lobbyStartFreshBtnEl = document.getElementById('lobbyStartFreshBtn');
  const ingameToolbar = document.getElementById('ingameToolbar');
  const promotionPickerEl = document.getElementById('promotionPicker');
  const promotionPiecesEl = document.getElementById('promotionPieces');
  const topPlayerNameEl = document.getElementById('topPlayerName');
  const topPlayerMaterialEl = document.getElementById('topPlayerMaterial');
  const topPlayerCapturesEl = document.getElementById('topPlayerCaptures');
  const bottomPlayerNameEl = document.getElementById('bottomPlayerName');
  const bottomPlayerMaterialEl = document.getElementById('bottomPlayerMaterial');
  const bottomPlayerCapturesEl = document.getElementById('bottomPlayerCaptures');
  const uiThemeHeaderEl = document.getElementById('uiThemeHeader');
  const boardThemeHeaderEl = document.getElementById('boardThemeHeader');

  // Drag-and-drop state
  let dragState = null;

  const {
    createInitialState,
    generateLegalMoves,
    applyMove,
    isInCheck,
    squareName,
    colorName,
    otherColor,
    moveToSAN,
    cloneBoard,
    recordCurrentPosition,
    isThreefoldRepetition,
    isFivefoldRepetition,
    isFiftyMoveRule,
    isSeventyFiveMoveRule,
    isInsufficientMaterial,
    moveRejectionReason: coreMoveRejectionReason,
    evaluateTerminalState: coreEvaluateTerminalState,
  } = core;

  const DEFAULT_SERVER_URL = window.BLENDCHESS_SERVER_URL
    || (
      window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
        ? 'ws://localhost:3000'
        : 'wss://blendchess-ws.omertalib42.workers.dev'
    );
  const SERVER_URL_STORAGE_KEY = 'blendchess.serverUrl';
  const ONLINE_SESSION_STORAGE_KEY = 'blendchess.onlineSession';
  const PLAY_MODE_STORAGE_KEY = 'blendchess.playMode';
  const HISTORY_STORAGE_KEY = 'blendchess.history';
  const HISTORY_MAX_ITEMS = 40;
  const UI_THEME_STORAGE_KEY = 'blendchess.uiTheme';
  const BOARD_THEME_STORAGE_KEY = 'blendchess.boardTheme';
  const AUTO_RECONNECT_MAX_ATTEMPTS = 6;
  const AUTO_RECONNECT_BASE_DELAY_MS = 1200;
  const DRAW_CLAIM_REASONS = ['threefold', 'fiftyMove', 'seventyFiveMove', 'fivefold', 'insufficientMaterial'];
  const MASKED_MOVE_TEXT = '****';
  const DRAW_REASON_ALIASES = {
    threefold: 'threefold',
    fiftymove: 'fiftyMove',
    fiftymoverule: 'fiftyMove',
    seventyfivemove: 'seventyFiveMove',
    seventyfivemoverule: 'seventyFiveMove',
    fivefold: 'fivefold',
    insufficientmaterial: 'insufficientMaterial',
  };

  const multiplayer = {
    mode: 'local',
    connected: false,
    socket: null,
    connectPromise: null,
    socketUrl: DEFAULT_SERVER_URL,
    roomCode: '',
    playerId: null,
    resumeToken: null,
    color: null,
    role: 'player',
    spectatorId: null,
    players: [],
    spectators: [],
    awaitingStateSync: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    resumeInFlight: false,
    intentionalLeave: false,
  };

  let audioContext = null;
  let state = newGameState();
  let replayHistory = [];
  let pendingServerAttempt = null;
  const replay = { active: false, ply: 0 };
  const illegalAttemptsByPly = {};
  const captureMarkersByPly = {};
  const moveHighlightsByPly = {};
  let bannerTimer = null;
  let historyCache = [];

  function getAudioContext() {
    if (audioContext) {
      return audioContext;
    }

    const Ctx = window.AudioContext || window.webkitAudioContext;
    if (!Ctx) {
      return null;
    }

    audioContext = new Ctx();
    return audioContext;
  }

  function unlockAudio() {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }

    if (ctx.state === 'suspended') {
      ctx.resume().catch(() => {});
    }
  }

  function scheduleTone(ctx, options) {
    const {
      frequency,
      delay = 0,
      duration = 0.08,
      gain = 0.06,
      type = 'triangle',
    } = options;
    const startTime = ctx.currentTime + delay;
    const endTime = startTime + duration;
    const oscillator = ctx.createOscillator();
    const gainNode = ctx.createGain();

    oscillator.type = type;
    oscillator.frequency.setValueAtTime(frequency, startTime);

    gainNode.gain.setValueAtTime(0.0001, startTime);
    gainNode.gain.exponentialRampToValueAtTime(gain, startTime + 0.01);
    gainNode.gain.exponentialRampToValueAtTime(0.0001, endTime);

    oscillator.connect(gainNode);
    gainNode.connect(ctx.destination);
    oscillator.start(startTime);
    oscillator.stop(endTime + 0.02);
  }

  function playMoveSound() {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }

    unlockAudio();
    scheduleTone(ctx, {
      frequency: 420,
      duration: 0.045,
      gain: 0.045,
      type: 'square',
    });
    scheduleTone(ctx, {
      frequency: 320,
      delay: 0.05,
      duration: 0.055,
      gain: 0.05,
      type: 'triangle',
    });
  }

  function playCaptureSound(role) {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }

    unlockAudio();
    if (role === 'loser') {
      scheduleTone(ctx, {
        frequency: 260,
        duration: 0.09,
        gain: 0.065,
        type: 'sawtooth',
      });
      scheduleTone(ctx, {
        frequency: 170,
        delay: 0.05,
        duration: 0.13,
        gain: 0.06,
        type: 'sawtooth',
      });
      return;
    }

    scheduleTone(ctx, {
      frequency: 620,
      duration: 0.06,
      gain: 0.055,
      type: 'triangle',
    });
    scheduleTone(ctx, {
      frequency: 760,
      delay: 0.03,
      duration: 0.08,
      gain: 0.055,
      type: 'triangle',
    });
  }

  function playIllegalMoveSound() {
    const ctx = getAudioContext();
    if (!ctx) {
      return;
    }

    unlockAudio();
    scheduleTone(ctx, {
      frequency: 250,
      duration: 0.1,
      gain: 0.06,
      type: 'sawtooth',
    });
    scheduleTone(ctx, {
      frequency: 170,
      delay: 0.05,
      duration: 0.12,
      gain: 0.06,
      type: 'square',
    });
  }

  function playMoveFeedback(options = {}) {
    const {
      capture = false,
      moverColor = null,
      capturedColor = null,
    } = options;

    if (!capture) {
      playMoveSound();
      return;
    }

    if (!isOnlineMode() || !multiplayer.color) {
      playCaptureSound('taker');
      return;
    }

    if (moverColor && moverColor === multiplayer.color) {
      playCaptureSound('taker');
      return;
    }

    if (capturedColor && capturedColor === multiplayer.color) {
      playCaptureSound('loser');
      return;
    }

    playCaptureSound('taker');
  }

  function getCurrentPly() {
    let ply = 0;
    for (const pair of state.movePairs) {
      if (pair.white) {
        ply += 1;
      }
      if (pair.black) {
        ply += 1;
      }
    }
    return ply;
  }

  function normalizeEventColor(color) {
    return color === 'w' || color === 'b' ? color : null;
  }

  function getViewerColorForMasking() {
    if (shouldRevealBoardAndHistory() || replay.active || isSpectatorMode()) {
      return null;
    }
    if (isOnlineMode()) {
      return normalizeEventColor(multiplayer.color);
    }
    return state.turn === 'w' || state.turn === 'b' ? state.turn : null;
  }

  function inferEventColor(text) {
    const viewerColor = getViewerColorForMasking();
    if (/^White\b/i.test(text)) {
      return 'w';
    }
    if (/^Black\b/i.test(text)) {
      return 'b';
    }
    if (/^You\b/i.test(text)) {
      return viewerColor;
    }
    if (/^Opponent\b/i.test(text) && viewerColor) {
      return otherColor(viewerColor);
    }
    return null;
  }

  function normalizeEventEntry(entry) {
    if (entry && typeof entry === 'object' && typeof entry.text === 'string') {
      return {
        time: typeof entry.time === 'string' && entry.time ? entry.time : '--:--',
        move: Number.isInteger(entry.move) ? entry.move : getCurrentPly(),
        text: entry.text,
        color: normalizeEventColor(entry.color) || inferEventColor(entry.text),
      };
    }

    if (typeof entry === 'string') {
      const match = entry.match(/^\[(\d{1,2}:\d{2})(?:\s*\|\s*M(\d+))?\]\s*(.*)$/);
      if (match) {
        const move = Number.isInteger(Number(match[2])) ? Number(match[2]) : getCurrentPly();
        return {
          time: match[1],
          move,
          text: match[3],
          color: inferEventColor(match[3]),
        };
      }
      return {
        time: '--:--',
        move: getCurrentPly(),
        text: entry,
        color: inferEventColor(entry),
      };
    }

    return {
      time: '--:--',
      move: getCurrentPly(),
      text: String(entry || ''),
      color: null,
    };
  }

  function clearIllegalAttempts() {
    Object.keys(illegalAttemptsByPly).forEach((key) => {
      delete illegalAttemptsByPly[key];
    });
  }

  function clearCaptureMarkers() {
    Object.keys(captureMarkersByPly).forEach((key) => {
      delete captureMarkersByPly[key];
    });
  }

  function clearMoveHighlights() {
    Object.keys(moveHighlightsByPly).forEach((key) => {
      delete moveHighlightsByPly[key];
    });
  }

  function setMoveHighlightForPly(ply, highlight) {
    if (!Number.isInteger(ply) || ply <= 0 || !highlight) {
      return;
    }

    moveHighlightsByPly[String(ply)] = {
      from: highlight.from ? { ...highlight.from } : null,
      to: highlight.to ? { ...highlight.to } : null,
      san: typeof highlight.san === 'string' ? highlight.san : '',
    };
  }

  function getMoveHighlightForPly(ply) {
    if (!Number.isInteger(ply) || ply <= 0) {
      return null;
    }
    return moveHighlightsByPly[String(ply)] || null;
  }

  function findKingSquare(board, color) {
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const piece = board[r][c];
        if (piece && piece.type === 'K' && piece.color === color) {
          return { r, c };
        }
      }
    }
    return null;
  }

  function showTransientBanner(text) {
    if (!flashBannerEl) {
      return;
    }
    flashBannerEl.textContent = text;
    flashBannerEl.classList.add('visible');
    if (bannerTimer) {
      window.clearTimeout(bannerTimer);
    }
    bannerTimer = window.setTimeout(() => {
      flashBannerEl.classList.remove('visible');
    }, 1800);
  }

  function showIllegalOverlay(reason, from, to) {
    if (!illegalOverlayEl) return;
    const text = (from && to)
      ? `${squareName(from)} → ${squareName(to)}: ${reason}`
      : `Illegal move: ${reason}`;
    const textEl = illegalOverlayEl.querySelector('.illegal-text');
    if (textEl) textEl.textContent = text;
    illegalOverlayEl.hidden = false;
    illegalOverlayEl.classList.add('visible');
    if (boardEl && !boardEl.classList.contains('shake')) {
      boardEl.classList.add('shake');
      window.setTimeout(() => boardEl.classList.remove('shake'), 420);
    }
    if (illegalOverlayTimer) window.clearTimeout(illegalOverlayTimer);
    illegalOverlayTimer = window.setTimeout(() => {
      illegalOverlayEl.classList.remove('visible');
      illegalOverlayTimer = null;
      window.setTimeout(() => { illegalOverlayEl.hidden = true; }, 260);
    }, 2200);
  }

  let illegalOverlayTimer = null;

  function showIllegalMoveBanner(from, to, reason, nextTurnColor = null) {
    const nextTurnSuffix = nextTurnColor
      ? ` Turn forfeited. ${colorName(nextTurnColor)} to move.`
      : '';
    showTransientBanner(`Illegal: ${squareName(from)} → ${squareName(to)} (${reason}).${nextTurnSuffix}`);
    showIllegalOverlay(reason, from, to);
    playIllegalMoveSound();
  }

  function getPgnResult() {
    if (state.winner === 'White') {
      return '1-0';
    }
    if (state.winner === 'Black') {
      return '0-1';
    }
    if (state.gameOver) {
      return '1/2-1/2';
    }
    return '*';
  }

  function buildPgnText() {
    const resultTag = getPgnResult();
    const date = new Date();
    const dateTag = `${date.getFullYear()}.${String(date.getMonth() + 1).padStart(2, '0')}.${String(date.getDate()).padStart(2, '0')}`;
    const headers = [
      '[Event "BlendChess Game"]',
      `[Site "${window.location.origin}"]`,
      `[Date "${dateTag}"]`,
      '[White "White"]',
      '[Black "Black"]',
      `[Result "${resultTag}"]`,
    ];

    const tokens = [];
    for (const pair of state.movePairs) {
      tokens.push(`${pair.num}.`);
      if (pair.white) {
        tokens.push(pair.white);
      }
      if (pair.black) {
        tokens.push(pair.black);
      }
    }
    tokens.push(resultTag);

    return `${headers.join('\n')}\n\n${tokens.join(' ').trim()}\n`;
  }

  async function handleExportPgn() {
    if (!state.gameOver) {
      showTransientBanner('PGN export is available after the game ends.');
      return;
    }

    const pgnText = buildPgnText();
    const filename = `blendchess-${new Date().toISOString().slice(0, 19).replace(/[:T]/g, '-')}.pgn`;
    try {
      const blob = new Blob([pgnText], { type: 'application/x-chess-pgn;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = filename;
      document.body.appendChild(link);
      link.click();
      link.remove();
      URL.revokeObjectURL(url);
      showTransientBanner(`PGN exported: ${filename}`);
    } catch {
      try {
        await navigator.clipboard.writeText(pgnText);
        showTransientBanner('PGN copied to clipboard.');
      } catch {
        showTransientBanner('Could not export PGN.');
      }
    }
  }

  function setCaptureMarkerForPly(ply, marker) {
    if (!Number.isInteger(ply) || ply <= 0 || !marker) {
      return;
    }

    captureMarkersByPly[String(ply)] = {
      square: marker.square ? { ...marker.square } : null,
      moverColor: normalizeEventColor(marker.moverColor),
      capturedColor: normalizeEventColor(marker.capturedColor),
    };
  }

  function getCaptureMarkerForPly(ply) {
    if (!Number.isInteger(ply) || ply <= 0) {
      return null;
    }
    return captureMarkersByPly[String(ply)] || null;
  }

  function resolveCaptureMarkerClass(marker, perspectiveColor) {
    if (!marker?.square) {
      return '';
    }

    if (perspectiveColor && marker.moverColor === perspectiveColor) {
      return 'capture-win';
    }

    if (perspectiveColor && marker.capturedColor === perspectiveColor) {
      return 'capture-loss';
    }

    return '';
  }

  function deriveCaptureSquare(from, to, enPassantCapture) {
    if (!from || !to) {
      return null;
    }
    if (enPassantCapture) {
      return { r: from.r, c: to.c };
    }
    return { ...to };
  }

  function buildReplaySnapshotFromState(ply) {
    return {
      ply,
      board: cloneBoard(state.board),
      turn: state.turn,
    };
  }

  function getReplaySnapshot(targetPly) {
    return replayHistory.find((entry) => entry.ply === targetPly) || null;
  }

  function syncReplayHistoryWithState() {
    const ply = getCurrentPly();
    if (ply === 0 && replayHistory.length && replayHistory[replayHistory.length - 1].ply > 0) {
      clearIllegalAttempts();
      clearCaptureMarkers();
      clearMoveHighlights();
      replayHistory = [];
      replay.active = false;
      replay.ply = 0;
      pendingServerAttempt = null;
    }

    const snapshot = buildReplaySnapshotFromState(ply);
    const existing = getReplaySnapshot(ply);
    if (existing) {
      existing.board = snapshot.board;
      existing.turn = snapshot.turn;
    } else {
      replayHistory.push(snapshot);
      replayHistory.sort((a, b) => a.ply - b.ply);
    }

    const maxPly = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    if (!state.gameOver) {
      replay.active = false;
      replay.ply = maxPly;
    } else if (!replay.active) {
      replay.ply = maxPly;
    } else if (replay.ply > maxPly) {
      replay.ply = maxPly;
    }
  }

  function describePly(ply) {
    if (ply <= 0) {
      return 'initial position';
    }
    const side = ply % 2 === 1 ? 'White' : 'Black';
    const fullMove = Math.ceil(ply / 2);
    return `${side} move ${fullMove}`;
  }

  function getIllegalAttemptsForPly(ply) {
    const key = String(ply);
    return illegalAttemptsByPly[key] || [];
  }

  function recordIllegalAttempt(from, to, reason, color, forcedPly = null) {
    const ply = Number.isInteger(forcedPly) ? forcedPly : (getCurrentPly() + 1);
    const key = String(ply);
    if (!illegalAttemptsByPly[key]) {
      illegalAttemptsByPly[key] = [];
    }
    illegalAttemptsByPly[key].push({
      from: { ...from },
      to: { ...to },
      reason: String(reason || '').trim(),
      color: normalizeEventColor(color),
    });
  }

  function updateReplayBannerAndControls() {
    if (!replayFirstEl || !replayPrevEl || !replayNextEl || !replayFinalEl || !replayBannerEl) {
      return;
    }

    const hasReplay = state.gameOver && replayHistory.length > 1;
    const maxPly = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    replayFirstEl.disabled = !hasReplay || replay.ply <= 0;
    replayPrevEl.disabled = !hasReplay || replay.ply <= 0;
    replayNextEl.disabled = !hasReplay || replay.ply >= maxPly;
    replayFinalEl.disabled = !hasReplay || replay.ply === maxPly;

    if (!hasReplay) {
      replayBannerEl.textContent = state.gameOver
        ? 'No replay states available for this game.'
        : 'Replay becomes available when the game ends.';
      return;
    }

    const highlight = getMoveHighlightForPly(replay.ply);
    const attempts = getIllegalAttemptsForPly(replay.ply);
    const sanText = highlight?.san ? ` SAN: ${highlight.san}.` : '';
    if (!attempts.length) {
      replayBannerEl.textContent = `Viewing ${describePly(replay.ply)}.${sanText} No illegal attempts recorded on this turn.`;
      return;
    }

    const details = attempts
      .map((attempt) => `${colorName(attempt.color || 'w')} tried ${squareName(attempt.from)} to ${squareName(attempt.to)} (${attempt.reason || 'illegal'})`)
      .join('  |  ');
    replayBannerEl.textContent = `Viewing ${describePly(replay.ply)}. Illegal attempts: ${details}`;
  }

  function setReplayPly(nextPly) {
    const maxPly = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    const normalized = Math.max(0, Math.min(maxPly, nextPly));
    replay.active = true;
    replay.ply = normalized;
    render();
  }

  function setReplayFinal() {
    const maxPly = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    replay.active = true;
    replay.ply = maxPly;
    render();
  }

  function setReplayFirst() {
    replay.active = true;
    replay.ply = 0;
    render();
  }

  function stepReplay(delta) {
    setReplayPly(replay.ply + delta);
  }

  function readSavedServerUrl() {
    try {
      const saved = window.localStorage.getItem(SERVER_URL_STORAGE_KEY);
      return saved ? saved.trim() : '';
    } catch {
      return '';
    }
  }

  function saveServerUrl(value) {
    try {
      const normalized = String(value || '').trim();
      if (!normalized) {
        return;
      }
      window.localStorage.setItem(SERVER_URL_STORAGE_KEY, normalized);
    } catch {
      // no-op
    }
  }

  function readSavedPlayMode() {
    try {
      const saved = window.localStorage.getItem(PLAY_MODE_STORAGE_KEY);
      return saved === 'online' ? 'online' : 'local';
    } catch {
      return 'local';
    }
  }

  function savePlayMode(mode) {
    try {
      window.localStorage.setItem(PLAY_MODE_STORAGE_KEY, mode === 'online' ? 'online' : 'local');
    } catch {
      // no-op
    }
  }

  function cloneReplayHistory(source) {
    return source.map((entry) => ({
      ply: entry.ply,
      board: cloneBoard(entry.board),
      turn: entry.turn,
    }));
  }

  function cloneMapOfObjects(source) {
    return JSON.parse(JSON.stringify(source || {}));
  }

  function normalizeHistoryEntry(raw) {
    if (!raw || typeof raw !== 'object') {
      return null;
    }
    const snapshot = normalizeStateHistorySnapshot(raw.snapshot, cloneBoard, PIECE_SYMBOLS);
    if (!snapshot) {
      return null;
    }
    const finishedAt = Number.isFinite(raw.finishedAt) ? Number(raw.finishedAt) : Date.now();
    const finishedAtText = typeof raw.finishedAtText === 'string' && raw.finishedAtText.trim()
      ? raw.finishedAtText
      : new Date(finishedAt).toLocaleString();
    const id = typeof raw.id === 'string' && raw.id.trim()
      ? raw.id
      : `${finishedAt}-${Math.random().toString(36).slice(2, 8)}`;
    return {
      ...raw,
      id,
      finishedAt,
      finishedAtText,
      mode: raw.mode === 'online' ? 'online' : 'local',
      winner: raw.winner || null,
      result: raw.result || null,
      snapshot,
      replayHistory: Array.isArray(raw.replayHistory) ? raw.replayHistory : [],
      illegalAttemptsByPly: raw.illegalAttemptsByPly || {},
      captureMarkersByPly: raw.captureMarkersByPly || {},
      moveHighlightsByPly: raw.moveHighlightsByPly || {},
      fingerprint: typeof raw.fingerprint === 'string' ? raw.fingerprint : '',
    };
  }

  function buildHistoryLabel(entry) {
    const prefix = entry.mode === 'online' ? 'Online' : 'Local';
    const resultText = entry.winner
      ? `${entry.winner} won`
      : entry.result
        ? `Draw (${entry.result})`
        : 'Game';
    return `${entry.finishedAtText} · ${prefix} · ${resultText}`;
  }

  function persistHistory() {
    try {
      window.localStorage.setItem(HISTORY_STORAGE_KEY, JSON.stringify(historyCache.slice(0, HISTORY_MAX_ITEMS)));
    } catch {
      // no-op
    }
  }

  function refreshHistoryControls() {
    if (!historyGamesEl || !loadHistoryGameEl || !clearHistoryGamesEl) {
      return;
    }

    historyGamesEl.replaceChildren();
    if (!historyCache.length) {
      const option = document.createElement('option');
      option.value = '';
      option.textContent = 'No saved games';
      historyGamesEl.appendChild(option);
      historyGamesEl.disabled = true;
      loadHistoryGameEl.disabled = true;
      clearHistoryGamesEl.disabled = true;
      return;
    }

    for (const entry of historyCache) {
      const option = document.createElement('option');
      option.value = entry.id;
      option.textContent = buildHistoryLabel(entry);
      historyGamesEl.appendChild(option);
    }
    historyGamesEl.disabled = false;
    loadHistoryGameEl.disabled = false;
    clearHistoryGamesEl.disabled = false;
  }

  function loadHistoryCache() {
    try {
      const raw = window.localStorage.getItem(HISTORY_STORAGE_KEY);
      if (!raw) {
        historyCache = [];
      } else {
        const parsed = JSON.parse(raw);
        historyCache = Array.isArray(parsed)
          ? parsed
            .map((entry) => normalizeHistoryEntry(entry))
            .filter(Boolean)
            .slice(0, HISTORY_MAX_ITEMS)
          : [];
      }
    } catch {
      historyCache = [];
    }
    refreshHistoryControls();
  }

  function createHistoryEntryFromCurrentGame() {
    const finishedAt = Date.now();
    return {
      id: `${finishedAt}-${Math.random().toString(36).slice(2, 8)}`,
      finishedAt,
      finishedAtText: new Date(finishedAt).toLocaleString(),
      mode: isOnlineMode() ? 'online' : 'local',
      winner: state.winner || null,
      result: state.result || null,
      snapshot: {
        board: cloneBoard(state.board),
        turn: state.turn,
        enPassant: state.enPassant ? { ...state.enPassant } : null,
        moveNumber: state.moveNumber,
        movePairs: state.movePairs.map((pair) => ({ ...pair })),
        events: state.events.map((entry) => normalizeEventEntry(entry)),
        captured: { ...state.captured },
        winner: state.winner,
        result: state.result,
        gameOver: state.gameOver,
        halfMoveClock: state.halfMoveClock,
        boardVersion: state.boardVersion,
        positionCounts: { ...state.positionCounts },
        hardMode: Boolean(state.hardMode),
      },
      replayHistory: cloneReplayHistory(replayHistory),
      illegalAttemptsByPly: cloneMapOfObjects(illegalAttemptsByPly),
      captureMarkersByPly: cloneMapOfObjects(captureMarkersByPly),
      moveHighlightsByPly: cloneMapOfObjects(moveHighlightsByPly),
    };
  }

  function buildGameFingerprint() {
    const replayMax = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    const moveToken = state.movePairs
      .map((pair) => `${pair.num}:${pair.white || ''}:${pair.black || ''}`)
      .join('|');
    return `${state.result || ''}|${state.winner || ''}|${state.movePairs.length}|${replayMax}|${moveToken}`;
  }

  function saveCompletedGameToHistory() {
    if (!state.gameOver || !state.movePairs.length) {
      return;
    }
    if (isOnlineMode() && multiplayer.role === 'spectator') {
      return;
    }

    const gameFingerprint = buildGameFingerprint();
    const alreadySaved = historyCache.some((entry) => entry.fingerprint === gameFingerprint);
    if (alreadySaved) {
      return;
    }

    const entry = createHistoryEntryFromCurrentGame();
    entry.fingerprint = gameFingerprint;
    historyCache.unshift(entry);
    historyCache = historyCache.slice(0, HISTORY_MAX_ITEMS);
    persistHistory();
    refreshHistoryControls();
  }

  function replaceMapValues(target, source) {
    Object.keys(target).forEach((key) => delete target[key]);
    if (!source || typeof source !== 'object') {
      return;
    }
    for (const [key, value] of Object.entries(source)) {
      target[key] = JSON.parse(JSON.stringify(value));
    }
  }

  function loadHistoryEntryById(id) {
    const entry = historyCache.find((item) => item.id === id);
    if (!entry) {
      return false;
    }

    playModeEl.value = 'local';
    savePlayMode('local');
    setMode('local');

    const snapshot = normalizeStateHistorySnapshot(entry.snapshot, cloneBoard, PIECE_SYMBOLS);
    if (!snapshot) {
      return false;
    }
    const base = newGameState();
    state = {
      ...base,
      board: snapshot.board ? cloneBoard(snapshot.board) : base.board,
      turn: snapshot.turn || 'w',
      enPassant: snapshot.enPassant ? { ...snapshot.enPassant } : null,
      moveNumber: snapshot.moveNumber || 1,
      movePairs: Array.isArray(snapshot.movePairs) ? snapshot.movePairs.map((pair) => ({ ...pair })) : [],
      events: Array.isArray(snapshot.events) ? snapshot.events.map((event) => normalizeEventEntry(event)) : [],
      captured: snapshot.captured ? { ...snapshot.captured } : { w: 0, b: 0 },
      winner: snapshot.winner || null,
      result: snapshot.result || null,
      gameOver: Boolean(snapshot.gameOver),
      halfMoveClock: Number.isInteger(snapshot.halfMoveClock) ? snapshot.halfMoveClock : 0,
      boardVersion: Number.isInteger(snapshot.boardVersion) ? snapshot.boardVersion : 0,
      positionCounts: snapshot.positionCounts ? { ...snapshot.positionCounts } : {},
      hardMode: Boolean(snapshot.hardMode),
      selected: null,
    };

    replayHistory = Array.isArray(entry.replayHistory) ? cloneReplayHistory(entry.replayHistory) : [];
    replaceMapValues(illegalAttemptsByPly, entry.illegalAttemptsByPly || {});
    replaceMapValues(captureMarkersByPly, entry.captureMarkersByPly || {});
    replaceMapValues(moveHighlightsByPly, entry.moveHighlightsByPly || {});
    replay.active = true;
    replay.ply = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
    state.hardMode = Boolean(snapshot.hardMode);
    hardModeEl.checked = state.hardMode;
    addEvent(`Loaded saved game from ${entry.finishedAtText}.`);
    render();
    return true;
  }

  function clearHistoryGames() {
    historyCache = [];
    persistHistory();
    refreshHistoryControls();
    showTransientBanner('Saved history cleared.');
  }

  function clearReconnectTimer() {
    if (multiplayer.reconnectTimer) {
      window.clearTimeout(multiplayer.reconnectTimer);
      multiplayer.reconnectTimer = null;
    }
  }

  function readSavedOnlineSession() {
    try {
      const raw = window.localStorage.getItem(ONLINE_SESSION_STORAGE_KEY);
      if (!raw) {
        return null;
      }

      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object') {
        return null;
      }

      const roomCode = normalizeRoomCode(parsed.roomCode);
      const playerId = typeof parsed.playerId === 'string' ? parsed.playerId.trim() : '';
      const resumeToken = typeof parsed.resumeToken === 'string' ? parsed.resumeToken.trim() : '';
      const socketUrl = typeof parsed.socketUrl === 'string' ? parsed.socketUrl.trim() : '';
      const color = parsed.color === 'w' || parsed.color === 'b' ? parsed.color : null;

      if (!roomCode || !playerId || !resumeToken) {
        return null;
      }

      return {
        roomCode,
        playerId,
        resumeToken,
        socketUrl: socketUrl || DEFAULT_SERVER_URL,
        color,
      };
    } catch {
      return null;
    }
  }

  function clearSavedOnlineSession() {
    try {
      window.localStorage.removeItem(ONLINE_SESSION_STORAGE_KEY);
    } catch {
      // no-op
    }
  }

  function saveOnlineSession() {
    if (
      multiplayer.role !== 'player'
      || !multiplayer.roomCode
      || !multiplayer.playerId
      || !multiplayer.resumeToken
    ) {
      return;
    }

    const session = {
      roomCode: normalizeRoomCode(multiplayer.roomCode),
      playerId: multiplayer.playerId,
      resumeToken: multiplayer.resumeToken,
      color: multiplayer.color || null,
      socketUrl: (serverUrlEl.value.trim() || multiplayer.socketUrl || DEFAULT_SERVER_URL),
    };

    try {
      window.localStorage.setItem(ONLINE_SESSION_STORAGE_KEY, JSON.stringify(session));
    } catch {
      // no-op
    }
  }

  function updateOnlineSessionPersistence() {
    if (
      isOnlineMode()
      && multiplayer.role === 'player'
      && multiplayer.roomCode
      && multiplayer.playerId
      && multiplayer.resumeToken
    ) {
      saveOnlineSession();
      return;
    }
    clearSavedOnlineSession();
  }

  function scheduleAutoReconnect() {
    if (
      multiplayer.intentionalLeave
      || !isOnlineMode()
      || multiplayer.role !== 'player'
      || !multiplayer.roomCode
      || !multiplayer.playerId
      || multiplayer.resumeInFlight
    ) {
      return;
    }

    if (multiplayer.reconnectAttempts >= AUTO_RECONNECT_MAX_ATTEMPTS) {
      addEvent('Reconnect attempts exhausted. Click Connect to retry.');
      syncMultiplayerPanel();
      syncMultiplayerControlState();
      return;
    }

    multiplayer.reconnectAttempts += 1;
    const attempt = multiplayer.reconnectAttempts;
    const delay = Math.min(7000, AUTO_RECONNECT_BASE_DELAY_MS * attempt);
    syncMultiplayerPanel();
    syncMultiplayerControlState();
    clearReconnectTimer();
    multiplayer.reconnectTimer = window.setTimeout(() => {
      resumeOnlineSession(`Reconnect attempt ${attempt}`);
    }, delay);
  }

  function newGameState() {
    return createInitialState();
  }

  function normalizeRoomCode(value) {
    return String(value || '').trim().toUpperCase();
  }

  function buildInviteUrl(roomCode) {
    const invite = new URL(window.location.href);
    invite.searchParams.set('mode', 'online');
    invite.searchParams.set('room', roomCode);
    invite.searchParams.set('ws', serverUrlEl.value.trim() || DEFAULT_SERVER_URL);
    return invite.toString();
  }

  function syncAllThemeSelectors(uiTheme, boardTheme) {
    const allUiSelects = [uiThemeEl, uiThemeHeaderEl];
    const allBoardSelects = [boardThemeEl, boardThemeHeaderEl];
    for (const sel of allUiSelects) {
      if (sel && [...sel.options].some((o) => o.value === uiTheme)) {
        sel.value = uiTheme;
      }
    }
    for (const sel of allBoardSelects) {
      if (sel && [...sel.options].some((o) => o.value === boardTheme)) {
        sel.value = boardTheme;
      }
    }
  }

  function applyThemes() {
    const uiTheme = (uiThemeEl && uiThemeEl.value) || (uiThemeHeaderEl && uiThemeHeaderEl.value) || 'classic';
    const boardTheme = (boardThemeEl && boardThemeEl.value) || (boardThemeHeaderEl && boardThemeHeaderEl.value) || 'chesscom';
    document.documentElement.setAttribute('data-ui-theme', uiTheme);
    document.documentElement.setAttribute('data-board-theme', boardTheme);
    syncAllThemeSelectors(uiTheme, boardTheme);
    try {
      window.localStorage.setItem(UI_THEME_STORAGE_KEY, uiTheme);
      window.localStorage.setItem(BOARD_THEME_STORAGE_KEY, boardTheme);
    } catch {}
  }

  function loadSavedThemes() {
    try {
      const savedUi = window.localStorage.getItem(UI_THEME_STORAGE_KEY);
      const savedBoard = window.localStorage.getItem(BOARD_THEME_STORAGE_KEY);
      if (savedUi) {
        syncAllThemeSelectors(savedUi, null);
        if (uiThemeEl) uiThemeEl.value = savedUi;
        if (uiThemeHeaderEl) uiThemeHeaderEl.value = savedUi;
      }
      if (savedBoard) {
        syncAllThemeSelectors(null, savedBoard);
        if (boardThemeEl) boardThemeEl.value = savedBoard;
        if (boardThemeHeaderEl) boardThemeHeaderEl.value = savedBoard;
      }
    } catch {}
    applyThemes();
  }

  function applyUrlPrefill() {
    const params = new URLSearchParams(window.location.search);
    const ws = params.get('ws');
    const room = params.get('room');
    const mode = params.get('mode');

    if (ws && ws.trim()) {
      serverUrlEl.value = ws.trim();
      saveServerUrl(ws.trim());
    } else {
      const saved = readSavedServerUrl();
      serverUrlEl.value = saved || DEFAULT_SERVER_URL;
    }

    if (room && room.trim()) {
      joinRoomCodeEl.value = normalizeRoomCode(room);
    }

    if (mode) {
      const normalizedMode = mode.toLowerCase() === 'online' ? 'online' : 'local';
      playModeEl.value = normalizedMode;
      setMode(normalizedMode);
      if (normalizedMode === 'online') {
        addEvent('Invite link detected. Click Connect, then Join room.');
      }
      render();
    }
  }

  async function resumeOnlineSession(contextText = 'Refreshing session') {
    if (multiplayer.resumeInFlight) {
      return;
    }

    const saved = readSavedOnlineSession();
    if (!saved) {
      return;
    }

    multiplayer.resumeInFlight = true;
    multiplayer.intentionalLeave = false;
    clearReconnectTimer();

    multiplayer.roomCode = saved.roomCode;
    multiplayer.playerId = saved.playerId;
    multiplayer.resumeToken = saved.resumeToken;
    multiplayer.color = multiplayer.color || saved.color || null;
    multiplayer.role = 'player';
    multiplayer.spectatorId = null;
    multiplayer.socketUrl = saved.socketUrl || DEFAULT_SERVER_URL;
    serverUrlEl.value = multiplayer.socketUrl;
    joinRoomCodeEl.value = saved.roomCode;
    saveServerUrl(multiplayer.socketUrl);

    if (!isOnlineMode()) {
      playModeEl.value = 'online';
      setMode('online');
    }

    syncMultiplayerControlState();
    syncMultiplayerPanel();
    addEvent(`${contextText}. Rejoining room ${saved.roomCode}...`);
    render();

    try {
      await connectSocket();
      sendSocketMessage(
        WEBSOCKET_TYPES.JOIN_ROOM,
        { nickname: 'Player', resume: true, resumeToken: multiplayer.resumeToken },
        saved.roomCode,
      );
    } catch (error) {
      addEvent(`Reconnect failed: ${error.message}`);
      render();
    } finally {
      multiplayer.resumeInFlight = false;
      syncMultiplayerControlState();
    }
  }

  function tryResumeOnlineSessionOnLoad() {
    if (!isOnlineMode()) {
      return;
    }

    const saved = readSavedOnlineSession();
    if (!saved) {
      return;
    }

    multiplayer.roomCode = saved.roomCode;
    multiplayer.playerId = saved.playerId;
    multiplayer.resumeToken = saved.resumeToken;
    multiplayer.color = saved.color || null;
    multiplayer.role = 'player';
    multiplayer.spectatorId = null;
    multiplayer.socketUrl = saved.socketUrl || DEFAULT_SERVER_URL;
    joinRoomCodeEl.value = saved.roomCode;
    serverUrlEl.value = multiplayer.socketUrl;
    syncMultiplayerPanel();
    syncMultiplayerControlState();
    resumeOnlineSession('Recovered room from last session');
  }

  function isOnlineMode() {
    return playModeEl.value === 'online';
  }

  function isSpectatorMode() {
    return isOnlineMode() && multiplayer.role === 'spectator';
  }

  function getActiveColor() {
    if (!isOnlineMode()) {
      return state.turn;
    }
    if (!multiplayer.connected || !multiplayer.roomCode) {
      return state.turn;
    }
    if (isSpectatorMode()) {
      return null;
    }
    return multiplayer.color || null;
  }

  function getPerspectiveColor() {
    if (isSpectatorMode()) {
      return 'w';
    }
    if (isOnlineMode()) {
      return multiplayer.color || state.turn;
    }
    return state.turn;
  }

  function shouldRevealBoardAndHistory() {
    return state.gameOver;
  }

  function shouldMaskOpponentMoves() {
    return Boolean(getViewerColorForMasking());
  }

  function moveColorFromPly(ply) {
    if (!Number.isInteger(ply) || ply <= 0) {
      return null;
    }
    return ply % 2 === 1 ? 'w' : 'b';
  }

  function shouldShowMoveHighlightForPly(ply) {
    if (state.hardMode && !shouldRevealBoardAndHistory() && !replay.active) {
      return false;
    }

    if (shouldRevealBoardAndHistory() || replay.active || isSpectatorMode()) {
      return true;
    }

    const moverColor = moveColorFromPly(ply);
    if (!moverColor) {
      return false;
    }
    const viewerColor = getViewerColorForMasking();
    return viewerColor ? moverColor === viewerColor : true;
  }

  function shouldShowCaptureMarker(marker) {
    if (!marker?.square) {
      return false;
    }
    if (shouldRevealBoardAndHistory() || replay.active || isSpectatorMode()) {
      return true;
    }
    if (!shouldMaskOpponentMoves()) {
      return true;
    }
    const viewerColor = getViewerColorForMasking();
    // Show to the taker (green circle) AND to the player who lost the piece (X)
    return viewerColor
      ? (marker.moverColor === viewerColor || marker.capturedColor === viewerColor)
      : true;
  }

  function shouldShowCheckSquareHighlight(turnForBoard) {
    if (!turnForBoard) {
      return false;
    }
    // Always show check to the player whose king is in check (even in hard mode)
    if (shouldRevealBoardAndHistory() || replay.active) {
      return true;
    }
    if (!isOnlineMode() || !multiplayer.connected || !multiplayer.roomCode) {
      // Local mode: only show to the player whose turn it is (they are the one in check)
      return true;
    }
    if (isSpectatorMode()) {
      return true;
    }
    if (!multiplayer.color) {
      return false;
    }
    // Online: only show check highlight to the player whose king is in check
    return turnForBoard === multiplayer.color;
  }

  function maskMoveText(text) {
    if (!text) {
      return '';
    }
    return MASKED_MOVE_TEXT;
  }

  function formatMoveForViewer(text, color) {
    if (!text) {
      return '';
    }
    if (!shouldMaskOpponentMoves()) {
      return text;
    }
    const viewerColor = getViewerColorForMasking();
    if (!viewerColor) {
      return MASKED_MOVE_TEXT;
    }
    return color === viewerColor ? text : MASKED_MOVE_TEXT;
  }

  function maskBoardSquareText(text) {
    return String(text || '').replace(/\b[a-h][1-8]\b/gi, MASKED_MOVE_TEXT);
  }

  function formatEventForViewer(entry, eventColor = null) {
    if (!shouldMaskOpponentMoves()) {
      return entry;
    }
    const viewerColor = getViewerColorForMasking();
    if (!viewerColor) {
      return entry;
    }
    const body = entry;
    const normalizedEventColor = normalizeEventColor(eventColor) || inferEventColor(body);

    if (/^You played\s+/i.test(body) || /^Opponent moved/i.test(body)) {
      return entry;
    }

    const playedByColor = body.match(/^(White|Black) played\s+(.+)$/);
    if (playedByColor) {
      const moverColor = playedByColor[1] === 'White' ? 'w' : 'b';
      if (moverColor === viewerColor) {
        return entry;
      }
      return `${playedByColor[1]} played ${maskMoveText(playedByColor[2])}`;
    }

    const genericPlayed = body.match(/^Move played:\s+(.+)$/);
    if (genericPlayed) {
      return `Move played: ${maskMoveText(genericPlayed[1])}`;
    }

    const illegalAttemptByColor = body.match(/^(White|Black) attempted illegal move\s+([a-h][1-8])\s+to\s+([a-h][1-8])(.*)$/i);
    if (illegalAttemptByColor) {
      const moverColor = illegalAttemptByColor[1] === 'White' ? 'w' : 'b';
      if (moverColor !== viewerColor) {
        return `${illegalAttemptByColor[1]} attempted illegal move ${MASKED_MOVE_TEXT} to ${MASKED_MOVE_TEXT}${illegalAttemptByColor[4] || ''}`;
      }
      return entry;
    }

    if (normalizedEventColor && normalizedEventColor !== viewerColor) {
      return maskBoardSquareText(body);
    }

    return entry;
  }

  // Board frame labels are now integrated as coordinate labels inside edge squares.
  // This function is kept as a no-op for backward compatibility.
  function updateBoardFrameLabels() {}

  function toMoveColorFromState() {
    return colorName(state.turn);
  }

  function evaluateTerminalState() {
    const outcome = coreEvaluateTerminalState(state);
    if (!outcome.isTerminal) {
      return;
    }

    state.gameOver = true;
    state.winner = outcome.winner;
    state.result = outcome.result;
    addEvent(outcome.eventText);
  }

  function moveRejectionReason(from, to) {
    return coreMoveRejectionReason(state, from, to);
  }

  function addMoveRecord(color, san) {
    if (color === 'w') {
      state.movePairs.push({
        num: state.moveNumber,
        white: san,
        black: '',
      });
    } else {
      if (!state.movePairs.length || state.movePairs[state.movePairs.length - 1].black !== '') {
        state.movePairs.push({
          num: state.moveNumber,
          white: '',
          black: san,
        });
      } else {
        state.movePairs[state.movePairs.length - 1].black = san;
      }
      state.moveNumber += 1;
    }
  }

  function addEvent(text, options = {}) {
    const prefix = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
    const event = normalizeEventEntry({
      time: prefix,
      move: Number.isInteger(options.move) ? options.move : getCurrentPly(),
      color: normalizeEventColor(options.color) || inferEventColor(text),
      text,
    });
    state.events.unshift(event);
  }

  function setMode(mode, options = {}) {
    const { preserveSession = false } = options;
    savePlayMode(mode);
    multiplayer.mode = mode;
    if (mode === 'local') {
      clearRoomSession({ clearSavedSession: !preserveSession });
      state = newGameState();
      state.hardMode = hardModeEl.checked;
      replayHistory = [];
      replay.active = false;
      replay.ply = 0;
      clearIllegalAttempts();
      clearCaptureMarkers();
      clearMoveHighlights();
      pendingServerAttempt = null;
    } else if (mode === 'online') {
      state = newGameState();
      state.hardMode = hardModeEl.checked;
      replayHistory = [];
      replay.active = false;
      replay.ply = 0;
      clearIllegalAttempts();
      clearCaptureMarkers();
      clearMoveHighlights();
      pendingServerAttempt = null;
    }
    syncMultiplayerControlState();
    syncMultiplayerPanel();
    render();
  }

  function syncMultiplayerPanel() {
    if (isOnlineMode()) {
      const playerColor = isSpectatorMode()
        ? 'spectator'
        : multiplayer.color
          ? `${multiplayer.color === 'w' ? 'White' : 'Black'}`
          : 'waiting';
      const roomReady = multiplayer.roomCode ? `Room ${multiplayer.roomCode}` : 'No room';
      let connectionText = multiplayer.connected ? 'Connected' : 'Not connected';
      if (multiplayer.resumeInFlight) {
        connectionText = 'Reconnecting...';
      } else if (
        !multiplayer.connected
        && multiplayer.reconnectAttempts > 0
        && multiplayer.reconnectAttempts <= AUTO_RECONNECT_MAX_ATTEMPTS
        && multiplayer.roomCode
        && !multiplayer.intentionalLeave
      ) {
        connectionText = `Reconnecting (${multiplayer.reconnectAttempts}/${AUTO_RECONNECT_MAX_ATTEMPTS})`;
      }
      const connectedCount = multiplayer.players.filter((player) => player.connected !== false).length;
      const connectedSpectators = multiplayer.spectators.filter((spectator) => spectator.connected !== false).length;
      multiplayerStatusEl.textContent = `Online mode · ${connectionText} · ${roomReady} · You are ${playerColor}.`;
      multiplayerInfoEl.textContent = `Players connected: ${connectedCount}/2 · Spectators: ${connectedSpectators}`;
      if (multiplayer.roomCode && multiplayer.playerId && multiplayer.resumeToken) {
        multiplayerInfoEl.textContent += ' · Refresh-safe session enabled.';
      }
      const playerRosterText = multiplayer.players
        .map((player) => {
          const connectionState = player.connected === false ? 'disconnected' : 'connected';
          return `${player.nickname || 'Player'} (${player.color === 'w' ? 'White' : 'Black'}, ${connectionState})`;
        })
        .join('  |  ');

      if (playerRosterText && connectedSpectators > 0) {
        playerRoster.textContent = `${playerRosterText}  ||  Spectators: ${connectedSpectators}`;
      } else if (playerRosterText) {
        playerRoster.textContent = playerRosterText;
      } else if (connectedSpectators > 0) {
        playerRoster.textContent = `Spectators: ${connectedSpectators}`;
      } else {
        playerRoster.textContent = 'No players yet.';
      }
      roomCodeBadge.textContent = multiplayer.roomCode
        ? `Room: ${multiplayer.roomCode}`
        : 'Room: not active';
    } else {
      multiplayerStatusEl.textContent = 'Local mode only.';
      multiplayerInfoEl.textContent = 'You are playing locally.';
      roomCodeBadge.textContent = 'Room: not active';
      playerRoster.textContent = '';
    }
    updateSetupHint();
  }

  function updateSetupHint() {
    if (!setupHintEl) {
      return;
    }

    if (!isOnlineMode()) {
      setupHintEl.textContent = 'Local mode active. Switch to Online Friend to create or join a room.';
      return;
    }

    if (!multiplayer.connected) {
      setupHintEl.textContent = 'Step 1: Click Connect.';
      return;
    }

    if (!multiplayer.roomCode) {
      setupHintEl.textContent = 'Step 2: Create a room or paste a room code to join.';
      return;
    }

    if (isSpectatorMode()) {
      setupHintEl.textContent = `Spectating room ${multiplayer.roomCode}.`;
      return;
    }

    const connectedPlayers = multiplayer.players.filter((player) => player.connected !== false).length;
    if (connectedPlayers < 2) {
      setupHintEl.textContent = `Room ${multiplayer.roomCode} is ready. Share invite and wait (${connectedPlayers}/2 connected).`;
      return;
    }

    if (state.gameOver) {
      setupHintEl.textContent = `Game ended in room ${multiplayer.roomCode}. Start a new game or leave room.`;
      return;
    }

    if (isMyTurn()) {
      setupHintEl.textContent = `Your turn as ${colorName(multiplayer.color || state.turn)}.`;
      return;
    }

    setupHintEl.textContent = `Waiting for opponent move in room ${multiplayer.roomCode}.`;
  }

  function syncMultiplayerControlState() {
    const online = isOnlineMode();
    const spectator = isSpectatorMode();
    const inRoom = Boolean(multiplayer.roomCode);
    connectServerEl.disabled = !online || multiplayer.connected || multiplayer.resumeInFlight;
    createRoomEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight || (inRoom && !state.gameOver);
    joinRoomEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight || (inRoom && !state.gameOver);
    if (spectateRoomEl) {
      spectateRoomEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight || (inRoom && !state.gameOver);
    }
    joinRoomCodeEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight || (inRoom && !state.gameOver);
    copyRoomCodeEl.disabled = !online || !multiplayer.roomCode;
    leaveRoomEl.disabled = !online;
    serverUrlEl.disabled = multiplayer.connected || multiplayer.resumeInFlight;
    claimDrawEl.disabled = online ? (!multiplayer.connected || spectator) : false;
    resignEl.disabled = spectator || multiplayer.resumeInFlight || state.gameOver;
    const onlineGameActive = isOnlineMode() && multiplayer.connected && Boolean(multiplayer.roomCode);
    const hardModeLocked = onlineGameActive && (multiplayer.color === 'b' || getCurrentPly() > 0);
    hardModeEl.disabled = spectator || multiplayer.resumeInFlight || hardModeLocked;
  }

  function updateModeText() {
    if (isOnlineMode()) {
      if (isSpectatorMode()) {
        modeText.textContent = 'Spectator mode: watching live game. Moves are disabled.';
        return;
      }
      if (state.hardMode) {
        modeText.textContent = 'Online hard mode: illegal moves forfeit turn; while in check, illegal moves are rejected.';
      } else {
        modeText.textContent = 'Online strict mode: illegal moves are rejected by server.';
      }
      return;
    }

    if (state.hardMode) {
      modeText.textContent = 'Hard mode: illegal moves lose turn; while in check, illegal moves are rejected.';
    } else {
      modeText.textContent = 'Strict mode: illegal moves are rejected.';
    }
  }

  function clearRoomSession(options = {}) {
    const { clearSavedSession = false } = options;
    if (!isOnlineMode()) {
      // reset server state and return to local rules
      disconnectSocket();
    }
    clearReconnectTimer();
    multiplayer.reconnectAttempts = 0;
    multiplayer.resumeInFlight = false;
    multiplayer.connected = false;
    multiplayer.playerId = null;
    multiplayer.spectatorId = null;
    multiplayer.resumeToken = null;
    multiplayer.color = null;
    multiplayer.role = 'player';
    multiplayer.roomCode = '';
    multiplayer.players = [];
    multiplayer.spectators = [];
    multiplayer.awaitingStateSync = false;
    multiplayer.intentionalLeave = false;
    if (clearSavedSession) {
      clearSavedOnlineSession();
    }
  }

  function renderBoard() {
    boardEl.replaceChildren();
    const perspectiveColor = getPerspectiveColor();
    const revealAll = shouldRevealBoardAndHistory();
    const showAllPieces = revealAll || isSpectatorMode();
    const visibleColor = showAllPieces ? null : perspectiveColor;
    const flipped = perspectiveColor === 'b';
    const replaySnapshot = replay.active ? getReplaySnapshot(replay.ply) : null;
    const boardState = replaySnapshot ? replaySnapshot.board : state.board;
    const markerPly = replay.active ? replay.ply : getCurrentPly();
    const captureMarker = getCaptureMarkerForPly(markerPly);
    const captureMarkerClass = resolveCaptureMarkerClass(captureMarker, perspectiveColor);
    const moveHighlight = getMoveHighlightForPly(markerPly);
    const turnForBoard = replaySnapshot ? replaySnapshot.turn : state.turn;
    const showMoveMarkers = shouldShowMoveHighlightForPly(markerPly);
    const showCaptureMarkers = shouldShowCaptureMarker(captureMarker);
    const inCheckForBoard = turnForBoard
      ? isInCheck(boardState, turnForBoard) && (!state.gameOver || replay.active)
      : false;
    const showCheckSquareHighlight = shouldShowCheckSquareHighlight(turnForBoard);
    const checkedKingSquare = showCheckSquareHighlight && inCheckForBoard && turnForBoard
      ? findKingSquare(boardState, turnForBoard)
      : null;
    const canEmphasizeTurn = !state.gameOver
      && !replay.active
      && !isSpectatorMode()
      && (
        !isOnlineMode()
        || (multiplayer.connected && Boolean(multiplayer.roomCode) && Boolean(multiplayer.color))
      );
    const showTurnEmphasis = canEmphasizeTurn && isMyTurn() && !inCheckForBoard;

    const files = flipped
      ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
      : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = flipped
      ? ['1', '2', '3', '4', '5', '6', '7', '8']
      : ['8', '7', '6', '5', '4', '3', '2', '1'];

    boardEl.classList.toggle('revealed', revealAll);
    boardEl.classList.toggle('turn-emphasis', showTurnEmphasis);
    boardEl.classList.toggle('check-emphasis', inCheckForBoard);

    for (let displayR = 0; displayR < 8; displayR += 1) {
      for (let displayC = 0; displayC < 8; displayC += 1) {
        const r = flipped ? 7 - displayR : displayR;
        const c = flipped ? 7 - displayC : displayC;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'square';
        const isLight = (displayR + displayC) % 2 === 0;
        button.classList.add(isLight ? 'light' : 'dark');
        button.dataset.r = String(r);
        button.dataset.c = String(c);

        // Integrated coordinate labels
        if (displayR === 7) {
          const fileLabel = document.createElement('span');
          fileLabel.className = 'coord-label coord-file';
          fileLabel.textContent = files[displayC];
          button.appendChild(fileLabel);
        }
        if (displayC === 0) {
          const rankLabel = document.createElement('span');
          rankLabel.className = 'coord-label coord-rank';
          rankLabel.textContent = ranks[displayR];
          button.appendChild(rankLabel);
        }

        const piece = boardState[r][c];
        let hasPiece = false;
        if (piece && (showAllPieces || piece.color === visibleColor)) {
          hasPiece = true;
          button.classList.add('visible');
          const svgEl = createPieceSvgElement(piece.color, piece.type);
          if (svgEl) {
            button.appendChild(svgEl);
          } else {
            // Fallback to text
            button.classList.add('piece', piece.color === 'w' ? 'white' : 'black');
            button.textContent = PIECE_SYMBOLS[piece.color][piece.type];
          }
        } else {
          button.classList.add('hidden');
        }

        if (!replay.active && state.selected && state.selected.r === r && state.selected.c === c) {
          button.classList.add('selected');
        }

        if (
          showCaptureMarkers
          && captureMarkerClass
          && captureMarker?.square
          && captureMarker.square.r === r
          && captureMarker.square.c === c
        ) {
          button.classList.add(captureMarkerClass);
        }
        if (
          showMoveMarkers
          && moveHighlight?.from
          && moveHighlight.from.r === r
          && moveHighlight.from.c === c
        ) {
          button.classList.add('last-move-from');
        }
        if (
          showMoveMarkers
          && moveHighlight?.to
          && moveHighlight.to.r === r
          && moveHighlight.to.c === c
        ) {
          button.classList.add('last-move-to');
        }
        if (checkedKingSquare && checkedKingSquare.r === r && checkedKingSquare.c === c) {
          button.classList.add('check-king');
        }

        // Click handler (also used by drag-and-drop end)
        button.addEventListener('click', () => handleSquareClick(r, c));

        // Drag-and-drop: start drag on pointerdown for pieces
        if (hasPiece && !replay.active && !state.gameOver) {
          button.addEventListener('pointerdown', (e) => {
            if (e.button !== 0) return;
            startDrag(e, r, c, piece);
          });
        }

        boardEl.appendChild(button);
      }
    }

    renderPlayerBars(boardState, perspectiveColor);
  }

  // Drag-and-drop implementation
  function startDrag(e, r, c, piece) {
    const activeColor = getActiveColor();
    if (!activeColor || piece.color !== activeColor) return;
    if (isOnlineMode() && !isMyTurn()) return;

    // Select the piece
    state.selected = { r, c };
    renderBoard();

    const svgHtml = PIECE_SVG[getPieceSvgKey(piece.color, piece.type)];
    if (!svgHtml) return;

    const ghost = document.createElement('div');
    ghost.className = 'drag-ghost';
    ghost.innerHTML = svgHtml;
    document.body.appendChild(ghost);

    const boardRect = boardEl.getBoundingClientRect();
    const sqSize = boardRect.width / 8;
    ghost.style.width = sqSize + 'px';
    ghost.style.height = sqSize + 'px';
    ghost.style.left = (e.clientX - sqSize / 2) + 'px';
    ghost.style.top = (e.clientY - sqSize / 2) + 'px';

    // Mark source square
    const srcSquare = boardEl.querySelector(`[data-r="${r}"][data-c="${c}"]`);
    if (srcSquare) srcSquare.classList.add('drag-source');

    dragState = { fromR: r, fromC: c, ghost, sqSize };

    const onPointerMove = (ev) => {
      ghost.style.left = (ev.clientX - sqSize / 2) + 'px';
      ghost.style.top = (ev.clientY - sqSize / 2) + 'px';
    };

    const onPointerUp = (ev) => {
      document.removeEventListener('pointermove', onPointerMove);
      document.removeEventListener('pointerup', onPointerUp);
      ghost.remove();

      // Determine target square from pointer position
      const targetBoardRect = boardEl.getBoundingClientRect();
      const col = Math.floor((ev.clientX - targetBoardRect.left) / (targetBoardRect.width / 8));
      const row = Math.floor((ev.clientY - targetBoardRect.top) / (targetBoardRect.height / 8));

      if (col >= 0 && col < 8 && row >= 0 && row < 8) {
        const perspectiveColor = getPerspectiveColor();
        const flipped = perspectiveColor === 'b';
        const targetR = flipped ? 7 - row : row;
        const targetC = flipped ? 7 - col : col;

        if (targetR !== r || targetC !== c) {
          handleSquareClick(targetR, targetC);
        }
      }

      dragState = null;
    };

    document.addEventListener('pointermove', onPointerMove);
    document.addEventListener('pointerup', onPointerUp);
  }

  // Player bars rendering
  function renderPlayerBars(boardState, perspectiveColor) {
    const flipped = perspectiveColor === 'b';
    const topColor = flipped ? 'w' : 'b';
    const bottomColor = flipped ? 'b' : 'w';

    // Names
    const getPlayerName = (color) => {
      if (isOnlineMode()) {
        const player = multiplayer.players.find((p) => p.color === color);
        if (player) return player.nickname || (color === 'w' ? 'White' : 'Black');
      }
      return color === 'w' ? 'White' : 'Black';
    };

    topPlayerNameEl.textContent = getPlayerName(topColor);
    bottomPlayerNameEl.textContent = getPlayerName(bottomColor);

    // Material count
    const PIECE_VALUES = { P: 1, N: 3, B: 3, R: 5, Q: 9, K: 0 };
    let whiteMaterial = 0;
    let blackMaterial = 0;
    const capturedByWhite = []; // pieces black lost (white captured)
    const capturedByBlack = []; // pieces white lost (black captured)

    // Count material on board
    for (let rr = 0; rr < 8; rr++) {
      for (let cc = 0; cc < 8; cc++) {
        const p = boardState[rr][cc];
        if (p) {
          if (p.color === 'w') whiteMaterial += PIECE_VALUES[p.type] || 0;
          else blackMaterial += PIECE_VALUES[p.type] || 0;
        }
      }
    }

    const diff = whiteMaterial - blackMaterial;
    topPlayerMaterialEl.textContent = (topColor === 'w' && diff > 0) || (topColor === 'b' && diff < 0)
      ? `+${Math.abs(diff)}`
      : '';
    bottomPlayerMaterialEl.textContent = (bottomColor === 'w' && diff > 0) || (bottomColor === 'b' && diff < 0)
      ? `+${Math.abs(diff)}`
      : '';

    // Clear capture displays
    topPlayerCapturesEl.replaceChildren();
    bottomPlayerCapturesEl.replaceChildren();
  }

  function renderEvents() {
    eventsEl.replaceChildren();
    for (const entry of state.events) {
      const normalized = normalizeEventEntry(entry);
      const item = document.createElement('li');
      const formattedText = formatEventForViewer(normalized.text, normalized.color);
      item.textContent = `[${normalized.time} | M${normalized.move}] ${formattedText}`;
      item.classList.add(`event-${normalized.color || 'neutral'}`);
      eventsEl.appendChild(item);
    }
  }

  function renderMoves() {
    moveListInlineEl.replaceChildren();
    const activePly = replay.active ? replay.ply : getCurrentPly();
    for (const move of state.movePairs) {
      const whitePly = ((move.num - 1) * 2) + 1;
      const blackPly = whitePly + 1;

      // Move number
      const numSpan = document.createElement('span');
      numSpan.className = 'move-number';
      numSpan.textContent = `${move.num}.`;
      moveListInlineEl.appendChild(numSpan);

      // White move
      if (move.white) {
        const whiteSpan = document.createElement('span');
        whiteSpan.className = 'move-cell';
        whiteSpan.textContent = formatMoveForViewer(move.white, 'w');
        if (whiteSpan.textContent === MASKED_MOVE_TEXT) {
          whiteSpan.classList.add('masked');
        }
        if (state.gameOver) {
          whiteSpan.classList.add('clickable');
          whiteSpan.addEventListener('click', () => setReplayPly(whitePly));
        }
        if (activePly === whitePly) {
          whiteSpan.classList.add('active');
        }
        moveListInlineEl.appendChild(whiteSpan);
      }

      // Black move
      if (move.black) {
        const blackSpan = document.createElement('span');
        blackSpan.className = 'move-cell';
        blackSpan.textContent = formatMoveForViewer(move.black, 'b');
        if (blackSpan.textContent === MASKED_MOVE_TEXT) {
          blackSpan.classList.add('masked');
        }
        if (state.gameOver) {
          blackSpan.classList.add('clickable');
          blackSpan.addEventListener('click', () => setReplayPly(blackPly));
        }
        if (activePly === blackPly) {
          blackSpan.classList.add('active');
        }
        moveListInlineEl.appendChild(blackSpan);
      }
    }

    // Auto-scroll to bottom
    moveListInlineEl.scrollTop = moveListInlineEl.scrollHeight;

    if (exportPgnEl) {
      exportPgnEl.disabled = !state.gameOver;
    }
    updateReplayBannerAndControls();
  }

  function renderStatus() {
    updateModeText();
    let status = '';
    const replaySnapshot = replay.active ? getReplaySnapshot(replay.ply) : null;
    const boardState = replaySnapshot ? replaySnapshot.board : state.board;
    const boardTurn = replaySnapshot ? replaySnapshot.turn : state.turn;
    const inCheckNow = boardTurn
      ? isInCheck(boardState, boardTurn) && (!state.gameOver || replay.active)
      : false;
    if (state.gameOver) {
      if (state.result === 'resign') {
        status = `${state.winner} wins by resignation.`;
      } else if (state.result === 'illegalForfeit') {
        status = `${state.winner} wins by hard-mode forfeit.`;
      } else if (state.result === 'kingCaptured') {
        status = state.winner
          ? `${state.winner} wins by king capture.`
          : 'Game ended: king missing from board.';
      } else if (state.result === 'stalemate') {
        status = 'Game ended in stalemate.';
      } else if (state.result === 'seventyFiveMove') {
        status = 'Game ended in a 75-move draw.';
      } else if (state.result === 'fivefold') {
        status = 'Game ended in a fivefold repetition draw.';
      } else if (state.result === 'fiftyMove') {
        status = 'Game ended in a 50-move draw.';
      } else if (state.result === 'threefold') {
        status = 'Game ended in a threefold repetition draw.';
      } else if (state.result === 'insufficientMaterial') {
        status = 'Game ended in an insufficient material draw.';
      } else if (state.result) {
        status = `Game ended in a draw (${state.result}).`;
      } else if (state.winner) {
        status = `${state.winner} wins by checkmate.`;
      } else {
        status = 'Game over.';
      }
    } else if (isOnlineMode()) {
      if (isSpectatorMode()) {
        status = 'Spectating live game.';
      } else if (inCheckNow && multiplayer.color && boardTurn === multiplayer.color) {
        status = `CHECK. Your ${colorName(boardTurn)} king is under attack.`;
      } else if (isMyTurn()) {
        status = `${toMoveColorFromState()} to move.`;
      } else if (multiplayer.color) {
        status = `You are ${colorName(multiplayer.color)}. Waiting for opponent move.`;
      } else {
        status = 'Waiting for seat assignment.';
      }
    } else if (inCheckNow) {
      status = `${toMoveColorFromState()} is in check.`;
    } else {
      status = `${toMoveColorFromState()} to move.`;
    }
    statusEl.textContent = status;
    statusEl.classList.remove('status-check', 'status-turn', 'status-waiting');
    const canShowTurnStatus = !state.gameOver
      && !replay.active
      && !isSpectatorMode()
      && (
        !isOnlineMode()
        || (multiplayer.connected && Boolean(multiplayer.roomCode) && Boolean(multiplayer.color))
      );
    if (inCheckNow) {
      statusEl.classList.add('status-check');
    } else if (canShowTurnStatus && isMyTurn()) {
      statusEl.classList.add('status-turn');
    } else if (isOnlineMode() && !state.gameOver && !isSpectatorMode()) {
      statusEl.classList.add('status-waiting');
    }

    if (checkAlertEl) {
      checkAlertEl.classList.remove('turn-alert');
      if (inCheckNow) {
        checkAlertEl.hidden = false;
        checkAlertEl.textContent = `CHECK: ${colorName(boardTurn)}`;
      } else if (canShowTurnStatus && isMyTurn()) {
        checkAlertEl.hidden = false;
        checkAlertEl.classList.add('turn-alert');
        checkAlertEl.textContent = `YOUR TURN: ${colorName(boardTurn)}`;
      } else {
        checkAlertEl.hidden = true;
        checkAlertEl.textContent = 'CHECK';
      }
    }
    capturesEl.textContent = `White pieces lost: ${state.captured.w}, Black pieces lost: ${state.captured.b}`;
    syncMultiplayerPanel();
  }

  function isMyTurn() {
    const activeColor = getActiveColor();
    if (!activeColor) {
      return false;
    }
    return state.turn === activeColor;
  }

  function evaluateAfterTurnChange() {
    evaluateTerminalState();
  }

  function checkAfterLegalMove() {
    const opponent = state.turn;
    evaluateTerminalState();
    if (state.gameOver) {
      return;
    }

    if (isInCheck(state.board, opponent)) {
      addEvent(`${colorName(opponent)} is in check.`, {
        color: opponent,
        move: getCurrentPly(),
      });
    }
  }

  function hydrateGameState(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') {
      return false;
    }

    const base = newGameState();
    const incomingVersion = Number.isInteger(snapshot.boardVersion) ? snapshot.boardVersion : null;
    const currentVersion = Number.isInteger(state.boardVersion) ? state.boardVersion : null;

    if (!shouldHydrateSnapshotVersion(incomingVersion, currentVersion)) {
      return false;
    }

    if (Number.isInteger(incomingVersion) && Number.isInteger(currentVersion)) {
      if (incomingVersion > currentVersion + 1 && isOnlineMode()) {
        addEvent('Detected missed updates; applied latest server snapshot.');
      }
    }

    if (isOnlineMode()) {
      multiplayer.awaitingStateSync = false;
    }

    state = {
      ...base,
      board: snapshot.board ? cloneBoard(snapshot.board) : base.board,
      turn: snapshot.turn || base.turn,
      enPassant: snapshot.enPassant ? { ...snapshot.enPassant } : null,
      moveNumber: snapshot.moveNumber || base.moveNumber,
      movePairs: snapshot.movePairs
        ? snapshot.movePairs.map((item) => ({ ...item }))
        : base.movePairs,
      events: snapshot.events
        ? snapshot.events.map((entry) => normalizeEventEntry(entry))
        : base.events,
      captured: snapshot.captured ? { ...snapshot.captured } : base.captured,
      winner: snapshot.winner || null,
      result: snapshot.result || null,
      gameOver: Boolean(snapshot.gameOver),
      halfMoveClock: Number.isInteger(snapshot.halfMoveClock) ? snapshot.halfMoveClock : base.halfMoveClock,
      boardVersion: Number.isInteger(snapshot.boardVersion) ? snapshot.boardVersion : base.boardVersion,
      positionCounts: snapshot.positionCounts
        ? { ...snapshot.positionCounts }
        : base.positionCounts,
      hardMode: typeof snapshot.hardMode === 'boolean'
        ? snapshot.hardMode
        : hardModeEl.checked,
      selected: null,
    };

    hardModeEl.checked = state.hardMode;

    return true;
  }

  function requestStateSync(reason = '') {
    if (!isOnlineMode() || !multiplayer.connected || !multiplayer.roomCode || multiplayer.awaitingStateSync) {
      return;
    }

    multiplayer.awaitingStateSync = true;
    if (reason) {
      addEvent(reason);
      render();
    }

    const sent = sendSocketMessage(WEBSOCKET_TYPES.GAME_STATE, {}, multiplayer.roomCode);
    if (!sent) {
      multiplayer.awaitingStateSync = false;
    }
  }

  function syncFromRoomPayload(messagePayload) {
    if (!messagePayload?.game) {
      return;
    }
    if (Array.isArray(messagePayload.players)) {
      multiplayer.players = messagePayload.players;
    }
    if (Array.isArray(messagePayload.spectators)) {
      multiplayer.spectators = messagePayload.spectators;
    }
    if (Array.isArray(messagePayload.game.players)) {
      multiplayer.players = messagePayload.game.players;
    }
    if (Array.isArray(messagePayload.game.spectators)) {
      multiplayer.spectators = messagePayload.game.spectators;
    }
    if (!hydrateGameState(messagePayload.game)) {
      return;
    }
    render();
  }

  function applyRosterFromPayload(payload = {}) {
    if (!payload || typeof payload !== 'object') {
      return;
    }
    if (Array.isArray(payload.players)) {
      multiplayer.players = payload.players;
    } else if (Array.isArray(payload?.game?.players)) {
      multiplayer.players = payload.game.players;
    }

    if (Array.isArray(payload.spectators)) {
      multiplayer.spectators = payload.spectators;
    } else if (Array.isArray(payload?.game?.spectators)) {
      multiplayer.spectators = payload.game.spectators;
    }
  }

  function getNormalizedDrawReason(input) {
    const normalized = typeof input === 'string'
      ? input.trim().toLowerCase().replace(/[^a-z]/g, '')
      : '';
    if (!normalized) {
      return '';
    }
    return DRAW_REASON_ALIASES[normalized] || '';
  }

  function evaluateDrawEligibility(currentState, requestedReason = '') {
    const claims = {
      fivefold: isFivefoldRepetition(currentState),
      seventyFiveMove: isSeventyFiveMoveRule(currentState),
      threefold: isThreefoldRepetition(currentState),
      fiftyMove: isFiftyMoveRule(currentState),
      insufficientMaterial: isInsufficientMaterial(currentState.board),
    };

    if (requestedReason) {
      return claims[requestedReason] ? requestedReason : '';
    }

    return claims.fivefold
      ? 'fivefold'
      : claims.seventyFiveMove
        ? 'seventyFiveMove'
        : claims.threefold
          ? 'threefold'
          : claims.fiftyMove
            ? 'fiftyMove'
            : claims.insufficientMaterial
              ? 'insufficientMaterial'
              : '';
  }

  function applyPlayerIdentity(message, payload = {}) {
    if (payload.role === 'spectator') {
      multiplayer.role = 'spectator';
      multiplayer.color = null;
      multiplayer.playerId = null;
      multiplayer.spectatorId = payload.spectatorId || null;
      multiplayer.resumeToken = null;
    }

    const nextPlayerId = payload.role === 'spectator' ? '' : (message?.playerId || payload.playerId);
    if (nextPlayerId) {
      multiplayer.playerId = nextPlayerId;
    }

    if (payload.color) {
      multiplayer.color = payload.color;
      multiplayer.role = 'player';
      multiplayer.spectatorId = null;
    }

    if (payload.resumeToken) {
      multiplayer.resumeToken = payload.resumeToken;
    }

    const roster = payload?.players || payload?.game?.players;
    // Always trust the server's roster for color — overrides stale local cache
    if (roster && multiplayer.playerId) {
      const match = roster.find((player) => player.playerId === multiplayer.playerId);
      if (match?.color) {
        multiplayer.color = match.color;
        multiplayer.role = 'player';
        multiplayer.spectatorId = null;
      }
    }

    applyRosterFromPayload(payload);

    updateOnlineSessionPersistence();
  }

  function pickPromotionFromOptions(promotionMoves) {
    return new Promise((resolve) => {
      const options = [...new Set(promotionMoves.map((move) => move.promotion).filter(Boolean))];
      const color = promotionMoves[0]?.piece?.color || state.turn;

      promotionPiecesEl.replaceChildren();
      for (const opt of options) {
        const btn = document.createElement('button');
        btn.type = 'button';
        const svgEl = createPieceSvgElement(color, opt);
        if (svgEl) {
          svgEl.style.width = '52px';
          svgEl.style.height = '52px';
          btn.appendChild(svgEl);
        } else {
          btn.textContent = PIECE_SYMBOLS[color][opt];
        }
        btn.addEventListener('click', () => {
          promotionPickerEl.hidden = true;
          promotionPickerEl.classList.remove('visible');
          const chosen = promotionMoves.find((move) => move.promotion === opt);
          resolve(chosen || null);
        });
        promotionPiecesEl.appendChild(btn);
      }

      // Position the picker near the promotion square
      const toSquare = promotionMoves[0]?.to;
      if (toSquare) {
        const boardRect = boardEl.getBoundingClientRect();
        const sqSize = boardRect.width / 8;
        const perspectiveColor = getPerspectiveColor();
        const flipped = perspectiveColor === 'b';
        const displayC = flipped ? 7 - toSquare.c : toSquare.c;
        const left = boardRect.left + displayC * sqSize;
        const top = boardRect.top;
        promotionPickerEl.style.left = left + 'px';
        promotionPickerEl.style.top = top + 'px';
      }

      promotionPickerEl.hidden = false;
      requestAnimationFrame(() => promotionPickerEl.classList.add('visible'));
    });
  }

  function applyLocalMove(attempted) {
    const movePly = getCurrentPly() + 1;
    const beforeBoard = cloneBoard(state.board);
    const beforeEnPassant = state.enPassant ? { ...state.enPassant } : null;
    const outcome = applyMove(state.board, attempted, state.enPassant);
    state.board = outcome.board;
    state.enPassant = outcome.enPassant;
    state.selected = null;
    if (outcome.captured || attempted.piece.type === 'P') {
      state.halfMoveClock = 0;
    } else {
      state.halfMoveClock += 1;
    }
    playMoveFeedback({
      capture: Boolean(outcome.captured),
      moverColor: attempted.piece.color,
      capturedColor: outcome.captured?.color || null,
    });

    if (outcome.captured) {
      state.captured[outcome.captured.color] += 1;
      setCaptureMarkerForPly(movePly, {
        square: deriveCaptureSquare(attempted.from, attempted.to, Boolean(attempted.enPassant)),
        moverColor: attempted.piece.color,
        capturedColor: outcome.captured.color,
      });
      addEvent(`${colorName(outcome.captured.color)} piece was taken.`, {
        color: attempted.piece.color,
        move: movePly,
      });
    }

    const san = moveToSAN(beforeBoard, beforeEnPassant, attempted, state.board, state.enPassant);
    setMoveHighlightForPly(movePly, {
      from: attempted.from,
      to: attempted.to,
      san,
    });
    addMoveRecord(state.turn, san);
    addEvent(`${toMoveColorFromState()} played ${san}`, {
      color: attempted.piece.color,
      move: getCurrentPly(),
    });

    state.turn = otherColor(state.turn);
    recordCurrentPosition(state);
    pendingServerAttempt = null;
    checkAfterLegalMove();
  }

  function requestMoveToServer(attempted) {
    if (!multiplayer.connected) {
      addEvent('Server is not connected.');
      render();
      return;
    }
    if (!multiplayer.roomCode || !multiplayer.color) {
      addEvent('Join a room first.');
      render();
      return;
    }
    if (!isMyTurn()) {
      addEvent('It is not your turn.');
      render();
      return;
    }

    const payload = {
      from: attempted.from,
      to: attempted.to,
    };

    if (attempted.promotion) {
      payload.promotion = attempted.promotion;
    }

    pendingServerAttempt = {
      from: { ...attempted.from },
      to: { ...attempted.to },
      color: attempted.piece.color,
      ply: getCurrentPly() + 1,
    };
    sendSocketMessage(WEBSOCKET_TYPES.MOVE_INTENT, payload, multiplayer.roomCode);
    addEvent('Move sent.');
    state.selected = null;
  }

  function requestRawMoveIntentToServer(from, to, color) {
    if (!multiplayer.connected || !multiplayer.roomCode || !isMyTurn()) {
      return false;
    }

    pendingServerAttempt = {
      from: { ...from },
      to: { ...to },
      color,
      ply: getCurrentPly() + 1,
    };
    return sendSocketMessage(
      WEBSOCKET_TYPES.MOVE_INTENT,
      { from: { ...from }, to: { ...to } },
      multiplayer.roomCode,
    );
  }

  function sendHardModeUpdate(previousHardMode = state.hardMode) {
    if (!isOnlineMode() || !multiplayer.connected || !multiplayer.roomCode) {
      return;
    }
    if (isSpectatorMode()) {
      state.hardMode = previousHardMode;
      hardModeEl.checked = previousHardMode;
      return;
    }

    sendSocketMessage(
      WEBSOCKET_TYPES.SET_HARD_MODE,
      { enabled: Boolean(state.hardMode) },
      multiplayer.roomCode,
    );
  }

  function handleClaimDraw() {
    const response = window.prompt(
      `Enter draw reason (${DRAW_CLAIM_REASONS.join(' | ')}). Leave blank for auto-check.`,
      '',
    );
    if (response === null) {
      return;
    }

    const requestedReason = getNormalizedDrawReason(response);
    if (!isOnlineMode()) {
      const drawReason = evaluateDrawEligibility(state, requestedReason);
      if (!drawReason) {
        addEvent('No valid draw claim available.');
        render();
        return;
      }

      state.gameOver = true;
      state.winner = null;
      state.result = drawReason;
      addEvent(`Draw claimed: ${drawReason}.`);
      render();
      return;
    }

    if (!multiplayer.connected || !multiplayer.roomCode) {
      addEvent('Join a room first.');
      render();
      return;
    }

    const payload = {
      reason: requestedReason,
    };
    sendSocketMessage(WEBSOCKET_TYPES.CLAIM_DRAW, payload, multiplayer.roomCode);
    addEvent('Draw requested.');
    render();
  }

  function applyLocalResignation(resigningColor) {
    if (state.gameOver) {
      return;
    }

    const color = resigningColor === 'w' || resigningColor === 'b' ? resigningColor : state.turn;
    const winnerColor = otherColor(color);
    state.gameOver = true;
    state.winner = colorName(winnerColor);
    state.result = 'resign';
    state.selected = null;
    addEvent(`${colorName(color)} resigned. ${state.winner} wins.`, {
      color,
      move: getCurrentPly(),
    });
  }

  function handleResign() {
    if (isSpectatorMode()) {
      addEvent('Spectators cannot resign.');
      render();
      return;
    }

    if (state.gameOver) {
      render();
      return;
    }

    const confirmed = window.confirm('Resign this game?');
    if (!confirmed) {
      return;
    }

    if (isOnlineMode() && multiplayer.connected && multiplayer.roomCode) {
      sendSocketMessage(WEBSOCKET_TYPES.RESIGN, {}, multiplayer.roomCode);
      return;
    }

    applyLocalResignation(getActiveColor() || state.turn);
    render();
  }

  async function handleSquareClick(r, c) {
    unlockAudio();

    if (state.gameOver) {
      showTransientBanner('Game over. Start a new game to continue.');
      return;
    }

    const activeColor = getActiveColor();
    if (!activeColor) {
      if (isSpectatorMode()) {
        showTransientBanner('Spectator mode: moves disabled.');
        return;
      }
      addEvent(isOnlineMode() ? 'Join a room before moving.' : 'No playable color found.');
      render();
      return;
    }

    if (!isMyTurn() && isOnlineMode()) {
      addEvent('Wait for your turn.');
      state.selected = null;
      render();
      return;
    }

    const clickedPiece = state.board[r][c];
    if (!state.selected) {
      if (clickedPiece && clickedPiece.color === activeColor) {
        state.selected = { r, c };
        renderBoard();
      }
      return;
    }

    const from = state.selected;
    if (from.r === r && from.c === c) {
      state.selected = null;
      renderBoard();
      return;
    }

    if (clickedPiece && clickedPiece.color === activeColor && !(from.r === r && from.c === c)) {
      state.selected = { r, c };
      renderBoard();
      return;
    }

    const legalMoves = generateLegalMoves(state.board, state.turn, state.enPassant);
    const matchingMoves = legalMoves.filter(
      (move) => move.from.r === from.r && move.from.c === from.c && move.to.r === r && move.to.c === c,
    );
    const promotionMoveSet = matchingMoves.filter((move) => move.promotion);
    let attempted;
    if (promotionMoveSet.length) {
      attempted = await pickPromotionFromOptions(promotionMoveSet);
    } else {
      attempted = matchingMoves[0];
    }
    if (!attempted && promotionMoveSet.length) {
      state.selected = null;
      render();
      return;
    }

    if (!attempted) {
      const message = `${toMoveColorFromState()} attempted an illegal move ${squareName(from)} to ${squareName({ r, c })}`;
      const reason = moveRejectionReason(from, { r, c });
      const illegalPly = getCurrentPly() + 1;
      const illegalColor = state.turn;
      if (isOnlineMode()) {
        const sent = requestRawMoveIntentToServer(from, { r, c }, illegalColor);
        if (sent) {
          showTransientBanner(`Checking ${squareName(from)} → ${squareName({ r, c })}...`);
          addEvent(`${message}. Sent to server for validation.`, {
            color: illegalColor,
            move: illegalPly,
          });
        } else {
          addEvent('Could not send move to server.', {
            color: illegalColor,
            move: illegalPly,
          });
        }
        state.selected = null;
        render();
        return;
      }

      recordIllegalAttempt(from, { r, c }, reason, illegalColor, illegalPly);
      if (state.hardMode) {
        state.selected = null;
        if (isInCheck(state.board, illegalColor)) {
          addEvent(`${message}; ${reason} You are in check. Choose a legal move.`, {
            color: illegalColor,
            move: illegalPly,
          });
          showIllegalMoveBanner(from, { r, c }, reason);
        } else {
          addEvent(`${message}; ${reason} Turn forfeited.`, {
            color: illegalColor,
            move: illegalPly,
          });
          state.turn = otherColor(state.turn);
          showIllegalMoveBanner(from, { r, c }, reason, state.turn);
          evaluateAfterTurnChange();
        }
        render();
      } else {
        showIllegalMoveBanner(from, { r, c }, reason);
        addEvent(`${message}. ${reason}`, {
          color: illegalColor,
          move: illegalPly,
        });
        state.selected = null;
        render();
      }
      return;
    }

    state.selected = null;
    if (isOnlineMode()) {
      requestMoveToServer(attempted);
      render();
      return;
    }

    applyLocalMove(attempted);
    render();
  }

  function sendSocketMessage(type, payload = {}, roomCode = '') {
    if (!multiplayer.socket || multiplayer.socket.readyState !== WebSocket.OPEN) {
      addEvent('Cannot send message: socket is not open.');
      render();
      return false;
    }

    const message = {
      type,
      roomCode: roomCode || multiplayer.roomCode,
      playerId: multiplayer.playerId || '',
      payload,
      version: PROTOCOL_VERSION,
    };

    if (type === WEBSOCKET_TYPES.CREATE_ROOM) {
      delete message.roomCode;
      delete message.playerId;
    }
    multiplayer.socket.send(JSON.stringify(message));
    return true;
  }

  function disconnectSocket() {
    if (multiplayer.connectPromise) {
      multiplayer.connectPromise = null;
    }
    if (!multiplayer.socket) {
      multiplayer.connected = false;
      multiplayer.awaitingStateSync = false;
      return;
    }

    const socket = multiplayer.socket;
    multiplayer.socket = null;
    socket.onopen = null;
    socket.onmessage = null;
    socket.onclose = null;
    socket.onerror = null;
    multiplayer.awaitingStateSync = false;
    if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
      socket.close();
    }
    multiplayer.connected = false;
  }

  function connectSocket() {
    if (multiplayer.connectPromise) {
      return multiplayer.connectPromise;
    }
    if (multiplayer.socket && multiplayer.connected) {
      return Promise.resolve();
    }

    const nextServerUrl = serverUrlEl.value.trim() || DEFAULT_SERVER_URL;
    if (!nextServerUrl) {
      multiplayerStatusEl.textContent = 'Enter a valid WebSocket URL.';
      return Promise.reject(new Error('Invalid server URL.'));
    }

    multiplayer.socketUrl = nextServerUrl;
    saveServerUrl(nextServerUrl);
    disconnectSocket();
    syncMultiplayerControlState();

    multiplayer.connectPromise = new Promise((resolve, reject) => {
      const socket = new WebSocket(nextServerUrl);
      multiplayer.socket = socket;

      socket.addEventListener('open', () => {
        multiplayer.connected = true;
        multiplayer.reconnectAttempts = 0;
        clearReconnectTimer();
        multiplayer.connectPromise = null;
        multiplayerStatusEl.textContent = `Connected to ${nextServerUrl}.`;
        syncMultiplayerControlState();
        syncMultiplayerPanel();
        resolve();
      });

      socket.addEventListener('message', handleServerMessage);
      socket.addEventListener('error', () => {
        multiplayer.connected = false;
        multiplayer.connectPromise = null;
        multiplayerStatusEl.textContent = 'Socket error while connecting.';
        syncMultiplayerControlState();
        reject(new Error('WebSocket error.'));
      });

      socket.addEventListener('close', () => {
        const wasOnline = isOnlineMode();
        const hadRoom = Boolean(multiplayer.roomCode);
        const shouldAutoReconnect = wasOnline && hadRoom && !multiplayer.intentionalLeave;
        multiplayer.connected = false;
        multiplayer.connectPromise = null;
        multiplayer.awaitingStateSync = false;
        if (wasOnline) {
          syncMultiplayerPanel();
          render();
        }
        syncMultiplayerControlState();
        if (shouldAutoReconnect) {
          scheduleAutoReconnect();
        }
      });
    });

    return multiplayer.connectPromise;
  }

  function handleServerMessage(event) {
    let message;
    try {
      message = JSON.parse(event.data);
    } catch {
      addEvent('Received invalid JSON from server.');
      render();
      return;
    }

    const { type, payload = {} } = message;
    if (type === WEBSOCKET_TYPES.ROOM_CREATED) {
      multiplayer.roomCode = normalizeRoomCode(message.roomCode || payload.roomCode);
      applyPlayerIdentity(message, payload);
      multiplayer.role = 'player';
      multiplayer.spectatorId = null;
      multiplayer.color = multiplayer.color || payload.playerColor || payload.color;
      applyRosterFromPayload(payload);
      multiplayer.intentionalLeave = false;
      syncFromRoomPayload(message);
      saveOnlineSession();
      resetLobbyActionButtons();
      hideLobby();
      addEvent(`Room ${multiplayer.roomCode} created. Share this code with your friend.`);
      joinRoomCodeEl.value = multiplayer.roomCode;
      copyInviteLinkSilently(multiplayer.roomCode);
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.PLAYER_ASSIGNED) {
      applyPlayerIdentity(message, payload);
      multiplayer.role = 'player';
      multiplayer.spectatorId = null;
      applyRosterFromPayload(payload);
      saveOnlineSession();
      syncMultiplayerPanel();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.ROOM_JOINED) {
      multiplayer.roomCode = normalizeRoomCode(message.roomCode || payload.roomCode);
      applyPlayerIdentity(message, payload);
      if (payload.role === 'spectator') {
        multiplayer.role = 'spectator';
        multiplayer.color = null;
        multiplayer.playerId = null;
        multiplayer.spectatorId = payload.spectatorId || multiplayer.spectatorId || null;
      }
      applyRosterFromPayload(payload);
      multiplayer.intentionalLeave = false;
      updateOnlineSessionPersistence();
      resetLobbyActionButtons();
      hideLobby();
      syncMultiplayerPanel();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.GAME_STATE) {
      applyRosterFromPayload(payload);
      if (payload.game) {
        const accepted = hydrateGameState(payload.game);
        if (!accepted) {
          return;
        }
      }
      updateOnlineSessionPersistence();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.MOVE_APPLIED) {
      const previousCaptured = { ...state.captured };
      applyRosterFromPayload(payload);
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      const moverColor = payload.color || payload.movedBy || otherColor(state.turn);
      let capturedColor = null;
      if (state.captured.w > previousCaptured.w) {
        capturedColor = 'w';
      } else if (state.captured.b > previousCaptured.b) {
        capturedColor = 'b';
      }
      const appliedPly = getCurrentPly();
      if (payload.move?.from && payload.move?.to) {
        setMoveHighlightForPly(appliedPly, {
          from: payload.move.from,
          to: payload.move.to,
          san: payload.san || '',
        });
      }
      if (capturedColor && payload.move?.from && payload.move?.to) {
        setCaptureMarkerForPly(appliedPly, {
          square: deriveCaptureSquare(
            payload.move.from,
            payload.move.to,
            Boolean(payload.move.enPassant),
          ),
          moverColor,
          capturedColor,
        });
      }
      playMoveFeedback({
        capture: Boolean(capturedColor),
        moverColor,
        capturedColor,
      });
      pendingServerAttempt = null;
      if (payload.san) {
        if (!shouldRevealBoardAndHistory() && moverColor && multiplayer.color && moverColor !== multiplayer.color) {
          addEvent('Opponent moved ****', {
            color: moverColor,
            move: getCurrentPly(),
          });
        } else if (moverColor && multiplayer.color && moverColor === multiplayer.color) {
          addEvent(`You played ${payload.san}`, {
            color: moverColor,
            move: getCurrentPly(),
          });
        } else {
          addEvent(`Move played: ${maskMoveText(payload.san)}`, {
            color: moverColor,
            move: getCurrentPly(),
          });
        }
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.DRAW_RESULT) {
      applyRosterFromPayload(payload);
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (payload.reason) {
        addEvent(`Draw accepted: ${payload.reason}.`);
      } else {
        addEvent('Game drawn.');
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.RESIGN_RESULT) {
      applyRosterFromPayload(payload);
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (payload.winner) {
        addEvent(`${payload.winner} won by resignation.`);
      } else {
        addEvent('Game ended by resignation.');
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.MOVE_REJECTED) {
      const pendingColor = pendingServerAttempt?.color || state.turn;
      const offenderInCheck = pendingColor && isInCheck(state.board, pendingColor);
      const reason = payload.reasonCode === ERROR_CODES.ILLEGAL_MOVE && offenderInCheck
        ? 'You are in check. Choose a legal move.'
        : (ERROR_TEXT[payload.reasonCode] || payload.reasonCode || 'Move rejected by server.');
      const pendingPly = Number.isInteger(pendingServerAttempt?.ply) ? pendingServerAttempt.ply : (getCurrentPly() + 1);
      const attemptedFrom = pendingServerAttempt?.from || payload?.moveIntent?.from || null;
      const attemptedTo = pendingServerAttempt?.to || payload?.moveIntent?.to || null;
      if (pendingServerAttempt?.from && pendingServerAttempt?.to) {
        recordIllegalAttempt(
          pendingServerAttempt.from,
          pendingServerAttempt.to,
          reason,
          pendingColor,
          pendingPly,
        );
      }
      if (attemptedFrom && attemptedTo) {
        const forfeitedTurn = payload.forfeited
          && payload.game
          && !payload.game.gameOver
          && (payload.game.turn === 'w' || payload.game.turn === 'b')
          ? payload.game.turn
          : null;
        showIllegalMoveBanner(attemptedFrom, attemptedTo, reason, forfeitedTurn);
      } else {
        showTransientBanner(`Illegal move (${reason})`);
        showIllegalOverlay(reason);
      }
      pendingServerAttempt = null;
      state.selected = null;
      if (payload.game) {
        applyRosterFromPayload(payload);
        hydrateGameState(payload.game);
      }
      if (!payload.forfeited) {
        addEvent(`Move rejected: ${reason}`, {
          color: pendingColor,
          move: pendingPly,
        });
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.ERROR) {
      const text = ERROR_TEXT[payload.errorCode] || payload.message || 'Server error.';
      if (
        payload.errorCode === 'UNKNOWN_ROOM'
        || payload.errorCode === 'PLAYER_NOT_FOUND'
      ) {
        clearSavedOnlineSession();
      }
      resetLobbyActionButtons();
      syncMultiplayerControlState();
      addEvent(`Server error: ${text}`);
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.DRAW_OFFERED) {
      const offeredBy = payload.offeredBy || '';
      const offeredByName = offeredBy === 'w' ? 'White' : offeredBy === 'b' ? 'Black' : 'Opponent';
      if (offeredBy && offeredBy === multiplayer.color) {
        // This is our own offer confirmation
        showTransientBanner('Draw offer sent. Waiting for opponent to accept.');
        addEvent('You offered a draw.');
      } else {
        // Opponent offered a draw
        showTransientBanner(`${offeredByName} offers a draw. Click ½ Draw to accept.`);
        addEvent(`${offeredByName} offers a draw. Click ½ Draw to accept or ignore to decline.`);
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.PONG) {
      addEvent('Server responded to ping.');
      render();
    }
  }

  async function handleConnectClick() {
    try {
      await connectSocket();
    } catch (error) {
      multiplayerStatusEl.textContent = error.message;
      resetLobbyActionButtons();
      syncMultiplayerControlState();
    }
  }

  function setLobbyButtonLabel(button, text) {
    if (!button) {
      return;
    }
    const textEl = button.querySelector('.btn-text');
    if (textEl) {
      textEl.textContent = text;
      return;
    }
    button.textContent = text;
  }

  function resetLobbyActionButtons() {
    setLobbyButtonLabel(createRoomEl, 'Create Room');
    createRoomEl.classList.remove('btn-loading');
    setLobbyButtonLabel(joinRoomEl, 'Join Game');
    joinRoomEl.classList.remove('btn-loading');
    if (spectateRoomEl) {
      setLobbyButtonLabel(spectateRoomEl, '👁 Spectate');
      spectateRoomEl.classList.remove('btn-loading');
    }
  }

  function ensureOnlineModeSelected() {
    if (isOnlineMode()) {
      return;
    }
    playModeEl.value = 'online';
    setMode('online');
  }

  async function handleCreateRoom() {
    const btn = createRoomEl;
    try {
      ensureOnlineModeSelected();
      setLobbyButtonLabel(btn, 'Creating...');
      btn.classList.add('btn-loading');

      // If already in a room, leave it first
      if (multiplayer.roomCode) {
        multiplayer.intentionalLeave = true;
        clearSavedOnlineSession();
        clearReconnectTimer();
        disconnectSocket();
        multiplayer.roomCode = '';
        multiplayer.playerId = null;
        multiplayer.resumeToken = null;
        multiplayer.color = null;
        multiplayer.role = 'player';
        multiplayer.spectatorId = null;
        multiplayer.players = [];
        multiplayer.spectators = [];
        multiplayer.awaitingStateSync = false;
        multiplayer.connected = false;
      }

      multiplayer.intentionalLeave = false;
      await connectSocket();
      multiplayer.role = 'player';
      multiplayer.resumeToken = null;
      multiplayer.spectatorId = null;
      if (!sendSocketMessage(WEBSOCKET_TYPES.CREATE_ROOM, {
        nickname: 'Player',
        hardMode: Boolean(state.hardMode),
      })) {
        throw new Error('Failed to send create request');
      }
      addEvent('Requesting room...');
      syncMultiplayerPanel();
      syncMultiplayerControlState();
    } catch (error) {
      addEvent(error.message);
      resetLobbyActionButtons();
      syncMultiplayerControlState();
      render();
    }
  }

  async function handleJoinRoom() {
    const roomCode = normalizeRoomCode(joinRoomCodeEl.value);
    if (!roomCode) {
      addEvent('Enter room code to join.');
      render();
      return;
    }

    const btn = joinRoomEl;
    try {
      ensureOnlineModeSelected();
      setLobbyButtonLabel(btn, 'Joining...');
      btn.classList.add('btn-loading');

      multiplayer.intentionalLeave = false;
      await connectSocket();
      const currentRoomCode = normalizeRoomCode(multiplayer.roomCode || '');
      const saved = readSavedOnlineSession();
      const hasLiveResume = currentRoomCode === roomCode
        && Boolean(multiplayer.playerId)
        && Boolean(multiplayer.resumeToken);
      const hasSavedResume = Boolean(saved)
        && saved.roomCode === roomCode
        && Boolean(saved.playerId)
        && Boolean(saved.resumeToken);
      const resumeIdentity = hasLiveResume
        ? {
          playerId: multiplayer.playerId,
          resumeToken: multiplayer.resumeToken,
          color: multiplayer.color || null,
        }
        : hasSavedResume
          ? {
            playerId: saved.playerId,
            resumeToken: saved.resumeToken,
            color: saved.color || null,
          }
          : null;
      const joinPayload = resumeIdentity
        ? { nickname: 'Player', resume: true, resumeToken: resumeIdentity.resumeToken }
        : { nickname: 'Player' };

      if (resumeIdentity) {
        multiplayer.playerId = resumeIdentity.playerId;
        multiplayer.resumeToken = resumeIdentity.resumeToken;
        multiplayer.color = resumeIdentity.color;
      } else {
        multiplayer.playerId = null;
        multiplayer.resumeToken = null;
        multiplayer.color = null;
      }

      if (!sendSocketMessage(WEBSOCKET_TYPES.JOIN_ROOM, joinPayload, roomCode)) {
        throw new Error('Failed to send join request');
      }
      multiplayer.role = 'player';
      multiplayer.spectatorId = null;
      multiplayer.roomCode = roomCode;
      addEvent(resumeIdentity
        ? `Rejoining saved seat in room ${roomCode}...`
        : `Joining room ${roomCode}...`);
      syncMultiplayerPanel();
      syncMultiplayerControlState();
    } catch (error) {
      addEvent(error.message);
      resetLobbyActionButtons();
      syncMultiplayerControlState();
      render();
    }
  }

  async function handleSpectateRoom() {
    const roomCode = normalizeRoomCode(joinRoomCodeEl.value);
    if (!roomCode) {
      addEvent('Enter room code to spectate.');
      render();
      return;
    }

    const btn = spectateRoomEl;
    try {
      ensureOnlineModeSelected();
      setLobbyButtonLabel(btn, 'Joining...');
      btn.classList.add('btn-loading');

      multiplayer.intentionalLeave = false;
      await connectSocket();
      multiplayer.resumeToken = null;
      if (!sendSocketMessage(WEBSOCKET_TYPES.JOIN_ROOM, {
        nickname: 'Spectator',
        spectator: true,
      }, roomCode)) {
        throw new Error('Failed to send spectate request');
      }
      clearSavedOnlineSession();
      multiplayer.role = 'spectator';
      multiplayer.color = null;
      multiplayer.playerId = null;
      multiplayer.spectatorId = null;
      multiplayer.roomCode = roomCode;
      addEvent(`Spectating room ${roomCode}...`);
      syncMultiplayerPanel();
      syncMultiplayerControlState();
    } catch (error) {
      addEvent(error.message);
      resetLobbyActionButtons();
      syncMultiplayerControlState();
      render();
    }
  }

  async function handleCopyCode() {
    if (!multiplayer.roomCode) {
      addEvent('No room code to copy.');
      render();
      return;
    }

    try {
      const inviteUrl = buildInviteUrl(multiplayer.roomCode);
      await navigator.clipboard.writeText(inviteUrl);
      addEvent(`Copied invite link for room ${multiplayer.roomCode}`);
    } catch {
      addEvent('Could not copy invite link. Copy room code manually.');
    }
    render();
  }

  function copyInviteLinkSilently(roomCode) {
    if (!roomCode || !navigator?.clipboard?.writeText) {
      return;
    }

    const inviteUrl = buildInviteUrl(roomCode);
    navigator.clipboard.writeText(inviteUrl)
      .then(() => {
        showTransientBanner('Room created. Invite link copied.');
      })
      .catch(() => {
        showTransientBanner(`Room ${roomCode} created.`);
      });
  }

  function handleLeaveRoom() {
    multiplayer.intentionalLeave = true;
    clearSavedOnlineSession();
    clearReconnectTimer();
    disconnectSocket();
    clearRoomSession({ clearSavedSession: true });
    if (isOnlineMode()) {
      playModeEl.value = 'local';
    }
    setMode('local');
    resetLobbyActionButtons();
    multiplayerStatusEl.textContent = 'Left room.';
    syncMultiplayerPanel();
    syncMultiplayerControlState();
    render();
  }

  function resetGame() {
    if (isOnlineMode()) {
      if (!multiplayer.connected || !multiplayer.roomCode) {
        addEvent('Join a room first.');
        render();
        return;
      }
      if (multiplayer.color !== 'w') {
        addEvent('Only White can request a new online game.');
        requestStateSync();
        render();
        return;
      }

      sendSocketMessage(WEBSOCKET_TYPES.NEW_GAME, {}, multiplayer.roomCode);
      addEvent('Requested new game from server.');
      render();
      return;
    }

    // Local: ask for confirmation if a game is in progress
    if (getCurrentPly() > 0 && !state.gameOver) {
      if (!window.confirm('Start a new game? The current game will be lost.')) {
        return;
      }
    }

    state = newGameState();
    state.hardMode = hardModeEl.checked;
    state.selected = null;
    render();
    addEvent('New game started.');
  }

  function render() {
    syncReplayHistoryWithState();
    saveCompletedGameToHistory();
    renderBoard();
    renderEvents();
    renderMoves();
    renderStatus();
    syncIngameToolbar();
  }

  // ===== LOBBY MODAL LOGIC =====
  function populateLobbyResumeSection() {
    if (!lobbyResumeSectionEl) {
      return;
    }
    const saved = readSavedOnlineSession();
    if (!saved) {
      lobbyResumeSectionEl.classList.add('hidden');
      return;
    }
    const colorLabel = saved.color === 'w' ? 'White' : saved.color === 'b' ? 'Black' : 'Unknown color';
    if (lobbyResumeInfoEl) {
      lobbyResumeInfoEl.textContent = `Room: ${saved.roomCode}  ·  Playing as: ${colorLabel}`;
    }
    lobbyResumeSectionEl.classList.remove('hidden');
  }

  async function handleLobbyResume() {
    const saved = readSavedOnlineSession();
    if (!saved) {
      return;
    }
    // Pre-populate the multiplayer state so the resume flow works
    multiplayer.roomCode = saved.roomCode;
    multiplayer.playerId = saved.playerId;
    multiplayer.resumeToken = saved.resumeToken;
    multiplayer.color = saved.color || null;
    multiplayer.role = 'player';
    multiplayer.spectatorId = null;
    multiplayer.socketUrl = saved.socketUrl || DEFAULT_SERVER_URL;
    joinRoomCodeEl.value = saved.roomCode;
    serverUrlEl.value = multiplayer.socketUrl;
    if (!isOnlineMode()) {
      playModeEl.value = 'online';
      setMode('online', { preserveSession: true });
    }
    syncMultiplayerPanel();
    syncMultiplayerControlState();
    hideLobby();
    resumeOnlineSession('Resuming saved session');
  }

  function handleLobbyStartFresh() {
    clearSavedOnlineSession();
    if (lobbyResumeSectionEl) {
      lobbyResumeSectionEl.classList.add('hidden');
    }
    // Reset multiplayer color so the board renders neutrally
    multiplayer.color = null;
    multiplayer.roomCode = '';
    multiplayer.playerId = null;
    multiplayer.resumeToken = null;
    render();
  }

  function showLobby() {
    if (gameLobbyOverlay) {
      gameLobbyOverlay.classList.remove('hidden');
      lobbyStep1.classList.add('active');
      lobbyStep2.classList.remove('active');
      if (lobbyHardModeEl) lobbyHardModeEl.checked = hardModeEl.checked;
      resetLobbyActionButtons();
      populateLobbyResumeSection();
    }
  }

  function hideLobby() {
    if (gameLobbyOverlay) {
      gameLobbyOverlay.classList.add('hidden');
    }
  }

  function lobbyChooseLocal() {
    if (lobbyHardModeEl) {
      hardModeEl.checked = lobbyHardModeEl.checked;
      state.hardMode = hardModeEl.checked;
    }
    playModeEl.value = 'local';
    setMode('local');
    hideLobby();
  }

  function lobbyChooseOnline() {
    if (lobbyHardModeEl) {
      hardModeEl.checked = lobbyHardModeEl.checked;
      state.hardMode = hardModeEl.checked;
    }
    ensureOnlineModeSelected();
    lobbyStep1.classList.remove('active');
    lobbyStep2.classList.add('active');
    resetLobbyActionButtons();
    syncMultiplayerControlState();
    syncMultiplayerPanel();
    if (!multiplayer.connected && !multiplayer.connectPromise && !multiplayer.resumeInFlight) {
      handleConnectClick();
    }
  }

  function lobbyGoBack() {
    // Reset any in-flight lobby operations
    resetLobbyActionButtons();
    // If not yet in a room, disconnect any partial socket connection and revert to local
    if (!multiplayer.roomCode) {
      multiplayer.intentionalLeave = true;
      if (multiplayer.connected) {
        disconnectSocket();
      }
      multiplayer.connectPromise = null;
      setMode('local');
      playModeEl.value = 'local';
    }
    lobbyStep2.classList.remove('active');
    lobbyStep1.classList.add('active');
    syncMultiplayerControlState();
    syncMultiplayerPanel();
  }

  // ===== INGAME TOOLBAR SYNC =====
  function syncIngameToolbar() {
    if (!ingameToolbar) return;
    const online = isOnlineMode();
    const inRoom = Boolean(multiplayer.roomCode);
    ingameToolbar.hidden = online && !inRoom;
    copyRoomCodeEl.hidden = !online || !inRoom;
    leaveRoomEl.hidden = !online;
    claimDrawEl.hidden = false;
    resignEl.hidden = false;
  }

  // ===== EVENT HANDLERS =====
  hardModeEl.addEventListener('change', () => {
    const previousHardMode = state.hardMode;
    // Online restrictions: only White can change hard mode, and only before the first move
    if (isOnlineMode() && multiplayer.connected && multiplayer.roomCode) {
      if (multiplayer.color === 'b') {
        hardModeEl.checked = previousHardMode;
        showTransientBanner('Only White can change the hard mode setting.');
        return;
      }
      if (getCurrentPly() > 0) {
        hardModeEl.checked = previousHardMode;
        showTransientBanner('Hard mode can only be changed before the first move.');
        return;
      }
    }
    state.hardMode = hardModeEl.checked;
    if (lobbyHardModeEl) lobbyHardModeEl.checked = hardModeEl.checked;
    sendHardModeUpdate(previousHardMode);
    renderStatus();
  });

  newGameEl.addEventListener('click', () => {
    resetGame();
  });

  playModeEl.addEventListener('change', (event) => {
    if (event.target.value === 'local') {
      clearSavedOnlineSession();
      multiplayer.intentionalLeave = true;
      clearReconnectTimer();
    } else {
      multiplayer.intentionalLeave = false;
    }
    setMode(event.target.value);
  });

  if (connectServerEl) {
    connectServerEl.addEventListener('click', () => {
      handleConnectClick();
    });
  }

  createRoomEl.addEventListener('click', () => {
    handleCreateRoom();
  });

  joinRoomEl.addEventListener('click', () => {
    handleJoinRoom();
  });

  if (spectateRoomEl) {
    spectateRoomEl.addEventListener('click', () => {
      handleSpectateRoom();
    });
  }

  copyRoomCodeEl.addEventListener('click', () => {
    handleCopyCode();
  });

  if (exportPgnEl) {
    exportPgnEl.addEventListener('click', () => {
      handleExportPgn();
    });
  }

  if (loadHistoryGameEl && historyGamesEl) {
    loadHistoryGameEl.addEventListener('click', () => {
      const selected = historyGamesEl.value;
      if (!selected) {
        return;
      }
      if (!loadHistoryEntryById(selected)) {
        showTransientBanner('Could not load selected game.');
      }
    });
  }

  if (clearHistoryGamesEl) {
    clearHistoryGamesEl.addEventListener('click', () => {
      clearHistoryGames();
    });
  }

  if (replayFirstEl) {
    replayFirstEl.addEventListener('click', () => {
      setReplayFirst();
    });
  }

  if (replayPrevEl) {
    replayPrevEl.addEventListener('click', () => {
      stepReplay(-1);
    });
  }

  if (replayNextEl) {
    replayNextEl.addEventListener('click', () => {
      stepReplay(1);
    });
  }

  if (replayFinalEl) {
    replayFinalEl.addEventListener('click', () => {
      setReplayFinal();
    });
  }

  leaveRoomEl.addEventListener('click', () => {
    handleLeaveRoom();
  });

  claimDrawEl.addEventListener('click', () => {
    handleClaimDraw();
  });

  resignEl.addEventListener('click', () => {
    handleResign();
  });

  window.addEventListener('pointerdown', unlockAudio, { once: true });
  window.addEventListener('keydown', unlockAudio, { once: true });

  // Theme selectors — lobby, header, and inline
  if (uiThemeEl) {
    uiThemeEl.addEventListener('change', applyThemes);
  }
  if (boardThemeEl) {
    boardThemeEl.addEventListener('change', applyThemes);
  }
  if (uiThemeHeaderEl) {
    uiThemeHeaderEl.addEventListener('change', () => {
      if (uiThemeEl) uiThemeEl.value = uiThemeHeaderEl.value;
      applyThemes();
    });
  }
  if (boardThemeHeaderEl) {
    boardThemeHeaderEl.addEventListener('change', () => {
      if (boardThemeEl) boardThemeEl.value = boardThemeHeaderEl.value;
      applyThemes();
    });
  }

  if (lobbyHardModeEl) {
    lobbyHardModeEl.addEventListener('change', () => {
      // Sync to main switch and state
      if (hardModeEl) hardModeEl.checked = lobbyHardModeEl.checked;
      state.hardMode = lobbyHardModeEl.checked;
    });
  }

  // Lobby modal buttons
  if (lobbyLocalBtn) {
    lobbyLocalBtn.addEventListener('click', lobbyChooseLocal);
  }
  if (lobbyOnlineBtn) {
    lobbyOnlineBtn.addEventListener('click', lobbyChooseOnline);
  }
  if (lobbyBackBtn) {
    lobbyBackBtn.addEventListener('click', lobbyGoBack);
  }
  if (openLobbyBtn) {
    openLobbyBtn.addEventListener('click', showLobby);
  if (lobbyCloseBtn) lobbyCloseBtn.addEventListener('click', hideLobby);
  }
  if (lobbyResumeBtnEl) {
    lobbyResumeBtnEl.addEventListener('click', handleLobbyResume);
  }
  if (lobbyStartFreshBtnEl) {
    lobbyStartFreshBtnEl.addEventListener('click', handleLobbyStartFresh);
  }

  // Initialize
  loadSavedThemes();
  const initialMode = readSavedPlayMode();
  playModeEl.value = initialMode;
  setMode(initialMode, { preserveSession: true });
  state.hardMode = hardModeEl.checked;
  loadHistoryCache();
  applyUrlPrefill();

  // Always show the lobby on page load so users explicitly choose how to proceed.
  // If a saved online session exists the lobby resume banner will appear,
  // letting the user decide whether to resume or start fresh.
  showLobby();

  render();
})();
