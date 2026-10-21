(() => {
  const core = window.ChessCore;
  const protocol = window.BlendChessProtocol;
  const rl = window.BlendChessRoomLogic;
  const guards = window.BlendChessStateGuards;
  const sprites = window.BlendChessSprites;
  const sfx = window.BlendChessSfx;
  const fx = window.BlendChessFx;
  if (!core || !protocol || !rl || !guards || !sprites || !sfx || !fx) {
    throw new Error('Load chess-core.js, shared/*.js and client/*.js before app.js.');
  }

  const { TYPES, ERROR_CODES } = protocol;
  const $ = (id) => document.getElementById(id);

  function el(tag, props = {}, ...children) {
    const node = document.createElement(tag);
    for (const [key, value] of Object.entries(props)) {
      if (value == null || value === false) continue;
      if (key === 'class') node.className = value;
      else if (key === 'text') node.textContent = value;
      else if (key === 'dataset') Object.assign(node.dataset, value);
      else if (key.startsWith('on')) node.addEventListener(key.slice(2), value);
      else node.setAttribute(key, value === true ? '' : value);
    }
    for (const child of children.flat()) {
      if (child == null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // ---------------------------------------------------------------------------
  // Storage and settings
  // ---------------------------------------------------------------------------

  const STORAGE = {
    settings: 'blendchess.settings.v2',
    session: 'blendchess.session.v2',
    local: 'blendchess.localGame.v2',
    archive: 'blendchess.archive.v2',
  };
  const ARCHIVE_MAX = 30;
  const isLocalHost = ['localhost', '127.0.0.1', ''].includes(window.location.hostname);
  const DEFAULT_SERVER_URL = window.BLENDCHESS_SERVER_URL
    || (isLocalHost ? 'ws://localhost:3000' : 'wss://blendchess-ws.omertalib42.workers.dev');

  function load(key, fallback) {
    try {
      const raw = window.localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch {
      return fallback;
    }
  }

  function save(key, value) {
    try {
      window.localStorage.setItem(key, JSON.stringify(value));
    } catch {
      // storage can be full or blocked; the game still works without it
    }
  }

  function remove(key) {
    try {
      window.localStorage.removeItem(key);
    } catch {
      // ignore
    }
  }

  function isWsUrl(value) {
    try {
      const url = new URL(value);
      return url.protocol === 'ws:' || url.protocol === 'wss:';
    } catch {
      return false;
    }
  }

  const settings = {
    sound: true,
    music: false,
    crt: true,
    fx: true,
    hints: true,
    theme: 'arcade',
    nickname: '',
    serverUrl: DEFAULT_SERVER_URL,
    ...load(STORAGE.settings, {}),
  };
  if (!isWsUrl(settings.serverUrl)) settings.serverUrl = DEFAULT_SERVER_URL;

  function saveSettings() {
    save(STORAGE.settings, settings);
  }

  function cssVar(name) {
    return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  }

  function applySettings() {
    const root = document.documentElement;
    root.dataset.theme = settings.theme;
    root.dataset.crt = settings.crt ? 'on' : 'off';
    root.style.setProperty('--fog-url', `url("${sprites.fogTexture(settings.theme === 'paper' ? '#241a12' : '#ffffff')}")`);
    sfx.setSound(settings.sound);
    fx.setEnabled(settings.fx);
    $('soundBtn').setAttribute('aria-pressed', String(settings.sound));
    $('musicBtn').setAttribute('aria-pressed', String(settings.music));
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.setAttribute('aria-pressed', String(button.dataset.themeChoice === settings.theme));
    });
    $('crtInput').checked = settings.crt;
    $('fxInput').checked = settings.fx;
    $('hintsInput').checked = settings.hints;
    $('serverUrlInput').value = settings.serverUrl;
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', cssVar('--bg') || '#140b2b');
  }

  // ---------------------------------------------------------------------------
  // App state
  // ---------------------------------------------------------------------------

  const app = {
    mode: null, // 'local' | 'online' | 'archive'
    view: null,
    prevView: null,
    selected: null,
    cursor: { r: 7, c: 4 },
    keyboard: false,
    replay: null,
    seenEventId: 0,
    marks: { boom: null, took: null },
    animate: null,
    revealing: false,
    gameOverShown: '',
    archiveTitle: null,
  };

  const local = {
    state: null,
    viewer: 'w',
    handoff: false,
    seen: { w: 0, b: 0 },
    lastView: { w: null, b: null },
  };

  const net = {
    ws: null,
    status: 'offline',
    roomCode: '',
    role: null,
    color: null,
    playerId: '',
    resumeToken: '',
    intentionalClose: false,
    reconnectAttempts: 0,
    reconnectTimer: null,
    heartbeatTimer: null,
    lastMessageAt: 0,
    pending: null,
    pendingTimer: null,
    spectatorNickname: '',
  };

  const RECONNECT_MAX_ATTEMPTS = 30;
  const HEARTBEAT_MS = 10_000;
  const STALE_SOCKET_MS = 25_000;
  const PENDING_TIMEOUT_MS = 9_000;

  const PIECE_NAMES = { P: 'pawn', N: 'knight', B: 'bishop', R: 'rook', Q: 'queen', K: 'king' };
  const RESULT_TEXT = {
    checkmate: 'by checkmate',
    resign: 'by resignation',
    stalemate: 'Stalemate.',
    mutualDraw: 'Draw agreed.',
    threefold: 'Draw by threefold repetition.',
    fivefold: 'Draw by fivefold repetition.',
    fiftyMove: 'Draw by the 50-move rule.',
    seventyFiveMove: 'Draw by the 75-move rule.',
    insufficientMaterial: 'Draw: nobody can checkmate any more.',
    kingCaptured: 'king captured',
  };
  const REASON_TEXT = {
    NOT_YOUR_TURN: "It's not your turn.",
    ROOM_NOT_READY: 'Waiting for your opponent.',
    GAME_OVER: 'This game is over.',
    GAME_IN_PROGRESS: 'Not while a game is in progress.',
    ROOM_FULL: 'That room is full. Try WATCH instead.',
    UNKNOWN_ROOM: 'No room with that code.',
    PLAYER_NOT_FOUND: 'That seat is reserved for a player who is reconnecting.',
    RATE_LIMIT: 'Whoa there, slow down.',
    VERSION_MISMATCH: 'The server runs a different version. Refresh the page.',
    INVALID_PAYLOAD: 'The server did not understand that.',
    WRONG_COLOR: "You can't do that right now.",
    INVALID_DRAW_CLAIM: 'No draw available.',
  };

  const colorName = (color) => (color === 'w' ? 'White' : 'Black');
  const same = (a, b) => Boolean(a && b && a.r === b.r && a.c === b.c);
  const squareName = (pos) => core.squareName(pos);

  // ---------------------------------------------------------------------------
  // Small UI helpers: toast, dialogs, umpire
  // ---------------------------------------------------------------------------

  let toastTimer = null;
  function toast(text, tone = '') {
    const node = $('toast');
    node.textContent = text;
    node.dataset.tone = tone;
    node.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => node.classList.remove('show'), 2600);
    if (tone === 'bad') sfx.play('error');
  }

  let dialogResolve = null;
  function dialog({ title, body, buttons }) {
    return new Promise((resolve) => {
      closeDialog(null);
      dialogResolve = resolve;
      $('dialogTitle').textContent = title;
      $('dialogBody').replaceChildren(typeof body === 'string' ? el('p', { text: body }) : body);
      $('dialogButtons').replaceChildren(...buttons.map((button) => el('button', {
        class: `px-btn ${button.kind || ''}`,
        type: 'button',
        text: button.label,
        onclick: () => closeDialog(button.value),
      })));
      $('dialog').classList.remove('hidden');
      const primary = $('dialogButtons').querySelector('.primary, .danger') || $('dialogButtons').lastElementChild;
      if (primary) primary.focus();
    });
  }

  function closeDialog(value) {
    $('dialog').classList.add('hidden');
    if (dialogResolve) {
      const resolve = dialogResolve;
      dialogResolve = null;
      resolve(value);
    }
  }

  function confirmDialog(title, body, okLabel = 'YES', kind = 'primary') {
    return dialog({
      title,
      body,
      buttons: [
        { label: 'CANCEL', kind: 'ghost', value: false },
        { label: okLabel, kind, value: true },
      ],
    });
  }

  let umpireCancel = null;
  let mouthTimer = null;
  function umpireSay(text, tone = '') {
    if (!text) return;
    const textEl = $('umpireText');
    const box = textEl.closest('.umpire');
    if (umpireCancel) umpireCancel();
    clearInterval(mouthTimer);
    textEl.dataset.tone = tone;
    box.classList.add('talking');
    let open = false;
    mouthTimer = setInterval(() => {
      open = !open;
      $('umpireFace').src = sprites.umpire(open ? 'talk' : 'idle');
    }, 110);
    umpireCancel = fx.typewriter(textEl, text, {
      speed: 2,
      onTick: () => sfx.play('type'),
      onDone: () => {
        clearInterval(mouthTimer);
        $('umpireFace').src = sprites.umpire('idle');
        box.classList.remove('talking');
      },
    });
  }

  // ---------------------------------------------------------------------------
  // Menu
  // ---------------------------------------------------------------------------

  const MENU_PANELS = ['menuMain', 'menuSetup', 'menuJoin', 'menuArchive', 'menuHelp'];
  let setupMode = 'local';

  function showScreen(name) {
    $('menuScreen').classList.toggle('hidden', name !== 'menu');
    $('gameScreen').classList.toggle('hidden', name !== 'game');
  }

  function showMenuPanel(panel) {
    showScreen('menu');
    $('pressStart').classList.toggle('hidden', panel !== 'title');
    $('logoBoard').classList.toggle('hidden', panel !== 'title' && panel !== 'menuMain');
    for (const id of MENU_PANELS) $(id).classList.toggle('hidden', id !== panel);
    if (panel === 'menuMain') refreshContinue();
    if (panel === 'menuArchive') renderArchiveList();
    const first = panel === 'title' ? $('pressStart') : $(panel).querySelector('input, .menu-item:not([hidden]), .px-btn.primary');
    if (first) setTimeout(() => first.focus(), 0);
  }

  function refreshContinue() {
    const session = load(STORAGE.session, null);
    const localSave = load(STORAGE.local, null);
    const item = $('continueItem');
    if (session && session.roomCode) {
      item.hidden = false;
      item.dataset.kind = 'online';
      $('continueHint').textContent = `online room ${session.roomCode}`;
    } else if (localSave && localSave.state && !localSave.state.gameOver) {
      item.hidden = false;
      item.dataset.kind = 'local';
      $('continueHint').textContent = `local duel, move ${Math.floor(localSave.state.log.length / 2) + 1}`;
    } else {
      item.hidden = true;
    }
  }

  function openSetup(mode) {
    setupMode = mode;
    $('setupTitle').textContent = mode === 'local' ? 'LOCAL DUEL' : 'CREATE ROOM';
    $('nicknameField').classList.toggle('hidden', mode === 'local');
    $('openSpectatorsField').classList.toggle('hidden', mode === 'local');
    $('nicknameInput').value = settings.nickname;
    $('setupGo').textContent = mode === 'local' ? 'START' : 'CREATE';
    showMenuPanel('menuSetup');
  }

  function rememberNickname(value) {
    settings.nickname = rl.cleanNickname(value, '');
    saveSettings();
    return settings.nickname || 'Player';
  }

  function onMenuAction(action) {
    sfx.play('click');
    if (action === 'back') showMenuPanel('menuMain');
    else if (action === 'local') openSetup('local');
    else if (action === 'create') openSetup('create');
    else if (action === 'join') {
      $('joinNicknameInput').value = settings.nickname;
      showMenuPanel('menuJoin');
    } else if (action === 'archive') showMenuPanel('menuArchive');
    else if (action === 'help') showMenuPanel('menuHelp');
    else if (action === 'continue') {
      if ($('continueItem').dataset.kind === 'online') resumeOnline(load(STORAGE.session, null));
      else continueLocal();
    }
  }

  // Decorative title board: pieces flicker in and out of the fog.
  let logoTimer = null;
  function initLogoBoard() {
    const board = $('logoBoard');
    const initial = core.createInitialBoard();
    for (let r = 0; r < 8; r += 1) {
      for (let c = 0; c < 8; c += 1) {
        const square = el('div', { class: `sq ${(r + c) % 2 ? 'dark' : 'light'} fog` });
        square.style.setProperty('--fog-delay', `${-Math.random() * 9}s`);
        const piece = initial[r][c];
        if (piece) square.append(el('img', { class: 'piece', src: sprites.piece(piece.color, piece.type), alt: '' }));
        board.append(square);
      }
    }
    const squares = [...board.children];
    clearInterval(logoTimer);
    logoTimer = setInterval(() => {
      if (board.classList.contains('hidden') || document.hidden) return;
      const square = squares[Math.floor(Math.random() * squares.length)];
      const img = square.querySelector('img');
      if (img) img.style.visibility = img.style.visibility === 'hidden' ? 'visible' : 'hidden';
    }, 260);
  }

  // ---------------------------------------------------------------------------
  // Board
  // ---------------------------------------------------------------------------

  const boardEl = $('board');
  const squareEls = [];

  function initBoard() {
    boardEl.tabIndex = 0;
    for (let i = 0; i < 64; i += 1) {
      const square = el('div', { class: 'sq', role: 'gridcell' });
      square.style.setProperty('--fog-delay', `${-Math.random() * 9}s`);
      square.style.setProperty('--reveal-delay', `${Math.random() * 0.9}s`);
      squareEls.push(square);
      boardEl.append(square);
    }
  }

  function myColor() {
    if (app.mode === 'local') return local.viewer;
    if (app.mode === 'online' && app.view && app.view.you.role === 'player') return app.view.you.color;
    return null;
  }

  function bottomColor() {
    return myColor() || 'w';
  }

  function displayBoard() {
    if (app.replay) return app.replay.positions[app.replay.index].board;
    return app.view ? app.view.board : core.createInitialBoard();
  }

  function canAct() {
    const view = app.view;
    if (!view || app.replay || view.gameOver) return false;
    if (app.mode === 'local') return !local.handoff;
    if (app.mode === 'online') {
      return view.you.role === 'player'
        && view.turn === view.you.color
        && !view.waitingForStart
        && net.status === 'online';
    }
    return false;
  }

  function lastVisibleMove() {
    if (app.replay) return app.replay.positions[app.replay.index].lastMove;
    // In the fog the latest visible move is usually your own, which is the one worth remembering.
    const moves = app.view ? app.view.moves : [];
    for (let i = moves.length - 1; i >= 0; i -= 1) {
      if (moves[i].from && moves[i].to && !moves[i].forfeit) return moves[i];
    }
    return null;
  }

  function squareElFor(pos) {
    if (!pos) return null;
    return boardEl.querySelector(`.sq[data-r="${pos.r}"][data-c="${pos.c}"]`);
  }

  function renderBoard() {
    const view = app.view;
    const board = displayBoard();
    const mine = myColor();
    const flipped = bottomColor() === 'b';
    const revealed = Boolean(app.replay) || Boolean(view && view.revealed);
    const fogAll = view && !revealed && !mine; // fog spectators
    const hints = new Map();
    if (app.selected && settings.hints && canAct()) {
      for (const move of core.generatePlausibleMovesForPiece(board, app.selected.r, app.selected.c)) {
        const key = `${move.to.r},${move.to.c}`;
        const isTry = move.capture && board[app.selected.r][app.selected.c].type === 'P';
        hints.set(key, isTry ? 'try' : 'dot');
      }
    }
    const last = lastVisibleMove();
    const checkSquare = view && view.check && !app.replay ? core.findKing(board, view.check.color) : null;
    const replayCapture = app.replay ? app.replay.positions[app.replay.index].capture : null;

    boardEl.classList.toggle('revealing', app.revealing);

    for (let i = 0; i < 64; i += 1) {
      const displayR = Math.floor(i / 8);
      const displayC = i % 8;
      const r = flipped ? 7 - displayR : displayR;
      const c = flipped ? 7 - displayC : displayC;
      const square = squareEls[i];
      const piece = board[r][c];
      const own = Boolean(piece && mine && piece.color === mine);
      const fogged = !revealed && (fogAll || !own) && Boolean(view);
      const key = `${r},${c}`;

      square.dataset.r = r;
      square.dataset.c = c;
      square.className = `sq ${(r + c) % 2 ? 'dark' : 'light'}`;
      if (fogged || (app.revealing && !own)) square.classList.add('fog');
      if (own) square.classList.add('mine', 'has-own');
      if (same(app.selected, { r, c })) square.classList.add('selected');
      if (last && (same(last.from, { r, c }))) square.classList.add('last-from');
      if (last && (same(last.to, { r, c }))) square.classList.add('last-to');
      if (same(checkSquare, { r, c })) square.classList.add('check');
      if (app.marks.boom === key || (replayCapture && replayCapture.r === r && replayCapture.c === c)) square.classList.add('boom');
      if (app.marks.took === key) square.classList.add('took');
      if (app.keyboard && same(app.cursor, { r, c })) square.classList.add('cursor');
      square.setAttribute('aria-label', `${squareName({ r, c })}${piece ? `, ${colorName(piece.color)} ${PIECE_NAMES[piece.type]}` : ''}`);

      const children = [];
      if (piece) {
        const img = el('img', { class: 'piece', src: sprites.piece(piece.color, piece.type), alt: '', draggable: 'false' });
        if (app.animate && same(app.animate.to, { r, c })) {
          const fromDisplayR = flipped ? 7 - app.animate.from.r : app.animate.from.r;
          const fromDisplayC = flipped ? 7 - app.animate.from.c : app.animate.from.c;
          img.style.setProperty('--dx', `${(fromDisplayC - displayC) * 100}%`);
          img.style.setProperty('--dy', `${(fromDisplayR - displayR) * 100}%`);
          img.classList.add('arrive');
        }
        children.push(img);
      }
      const hint = hints.get(key);
      if (hint) children.push(el('span', { class: `hint ${hint === 'try' ? 'try' : ''}` }));
      if (displayR === 7) children.push(el('span', { class: 'coord file', text: 'abcdefgh'[c] }));
      if (displayC === 0) children.push(el('span', { class: 'coord rank', text: String(8 - r) }));
      square.replaceChildren(...children);
    }
    app.animate = null;
  }

  function markSquare(kind, pos) {
    const key = `${pos.r},${pos.c}`;
    app.marks[kind] = key;
    const other = kind === 'boom' ? 'took' : 'boom';
    if (app.marks[other] === key) app.marks[other] = null;
    renderBoard();
    setTimeout(() => {
      if (app.marks[kind] === key) {
        app.marks[kind] = null;
        renderBoard();
      }
    }, 2400);
  }

  // ---------------------------------------------------------------------------
  // Input: pointer, drag and keyboard
  // ---------------------------------------------------------------------------

  function selectSquare(pos) {
    app.selected = pos;
    sfx.play(pos ? 'select' : 'deselect');
    renderBoard();
  }

  function clickSquare(r, c) {
    if (!app.view) return;
    if (app.view.you && app.view.you.role === 'spectator' && app.mode === 'online') {
      toast('Spectating: sit back and enjoy the fog.');
      return;
    }
    if (!canAct()) {
      if (app.mode === 'online' && app.view && !app.view.gameOver && app.view.turn !== myColor()) toast('Wait for your turn.');
      return;
    }
    const board = displayBoard();
    const piece = board[r][c];
    if (piece && piece.color === myColor()) {
      selectSquare(same(app.selected, { r, c }) ? null : { r, c });
      return;
    }
    if (app.selected) attemptMove(app.selected, { r, c });
  }

  function choosePromotion(color) {
    return new Promise((resolve) => {
      const choices = $('promotionChoices');
      choices.replaceChildren(...core.PROMOTION_OPTIONS.map((type) => el('button', {
        type: 'button',
        'aria-label': PIECE_NAMES[type],
        onclick: () => {
          $('promotion').classList.add('hidden');
          resolve(type);
        },
      }, el('img', { src: sprites.piece(color, type), alt: '' }))));
      $('promotionCancel').onclick = () => {
        $('promotion').classList.add('hidden');
        resolve(null);
      };
      $('promotion').classList.remove('hidden');
      choices.firstElementChild.focus();
    });
  }

  async function attemptMove(from, to) {
    const board = displayBoard();
    const piece = board[from.r][from.c];
    if (!piece) return;
    const candidates = core.generatePlausibleMovesForPiece(board, from.r, from.c).filter((move) => same(move.to, to));
    if (!candidates.length) {
      // Impossible even if the fog were empty: catch it here so a misclick never costs a hard-mode turn.
      sfx.play('illegal');
      fx.shake($('boardFrame'));
      umpireSay(`A ${PIECE_NAMES[piece.type]} can't move like that.`, 'bad');
      app.selected = null;
      renderBoard();
      return;
    }
    let promotion = null;
    if (candidates.some((move) => move.promotion)) {
      promotion = await choosePromotion(piece.color);
      if (!promotion) return;
    }
    app.selected = null;
    sendMove({ from: { ...from }, to: { ...to }, promotion });
  }

  function sendMove(intent) {
    if (app.mode === 'local') localAction(TYPES.MOVE_INTENT, intent);
    else if (app.mode === 'online') netSend(TYPES.MOVE_INTENT, intent);
    renderBoard();
  }

  let drag = null;
  function onBoardPointerDown(event) {
    const square = event.target.closest('.sq');
    if (!square || event.button > 0) return;
    sfx.unlock();
    app.keyboard = false;
    const r = Number(square.dataset.r);
    const c = Number(square.dataset.c);
    const piece = displayBoard()[r][c];
    if (!(canAct() && piece && piece.color === myColor())) {
      clickSquare(r, c);
      return;
    }
    event.preventDefault();
    const wasSelected = same(app.selected, { r, c });
    if (!wasSelected) selectSquare({ r, c });
    drag = { r, c, startX: event.clientX, startY: event.clientY, ghost: null, wasSelected, piece, pointerId: event.pointerId };
    window.addEventListener('pointermove', onDragMove);
    window.addEventListener('pointerup', onDragEnd, { once: true });
    window.addEventListener('pointercancel', onDragCancel, { once: true });
  }

  function onDragMove(event) {
    if (!drag) return;
    const moved = Math.hypot(event.clientX - drag.startX, event.clientY - drag.startY);
    if (!drag.ghost && moved > 6) {
      const size = boardEl.getBoundingClientRect().width / 8;
      drag.ghost = el('img', { class: 'drag-ghost', src: sprites.piece(drag.piece.color, drag.piece.type), alt: '' });
      drag.ghost.style.width = `${size}px`;
      drag.ghost.style.height = `${size}px`;
      document.body.append(drag.ghost);
      const origin = squareElFor(drag);
      if (origin) origin.classList.add('dragging');
    }
    if (drag.ghost) {
      drag.ghost.style.left = `${event.clientX}px`;
      drag.ghost.style.top = `${event.clientY}px`;
    }
  }

  function endDrag() {
    window.removeEventListener('pointermove', onDragMove);
    if (drag && drag.ghost) drag.ghost.remove();
    const finished = drag;
    drag = null;
    return finished;
  }

  function onDragCancel() {
    endDrag();
    renderBoard();
  }

  function onDragEnd(event) {
    const finished = endDrag();
    if (!finished) return;
    if (!finished.ghost) {
      if (finished.wasSelected) selectSquare(null);
      return;
    }
    const target = document.elementFromPoint(event.clientX, event.clientY);
    const square = target && target.closest ? target.closest('#board .sq') : null;
    if (!square) {
      renderBoard();
      return;
    }
    const to = { r: Number(square.dataset.r), c: Number(square.dataset.c) };
    if (same(to, finished)) {
      renderBoard();
      return;
    }
    attemptMove({ r: finished.r, c: finished.c }, to);
  }

  function onBoardKey(event) {
    const deltas = { ArrowUp: [-1, 0], ArrowDown: [1, 0], ArrowLeft: [0, -1], ArrowRight: [0, 1] };
    if (deltas[event.key]) {
      event.preventDefault();
      const flip = bottomColor() === 'b' ? -1 : 1;
      const [dr, dc] = deltas[event.key];
      if (!app.keyboard) {
        app.keyboard = true;
        app.cursor = app.selected ? { ...app.selected } : { ...app.cursor };
      } else {
        app.cursor = {
          r: Math.max(0, Math.min(7, app.cursor.r + dr * flip)),
          c: Math.max(0, Math.min(7, app.cursor.c + dc * flip)),
        };
      }
      sfx.play('hover');
      renderBoard();
    } else if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      app.keyboard = true;
      clickSquare(app.cursor.r, app.cursor.c);
    } else if (event.key === 'Escape' && app.selected) {
      selectSquare(null);
    }
  }

  // ---------------------------------------------------------------------------
  // Events -> umpire lines and effects
  // ---------------------------------------------------------------------------

  function playerName(color, view = app.view) {
    if (app.mode === 'local') return colorName(color);
    const seat = view && view.players.find((player) => player.color === color);
    return seat && seat.nickname && seat.nickname !== 'Player' ? `${seat.nickname} (${colorName(color)})` : colorName(color);
  }

  function directionText(directions = []) {
    if (!directions.length) return '';
    if (directions.length > 1) return `Double check: ${directions.join(' and ')}!`;
    return directions[0] === 'knight' ? 'From a knight!' : `Along the ${directions[0]}!`;
  }

  function resultLine(event) {
    if (event.winner) return `${event.winner} wins ${RESULT_TEXT[event.result] || ''}.`.replace(' .', '.');
    return RESULT_TEXT[event.result] || 'Game drawn.';
  }

  // Describe one event from the viewer's seat. Returns { text, tone, sound, effect, square }.
  function describeEvent(event, viewer, view = app.view) {
    const mine = viewer && event.color === viewer;
    const who = playerName(event.color, view);
    switch (event.kind) {
      case 'move':
        if (mine) return { text: `You played ${event.san}.`, sound: 'move' };
        return { text: event.san ? `${who} played ${event.san}.` : `${who} moved.`, sound: 'opponentMove' };
      case 'capture': {
        const square = { r: event.r, c: event.c };
        if (mine) return { text: `You captured something on ${event.square}!`, tone: 'good', sound: 'capture', effect: 'took', square };
        if (viewer && event.captured === viewer) {
          const before = app.prevView && app.prevView.board[event.r] && app.prevView.board[event.r][event.c];
          const name = before && before.color === viewer ? PIECE_NAMES[before.type] : 'piece';
          return { text: `Your ${name} on ${event.square} was captured!`, tone: 'bad', sound: 'lost', effect: 'boom', square };
        }
        return { text: `${who} captured on ${event.square}.`, sound: 'capture', effect: 'took', square };
      }
      case 'check':
        if (viewer && event.color === viewer) return { text: `CHECK! ${directionText(event.directions)}`, tone: 'bad', sound: 'check', effect: 'check' };
        return { text: `${playerName(event.color, view)} is in check. ${directionText(event.directions)}`, tone: 'warn', sound: 'check' };
      case 'illegal':
        if (mine) {
          const squares = event.fromSquare ? ` ${event.fromSquare}-${event.toSquare}` : '';
          return { text: `No!${squares} isn't legal. Try again.`, tone: 'bad', sound: 'illegal', effect: 'illegal' };
        }
        return { text: `${who} tried an illegal move.`, tone: 'warn', sound: 'opponentIllegal' };
      case 'forfeit':
        if (mine) return { text: `Illegal${event.fromSquare ? ` (${event.fromSquare}-${event.toSquare})` : ''}! You lose the turn.`, tone: 'bad', sound: 'forfeit', effect: 'forfeit' };
        return { text: `${who} tried an illegal move and lost the turn!`, tone: 'good', sound: 'opponentIllegal', effect: 'opponentForfeit' };
      case 'draw_offer':
        if (mine) return { text: 'You offered a draw. It stands until your opponent moves.', sound: 'drawOffer' };
        return { text: `${who} offers a draw. Press DRAW to accept, or just move to decline.`, tone: 'warn', sound: 'drawOffer', effect: 'drawOffer' };
      case 'draw_declined':
        return { text: mine ? 'Your draw offer was declined.' : 'Draw offer declined.', tone: 'warn' };
      case 'resign':
        return { text: mine ? 'You resigned.' : `${who} resigned!`, tone: mine ? 'bad' : 'good' };
      case 'game_over':
        return { text: resultLine(event), tone: 'warn' };
      case 'presence':
        if (app.mode === 'local') return null;
        return {
          text: `${event.nickname} (${colorName(event.color)}) ${event.online ? 'joined the table.' : 'left the table.'}`,
          tone: event.online ? 'good' : 'warn',
          sound: event.online ? 'join' : 'leave',
        };
      case 'options':
        return {
          text: `Rules updated: hard mode ${event.hardMode ? 'ON' : 'OFF'}, spectators ${event.spectatorView === 'open' ? 'see everything' : 'in the fog'}.`,
          tone: 'warn',
        };
      case 'new_game':
        return { text: `New game!${event.swapped ? ' Colours swapped.' : ''} White moves first.`, tone: 'good', sound: 'start' };
      default:
        return null;
    }
  }

  const SOUND_PRIORITY = ['lost', 'check', 'capture', 'forfeit', 'illegal', 'drawOffer', 'opponentIllegal', 'start', 'join', 'leave', 'opponentMove', 'move'];

  function runEffect(line) {
    const boardFrame = $('boardFrame');
    const target = line.square ? squareElFor(line.square) : null;
    switch (line.effect) {
      case 'took':
        if (line.square) markSquare('took', line.square);
        fx.burst(target, [cssVar('--good'), cssVar('--warn'), cssVar('--text')], 26);
        break;
      case 'boom':
        if (line.square) markSquare('boom', line.square);
        fx.burst(target, [cssVar('--bad'), cssVar('--warn'), '#000000'], 40, 3.2);
        fx.flash('bad');
        fx.shake($('app'), true);
        break;
      case 'check':
        fx.banner('CHECK!', 'bad');
        fx.flash('bad');
        fx.shake(boardFrame);
        break;
      case 'illegal':
        fx.banner('NO!', 'bad', 700);
        fx.shake(boardFrame);
        break;
      case 'forfeit':
        fx.banner('TURN LOST', 'bad');
        fx.flash('bad');
        fx.shake($('app'), true);
        break;
      case 'opponentForfeit':
        fx.banner('THEY FUMBLED!', 'good');
        break;
      case 'drawOffer':
        fx.banner('DRAW?', 'warn');
        break;
      default:
        break;
    }
  }

  // Announce events the viewer hasn't seen yet. `quiet` just catches up (first view after joining).
  function processEvents(view, viewer, seenId, { quiet = false } = {}) {
    const fresh = view.events.filter((event) => event.id > seenId);
    const maxId = view.events.reduce((max, event) => Math.max(max, event.id), seenId);
    if (quiet || !fresh.length) return maxId;

    const lines = fresh.map((event) => describeEvent(event, viewer, view)).filter(Boolean);
    if (!lines.length) return maxId;

    const sound = SOUND_PRIORITY.find((name) => lines.some((line) => line.sound === name));
    if (sound && !view.gameOver) sfx.play(sound);
    requestAnimationFrame(() => lines.forEach(runEffect));

    const spoken = lines.filter((line) => line.tone || line.effect).slice(-2);
    const say = (spoken.length ? spoken : lines.slice(-1));
    umpireSay(say.map((line) => line.text).join(' '), say[say.length - 1].tone || '');
    return maxId;
  }

  // ---------------------------------------------------------------------------
  // Views
  // ---------------------------------------------------------------------------

  function setView(view, { viewer, seenId, quiet = false, previousOwn = undefined }) {
    const previous = previousOwn === undefined ? app.view : previousOwn;
    if (previous && previous.gameId !== view.gameId) {
      app.selected = null;
      app.replay = null;
      app.gameOverShown = '';
      $('gameOver').classList.add('hidden');
    }
    app.prevView = previous;
    app.view = view;
    if (app.mode === 'local') local.lastView[viewer] = view;

    // Animate your own new move sliding into place.
    const last = view.moves[view.moves.length - 1];
    const prevCount = previous && previous.gameId === view.gameId ? previous.moves.length : view.moves.length;
    if (!quiet && last && view.moves.length > prevCount && last.from && last.to && !last.forfeit) {
      app.animate = { from: last.from, to: last.to };
    }

    const nextSeen = processEvents(view, viewer, seenId, { quiet });

    if (!quiet && previous && !previous.revealed && view.revealed && view.gameOver) startReveal();
    render();
    if (view.gameOver) onGameOver(view);
    return nextSeen;
  }

  function startReveal() {
    app.revealing = true;
    sfx.play('reveal');
    setTimeout(() => {
      app.revealing = false;
      renderBoard();
    }, 1500);
  }

  function onGameOver(view) {
    const key = `${app.mode}:${view.roomCode}:${view.gameId}`;
    archiveGame(view, key);
    if (app.gameOverShown === key || app.mode === 'archive') return;
    app.gameOverShown = key;
    const viewer = app.mode === 'online' && view.you.role === 'player' ? view.you.color : null;
    const winnerColor = view.winner === 'White' ? 'w' : view.winner === 'Black' ? 'b' : null;
    let title;
    let tone;
    if (!winnerColor) {
      title = 'DRAW';
      tone = 'warn';
    } else if (viewer) {
      title = winnerColor === viewer ? 'VICTORY!' : 'DEFEAT';
      tone = winnerColor === viewer ? 'good' : 'bad';
    } else {
      title = `${view.winner.toUpperCase()} WINS!`;
      tone = 'good';
    }

    setTimeout(() => {
      if (!app.view || app.view.gameId !== view.gameId) return;
      if (tone === 'good') {
        sfx.play('win');
        fx.confetti([cssVar('--accent'), cssVar('--accent-2'), cssVar('--warn'), cssVar('--good')]);
      } else if (tone === 'bad') {
        sfx.play('lose');
        fx.rain([cssVar('--muted'), cssVar('--accent-2')]);
      } else {
        sfx.play('draw');
      }
      $('gameOverKicker').textContent = 'GAME OVER';
      $('gameOverTitle').textContent = title;
      $('gameOverTitle').dataset.tone = tone;
      $('gameOverReason').textContent = winnerColor ? `${playerName(winnerColor)} wins ${RESULT_TEXT[view.result] || ''}. The fog has lifted.` : `${RESULT_TEXT[view.result] || 'Draw.'} The fog has lifted.`;
      const buttons = [
        el('button', { class: 'px-btn ghost', type: 'button', text: 'SEE BOARD', onclick: () => $('gameOver').classList.add('hidden') }),
        el('button', { class: 'px-btn', type: 'button', text: 'REPLAY', onclick: () => { $('gameOver').classList.add('hidden'); startReplay(0); } }),
        el('button', { class: 'px-btn', type: 'button', text: 'PGN', onclick: exportPgn }),
      ];
      if (app.mode === 'local' || (app.mode === 'online' && view.you.role === 'player')) {
        buttons.push(el('button', { class: 'px-btn primary', type: 'button', text: app.mode === 'local' ? 'NEW GAME' : 'REMATCH', onclick: () => { $('gameOver').classList.add('hidden'); newGame(); } }));
      }
      $('gameOverButtons').replaceChildren(...buttons);
      $('gameOver').classList.remove('hidden');
      buttons[buttons.length - 1].focus();
    }, app.revealing ? 1300 : 500);
  }

  // ---------------------------------------------------------------------------
  // Local pass-and-play
  // ---------------------------------------------------------------------------

  function localView() {
    return rl.createView(local.state, { role: 'player', color: local.viewer });
  }

  function saveLocal() {
    save(STORAGE.local, { state: local.state, seen: local.seen, startedAt: local.startedAt });
  }

  function enterGame(mode) {
    app.mode = mode;
    app.view = null;
    app.prevView = null;
    app.selected = null;
    app.replay = null;
    app.marks = { boom: null, took: null };
    app.gameOverShown = '';
    app.seenEventId = 0;
    app.archiveDate = null;
    $('gameOver').classList.add('hidden');
    showScreen('game');
    boardEl.focus({ preventScroll: true });
  }

  function startLocal(hardMode) {
    const state = rl.createRoomState('LOCAL', { hardMode });
    rl.assignPlayer(state, 'white', 'White', () => '');
    rl.assignPlayer(state, 'black', 'Black', () => '');
    local.state = state;
    local.seen = { w: 0, b: 0 };
    local.lastView = { w: null, b: null };
    local.startedAt = Date.now();
    enterGame('local');
    sfx.play('start');
    showLocalTurn('w');
    umpireSay('Welcome to the fog. White moves first.');
  }

  function continueLocal() {
    const saved = load(STORAGE.local, null);
    if (!saved || !saved.state) {
      toast('No saved local game.');
      return;
    }
    local.state = saved.state;
    local.seen = saved.seen || { w: 0, b: 0 };
    local.lastView = { w: null, b: null };
    local.startedAt = saved.startedAt || Date.now();
    enterGame('local');
    showLocalTurn(local.state.turn);
  }

  // Switch the board to the side to move. Their news (what the opponent did) plays as effects and
  // stays in the turn banner at the top until the next turn.
  function showLocalTurn(color) {
    local.viewer = color;
    local.handoff = false;
    app.selected = null;
    // Compare against this player's own last view, so "your knight was captured" names the right piece.
    local.seen[color] = setView(localView(), { viewer: color, seenId: local.seen[color], previousOwn: local.lastView[color] || null });
    fx.retrigger($('boardFrame'), 'fx-swap');
    saveLocal();
    boardEl.focus({ preventScroll: true });
  }

  function localAction(type, payload = {}) {
    const state = local.state;
    const actor = rl.getPlayerByColor(state, local.viewer);
    let result;
    if (type === TYPES.MOVE_INTENT) result = rl.applyMove(state, actor, payload);
    else if (type === TYPES.CLAIM_DRAW) result = rl.claimDraw(state, actor, payload);
    else if (type === TYPES.RESIGN) result = rl.resign(state, actor);
    else return;

    if (result.alreadyOffered) toast('Your draw offer already stands.');
    if (!result.ok && !result.forfeited && !result.drawOffered && result.reason !== ERROR_CODES.ILLEGAL_MOVE) {
      toast(REASON_TEXT[result.reason] || result.reason, 'bad');
    }

    local.seen[local.viewer] = setView(localView(), { viewer: local.viewer, seenId: local.seen[local.viewer] });
    saveLocal();

    // Give the mover a moment to see their move (or the red alert), then hand the board over.
    if (!state.gameOver && state.turn !== local.viewer) {
      local.handoff = true;
      render();
      setTimeout(() => {
        if (app.mode === 'local' && local.state === state) showLocalTurn(state.turn);
      }, result.forfeited ? 1700 : 1000);
    }
    if (state.gameOver) remove(STORAGE.local);
  }

  // ---------------------------------------------------------------------------
  // Online
  // ---------------------------------------------------------------------------

  function setNetStatus(status) {
    net.status = status;
    const node = $('netStatus');
    node.dataset.status = status;
    node.textContent = { online: 'ONLINE', connecting: 'CONNECTING', reconnecting: 'RECONNECTING', offline: 'OFFLINE' }[status];
    renderActions();
  }

  function buildSocketUrl(params) {
    const url = new URL(settings.serverUrl);
    for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
    return url.toString();
  }

  function openSocket(params) {
    closeSocket();
    net.intentionalClose = false;
    return new Promise((resolve, reject) => {
      let ws;
      try {
        ws = new WebSocket(buildSocketUrl(params));
      } catch (error) {
        reject(error);
        return;
      }
      net.ws = ws;
      setNetStatus(net.reconnectAttempts ? 'reconnecting' : 'connecting');
      let opened = false;
      ws.onopen = () => {
        opened = true;
        net.lastMessageAt = Date.now();
        startHeartbeat();
        resolve(ws);
      };
      ws.onmessage = (event) => {
        if (ws !== net.ws) return;
        net.lastMessageAt = Date.now();
        onServerMessage(event.data);
      };
      ws.onclose = () => {
        if (ws !== net.ws) return;
        net.ws = null;
        stopHeartbeat();
        if (!opened) reject(new Error('Could not reach the game server.'));
        onSocketClosed();
      };
    });
  }

  function closeSocket() {
    stopHeartbeat();
    if (net.ws) {
      const ws = net.ws;
      net.ws = null;
      try {
        ws.close(1000, 'bye');
      } catch {
        // already closed
      }
    }
  }

  function netSend(type, payload = {}) {
    if (!net.ws || net.ws.readyState !== WebSocket.OPEN) {
      toast('Not connected. Reconnecting...', 'bad');
      return false;
    }
    net.ws.send(JSON.stringify(protocol.createMessage(type, net.roomCode, net.playerId || '', payload)));
    return true;
  }

  function startHeartbeat() {
    stopHeartbeat();
    net.heartbeatTimer = setInterval(() => {
      if (!net.ws || net.ws.readyState !== WebSocket.OPEN) return;
      if (Date.now() - net.lastMessageAt > STALE_SOCKET_MS) {
        net.ws.close();
        return;
      }
      if (net.roomCode) net.ws.send(JSON.stringify(protocol.createMessage(TYPES.PING, net.roomCode, net.playerId || '', {})));
    }, HEARTBEAT_MS);
  }

  function stopHeartbeat() {
    clearInterval(net.heartbeatTimer);
    net.heartbeatTimer = null;
  }

  function setPending(kind) {
    net.pending = kind;
    clearTimeout(net.pendingTimer);
    net.pendingTimer = setTimeout(() => {
      if (net.pending !== kind) return;
      net.pending = null;
      toast('The server took too long to answer.', 'bad');
      if (app.mode !== 'online' || !app.view) {
        net.intentionalClose = true;
        closeSocket();
        setNetStatus('offline');
      }
    }, PENDING_TIMEOUT_MS);
  }

  function clearPending() {
    net.pending = null;
    clearTimeout(net.pendingTimer);
  }

  function saveSession() {
    if (net.role !== 'player' || !net.roomCode || !net.resumeToken) return;
    save(STORAGE.session, {
      roomCode: net.roomCode,
      playerId: net.playerId,
      resumeToken: net.resumeToken,
      color: net.color,
      serverUrl: settings.serverUrl,
    });
  }

  function setRoomInUrl(code) {
    const url = new URL(window.location.href);
    url.search = '';
    if (code) url.searchParams.set('room', code);
    if (code && settings.serverUrl !== DEFAULT_SERVER_URL) url.searchParams.set('ws', settings.serverUrl);
    window.history.replaceState(null, '', url);
  }

  function inviteUrl() {
    const url = new URL(window.location.href);
    url.search = '';
    url.hash = '';
    url.searchParams.set('room', net.roomCode);
    if (settings.serverUrl !== DEFAULT_SERVER_URL) url.searchParams.set('ws', settings.serverUrl);
    return url.toString();
  }

  async function copyInvite() {
    const link = inviteUrl();
    try {
      await navigator.clipboard.writeText(link);
      toast('Invite link copied!');
      sfx.play('select');
    } catch {
      window.prompt('Copy this invite link:', link);
    }
  }

  async function createRoom(options) {
    net.role = null;
    net.reconnectAttempts = 0;
    try {
      await openSocket({ create: '1' });
    } catch (error) {
      toast(error.message, 'bad');
      setNetStatus('offline');
      return;
    }
    setPending('create');
    net.ws.send(JSON.stringify(protocol.createMessage(TYPES.CREATE_ROOM, '', '', options)));
  }

  async function joinRoom(code, { spectator = false, nickname = '', reconnect = false } = {}) {
    const roomCode = protocol.normalizeRoomCode(code);
    if (roomCode.length !== protocol.ROOM_CODE_LENGTH) {
      toast('Room codes have 6 characters.', 'bad');
      return;
    }
    if (!reconnect) {
      net.role = null;
      net.reconnectAttempts = 0;
    }
    net.roomCode = roomCode;
    net.spectatorNickname = nickname;
    try {
      await openSocket({ room: roomCode });
    } catch (error) {
      if (!reconnect) toast(error.message, 'bad');
      setNetStatus('offline');
      return;
    }
    setPending(spectator ? 'watch' : 'join');
    net.ws.send(JSON.stringify(protocol.createMessage(TYPES.JOIN_ROOM, roomCode, '', { nickname, spectator })));
  }

  async function resumeOnline(session, { auto = false } = {}) {
    if (!session || !session.roomCode) return;
    if (session.serverUrl && isWsUrl(session.serverUrl)) settings.serverUrl = session.serverUrl;
    net.roomCode = session.roomCode;
    net.playerId = session.playerId;
    net.resumeToken = session.resumeToken;
    net.color = session.color;
    net.role = 'player';
    if (app.mode !== 'online') enterGame('online');
    renderRoomPanel();
    try {
      await openSocket({ room: session.roomCode });
    } catch {
      if (!auto) toast('Server unreachable. Retrying...', 'bad');
      return; // onSocketClosed schedules the retry
    }
    setPending('resume');
    net.ws.send(JSON.stringify(protocol.createMessage(TYPES.JOIN_ROOM, session.roomCode, session.playerId, {
      resume: true,
      resumeToken: session.resumeToken,
      nickname: settings.nickname,
    })));
  }

  function scheduleReconnect() {
    clearTimeout(net.reconnectTimer);
    if (net.reconnectAttempts >= RECONNECT_MAX_ATTEMPTS) {
      setNetStatus('offline');
      umpireSay('Lost the connection. Use CONTINUE in the menu to try again.', 'bad');
      return;
    }
    net.reconnectAttempts += 1;
    setNetStatus('reconnecting');
    const delay = Math.min(8000, 500 * 2 ** Math.min(net.reconnectAttempts, 4));
    net.reconnectTimer = setTimeout(reconnectNow, delay);
  }

  function reconnectNow() {
    clearTimeout(net.reconnectTimer);
    if (app.mode !== 'online' || net.ws) return;
    if (net.role === 'spectator') {
      joinRoom(net.roomCode, { spectator: true, nickname: net.spectatorNickname, reconnect: true });
    } else {
      const session = load(STORAGE.session, null);
      if (session) resumeOnline(session, { auto: true });
    }
  }

  function onSocketClosed() {
    setNetStatus('offline');
    if (net.intentionalClose || app.mode !== 'online' || !net.roomCode) return;
    if (net.role === 'player' || net.role === 'spectator') scheduleReconnect();
  }

  function leaveOnline() {
    net.intentionalClose = true;
    clearTimeout(net.reconnectTimer);
    clearPending();
    closeSocket();
    setNetStatus('offline');
    remove(STORAGE.session);
    net.roomCode = '';
    net.role = null;
    net.playerId = '';
    net.resumeToken = '';
    setRoomInUrl('');
  }

  function onServerMessage(raw) {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }
    const payload = message.payload || {};

    if (message.type === TYPES.ROOM_CREATED || message.type === TYPES.ROOM_JOINED) {
      const wasResume = net.pending === 'resume';
      clearPending();
      net.roomCode = payload.roomCode || message.roomCode;
      net.role = payload.role;
      net.reconnectAttempts = 0;
      if (payload.role === 'player') {
        net.playerId = payload.playerId;
        net.color = payload.color;
        net.resumeToken = payload.resumeToken;
        saveSession();
      } else {
        remove(STORAGE.session);
      }
      setRoomInUrl(net.roomCode);
      if (app.mode !== 'online') enterGame('online');
      setNetStatus('online');
      if (message.type === TYPES.ROOM_CREATED) {
        sfx.play('join');
        umpireSay(`Room ${net.roomCode} is open. Send the invite link to your opponent.`);
      } else if (payload.role === 'spectator') {
        umpireSay('You are watching. Spectators see the fog unless the host turned on party mode.');
      } else if (wasResume) {
        umpireSay('Welcome back. Your seat was saved.', 'good');
      }
      return;
    }

    if (message.type === TYPES.GAME_STATE || message.type === TYPES.MOVE_REJECTED) {
      if (message.type === TYPES.MOVE_REJECTED && payload.reasonCode && payload.reasonCode !== ERROR_CODES.ILLEGAL_MOVE) {
        toast(REASON_TEXT[payload.reasonCode] || payload.reasonCode, 'bad');
      }
      const view = payload.game;
      if (!view || app.mode !== 'online') return;
      if (app.view && !guards.shouldHydrateSnapshotVersion(view.boardVersion, app.view.boardVersion)) return;
      if (view.you.role === 'player' && view.you.color !== net.color) {
        net.color = view.you.color;
        saveSession();
      }
      const quiet = app.seenEventId === 0;
      app.seenEventId = setView(view, { viewer: view.you.color, seenId: app.seenEventId, quiet });
      if (quiet && !view.gameOver && view.you.role === 'player' && !view.waitingForStart) {
        umpireSay(view.turn === view.you.color ? 'Your move.' : `Waiting for ${playerName(view.turn)}...`);
      }
      return;
    }

    if (message.type === TYPES.ERROR) {
      const pending = net.pending;
      clearPending();
      toast(REASON_TEXT[payload.errorCode] || payload.message || 'Server error.', 'bad');
      const fatal = [ERROR_CODES.UNKNOWN_ROOM, ERROR_CODES.PLAYER_NOT_FOUND, ERROR_CODES.ROOM_FULL, ERROR_CODES.VERSION_MISMATCH].includes(payload.errorCode);
      if (fatal && (pending || !app.view)) {
        const wasInGame = app.mode === 'online';
        leaveOnline();
        if (wasInGame) {
          app.mode = null;
          showMenuPanel('menuMain');
        }
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Game actions
  // ---------------------------------------------------------------------------

  function act(type, payload = {}) {
    sfx.play('click');
    if (app.mode === 'local') localAction(type, payload);
    else if (app.mode === 'online') netSend(type, payload);
  }

  async function resignAction() {
    if (await confirmDialog('RESIGN?', 'Throw in the towel? The fog will lift and your opponent wins.', 'RESIGN', 'danger')) {
      act(TYPES.RESIGN);
    }
  }

  async function newGame() {
    if (app.mode === 'local') {
      const inProgress = local.state && !local.state.gameOver && local.state.log.length > 0;
      if (inProgress && !(await confirmDialog('NEW GAME?', 'The current local game will be lost.', 'NEW GAME'))) return;
      startLocal(local.state ? local.state.hardMode : false);
      return;
    }
    if (app.mode === 'online') act(TYPES.NEW_GAME);
  }

  async function backToMenu() {
    if (app.mode === 'online') {
      const inGame = app.view && app.view.inProgress && app.view.you.role === 'player';
      const ok = await confirmDialog(
        'LEAVE ROOM?',
        inGame ? 'Your seat stays reserved. Use CONTINUE in the menu to come back.' : 'You will leave this room.',
        'LEAVE',
      );
      if (!ok) return;
      if (inGame) {
        // Keep the session so CONTINUE can resume the seat.
        const session = load(STORAGE.session, null);
        net.intentionalClose = true;
        closeSocket();
        setNetStatus('offline');
        if (session) save(STORAGE.session, session);
      } else {
        leaveOnline();
      }
    }
    if (app.mode === 'local') saveLocal();
    app.mode = null;
    app.view = null;
    app.replay = null;
    $('gameOver').classList.add('hidden');
    setRoomInUrl('');
    showMenuPanel('menuMain');
  }

  function exportPgn() {
    const view = app.view;
    if (!view || !view.gameOver) {
      toast('PGN is available after the game.');
      return;
    }
    const pgn = rl.buildPgn({
      moves: view.moves,
      winner: view.winner,
      gameOver: view.gameOver,
      result: view.result,
      hardMode: view.hardMode,
      white: playerName('w').replace(/ \(White\)$/, ''),
      black: playerName('b').replace(/ \(Black\)$/, ''),
      site: window.location.origin,
      date: app.archiveDate || Date.now(),
    });
    const filename = `blendchess-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, '-')}.pgn`;
    try {
      const url = URL.createObjectURL(new Blob([pgn], { type: 'application/x-chess-pgn' }));
      const link = el('a', { href: url, download: filename });
      document.body.append(link);
      link.click();
      link.remove();
      setTimeout(() => URL.revokeObjectURL(url), 1000);
      toast('PGN saved.');
    } catch {
      navigator.clipboard.writeText(pgn).then(() => toast('PGN copied.'), () => toast('Could not export the PGN.', 'bad'));
    }
  }

  // ---------------------------------------------------------------------------
  // Replay and archive
  // ---------------------------------------------------------------------------

  function buildPositions(moves) {
    let board = core.createInitialBoard();
    let enPassant = null;
    let turn = 'w';
    const positions = [{ board, lastMove: null, capture: null }];
    for (const ply of moves) {
      if (ply.forfeit || !ply.from || !ply.to) {
        enPassant = null;
        turn = core.otherColor(turn);
        positions.push({ board, lastMove: null, capture: null, forfeit: true });
        continue;
      }
      const legal = core.generateLegalMoves(board, turn, enPassant).find((move) => same(move.from, ply.from)
        && same(move.to, ply.to)
        && (move.promotion || null) === (ply.promotion || null));
      if (!legal) break;
      const next = core.applyMove(board, legal, enPassant);
      board = next.board;
      enPassant = next.enPassant;
      turn = core.otherColor(turn);
      positions.push({ board, lastMove: { from: ply.from, to: ply.to }, capture: ply.capture });
    }
    return positions;
  }

  function startReplay(index = null) {
    if (!app.view || !app.view.revealed) return;
    const positions = buildPositions(app.view.moves);
    app.replay = { positions, index: index == null ? positions.length - 1 : Math.max(0, Math.min(index, positions.length - 1)) };
    app.selected = null;
    render();
  }

  function stepReplay(where) {
    if (!app.replay) return;
    const last = app.replay.positions.length - 1;
    const target = {
      first: 0,
      prev: app.replay.index - 1,
      next: app.replay.index + 1,
      last,
    }[where];
    const index = Math.max(0, Math.min(last, typeof where === 'number' ? where : target));
    if (index === app.replay.index) return;
    app.replay.index = index;
    const position = app.replay.positions[index];
    if (position.capture) sfx.play('capture');
    else if (position.forfeit) sfx.play('illegal');
    else sfx.play('move');
    if (position.lastMove && where === 'next') app.animate = position.lastMove;
    render();
  }

  function archiveGame(view, key) {
    if (!view.revealed || !view.moves.length || app.mode === 'archive') return;
    const archive = load(STORAGE.archive, []);
    if (archive.some((entry) => entry.key === key && entry.plies === view.moves.length)) return;
    const entry = {
      key,
      plies: view.moves.length,
      at: Date.now(),
      mode: app.mode,
      white: playerName('w', view).replace(/ \(White\)$/, ''),
      black: playerName('b', view).replace(/ \(Black\)$/, ''),
      winner: view.winner,
      result: view.result,
      hardMode: view.hardMode,
      moves: view.moves,
    };
    save(STORAGE.archive, [entry, ...archive.filter((item) => item.key !== key)].slice(0, ARCHIVE_MAX));
  }

  function renderArchiveList() {
    const archive = load(STORAGE.archive, []);
    const list = $('archiveList');
    if (!archive.length) {
      list.replaceChildren(el('li', { class: 'archive-empty', text: 'No finished games yet. Go make some history!' }));
      return;
    }
    list.replaceChildren(...archive.map((entry) => el('li', {}, el('button', {
      class: 'archive-item',
      type: 'button',
      onclick: () => openArchived(entry),
    },
    el('span', { class: 'archive-players', text: `${entry.white} vs ${entry.black}` }),
    el('span', { class: 'archive-result', text: entry.winner === 'White' ? '1-0' : entry.winner === 'Black' ? '0-1' : '½-½' }),
    el('span', {
      class: 'archive-meta',
      text: `${new Date(entry.at).toLocaleString()} · ${entry.mode === 'local' ? 'local' : 'online'} · ${Math.ceil(entry.plies / 2)} moves${entry.hardMode ? ' · hard' : ''}`,
    })))));
  }

  function openArchived(entry) {
    sfx.play('click');
    const positions = buildPositions(entry.moves);
    enterGame('archive');
    app.archiveDate = entry.at;
    app.view = {
      roomCode: 'ARCHIVE',
      gameId: 0,
      boardVersion: 0,
      you: { role: 'spectator', color: null },
      revealed: true,
      turn: entry.moves.length % 2 ? 'b' : 'w',
      board: positions[positions.length - 1].board,
      moves: entry.moves,
      events: [],
      captured: {
        w: entry.moves.filter((ply) => ply.capture && ply.color === 'b').length,
        b: entry.moves.filter((ply) => ply.capture && ply.color === 'w').length,
      },
      check: null,
      drawOffer: null,
      gameOver: true,
      winner: entry.winner,
      result: entry.result,
      hardMode: entry.hardMode,
      spectatorView: 'open',
      waitingForStart: false,
      inProgress: false,
      players: [
        { color: 'w', nickname: entry.white, connected: true },
        { color: 'b', nickname: entry.black, connected: true },
      ],
      spectatorCount: 0,
    };
    app.replay = { positions, index: 0 };
    render();
    umpireSay(`${entry.white} vs ${entry.black}. ${entry.winner ? `${entry.winner} won ${RESULT_TEXT[entry.result] || ''}.` : RESULT_TEXT[entry.result] || 'Drawn.'} Step through with the arrows.`);
  }

  // ---------------------------------------------------------------------------
  // Rendering: bars, side panel, actions, overlays
  // ---------------------------------------------------------------------------

  function renderBar(node, color) {
    const view = app.view;
    if (!view) {
      node.replaceChildren();
      return;
    }
    const seat = view.players.find((player) => player.color === color);
    const isMe = myColor() === color && app.mode !== 'local';
    const toMove = !view.gameOver && !view.waitingForStart && view.turn === color && !app.replay;
    let name = app.mode === 'local' ? colorName(color).toUpperCase() : (seat ? seat.nickname : 'Waiting...');
    if (isMe) name += ' (YOU)';
    const sub = [];
    if (app.mode === 'online') {
      sub.push(el('span', { class: `presence ${seat && seat.connected ? '' : 'off'}`, 'aria-hidden': 'true' }));
      sub.push(seat ? (seat.connected ? colorName(color) : `${colorName(color)}, disconnected`) : `${colorName(color)}, empty seat`);
    } else {
      sub.push(app.mode === 'local' && color === local.viewer ? 'your pieces' : colorName(color));
    }
    const lost = view.captured[color] || 0;
    node.classList.toggle('to-move', toMove);
    node.replaceChildren(...[
      el('img', { class: 'avatar', src: sprites.piece(color, 'K'), alt: '' }),
      el('div', { class: 'player-info' }, el('span', { class: 'player-name', text: name }), el('span', { class: 'player-sub' }, sub)),
      lost ? el('span', { class: 'taken', title: `${lost} ${colorName(color)} piece${lost > 1 ? 's' : ''} captured` }, el('img', { src: sprites.piece(color, 'P'), alt: '' }), `-${lost}`) : null,
    ].filter(Boolean));
  }

  const NOTE_KINDS = ['move', 'capture', 'check', 'illegal', 'forfeit', 'draw_offer', 'draw_declined', 'resign'];
  const TONE_RANK = { bad: 3, warn: 2, good: 1, '': 0 };

  // What happened since `anchor` last moved: the news the side to move needs before playing.
  function turnNote(view, viewer) {
    const anchor = viewer || view.turn;
    const events = view.events;
    let start = 0;
    for (let i = events.length - 1; i >= 0; i -= 1) {
      if (events[i].color === anchor && (events[i].kind === 'move' || events[i].kind === 'forfeit')) {
        start = i + 1;
        break;
      }
    }
    let recent = events.slice(start).filter((event) => NOTE_KINDS.includes(event.kind));
    if (!recent.length && start > 0) recent = [events[start - 1]];

    const lines = [];
    let illegalTries = 0;
    for (const event of recent) {
      if (event.kind === 'illegal' && event.color !== viewer) {
        illegalTries += 1;
        continue;
      }
      const line = describeEvent(event, viewer, view);
      if (line) lines.push(line);
    }
    if (illegalTries) {
      const who = playerName(recent.find((event) => event.kind === 'illegal' && event.color !== viewer).color, view);
      lines.unshift({ text: `${who} tried ${illegalTries > 1 ? `${illegalTries} illegal moves` : 'an illegal move'}.`, tone: 'warn' });
    }
    const tone = lines.reduce((worst, line) => (TONE_RANK[line.tone || ''] > TONE_RANK[worst] ? line.tone : worst), '');
    return { text: lines.map((line) => line.text).join(' '), tone };
  }

  function renderTurnBanner() {
    const view = app.view;
    const banner = $('turnBanner');
    banner.classList.toggle('hidden', !view);
    if (!view) return;
    const viewer = myColor();
    let who;
    let side = view.turn;
    let note = { text: '', tone: '' };
    if (app.replay) {
      who = 'REPLAY';
      side = '';
      note = { text: 'The fog has lifted. Step through the game with the arrows.', tone: '' };
    } else if (view.gameOver) {
      who = 'GAME OVER';
      side = '';
      const last = [...view.events].reverse().find((event) => event.kind === 'game_over');
      note = { text: last ? resultLine(last) : '', tone: 'warn' };
    } else if (app.mode === 'online' && view.waitingForStart) {
      who = view.players.length < 2 ? 'WAITING FOR OPPONENT' : 'OPPONENT DISCONNECTED';
      side = '';
    } else {
      const myTurn = viewer && view.turn === viewer;
      if (app.mode === 'local') who = `${colorName(view.turn).toUpperCase()} TO MOVE`;
      else if (myTurn) who = 'YOUR MOVE';
      else who = `${playerName(view.turn).toUpperCase()} TO MOVE`;
      note = local.handoff && app.mode === 'local' ? { text: 'Hand the device over.', tone: '' } : turnNote(view, viewer);
    }
    banner.dataset.side = side;
    banner.dataset.tone = note.tone || '';
    $('turnWho').textContent = who;
    $('turnNote').textContent = note.text || (view.moves.length ? '' : "The other side's pieces are hidden in the fog.");
  }

  function renderMoves() {
    const view = app.view;
    const list = $('movesList');
    if (!view || !view.moves.length) {
      list.replaceChildren(el('li', { class: 'empty-note', text: 'No moves yet.' }));
      return;
    }
    const mine = myColor();
    const replayIndex = app.replay ? app.replay.index : -1;
    const rows = [];
    view.moves.forEach((ply, index) => {
      if (index % 2 === 0) rows.push(el('li', {}, el('span', { class: 'move-num', text: `${index / 2 + 1}.` })));
      const classes = ['ply'];
      if (ply.color === mine) classes.push('mine');
      if (ply.forfeit) classes.push('forfeit');
      if (replayIndex === index + 1) classes.push('current');
      let content;
      if (ply.forfeit) content = ['--'];
      else if (ply.san) content = [ply.san];
      else content = [el('span', { class: 'masked', title: 'hidden move' })];
      if (ply.capture && !ply.san) content.push(el('span', { class: 'cap', text: `x${ply.capture.square}` }));
      const cell = app.replay
        ? el('button', { class: `${classes.join(' ')} ply-button`, type: 'button', onclick: () => stepReplay(index + 1) }, content)
        : el('span', { class: classes.join(' ') }, content);
      rows[rows.length - 1].append(cell);
    });
    list.replaceChildren(...rows);
    if (!app.replay) list.scrollTop = list.scrollHeight;
  }

  function formatTime(at) {
    const date = new Date(at);
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
  }

  function renderNews() {
    const view = app.view;
    const list = $('newsList');
    const viewer = myColor();
    const lines = view ? view.events.map((event) => ({ event, line: describeEvent(event, viewer, view) })).filter((item) => item.line) : [];
    if (!lines.length) {
      list.replaceChildren(el('li', { class: 'empty-note', text: 'The umpire has nothing to report.' }));
      return;
    }
    list.replaceChildren(...lines.map(({ event, line }) => el('li', { dataset: { tone: line.tone || '' } },
      el('span', { class: 'news-time', text: formatTime(event.at) }), line.text)));
    list.scrollTop = list.scrollHeight;
  }

  function optionToggle(label, checked, locked, onChange) {
    const input = el('input', { type: 'checkbox' });
    input.checked = checked;
    input.disabled = locked;
    input.addEventListener('change', () => onChange(input.checked));
    return el('label', { class: `toggle ${locked ? 'locked' : ''}`, title: locked ? 'Locked while a game is in progress' : '' },
      input, el('span', { class: 'toggle-box', 'aria-hidden': 'true' }), el('span', { class: 'toggle-text', text: label }));
  }

  function renderRoomPanel() {
    const panel = $('roomPanel');
    panel.classList.toggle('hidden', app.mode !== 'online');
    if (app.mode !== 'online') return;
    $('roomCode').textContent = net.roomCode || '------';
    const view = app.view;
    $('watchers').textContent = view && view.spectatorCount ? `${view.spectatorCount} watching` : '';
    const options = $('roomOptions');
    if (!view) {
      options.replaceChildren();
      return;
    }
    const isPlayer = view.you.role === 'player';
    const locked = !isPlayer || view.inProgress;
    options.classList.toggle('hidden', !isPlayer);
    options.replaceChildren(
      optionToggle('HARD MODE', view.hardMode, locked, (on) => netSend(TYPES.SET_OPTIONS, { hardMode: on })),
      optionToggle('PARTY MODE', view.spectatorView === 'open', locked, (on) => netSend(TYPES.SET_OPTIONS, { spectatorView: on ? 'open' : 'fog' })),
    );
  }

  function actionButton(label, onclick, { kind = '', disabled = false, pulse = false } = {}) {
    return el('button', {
      class: `px-btn ${kind} ${pulse ? 'pulse' : ''}`,
      type: 'button',
      text: label,
      disabled,
      onclick,
    });
  }

  function renderActions() {
    const container = $('actions');
    const view = app.view;
    if (!view) {
      container.replaceChildren(actionButton('MENU', backToMenu, { kind: 'ghost' }));
      return;
    }
    const buttons = [];
    const isPlayer = app.mode === 'local' || (app.mode === 'online' && view.you.role === 'player');
    const opponentOffered = view.drawOffer && view.drawOffer !== myColor();
    if (app.replay) {
      if (app.mode !== 'archive') buttons.push(actionButton('BACK TO GAME', () => { app.replay = null; render(); }));
      buttons.push(actionButton('PGN', exportPgn));
    } else if (!view.gameOver && isPlayer) {
      const playing = app.mode === 'local' || !view.waitingForStart;
      buttons.push(actionButton(opponentOffered ? 'ACCEPT DRAW' : 'OFFER DRAW', () => act(TYPES.CLAIM_DRAW), {
        disabled: !playing || (app.mode === 'online' && net.status !== 'online'),
        pulse: Boolean(opponentOffered),
        kind: opponentOffered ? 'primary' : '',
      }));
      buttons.push(actionButton('RESIGN', resignAction, { kind: 'danger', disabled: !playing }));
      if (app.mode === 'local') buttons.push(actionButton('NEW GAME', newGame));
    } else if (view.gameOver) {
      buttons.push(actionButton('REPLAY', () => startReplay(0)));
      buttons.push(actionButton('PGN', exportPgn));
      if (isPlayer) buttons.push(actionButton(app.mode === 'local' ? 'NEW GAME' : 'REMATCH', newGame, { kind: 'primary', disabled: app.mode === 'online' && net.status !== 'online' }));
    }
    buttons.push(actionButton(app.mode === 'online' ? 'LEAVE' : 'MENU', backToMenu, { kind: 'ghost' }));
    container.replaceChildren(...buttons);
  }

  function renderOverlays() {
    const view = app.view;
    const waiting = $('waiting');

    let showWaiting = false;
    if (app.mode === 'online' && view && !view.gameOver && !app.replay) {
      const opponentSeat = view.players.find((seat) => seat.color !== view.you.color);
      const missing = view.you.role === 'player' && (!opponentSeat || !opponentSeat.connected);
      if (missing) {
        showWaiting = true;
        const neverJoined = !opponentSeat;
        waiting.querySelector('.overlay-kicker').firstChild.textContent = neverJoined ? 'WAITING FOR OPPONENT' : 'OPPONENT DISCONNECTED';
        $('waitingCode').textContent = net.roomCode;
        waiting.querySelector('.overlay-label').classList.toggle('hidden', !neverJoined);
        $('waitingCode').classList.toggle('hidden', !neverJoined);
        $('waitingCopy').classList.toggle('hidden', !neverJoined);
        waiting.querySelector('.overlay-small').textContent = neverJoined
          ? 'Send the link or the code to a friend.'
          : 'Their seat is saved. The game continues when they reconnect.';
      }
    }
    waiting.classList.toggle('hidden', !showWaiting);

    $('replayBar').classList.toggle('hidden', !app.replay);
    if (app.replay) {
      const total = app.replay.positions.length - 1;
      $('replayLabel').textContent = `${app.replay.index} / ${total}`;
    }
  }

  function render() {
    if (!app.mode) return;
    renderBoard();
    const top = bottomColor() === 'w' ? 'b' : 'w';
    renderBar($('barTop'), top);
    renderBar($('barBottom'), bottomColor());
    renderTurnBanner();
    renderMoves();
    renderNews();
    renderRoomPanel();
    renderActions();
    renderOverlays();
  }

  // ---------------------------------------------------------------------------
  // Wiring
  // ---------------------------------------------------------------------------

  function wireMenu() {
    $('pressStart').addEventListener('click', () => {
      sfx.unlock();
      sfx.play('start');
      if (settings.music) sfx.setMusic(true);
      showMenuPanel('menuMain');
    });
    document.querySelectorAll('[data-action]').forEach((button) => {
      button.addEventListener('click', () => onMenuAction(button.dataset.action));
    });
    $('menuScreen').addEventListener('mouseover', (event) => {
      const item = event.target.closest('.menu-item, .px-btn');
      if (item && item !== wireMenu.lastHover) sfx.play('hover');
      wireMenu.lastHover = item;
    });

    $('setupGo').addEventListener('click', () => {
      sfx.play('click');
      const hardMode = $('hardModeInput').checked;
      if (setupMode === 'local') {
        startLocal(hardMode);
        return;
      }
      createRoom({
        nickname: rememberNickname($('nicknameInput').value),
        hardMode,
        spectatorView: $('openSpectatorsInput').checked ? 'open' : 'fog',
      });
    });

    $('roomCodeInput').addEventListener('input', (event) => {
      event.target.value = protocol.normalizeRoomCode(event.target.value);
    });
    const join = (spectator) => {
      sfx.play('click');
      joinRoom($('roomCodeInput').value, { spectator, nickname: rememberNickname($('joinNicknameInput').value) });
    };
    $('joinGo').addEventListener('click', () => join(false));
    $('watchGo').addEventListener('click', () => join(true));
    $('roomCodeInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') join(false);
    });

    $('archiveClear').addEventListener('click', async () => {
      if (await confirmDialog('CLEAR ARCHIVE?', 'Every saved game on this device will be deleted.', 'CLEAR', 'danger')) {
        remove(STORAGE.archive);
        renderArchiveList();
      }
    });

    // Arrow keys walk through menu entries, arcade style.
    $('menuScreen').addEventListener('keydown', (event) => {
      if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
      const panel = event.target.closest('.menu');
      if (!panel || event.target.tagName === 'INPUT') return;
      const items = [...panel.querySelectorAll('.menu-item:not([hidden]), .archive-item, .px-btn, label.toggle input')].filter((node) => node.offsetParent);
      const index = items.indexOf(document.activeElement);
      const next = items[(index + (event.key === 'ArrowDown' ? 1 : -1) + items.length) % items.length];
      if (next) {
        event.preventDefault();
        next.focus();
        sfx.play('hover');
      }
    });
  }

  function wireGame() {
    boardEl.addEventListener('pointerdown', onBoardPointerDown);
    boardEl.addEventListener('keydown', onBoardKey);
    boardEl.addEventListener('contextmenu', (event) => event.preventDefault());
    $('waitingCopy').addEventListener('click', copyInvite);
    $('copyLink').addEventListener('click', copyInvite);
    document.querySelectorAll('[data-replay]').forEach((button) => {
      button.addEventListener('click', () => stepReplay(button.dataset.replay));
    });
    document.querySelectorAll('.tab').forEach((tab) => {
      tab.addEventListener('click', () => {
        sfx.play('click');
        document.querySelectorAll('.tab').forEach((other) => {
          other.classList.toggle('active', other === tab);
          other.setAttribute('aria-selected', String(other === tab));
        });
        $('movesList').classList.toggle('hidden', tab.dataset.tab !== 'moves');
        $('newsList').classList.toggle('hidden', tab.dataset.tab !== 'news');
      });
    });
  }

  function wireChrome() {
    $('brandBtn').addEventListener('click', () => {
      if (app.mode) backToMenu();
      else showMenuPanel('menuMain');
    });
    $('soundBtn').addEventListener('click', () => {
      settings.sound = !settings.sound;
      saveSettings();
      applySettings();
      sfx.play('click');
    });
    $('musicBtn').addEventListener('click', () => {
      settings.music = !settings.music;
      saveSettings();
      applySettings();
      sfx.setMusic(settings.music);
    });
    $('settingsBtn').addEventListener('click', () => {
      sfx.play('click');
      $('settings').classList.remove('hidden');
      $('settingsClose').focus();
    });
    $('settingsClose').addEventListener('click', () => {
      const url = $('serverUrlInput').value.trim();
      if (url && url !== settings.serverUrl) {
        if (isWsUrl(url)) settings.serverUrl = url;
        else toast('Server URL must start with ws:// or wss://', 'bad');
      }
      saveSettings();
      $('settings').classList.add('hidden');
      sfx.play('click');
    });
    document.querySelectorAll('[data-theme-choice]').forEach((button) => {
      button.addEventListener('click', () => {
        settings.theme = button.dataset.themeChoice;
        saveSettings();
        applySettings();
        sfx.play('select');
        render();
      });
    });
    for (const [id, key] of [['crtInput', 'crt'], ['fxInput', 'fx'], ['hintsInput', 'hints']]) {
      $(id).addEventListener('change', (event) => {
        settings[key] = event.target.checked;
        saveSettings();
        applySettings();
        renderBoard();
      });
    }

    document.addEventListener('keydown', (event) => {
      if (event.target.tagName === 'INPUT') return;
      if (event.key === 'Escape') {
        if (!$('dialog').classList.contains('hidden')) closeDialog(false);
        else if (!$('settings').classList.contains('hidden')) $('settingsClose').click();
        else if (!$('gameOver').classList.contains('hidden')) $('gameOver').classList.add('hidden');
        else if (!$('promotion').classList.contains('hidden')) $('promotionCancel').click();
      } else if (event.key === 'm' || event.key === 'M') {
        $('soundBtn').click();
      } else if (app.replay && (event.key === 'ArrowLeft' || event.key === 'ArrowRight') && document.activeElement !== boardEl) {
        stepReplay(event.key === 'ArrowLeft' ? 'prev' : 'next');
      } else if (!$('menuScreen').classList.contains('hidden') && !$('pressStart').classList.contains('hidden') && (event.key === 'Enter' || event.key === ' ')) {
        event.preventDefault();
        $('pressStart').click();
      }
    });
    boardEl.addEventListener('keydown', (event) => {
      if (app.replay && (event.key === 'ArrowLeft' || event.key === 'ArrowRight')) {
        event.stopPropagation();
        stepReplay(event.key === 'ArrowLeft' ? 'prev' : 'next');
      }
    }, true);

    window.addEventListener('online', () => {
      if (app.mode === 'online' && !net.ws) reconnectNow();
    });
    document.addEventListener('visibilitychange', () => {
      if (!document.hidden && app.mode === 'online' && !net.ws && !net.intentionalClose) reconnectNow();
    });
  }

  function boot() {
    applySettings();
    $('umpireFace').src = sprites.umpire('idle');
    initBoard();
    initLogoBoard();
    wireMenu();
    wireGame();
    wireChrome();

    const params = new URLSearchParams(window.location.search);
    const wsParam = params.get('ws');
    if (wsParam && isWsUrl(wsParam)) {
      settings.serverUrl = wsParam;
      applySettings();
    }
    const room = protocol.normalizeRoomCode(params.get('room'));
    const session = load(STORAGE.session, null);

    if (room && session && session.roomCode === room) {
      resumeOnline(session, { auto: true });
      return;
    }
    if (room) {
      $('roomCodeInput').value = room;
      $('joinNicknameInput').value = settings.nickname;
      showMenuPanel('menuJoin');
      return;
    }
    showMenuPanel('title');
  }

  boot();
})();
