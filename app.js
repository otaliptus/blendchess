(() => {
  const core = window.ChessCore;
  if (!core) {
    throw new Error('Chess core is required. Load chess-core.js before app.js.');
  }

  const PIECE_SYMBOLS = {
    w: { K: '♔', Q: '♕', R: '♖', B: '♗', N: '♘', P: '♙' },
    b: { K: '♚', Q: '♛', R: '♜', B: '♝', N: '♞', P: '♟' },
  };

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

  const boardEl = document.getElementById('board');
  const statusEl = document.getElementById('status');
  const modeText = document.getElementById('modeText');
  const capturesEl = document.getElementById('captures');
  const eventsEl = document.getElementById('events');
  const moveBody = document.getElementById('moveBody');
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
  const playModeEl = document.getElementById('playMode');
  const serverUrlEl = document.getElementById('serverUrl');
  const fileLabelsTop = Array.from(document.querySelectorAll('.file-labels-top span'));
  const fileLabelsBottom = Array.from(document.querySelectorAll('.file-labels-bottom span'));
  const rankLabelsLeft = Array.from(document.querySelectorAll('.rank-labels-left span'));
  const rankLabelsRight = Array.from(document.querySelectorAll('.rank-labels-right span'));
  const connectServerEl = document.getElementById('connectServer');
  const createRoomEl = document.getElementById('createRoom');
  const joinRoomCodeEl = document.getElementById('joinRoomCode');
  const joinRoomEl = document.getElementById('joinRoom');
  const copyRoomCodeEl = document.getElementById('copyRoomCode');
  const leaveRoomEl = document.getElementById('leaveRoom');
  const claimDrawEl = document.getElementById('claimDraw');
  const resignEl = document.getElementById('resign');

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
    color: null,
    players: [],
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

  function inferEventColor(text) {
    if (/^White\b/i.test(text)) {
      return 'w';
    }
    if (/^Black\b/i.test(text)) {
      return 'b';
    }
    if (/^You\b/i.test(text)) {
      return normalizeEventColor(multiplayer.color);
    }
    if (/^Opponent\b/i.test(text) && multiplayer.color) {
      return otherColor(multiplayer.color);
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

  function showIllegalMoveBanner(from, to, reason) {
    showTransientBanner(`Illegal: ${squareName(from)} → ${squareName(to)} (${reason})`);
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
    const hasReplay = state.gameOver && replayHistory.length > 1;
    const maxPly = replayHistory.length ? replayHistory[replayHistory.length - 1].ply : 0;
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
      const socketUrl = typeof parsed.socketUrl === 'string' ? parsed.socketUrl.trim() : '';
      const color = parsed.color === 'w' || parsed.color === 'b' ? parsed.color : null;

      if (!roomCode || !playerId) {
        return null;
      }

      return {
        roomCode,
        playerId,
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
    if (!multiplayer.roomCode || !multiplayer.playerId) {
      return;
    }

    const session = {
      roomCode: normalizeRoomCode(multiplayer.roomCode),
      playerId: multiplayer.playerId,
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
    if (isOnlineMode() && multiplayer.roomCode && multiplayer.playerId) {
      saveOnlineSession();
      return;
    }
    clearSavedOnlineSession();
  }

  function scheduleAutoReconnect() {
    if (
      multiplayer.intentionalLeave
      || !isOnlineMode()
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

    if (mode && mode.toLowerCase() === 'online') {
      playModeEl.value = 'online';
      setMode('online');
      addEvent('Invite link detected. Click Connect, then Join room.');
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
    multiplayer.color = multiplayer.color || saved.color || null;
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
        { nickname: 'Player', resume: true },
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
    const saved = readSavedOnlineSession();
    if (!saved) {
      return;
    }

    if (!isOnlineMode()) {
      playModeEl.value = 'online';
      setMode('online');
    }

    multiplayer.roomCode = saved.roomCode;
    multiplayer.playerId = saved.playerId;
    multiplayer.color = saved.color || null;
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

  function getActiveColor() {
    if (!isOnlineMode()) {
      return state.turn;
    }
    return multiplayer.color || null;
  }

  function getPerspectiveColor() {
    if (isOnlineMode()) {
      return multiplayer.color || state.turn;
    }
    return state.turn;
  }

  function shouldRevealBoardAndHistory() {
    return state.gameOver;
  }

  function shouldMaskOpponentMoves() {
    return isOnlineMode() && !shouldRevealBoardAndHistory();
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
    if (!multiplayer.color) {
      return MASKED_MOVE_TEXT;
    }
    return color === multiplayer.color ? text : MASKED_MOVE_TEXT;
  }

  function formatEventForViewer(entry) {
    if (!shouldMaskOpponentMoves()) {
      return entry;
    }
    const body = entry;

    if (/^You played\s+/i.test(body) || /^Opponent moved/i.test(body)) {
      return entry;
    }

    const playedByColor = body.match(/^(White|Black) played\s+(.+)$/);
    if (playedByColor) {
      const moverColor = playedByColor[1] === 'White' ? 'w' : 'b';
      if (multiplayer.color && moverColor === multiplayer.color) {
        return entry;
      }
      return `${playedByColor[1]} played ${maskMoveText(playedByColor[2])}`;
    }

    const genericPlayed = body.match(/^Move played:\s+(.+)$/);
    if (genericPlayed) {
      return `Move played: ${maskMoveText(genericPlayed[1])}`;
    }

    return entry;
  }

  function updateBoardFrameLabels(flipped) {
    const files = flipped
      ? ['h', 'g', 'f', 'e', 'd', 'c', 'b', 'a']
      : ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    const ranks = flipped
      ? ['1', '2', '3', '4', '5', '6', '7', '8']
      : ['8', '7', '6', '5', '4', '3', '2', '1'];

    for (let i = 0; i < 8; i += 1) {
      if (fileLabelsTop[i + 1]) {
        fileLabelsTop[i + 1].textContent = files[i];
      }
      if (fileLabelsBottom[i + 1]) {
        fileLabelsBottom[i + 1].textContent = files[i];
      }
      if (rankLabelsLeft[i]) {
        rankLabelsLeft[i].textContent = ranks[i];
      }
      if (rankLabelsRight[i]) {
        rankLabelsRight[i].textContent = ranks[i];
      }
    }
  }

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
    }
    syncMultiplayerControlState();
    syncMultiplayerPanel();
    render();
  }

  function syncMultiplayerPanel() {
    if (isOnlineMode()) {
      const playerColor = multiplayer.color
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
      multiplayerStatusEl.textContent = `Online mode · ${connectionText} · ${roomReady} · You are ${playerColor}.`;
      multiplayerInfoEl.textContent = `Players connected: ${connectedCount}/2`;
      if (multiplayer.roomCode && multiplayer.playerId) {
        multiplayerInfoEl.textContent += ' · Refresh-safe session enabled.';
      }
      const roster = multiplayer.players
        .map((player) => {
          const connectionState = player.connected === false ? 'disconnected' : 'connected';
          return `${player.nickname || 'Player'} (${player.color === 'w' ? 'White' : 'Black'}, ${connectionState})`;
        })
        .join('  |  ');
      playerRoster.textContent = roster || 'No players yet.';
      roomCodeBadge.textContent = multiplayer.roomCode
        ? `Room: ${multiplayer.roomCode}`
        : 'Room: not active';
    } else {
      multiplayerStatusEl.textContent = 'Local mode only.';
      multiplayerInfoEl.textContent = 'You are playing locally.';
      roomCodeBadge.textContent = 'Room: not active';
      playerRoster.textContent = '';
    }
  }

  function syncMultiplayerControlState() {
    const online = isOnlineMode();
    const canEditHardMode = !online
      || !multiplayer.connected
      || !multiplayer.color
      || multiplayer.color === 'w';
    connectServerEl.disabled = !online || multiplayer.connected || multiplayer.resumeInFlight;
    createRoomEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight;
    joinRoomEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight;
    joinRoomCodeEl.disabled = !online || !multiplayer.connected || multiplayer.resumeInFlight;
    copyRoomCodeEl.disabled = !online || !multiplayer.roomCode;
    leaveRoomEl.disabled = !online;
    serverUrlEl.disabled = multiplayer.connected || multiplayer.resumeInFlight;
    claimDrawEl.disabled = online ? !multiplayer.connected : false;
    resignEl.disabled = !online || !multiplayer.connected;
    hardModeEl.disabled = !canEditHardMode || multiplayer.resumeInFlight;
  }

  function updateModeText() {
    if (isOnlineMode()) {
      if (state.hardMode) {
        modeText.textContent = 'Online hard mode: illegal moves forfeit turn (server enforced).';
      } else {
        modeText.textContent = 'Online strict mode: illegal moves are rejected by server.';
      }
      return;
    }

    if (state.hardMode) {
      modeText.textContent = 'Hard mode: illegal moves lose turn.';
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
    multiplayer.color = null;
    multiplayer.roomCode = '';
    multiplayer.players = [];
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
    const visibleColor = revealAll ? null : perspectiveColor;
    const flipped = perspectiveColor === 'b';
    const replaySnapshot = replay.active ? getReplaySnapshot(replay.ply) : null;
    const boardState = replaySnapshot ? replaySnapshot.board : state.board;
    const markerPly = replay.active ? replay.ply : getCurrentPly();
    const captureMarker = getCaptureMarkerForPly(markerPly);
    const captureMarkerClass = resolveCaptureMarkerClass(captureMarker, perspectiveColor);
    const moveHighlight = getMoveHighlightForPly(markerPly);
    const turnForBoard = replaySnapshot ? replaySnapshot.turn : state.turn;
    const checkSquare = turnForBoard && isInCheck(boardState, turnForBoard)
      ? findKingSquare(boardState, turnForBoard)
      : null;

    updateBoardFrameLabels(flipped);
    boardEl.classList.toggle('revealed', revealAll);

    for (let displayR = 0; displayR < 8; displayR += 1) {
      for (let displayC = 0; displayC < 8; displayC += 1) {
        const r = flipped ? 7 - displayR : displayR;
        const c = flipped ? 7 - displayC : displayC;
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'square';
        button.classList.add((displayR + displayC) % 2 === 0 ? 'light' : 'dark');
        button.dataset.r = String(r);
        button.dataset.c = String(c);
        button.addEventListener('click', () => handleSquareClick(r, c));

        const piece = boardState[r][c];
        if (piece && (revealAll || piece.color === visibleColor)) {
          button.classList.add('visible', 'piece', piece.color === 'w' ? 'white' : 'black');
          button.textContent = PIECE_SYMBOLS[piece.color][piece.type];
        } else {
          button.classList.add('hidden');
        }

        if (!replay.active && state.selected && state.selected.r === r && state.selected.c === c) {
          button.classList.add('selected');
        }
        if (
          captureMarkerClass
          && captureMarker?.square
          && captureMarker.square.r === r
          && captureMarker.square.c === c
        ) {
          button.classList.add(captureMarkerClass);
        }
        if (moveHighlight?.from && moveHighlight.from.r === r && moveHighlight.from.c === c) {
          button.classList.add('last-move-from');
        }
        if (moveHighlight?.to && moveHighlight.to.r === r && moveHighlight.to.c === c) {
          button.classList.add('last-move-to');
        }
        if (checkSquare && checkSquare.r === r && checkSquare.c === c) {
          button.classList.add('check-king');
        }

        boardEl.appendChild(button);
      }
    }
  }

  function renderEvents() {
    eventsEl.replaceChildren();
    for (const entry of state.events) {
      const normalized = normalizeEventEntry(entry);
      const item = document.createElement('li');
      const formattedText = formatEventForViewer(normalized.text);
      item.textContent = `[${normalized.time} | M${normalized.move}] ${formattedText}`;
      item.classList.add(`event-${normalized.color || 'neutral'}`);
      eventsEl.appendChild(item);
    }
  }

  function renderMoves() {
    moveBody.replaceChildren();
    const activePly = replay.active ? replay.ply : getCurrentPly();
    for (const move of state.movePairs) {
      const row = document.createElement('tr');
      const num = document.createElement('td');
      const white = document.createElement('td');
      const black = document.createElement('td');
      const whitePly = ((move.num - 1) * 2) + 1;
      const blackPly = whitePly + 1;
      num.textContent = String(move.num);
      white.textContent = formatMoveForViewer(move.white || '', 'w');
      black.textContent = formatMoveForViewer(move.black || '', 'b');
      if (white.textContent === MASKED_MOVE_TEXT) {
        white.classList.add('masked');
      }
      if (black.textContent === MASKED_MOVE_TEXT) {
        black.classList.add('masked');
      }
      if (move.white && state.gameOver) {
        white.classList.add('move-cell');
        white.addEventListener('click', () => {
          setReplayPly(whitePly);
        });
        if (activePly === whitePly) {
          white.classList.add('active');
        }
      }
      if (move.black && state.gameOver) {
        black.classList.add('move-cell');
        black.addEventListener('click', () => {
          setReplayPly(blackPly);
        });
        if (activePly === blackPly) {
          black.classList.add('active');
        }
      }
      row.appendChild(num);
      row.appendChild(white);
      row.appendChild(black);
      moveBody.appendChild(row);
    }
    exportPgnEl.disabled = getCurrentPly() === 0;
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
      if (isMyTurn()) {
        status = `${toMoveColorFromState()} to move.`;
      } else if (multiplayer.color) {
        status = `You are ${colorName(multiplayer.color)}. Waiting for opponent move.`;
      } else {
        status = 'Waiting for seat assignment.';
      }
    } else if (isInCheck(state.board, state.turn)) {
      status = `${toMoveColorFromState()} is in check.`;
    } else {
      status = `${toMoveColorFromState()} to move.`;
    }
    statusEl.textContent = status;
    if (inCheckNow) {
      checkAlertEl.hidden = false;
      checkAlertEl.textContent = `CHECK: ${colorName(boardTurn)}`;
    } else {
      checkAlertEl.hidden = true;
      checkAlertEl.textContent = 'CHECK';
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

    if (Number.isInteger(incomingVersion) && Number.isInteger(currentVersion)) {
      if (incomingVersion < currentVersion) {
        return false;
      }

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
    if (Array.isArray(messagePayload.game.players)) {
      multiplayer.players = messagePayload.game.players;
    }
    if (!hydrateGameState(messagePayload.game)) {
      return;
    }
    render();
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
    const nextPlayerId = message?.playerId || payload.playerId;
    if (nextPlayerId) {
      multiplayer.playerId = nextPlayerId;
    }

    if (payload.color) {
      multiplayer.color = payload.color;
    }

    const roster = payload?.players || payload?.game?.players;
    if (!multiplayer.color && roster && multiplayer.playerId) {
      const match = roster.find((player) => player.playerId === multiplayer.playerId);
      if (match?.color) {
        multiplayer.color = match.color;
      }
    }

    updateOnlineSessionPersistence();
  }

  function pickPromotionFromOptions(promotionMoves) {
    const options = [...new Set(promotionMoves.map((move) => move.promotion).filter(Boolean))];
    const defaultValue = options.includes('Q') ? 'Q' : options[0];
    while (true) {
      const response = window.prompt(`Choose promotion: ${options.join('/')}`, defaultValue);
      if (response === null) return null;

      const normalized = response.trim().toUpperCase()[0];
      if (options.includes(normalized)) {
        return promotionMoves.find((move) => move.promotion === normalized);
      }
    }
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

    if (multiplayer.color && multiplayer.color !== 'w') {
      state.hardMode = previousHardMode;
      hardModeEl.checked = previousHardMode;
      showTransientBanner('Only White can change hard mode.');
      addEvent('Only White can change hard mode in online rooms.');
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

  function handleResign() {
    if (!isOnlineMode() || !multiplayer.connected || !multiplayer.roomCode) {
      addEvent('Join a room first.');
      render();
      return;
    }

    const confirmed = window.confirm('Resign this game?');
    if (!confirmed) {
      return;
    }

    sendSocketMessage(WEBSOCKET_TYPES.RESIGN, {}, multiplayer.roomCode);
  }

  function handleSquareClick(r, c) {
    unlockAudio();

    if (state.gameOver) {
      return;
    }

    const activeColor = getActiveColor();
    if (!activeColor) {
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
    const attempted = promotionMoveSet.length ? pickPromotionFromOptions(promotionMoveSet) : matchingMoves[0];
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
      showIllegalMoveBanner(from, { r, c }, reason);
      if (state.hardMode) {
        addEvent(`${message}; ${reason} Turn forfeited.`, {
          color: illegalColor,
          move: illegalPly,
        });
        state.selected = null;
        state.turn = otherColor(state.turn);
        evaluateAfterTurnChange();
        render();
      } else {
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
      multiplayer.color = multiplayer.color || payload.playerColor || payload.color;
      multiplayer.players = payload.players || [];
      multiplayer.intentionalLeave = false;
      syncFromRoomPayload(message);
      saveOnlineSession();
      addEvent(`Room ${multiplayer.roomCode} created. Share this code with your friend.`);
      if (!joinRoomCodeEl.value || !joinRoomCodeEl.value.trim()) {
        joinRoomCodeEl.value = multiplayer.roomCode;
      }
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.PLAYER_ASSIGNED) {
      applyPlayerIdentity(message, payload);
      multiplayer.players = payload.players || multiplayer.players;
      saveOnlineSession();
      syncMultiplayerPanel();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.ROOM_JOINED) {
      multiplayer.roomCode = normalizeRoomCode(message.roomCode || payload.roomCode);
      applyPlayerIdentity(message, payload);
      multiplayer.players = payload.players || [];
      multiplayer.intentionalLeave = false;
      saveOnlineSession();
      syncMultiplayerPanel();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.GAME_STATE) {
      if (payload.game) {
        if (Array.isArray(payload.game.players)) {
          multiplayer.players = payload.game.players;
        }
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
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (Array.isArray(payload?.game?.players)) {
        multiplayer.players = payload.game.players;
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
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (Array.isArray(payload?.game?.players)) {
        multiplayer.players = payload.game.players;
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
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (Array.isArray(payload?.game?.players)) {
        multiplayer.players = payload.game.players;
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
      const reason = ERROR_TEXT[payload.reasonCode] || payload.reasonCode || 'Move rejected by server.';
      const pendingColor = pendingServerAttempt?.color || state.turn;
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
        showIllegalMoveBanner(attemptedFrom, attemptedTo, reason);
      } else {
        showTransientBanner(`Illegal move (${reason})`);
      }
      pendingServerAttempt = null;
      state.selected = null;
      if (payload.game) {
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
      addEvent(`Server error: ${text}`);
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
      syncMultiplayerControlState();
    }
  }

  async function handleCreateRoom() {
    try {
      multiplayer.intentionalLeave = false;
      await connectSocket();
      setMode('online');
      if (!sendSocketMessage(WEBSOCKET_TYPES.CREATE_ROOM, {
        nickname: 'Player',
        hardMode: Boolean(state.hardMode),
      })) {
        return;
      }
      addEvent('Requesting room...');
      syncMultiplayerPanel();
      syncMultiplayerControlState();
    } catch (error) {
      addEvent(error.message);
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

    try {
      multiplayer.intentionalLeave = false;
      await connectSocket();
      setMode('online');
      if (!sendSocketMessage(WEBSOCKET_TYPES.JOIN_ROOM, { nickname: 'Player' }, roomCode)) {
        return;
      }
      multiplayer.roomCode = roomCode;
      addEvent(`Joining room ${roomCode}...`);
      syncMultiplayerPanel();
      syncMultiplayerControlState();
    } catch (error) {
      addEvent(error.message);
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

    state = newGameState();
    state.hardMode = hardModeEl.checked;
    state.selected = null;
    render();
    addEvent('New game started.');
  }

  function render() {
    syncReplayHistoryWithState();
    renderBoard();
    renderEvents();
    renderMoves();
    renderStatus();
  }

  hardModeEl.addEventListener('change', () => {
    const previousHardMode = state.hardMode;
    state.hardMode = hardModeEl.checked;
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

  connectServerEl.addEventListener('click', () => {
    handleConnectClick();
  });

  createRoomEl.addEventListener('click', () => {
    handleCreateRoom();
  });

  joinRoomEl.addEventListener('click', () => {
    handleJoinRoom();
  });

  copyRoomCodeEl.addEventListener('click', () => {
    handleCopyCode();
  });

  exportPgnEl.addEventListener('click', () => {
    handleExportPgn();
  });

  replayPrevEl.addEventListener('click', () => {
    stepReplay(-1);
  });

  replayNextEl.addEventListener('click', () => {
    stepReplay(1);
  });

  replayFinalEl.addEventListener('click', () => {
    setReplayFinal();
  });

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

  setMode('local', { preserveSession: true });
  state.hardMode = hardModeEl.checked;
  applyUrlPrefill();
  tryResumeOnlineSessionOnLoad();
  render();
})();
