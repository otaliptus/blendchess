(function installLobbyLogic() {
  const protocol = globalThis.BlendChessProtocol;
  const rating = globalThis.BlendChessRating;

  if (!protocol) throw new Error('shared/protocol.js must be loaded before lobby-logic.js');
  if (!rating) throw new Error('shared/rating.js must be loaded before lobby-logic.js');

  const NAME_MAX = 16;
  const MAX_QUEUE = 500;
  const MAX_QUEUE_PER_NETWORK = 6;
  const NEW_PLAYER_LIMIT = 10;
  const NEW_PLAYER_WINDOW_MS = 60 * 60 * 1000;
  const QUEUE_STALE_MS = 10 * 60 * 1000;
  const ACTIVE_GAME_TTL_MS = 2 * 60 * 60 * 1000;
  const REMATCH_COOLDOWN_MS = 3 * 60 * 1000;
  const REMATCH_OVERRIDE_WAIT_MS = 30 * 1000;
  const LEADERBOARD_SIZE = 200;
  const TOKEN_BYTES = 32;
  const PLAYER_ID_LENGTH = 12;
  const GAME_ID_LENGTH = 10;
  // Accounts: every device has its own session; a player can hold a few passkeys and one key.
  const SESSIONS_PER_PLAYER = 20;
  const PASSKEYS_PER_PLAYER = 10;
  const RECENT_GAMES = 50;
  const LIVE_MAX = 500;
  const CHALLENGE_TTL_MS = 5 * 60 * 1000;
  const MAX_RECORD_PLIES = 1200;

  // Time controls the ranked pool offers. baseMs/incMs are the server-enforced clock.
  const CONTROLS = {
    '5+3': { id: '5+3', label: 'BLITZ 5+3', baseMs: 5 * 60 * 1000, incMs: 3000 },
    '10+0': { id: '10+0', label: 'RAPID 10+0', baseMs: 10 * 60 * 1000, incMs: 0 },
  };
  const DEFAULT_CONTROL = '10+0';
  const CONTROL_IDS = Object.keys(CONTROLS);

  function controlOf(value) {
    return CONTROL_IDS.includes(value) ? CONTROLS[value] : null;
  }

  function cleanName(value, fallback) {
    const text = String(value || '')
      .replace(/[\u0000-\u001f\u007f<>]/g, '')
      .trim()
      .slice(0, NAME_MAX);
    return text || fallback;
  }

  const TOKEN_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
  const ID_ALPHABET = 'abcdefghijkmnpqrstuvwxyz23456789';

  // 64 is a multiple of 64: rejecting bytes above 191 keeps the alphabet unbiased.
  function randomString(length, alphabet) {
    const limit = 256 - (256 % alphabet.length);
    let out = '';
    while (out.length < length) {
      const bytes = new Uint8Array(length * 2);
      crypto.getRandomValues(bytes);
      for (const byte of bytes) {
        if (byte < limit && out.length < length) out += alphabet[byte % alphabet.length];
      }
    }
    return out;
  }

  function makeToken(bytes = TOKEN_BYTES) {
    return randomString(bytes, TOKEN_ALPHABET);
  }

  function makePlayerId() {
    return randomString(PLAYER_ID_LENGTH, ID_ALPHABET);
  }

  async function sha256Hex(text) {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(text)));
    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join('');
  }

  function makeGameId() {
    return randomString(GAME_ID_LENGTH, ID_ALPHABET);
  }

  // --- Account keys --------------------------------------------------------
  // The passkey alternative: a 120-bit secret the player writes down or keeps in a password
  // manager. Crockford base32 (no I, L, O, U) so it survives being read aloud or retyped.
  // High entropy means a plain SHA-256 is enough at rest: there is nothing to brute-force.

  const KEY_ALPHABET = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
  const KEY_LENGTH = 24;
  const KEY_PREFIX = 'BLND';

  function makeAccountKey() {
    const raw = randomString(KEY_LENGTH, KEY_ALPHABET);
    return [KEY_PREFIX, ...raw.match(/.{4}/g)].join('-');
  }

  // Accepts the key with or without the prefix, dashes, spaces or lowercase. '' when malformed.
  function normalizeAccountKey(value) {
    let text = String(value || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (text.length === KEY_LENGTH + KEY_PREFIX.length && text.startsWith(KEY_PREFIX)) text = text.slice(KEY_PREFIX.length);
    text = text.replace(/O/g, '0').replace(/[IL]/g, '1');
    return new RegExp(`^[${KEY_ALPHABET}]{${KEY_LENGTH}}$`).test(text) ? text : '';
  }

  function accountKeyHash(normalized) {
    return sha256Hex(`account-key:${normalized}`);
  }

  // --- base64url (WebAuthn ids and public keys) ----------------------------

  function toBase64Url(bytes) {
    let binary = '';
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
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

  // --- Matchmaking ---------------------------------------------------------

  function matchWindow(waitedMs) {
    return Math.min(400, 100 + Math.floor(Math.max(0, waitedMs) / 10_000) * 50);
  }

  function rematchBlocked(entry, other, now) {
    if (entry.lastOpponent !== other.playerId) return false;
    if (now - (entry.lastOpponentAt || 0) >= REMATCH_COOLDOWN_MS) return false;
    // A small pool must not deadlock: once someone has waited a while, rematches are allowed.
    return now - entry.joinedAt < REMATCH_OVERRIDE_WAIT_MS;
  }

  // Pairs waiting players by rating closeness, widening the window with wait time.
  // One pass over the longest-waiting players: O(n^2), not the repeated re-scan it used to be.
  // Returns { pairs, remaining }; input is not mutated.
  function takeMatches(queue, now) {
    const ordered = queue.slice().sort((a, b) => a.joinedAt - b.joinedAt);
    const used = new Set();
    const pairs = [];
    for (let i = 0; i < ordered.length; i += 1) {
      if (used.has(i)) continue;
      const a = ordered[i];
      let bestIndex = -1;
      let bestScore = Infinity;
      for (let j = i + 1; j < ordered.length; j += 1) {
        if (used.has(j)) continue;
        const b = ordered[j];
        if (a.control !== b.control) continue;
        if (rematchBlocked(a, b, now) || rematchBlocked(b, a, now)) continue;
        const window = Math.max(matchWindow(now - a.joinedAt), matchWindow(now - b.joinedAt));
        const diff = Math.abs(a.rating - b.rating);
        if (diff > window) continue;
        const score = diff + Math.max(0, b.joinedAt - a.joinedAt) / 1000;
        if (score < bestScore) {
          bestScore = score;
          bestIndex = j;
        }
      }
      if (bestIndex >= 0) {
        pairs.push([a, ordered[bestIndex]]);
        used.add(i);
        used.add(bestIndex);
      }
    }
    return { pairs, remaining: ordered.filter((_, index) => !used.has(index)) };
  }

  // --- Players -------------------------------------------------------------

  function newPlayerRecord(name, now = Date.now()) {
    return {
      id: makePlayerId(),
      name: cleanName(name, 'Player'),
      rating: rating.START_RATING,
      games: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      peak: rating.START_RATING,
      createdAt: now,
      lastSeen: now,
      lastOpponent: '',
      lastOpponentAt: 0,
      // Session hashes for this player's devices, passkey credential ids, the account key's hash
      // and the ids of their most recent games (newest first). Never part of a public summary.
      sessions: [],
      passkeys: [],
      keyHash: '',
      recent: [],
    };
  }

  // A secured account can be signed into from another device; only those appear on the leaderboard.
  function isSecured(record) {
    return Boolean(record && ((Array.isArray(record.passkeys) && record.passkeys.length) || record.keyHash));
  }

  function summary(record) {
    return {
      id: record.id,
      name: record.name,
      rating: record.rating,
      peak: Math.max(Number(record.peak) || 0, record.rating),
      games: record.games,
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      provisional: record.games < rating.PROVISIONAL_GAMES,
      secured: isSecured(record),
      createdAt: record.createdAt || 0,
    };
  }

  function onLeaderboard(record) {
    return Boolean(record && record.games > 0 && isSecured(record));
  }

  // --- Game records ----------------------------------------------------------
  // A finished lobby game, stored once by the lobby. Plies are compact tuples:
  // [from, to, san, promotion, captureSquare, forfeit] with squares in algebraic notation.

  const RESULT_CODES = ['checkmate', 'resign', 'stalemate', 'mutualDraw', 'threefold', 'fivefold', 'fiftyMove',
    'seventyFiveMove', 'insufficientMaterial', 'kingCaptured', 'timeout', 'abandon'];
  const SQUARE_RE = /^[a-h][1-8]$/;

  function cleanPlies(plies) {
    if (!Array.isArray(plies)) return [];
    const out = [];
    for (const ply of plies.slice(0, MAX_RECORD_PLIES)) {
      if (!Array.isArray(ply)) break;
      const [from, to, san, promotion, capture, forfeit] = ply;
      out.push([
        SQUARE_RE.test(from) ? from : '',
        SQUARE_RE.test(to) ? to : '',
        typeof san === 'string' ? san.slice(0, 12) : '',
        ['Q', 'R', 'B', 'N'].includes(String(promotion || '').toUpperCase()) ? String(promotion).toUpperCase() : '',
        SQUARE_RE.test(capture) ? capture : '',
        forfeit ? 1 : 0,
      ]);
    }
    return out;
  }

  function cleanResult(value) {
    return RESULT_CODES.includes(value) ? value : null;
  }

  // What anyone may see about a finished game.
  function publicGame(game) {
    if (!game) return null;
    return {
      id: game.id,
      rated: Boolean(game.rated),
      control: game.control || null,
      white: { name: game.white.name, before: game.white.before, after: game.white.after },
      black: { name: game.black.name, before: game.black.before, after: game.black.after },
      winner: game.winner || null,
      result: game.result || null,
      startedAt: game.startedAt || 0,
      endedAt: game.endedAt || 0,
      plies: game.plies || [],
    };
  }

  // One line of a profile's game list, from that player's side of the board.
  function gameLine(game, playerId) {
    const color = game.white.id === playerId ? 'w' : 'b';
    const me = color === 'w' ? game.white : game.black;
    const them = color === 'w' ? game.black : game.white;
    const outcome = !game.winner ? 'draw' : game.winner === color ? 'win' : 'loss';
    return {
      id: game.id,
      color,
      outcome,
      result: game.result || null,
      rated: Boolean(game.rated),
      control: game.control || null,
      opponent: { name: them.name, rating: them.before },
      delta: game.rated && Number.isFinite(me.after) && Number.isFinite(me.before) ? me.after - me.before : null,
      moves: Math.ceil((game.plies || []).length / 2),
      endedAt: game.endedAt || 0,
    };
  }

  function liveIsFresh(entry, now = Date.now()) {
    return Boolean(entry && now - (entry.startedAt || 0) < ACTIVE_GAME_TTL_MS);
  }

  // Picks a display name nobody else holds. `exceptId` keeps the current owner's name.
  // Async because the Worker's store reads from storage.
  async function uniqueNameAsync(store, desired, exceptId) {
    const base = cleanName(desired, 'Player');
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const suffix = attempt === 0 ? '' : String(attempt + 1);
      const candidate = `${base.slice(0, NAME_MAX - suffix.length)}${suffix}`;
      const owner = await store.nameOwner(candidate.toLowerCase());
      if (!owner || owner === exceptId) return candidate;
    }
    return `${base.slice(0, NAME_MAX - 4)}${Math.floor(Math.random() * 9000 + 1000)}`;
  }

  // --- In-memory store -----------------------------------------------------
  // Node server and tests use this. The Worker has a storage-backed equivalent.

  function createMemoryStore() {
    const players = new Map();
    const sessions = new Map();
    const credentials = new Map();
    const keys = new Map();
    const challenges = new Map();
    const games = new Map();
    const names = new Map();
    const active = new Map();
    const creations = new Map();
    const reports = new Map();
    let queue = [];
    let live = [];
    let top = [];

    function rebuildTop() {
      top = [...players.values()]
        .filter(onLeaderboard)
        .sort((a, b) => b.rating - a.rating || b.games - a.games || a.createdAt - b.createdAt)
        .slice(0, LEADERBOARD_SIZE)
        .map((record) => summary(record));
    }

    function rankedCount() {
      return [...players.values()].filter((record) => record.games > 0).length;
    }

    return {
      getPlayer: (id) => players.get(id) || null,
      savePlayer(record) {
        players.set(record.id, record);
      },
      // hash -> { playerId, method, createdAt, lastUsed }
      getSession: (hash) => sessions.get(hash) || null,
      saveSession(hash, data) {
        sessions.set(hash, { ...data });
      },
      removeSession(hash) {
        sessions.delete(hash);
      },
      // credential id -> { playerId, publicKey, counter, transports, rpID, label, createdAt, lastUsed }
      getCredential: (id) => credentials.get(id) || null,
      saveCredential(id, data) {
        credentials.set(id, { ...data });
      },
      removeCredential(id) {
        credentials.delete(id);
      },
      keyOwner: (hash) => keys.get(hash) || null,
      saveKey(hash, playerId) {
        keys.set(hash, playerId);
      },
      removeKey(hash) {
        keys.delete(hash);
      },
      getChallenge(id) {
        const found = challenges.get(id) || null;
        if (found && found.expiresAt <= Date.now()) {
          challenges.delete(id);
          return null;
        }
        return found;
      },
      saveChallenge(id, data) {
        challenges.set(id, { ...data });
        if (challenges.size > 5000) {
          const now = Date.now();
          for (const [key, value] of challenges) if (value.expiresAt <= now) challenges.delete(key);
        }
      },
      removeChallenge(id) {
        challenges.delete(id);
      },
      getGame: (id) => games.get(id) || null,
      getGames: (ids) => ids.map((id) => games.get(id)).filter(Boolean),
      saveGame(game) {
        games.set(game.id, game);
      },
      getLive: () => live.map((entry) => ({ ...entry })),
      saveLive(entries) {
        live = entries.slice(0, LIVE_MAX).map((entry) => ({ ...entry }));
      },
      nameOwner: (lower) => names.get(lower) || null,
      saveName(lower, id) {
        names.set(lower, id);
      },
      removeName(lower) {
        names.delete(lower);
      },
      getQueue: () => queue.map((entry) => ({ ...entry })),
      saveQueue(entries) {
        queue = entries.map((entry) => ({ ...entry }));
      },
      getActiveGame: (playerId) => active.get(playerId) || null,
      saveActiveGame(playerId, game) {
        active.set(playerId, { ...game });
      },
      clearActiveGame(playerId) {
        active.delete(playerId);
      },
      creationCount(ipHash, since) {
        const list = (creations.get(ipHash) || []).filter((at) => at >= since);
        if (!list.length) creations.delete(ipHash);
        return list.length;
      },
      recordCreation(ipHash, at) {
        const list = (creations.get(ipHash) || []).filter((stamp) => at - stamp < NEW_PLAYER_WINDOW_MS);
        list.push(at);
        creations.set(ipHash, list.slice(-NEW_PLAYER_LIMIT * 2));
        if (creations.size > 5000) {
          for (const [key, stamps] of creations) {
            if (!stamps.some((stamp) => at - stamp < NEW_PLAYER_WINDOW_MS)) creations.delete(key);
          }
        }
      },
      getReport(key) {
        return reports.get(key) || null;
      },
      saveReport(key, data) {
        reports.set(key, { ...data, at: data.at || Date.now() });
        if (reports.size > 10_000) {
          for (const [oldKey, value] of reports) {
            if (reports.size <= 8_000) break;
            if (Date.now() - (value.at || 0) > 7 * 24 * 60 * 60 * 1000) reports.delete(oldKey);
          }
        }
      },
      bumpLeaderboard() {
        rebuildTop();
      },
      leaderboard(limit = 20) {
        return { entries: top.slice(0, Math.max(1, Math.min(LEADERBOARD_SIZE, limit))), total: rankedCount() };
      },
      rankedCount,
    };
  }

  const lobbyLogicExports = {
    NAME_MAX,
    MAX_QUEUE,
    MAX_QUEUE_PER_NETWORK,
    NEW_PLAYER_LIMIT,
    NEW_PLAYER_WINDOW_MS,
    QUEUE_STALE_MS,
    ACTIVE_GAME_TTL_MS,
    REMATCH_COOLDOWN_MS,
    LEADERBOARD_SIZE,
    SESSIONS_PER_PLAYER,
    PASSKEYS_PER_PLAYER,
    RECENT_GAMES,
    LIVE_MAX,
    CHALLENGE_TTL_MS,
    CONTROLS,
    CONTROL_IDS,
    DEFAULT_CONTROL,
    controlOf,
    cleanName,
    makeToken,
    makePlayerId,
    makeGameId,
    sha256Hex,
    makeAccountKey,
    normalizeAccountKey,
    accountKeyHash,
    toBase64Url,
    fromBase64Url,
    matchWindow,
    takeMatches,
    newPlayerRecord,
    isSecured,
    onLeaderboard,
    summary,
    cleanPlies,
    cleanResult,
    publicGame,
    gameLine,
    liveIsFresh,
    uniqueNameAsync,
    createMemoryStore,
  };

  globalThis.BlendChessLobbyLogic = lobbyLogicExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lobbyLogicExports;
  }
})();
