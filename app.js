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
  const hardModeEl = document.getElementById('hardMode');
  const newGameEl = document.getElementById('newGame');
  const multiplayerStatusEl = document.getElementById('multiplayerStatus');
  const multiplayerInfoEl = document.getElementById('multiplayerInfo');
  const roomCodeBadge = document.getElementById('roomCodeBadge');
  const playerRoster = document.getElementById('playerRoster');
  const playModeEl = document.getElementById('playMode');
  const serverUrlEl = document.getElementById('serverUrl');
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
        : 'wss://blendchess-ws.<your-worker-subdomain>.workers.dev'
    );
  const SERVER_URL_STORAGE_KEY = 'blendchess.serverUrl';
  const DRAW_CLAIM_REASONS = ['threefold', 'fiftyMove', 'seventyFiveMove', 'fivefold', 'insufficientMaterial'];
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
  };

  let state = newGameState();

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

  function isOnlineMode() {
    return playModeEl.value === 'online';
  }

  function getActiveColor() {
    if (!isOnlineMode()) {
      return state.turn;
    }
    return multiplayer.color || null;
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

  function addEvent(text) {
    const prefix = new Date().toLocaleTimeString([], { minute: '2-digit', second: '2-digit' });
    state.events.unshift(`[${prefix}] ${text}`);
    state.events = state.events.slice(0, 20);
  }

  function setMode(mode) {
    multiplayer.mode = mode;
    if (mode === 'local') {
      clearRoomSession();
      state = newGameState();
      state.hardMode = hardModeEl.checked;
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
      const connectionText = multiplayer.connected ? 'Connected' : 'Not connected';
      const connectedCount = multiplayer.players.filter((player) => player.connected !== false).length;
      multiplayerStatusEl.textContent = `Online mode · ${connectionText} · ${roomReady} · You are ${playerColor}.`;
      multiplayerInfoEl.textContent = `Players connected: ${connectedCount}/2`;
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
    connectServerEl.disabled = !online || multiplayer.connected;
    createRoomEl.disabled = !online || !multiplayer.connected;
    joinRoomEl.disabled = !online || !multiplayer.connected;
    joinRoomCodeEl.disabled = !online || !multiplayer.connected;
    copyRoomCodeEl.disabled = !online || !multiplayer.roomCode;
    leaveRoomEl.disabled = !online;
    serverUrlEl.disabled = multiplayer.connected;
    claimDrawEl.disabled = online ? !multiplayer.connected : false;
    resignEl.disabled = !online || !multiplayer.connected;
  }

  function updateModeText() {
    if (isOnlineMode()) {
      if (state.hardMode) {
        modeText.textContent = 'Online friend mode: illegal moves are sent to server.';
      } else {
        modeText.textContent = 'Online friend mode: illegal moves are rejected by server.';
      }
      return;
    }

    if (state.hardMode) {
      modeText.textContent = 'Hard mode: illegal moves lose turn.';
    } else {
      modeText.textContent = 'Strict mode: illegal moves are rejected.';
    }
  }

  function clearRoomSession() {
    if (!isOnlineMode()) {
      // reset server state and return to local rules
      disconnectSocket();
    }
    multiplayer.connected = false;
    multiplayer.playerId = null;
    multiplayer.color = null;
    multiplayer.roomCode = '';
    multiplayer.players = [];
    multiplayer.awaitingStateSync = false;
  }

  function renderBoard() {
    boardEl.replaceChildren();
    const visibleColor = isOnlineMode() ? multiplayer.color : state.turn;

    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const button = document.createElement('button');
        button.type = 'button';
        button.className = 'square';
        button.classList.add((r + c) % 2 === 0 ? 'light' : 'dark');
        button.dataset.r = String(r);
        button.dataset.c = String(c);
        button.addEventListener('click', () => handleSquareClick(r, c));

        const piece = state.board[r][c];
        if (piece && piece.color === visibleColor) {
          button.classList.add('visible', 'piece', piece.color === 'w' ? 'white' : 'black');
          button.textContent = PIECE_SYMBOLS[piece.color][piece.type];
        } else {
          button.classList.add('hidden');
        }

        if (state.selected && state.selected.r === r && state.selected.c === c) {
          button.classList.add('selected');
        }

        boardEl.appendChild(button);
      }
    }
  }

  function renderEvents() {
    eventsEl.replaceChildren();
    for (const entry of state.events) {
      const item = document.createElement('li');
      item.textContent = entry;
      eventsEl.appendChild(item);
    }
  }

  function renderMoves() {
    moveBody.replaceChildren();
    for (const move of state.movePairs) {
      const row = document.createElement('tr');
      const num = document.createElement('td');
      const white = document.createElement('td');
      const black = document.createElement('td');
      num.textContent = String(move.num);
      white.textContent = move.white || '';
      black.textContent = move.black || '';
      row.appendChild(num);
      row.appendChild(white);
      row.appendChild(black);
      moveBody.appendChild(row);
    }
  }

  function renderStatus() {
    updateModeText();
    let status = '';
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
      addEvent(`${colorName(opponent)} is in check.`);
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
      events: snapshot.events ? snapshot.events.slice() : base.events,
      captured: snapshot.captured ? { ...snapshot.captured } : base.captured,
      winner: snapshot.winner || null,
      result: snapshot.result || null,
      gameOver: Boolean(snapshot.gameOver),
      halfMoveClock: Number.isInteger(snapshot.halfMoveClock) ? snapshot.halfMoveClock : base.halfMoveClock,
      boardVersion: Number.isInteger(snapshot.boardVersion) ? snapshot.boardVersion : base.boardVersion,
      positionCounts: snapshot.positionCounts
        ? { ...snapshot.positionCounts }
        : base.positionCounts,
      hardMode: hardModeEl.checked,
      selected: null,
    };

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

    if (outcome.captured) {
      state.captured[outcome.captured.color] += 1;
      addEvent(`${colorName(outcome.captured.color)} piece was taken.`);
    }

    const san = moveToSAN(beforeBoard, beforeEnPassant, attempted, state.board, state.enPassant);
    addMoveRecord(state.turn, san);
    addEvent(`${toMoveColorFromState()} played ${san}`);

    state.turn = otherColor(state.turn);
    recordCurrentPosition(state);
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

    sendSocketMessage(WEBSOCKET_TYPES.MOVE_INTENT, payload, multiplayer.roomCode);
    addEvent('Move sent.');
    state.selected = null;
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
      if (state.hardMode) {
        addEvent(`${message}; ${reason} Turn forfeited.`);
        state.selected = null;
        state.turn = otherColor(state.turn);
        evaluateAfterTurnChange();
        render();
      } else {
        addEvent(`${message}. ${reason}`);
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
        multiplayer.connected = false;
        multiplayer.connectPromise = null;
        multiplayer.awaitingStateSync = false;
        multiplayerStatusEl.textContent = wasOnline && hadRoom
          ? 'Disconnected. Reconnect to continue this room.'
          : 'Disconnected.';
        if (wasOnline) {
          syncMultiplayerPanel();
          render();
        }
        syncMultiplayerControlState();
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
      syncFromRoomPayload(message);
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
      syncMultiplayerPanel();
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.ROOM_JOINED) {
      multiplayer.roomCode = normalizeRoomCode(message.roomCode || payload.roomCode);
      applyPlayerIdentity(message, payload);
      multiplayer.players = payload.players || [];
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
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.MOVE_APPLIED) {
      if (payload.game && !hydrateGameState(payload.game)) {
        return;
      }
      if (Array.isArray(payload?.game?.players)) {
        multiplayer.players = payload.game.players;
      }
      if (payload.san) {
        addEvent(`Move played: ${payload.san}`);
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
      state.selected = null;
      addEvent(`Move rejected: ${reason}`);
      render();
      return;
    }

    if (type === WEBSOCKET_TYPES.ERROR) {
      const text = ERROR_TEXT[payload.errorCode] || payload.message || 'Server error.';
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
      await connectSocket();
      setMode('online');
      if (!sendSocketMessage(WEBSOCKET_TYPES.CREATE_ROOM, { nickname: 'Player' })) {
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
    disconnectSocket();
    clearRoomSession();
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
    renderBoard();
    renderEvents();
    renderMoves();
    renderStatus();
  }

  hardModeEl.addEventListener('change', () => {
    state.hardMode = hardModeEl.checked;
    renderStatus();
  });

  newGameEl.addEventListener('click', () => {
    resetGame();
  });

  playModeEl.addEventListener('change', (event) => {
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

  leaveRoomEl.addEventListener('click', () => {
    handleLeaveRoom();
  });

  claimDrawEl.addEventListener('click', () => {
    handleClaimDraw();
  });

  resignEl.addEventListener('click', () => {
    handleResign();
  });

  setMode('local');
  state.hardMode = hardModeEl.checked;
  applyUrlPrefill();
  render();
})();
