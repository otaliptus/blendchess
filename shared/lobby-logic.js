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
      createdAt: now,
      lastSeen: now,
      lastOpponent: '',
      lastOpponentAt: 0,
    };
  }

  function summary(record) {
    return {
      id: record.id,
      name: record.name,
      rating: record.rating,
      games: record.games,
      wins: record.wins,
      losses: record.losses,
      draws: record.draws,
      provisional: record.games < rating.PROVISIONAL_GAMES,
    };
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
    const tokens = new Map();
    const names = new Map();
    const active = new Map();
    const creations = new Map();
    const reports = new Map();
    let queue = [];
    let top = [];

    function rebuildTop() {
      top = [...players.values()]
        .filter((record) => record.games > 0)
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
      playerByToken(hash) {
        const id = tokens.get(hash);
        return id ? players.get(id) || null : null;
      },
      saveToken(hash, id) {
        tokens.set(hash, id);
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
    CONTROLS,
    CONTROL_IDS,
    DEFAULT_CONTROL,
    controlOf,
    cleanName,
    makeToken,
    makePlayerId,
    sha256Hex,
    matchWindow,
    takeMatches,
    newPlayerRecord,
    summary,
    uniqueNameAsync,
    createMemoryStore,
  };

  globalThis.BlendChessLobbyLogic = lobbyLogicExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = lobbyLogicExports;
  }
})();
