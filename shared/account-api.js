(function installAccountApi() {
  const protocol = globalThis.BlendChessProtocol;
  const logic = globalThis.BlendChessLobbyLogic;
  const lobbySession = globalThis.BlendChessLobbySession;

  if (!protocol) throw new Error('shared/protocol.js must be loaded before account-api.js');
  if (!logic) throw new Error('shared/lobby-logic.js must be loaded before account-api.js');
  if (!lobbySession) throw new Error('shared/lobby-session.js must be loaded before account-api.js');

  // The HTTP side of the lobby: accounts (passkeys, account keys, device sessions), profiles,
  // game records, live games and the leaderboard. Transport-agnostic like lobby-session.js:
  //
  // Transports call handleHttp(store, ctx, { method, url, origin, authorization, ipHash, bodyText })
  // and send back { status, body } with responseHeaders(). handle() takes an already parsed
  // { method, path, query, origin, authorization, ipHash, body }.
  // ctx = {
  //   origins: allowed site origins (localhost is always allowed, for development),
  //   webauthn: { generateRegistrationOptions, verifyRegistrationResponse,
  //               generateAuthenticationOptions, verifyAuthenticationResponse },
  //   hooks: lobby hooks (connections(), close()), to drop sockets of a signed-out session,
  //   revokeSeats(rooms): tell each { roomCode, sessions } room to take away the seats those
  //     sessions hold and close their game sockets,
  // }
  // Results are { status, body, cacheSeconds }; a 200 with cacheSeconds > 0 is a public read.

  const RP_NAME = 'Blendchess';
  const DEFAULT_ORIGINS = ['https://blendchess.com', 'https://www.blendchess.com', 'https://blendchess.pages.dev'];
  const LIVE_LIST_MAX = 50;
  const MAX_BODY_BYTES = 16 * 1024;
  const PUBLIC_READS = ['/api/leaderboard', '/api/live', '/api/players/', '/api/games/'];
  const LIMIT_WINDOW_MS = 60 * 1000;
  const AUTH_REQUESTS_PER_MINUTE = 30;
  const FAILED_SIGNINS_PER_MINUTE = 10;
  const GAME_ID_RE = /^[a-z0-9]{6,16}$/;

  function parseOrigins(value) {
    const list = Array.isArray(value) ? value : String(value || '').split(',');
    const cleaned = list.map((item) => String(item).trim()).filter((item) => /^https?:\/\/[^/\s]+$/.test(item));
    return cleaned.length ? cleaned : DEFAULT_ORIGINS.slice();
  }

  function originAllowed(origin, allowed) {
    if (typeof origin !== 'string' || !origin) return false;
    let url;
    try {
      url = new URL(origin);
    } catch {
      return false;
    }
    if (url.origin !== origin) return false;
    if (url.hostname === 'localhost') return true;
    return (allowed || DEFAULT_ORIGINS).includes(origin);
  }

  // Passkeys belong to the registrable domain, so www.blendchess.com and blendchess.com share them.
  function rpIdFor(origin) {
    return new URL(origin).hostname.replace(/^www\./, '');
  }

  // How a request URL maps onto the API, for every transport: the /leaderboard alias, trailing
  // slashes, the query parameters routes read, and the edge-cache key of a public read (built only
  // from those parameters, so junk query strings cannot dodge the cache).
  function routeOf(method, pathname, searchParams) {
    const trimmed = String(pathname || '').replace(/\/+$/, '') || '/';
    const path = trimmed === '/leaderboard' ? '/api/leaderboard' : trimmed;
    const limit = Math.min(100, Math.max(1, Number(searchParams && searchParams.get('limit')) || 20));
    const publicRead = method === 'GET' && PUBLIC_READS.some((route) => (route.endsWith('/') ? path.startsWith(route) : path === route));
    const cacheKey = publicRead ? (path === '/api/leaderboard' ? `${path}?limit=${limit}` : path) : null;
    return { path, query: { limit }, cacheKey };
  }

  function isApiPath(pathname) {
    return pathname === '/leaderboard' || String(pathname || '').startsWith('/api/');
  }

  // --- Rate limits (per network, per isolate) --------------------------------

  const hits = new Map();

  function countHits(key, now) {
    const list = (hits.get(key) || []).filter((at) => now - at < LIMIT_WINDOW_MS);
    hits.set(key, list);
    if (hits.size > 5000) {
      for (const [other, stamps] of hits) if (!stamps.some((at) => now - at < LIMIT_WINDOW_MS)) hits.delete(other);
    }
    return list;
  }

  function overLimit(bucket, ipHash, max, now) {
    return countHits(`${bucket}:${ipHash || 'unknown'}`, now).length >= max;
  }

  function hit(bucket, ipHash, now) {
    countHits(`${bucket}:${ipHash || 'unknown'}`, now).push(now);
  }

  // --- Helpers ---------------------------------------------------------------

  function reply(status, body, cacheSeconds = 0) {
    return { status, body, cacheSeconds };
  }

  function failure(status, error, message) {
    return reply(status, { error, message });
  }

  function bearer(req) {
    const header = String(req.authorization || '');
    return header.toLowerCase().startsWith('bearer ') ? header.slice(7).trim() : '';
  }

  async function takeChallenge(store, id, kind) {
    if (typeof id !== 'string' || !id || id.length > 64) return null;
    const challenge = await store.getChallenge(id);
    if (!challenge) return null;
    // Single use, whatever happens next.
    await store.removeChallenge(id);
    if (challenge.kind !== kind || challenge.expiresAt <= Date.now()) return null;
    return challenge;
  }

  async function newChallenge(store, data) {
    const expiresAt = Date.now() + logic.CHALLENGE_TTL_MS;
    const id = logic.makeChallengeId(expiresAt);
    await store.saveChallenge(id, { ...data, expiresAt });
    return id;
  }

  async function securityOf(store, record) {
    const passkeys = [];
    for (const id of record.passkeys || []) {
      const credential = await store.getCredential(id);
      if (credential) {
        passkeys.push({
          id,
          label: credential.label,
          backedUp: Boolean(credential.backedUp),
          createdAt: credential.createdAt,
          lastUsed: credential.lastUsed,
        });
      }
    }
    return {
      passkeys,
      hasKey: Boolean(record.keyHash),
      keyCreatedAt: record.keyCreatedAt || 0,
      sessions: (record.sessions || []).length,
    };
  }

  async function meBody(store, record) {
    return { player: logic.summary(record), security: await securityOf(store, record) };
  }

  // Every change to a player's sign-in methods ends the same way: save, refresh the leaderboard
  // (only secured accounts are listed), and answer with the account as it now stands.
  async function saved(store, record, extra = {}) {
    await store.savePlayer(record);
    await store.bumpLeaderboard([record]);
    return reply(200, { ...extra, ...(await meBody(store, record)) });
  }

  // Ends these sessions of the player: their lobby sockets close, and the rooms revoke the seats
  // they were matched with (ticket and resume token dead, game sockets closed).
  async function endSessions(store, ctx, record, ended) {
    for (const hash of ended) await store.removeSession(hash);
    record.sessions = (record.sessions || []).filter((hash) => !ended.includes(hash));
    await store.savePlayer(record);
    for (const conn of ctx.hooks.connections()) {
      if (ended.includes(conn.sessionHash)) {
        try {
          ctx.hooks.close(conn, 4001, 'Signed out.');
        } catch {
          // already closed
        }
      }
    }
    const rooms = lobbySession.seatsFor(record, ended);
    if (!rooms.length) return;
    try {
      await ctx.revokeSeats(rooms);
    } catch (error) {
      console.error('seat revocation failed', error);
    }
  }

  function liveByPlayer(entries) {
    const map = new Map();
    for (const entry of entries) {
      map.set(entry.w.id, entry);
      map.set(entry.b.id, entry);
    }
    return map;
  }

  function liveLine(entry) {
    return {
      roomCode: entry.roomCode,
      control: entry.control || null,
      rated: Boolean(entry.rated),
      startedAt: entry.startedAt,
      white: { name: entry.w.name, rating: entry.w.rating },
      black: { name: entry.b.name, rating: entry.b.rating },
    };
  }

  // --- Public routes ---------------------------------------------------------

  async function leaderboard(store, limit) {
    const data = await store.leaderboard(limit || 20);
    const live = liveByPlayer(await lobbySession.liveGames(store));
    const players = data.entries.map((entry) => ({ ...entry, live: live.has(entry.id) ? live.get(entry.id).roomCode : null }));
    return reply(200, { players, total: data.total }, 10);
  }

  async function liveList(store) {
    const games = (await lobbySession.liveGames(store))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, LIVE_LIST_MAX)
      .map(liveLine);
    return reply(200, { games }, 5);
  }

  async function profile(store, rawName) {
    const name = logic.cleanName(rawName, '');
    if (!name) return failure(404, 'NOT_FOUND', 'No such player.');
    const id = await store.nameOwner(name.toLowerCase());
    const record = id ? await store.getPlayer(id) : null;
    if (!record) return failure(404, 'NOT_FOUND', 'No such player.');
    const live = liveByPlayer(await lobbySession.liveGames(store)).get(record.id) || null;
    return reply(200, {
      player: logic.summary(record),
      live: live ? { ...liveLine(live), color: live.w.id === record.id ? 'w' : 'b' } : null,
      // Summaries written when each game was reported (see lobby-session reportNow).
      games: (record.recent || []).filter((item) => item && typeof item === 'object'),
    }, 10);
  }

  async function gameById(store, id) {
    if (!GAME_ID_RE.test(id)) return failure(404, 'NOT_FOUND', 'No such game.');
    const game = await store.getGame(id);
    if (!game) return failure(404, 'NOT_FOUND', 'No such game.');
    // Finished games never change.
    return reply(200, { game: logic.publicGame(game) }, 86400);
  }

  // --- Account routes --------------------------------------------------------

  async function registerOptions(store, ctx, req, auth) {
    const record = auth.record;
    if ((record.passkeys || []).length >= logic.PASSKEYS_PER_PLAYER) {
      return failure(409, 'TOO_MANY_PASSKEYS', 'This account already has the maximum number of passkeys.');
    }
    const rpID = rpIdFor(req.origin);
    const excludeCredentials = [];
    for (const id of record.passkeys || []) {
      const credential = await store.getCredential(id);
      if (credential) excludeCredentials.push({ id, transports: credential.transports || [] });
    }
    const options = await ctx.webauthn.generateRegistrationOptions({
      rpName: RP_NAME,
      rpID,
      userName: record.name,
      userDisplayName: record.name,
      userID: new TextEncoder().encode(record.id),
      attestationType: 'none',
      excludeCredentials,
      authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
    });
    const challengeId = await newChallenge(store, {
      kind: 'register',
      challenge: options.challenge,
      playerId: record.id,
      rpID,
      origin: req.origin,
    });
    return reply(200, { challengeId, options });
  }

  async function registerVerify(store, ctx, req, auth) {
    const body = req.body || {};
    const record = auth.record;
    const challenge = await takeChallenge(store, body.challengeId, 'register');
    if (!challenge || challenge.playerId !== record.id || challenge.origin !== req.origin) {
      return failure(400, 'CHALLENGE', 'That request expired. Try again.');
    }
    let verification;
    try {
      verification = await ctx.webauthn.verifyRegistrationResponse({
        response: body.response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        requireUserVerification: false,
      });
    } catch {
      verification = null;
    }
    if (!verification || !verification.verified || !verification.registrationInfo) {
      return failure(400, 'PASSKEY_INVALID', 'The passkey could not be verified.');
    }
    const { credential, credentialBackedUp } = verification.registrationInfo;
    if (await store.getCredential(credential.id)) return failure(409, 'PASSKEY_EXISTS', 'That passkey is already registered.');
    // Checked again here: several option requests could be in flight at once.
    if ((record.passkeys || []).length >= logic.PASSKEYS_PER_PLAYER) {
      return failure(409, 'TOO_MANY_PASSKEYS', 'This account already has the maximum number of passkeys.');
    }
    const now = Date.now();
    await store.saveCredential(credential.id, {
      playerId: record.id,
      publicKey: protocol.toBase64Url(credential.publicKey),
      counter: Number(credential.counter) || 0,
      transports: Array.isArray(credential.transports) ? credential.transports.slice(0, 6) : [],
      rpID: challenge.rpID,
      label: logic.cleanName(body.label, 'Passkey', 24),
      backedUp: Boolean(credentialBackedUp),
      createdAt: now,
      lastUsed: now,
    });
    record.passkeys = [...(record.passkeys || []), credential.id];
    return saved(store, record);
  }

  async function removePasskey(store, req, auth) {
    const id = req.body && typeof req.body.id === 'string' ? req.body.id : '';
    const record = auth.record;
    if (!id || !(record.passkeys || []).includes(id)) return failure(404, 'NOT_FOUND', 'No such passkey.');
    await store.removeCredential(id);
    record.passkeys = record.passkeys.filter((item) => item !== id);
    return saved(store, record);
  }

  async function loginOptions(store, ctx, req) {
    const rpID = rpIdFor(req.origin);
    const options = await ctx.webauthn.generateAuthenticationOptions({
      rpID,
      userVerification: 'preferred',
      allowCredentials: [],
    });
    const challengeId = await newChallenge(store, { kind: 'login', challenge: options.challenge, rpID, origin: req.origin });
    return reply(200, { challengeId, options });
  }

  async function signedIn(store, record) {
    const { token } = await lobbySession.createSession(store, record);
    return reply(200, { token, player: logic.summary(record) });
  }

  async function loginVerify(store, ctx, req, now) {
    const body = req.body || {};
    const challenge = await takeChallenge(store, body.challengeId, 'login');
    if (!challenge || challenge.origin !== req.origin) return failure(400, 'CHALLENGE', 'That request expired. Try again.');
    const response = body.response && typeof body.response === 'object' ? body.response : null;
    const credentialId = response && typeof response.id === 'string' ? response.id.slice(0, 1400) : '';
    const credential = credentialId ? await store.getCredential(credentialId) : null;
    const reject = () => {
      hit('signin-failed', req.ipHash, now);
      return failure(401, 'PASSKEY_UNKNOWN', 'That passkey does not belong to a Blendchess account.');
    };
    if (!credential || credential.rpID !== challenge.rpID) return reject();
    let verification;
    try {
      verification = await ctx.webauthn.verifyAuthenticationResponse({
        response,
        expectedChallenge: challenge.challenge,
        expectedOrigin: challenge.origin,
        expectedRPID: challenge.rpID,
        credential: {
          id: credentialId,
          publicKey: protocol.fromBase64Url(credential.publicKey),
          counter: credential.counter,
          transports: credential.transports,
        },
        requireUserVerification: false,
      });
    } catch {
      verification = null;
    }
    if (!verification || !verification.verified) return reject();
    const record = await store.getPlayer(credential.playerId);
    if (!record) return reject();
    credential.counter = Number(verification.authenticationInfo && verification.authenticationInfo.newCounter) || credential.counter;
    credential.lastUsed = now;
    await store.saveCredential(credentialId, credential);
    return signedIn(store, record);
  }

  async function createKey(store, auth) {
    const record = auth.record;
    const key = logic.makeAccountKey();
    const hash = await logic.accountKeyHash(logic.normalizeAccountKey(key));
    // One key per account: making a new one retires the old one.
    if (record.keyHash) await store.removeKey(record.keyHash);
    await store.saveKey(hash, record.id);
    record.keyHash = hash;
    record.keyCreatedAt = Date.now();
    return saved(store, record, { key });
  }

  async function removeKey(store, auth) {
    const record = auth.record;
    if (record.keyHash) await store.removeKey(record.keyHash);
    record.keyHash = '';
    record.keyCreatedAt = 0;
    return saved(store, record);
  }

  async function keyLogin(store, req, now) {
    const normalized = logic.normalizeAccountKey(req.body && req.body.key);
    const owner = normalized ? await store.keyOwner(await logic.accountKeyHash(normalized)) : null;
    const record = owner ? await store.getPlayer(owner) : null;
    if (!record) {
      hit('signin-failed', req.ipHash, now);
      return failure(401, 'KEY_INVALID', 'That account key is not valid.');
    }
    return signedIn(store, record);
  }

  async function logout(store, ctx, auth) {
    await endSessions(store, ctx, auth.record, [auth.hash]);
    return reply(200, { ok: true });
  }

  async function logoutOthers(store, ctx, auth) {
    const { record, hash } = auth;
    await endSessions(store, ctx, record, (record.sessions || []).filter((other) => other !== hash));
    return reply(200, await meBody(store, record));
  }

  // --- Router ----------------------------------------------------------------

  async function route(store, ctx, req) {
    const path = String(req.path || '');
    const now = Date.now();

    if (req.method === 'GET') {
      if (path === '/api/leaderboard') return leaderboard(store, req.query && req.query.limit);
      if (path === '/api/live') return liveList(store);
      if (path.startsWith('/api/players/')) {
        let name;
        try {
          name = decodeURIComponent(path.slice('/api/players/'.length));
        } catch {
          return failure(404, 'NOT_FOUND', 'No such player.');
        }
        return profile(store, name);
      }
      if (path.startsWith('/api/games/')) return gameById(store, path.slice('/api/games/'.length));
    }

    const accountRoute = path === '/api/me' || path.startsWith('/api/auth/');
    if (!accountRoute) return failure(404, 'NOT_FOUND', 'Unknown route.');

    // Account routes are for the site itself: the passkey ceremony is bound to its origin anyway.
    if (!originAllowed(req.origin, ctx.origins)) return failure(403, 'ORIGIN', 'Requests must come from the Blendchess site.');
    if (req.method !== 'GET' && req.method !== 'POST') return failure(405, 'METHOD', 'Method not allowed.');
    if (req.method === 'POST' && path !== '/api/me') {
      if (overLimit('auth', req.ipHash, AUTH_REQUESTS_PER_MINUTE, now)) return failure(429, 'RATE_LIMIT', 'Too many requests. Try again in a minute.');
      hit('auth', req.ipHash, now);
    }

    const signInRoute = path === '/api/auth/passkey/login/verify' || path === '/api/auth/key/login';
    if (signInRoute && overLimit('signin-failed', req.ipHash, FAILED_SIGNINS_PER_MINUTE, now)) {
      return failure(429, 'RATE_LIMIT', 'Too many failed sign-ins. Try again in a minute.');
    }

    if (req.method === 'POST' && path === '/api/auth/passkey/login/options') return loginOptions(store, ctx, req);
    if (req.method === 'POST' && path === '/api/auth/passkey/login/verify') {
      return lobbySession.withLock('accounts', () => loginVerify(store, ctx, req, now));
    }
    if (req.method === 'POST' && path === '/api/auth/key/login') {
      return lobbySession.withLock('accounts', () => keyLogin(store, req, now));
    }

    const auth = await lobbySession.sessionForToken(store, bearer(req));
    if (!auth) return failure(401, 'NOT_AUTHENTICATED', 'Sign in first.');

    if (req.method === 'GET' && path === '/api/me') return reply(200, await meBody(store, auth.record));
    if (req.method !== 'POST') return failure(404, 'NOT_FOUND', 'Unknown route.');

    // Changes queue behind each other; a session signed out while this one waited must not proceed.
    const mutate = (work) => lobbySession.withLock('accounts', async () => {
      if (!(await store.sessionOwner(auth.hash))) return failure(401, 'NOT_AUTHENTICATED', 'Sign in first.');
      return work();
    });
    switch (path) {
      case '/api/auth/passkey/register/options':
        return registerOptions(store, ctx, req, auth);
      case '/api/auth/passkey/register/verify':
        return mutate(() => registerVerify(store, ctx, req, auth));
      case '/api/auth/passkey/remove':
        return mutate(() => removePasskey(store, req, auth));
      case '/api/auth/key/create':
        return mutate(() => createKey(store, auth));
      case '/api/auth/key/remove':
        return mutate(() => removeKey(store, auth));
      case '/api/auth/logout':
        return mutate(() => logout(store, ctx, auth));
      case '/api/auth/logout-others':
        return mutate(() => logoutOthers(store, ctx, auth));
      default:
        return failure(404, 'NOT_FOUND', 'Unknown route.');
    }
  }

  async function handle(store, ctx, req) {
    try {
      return await route(store, ctx, req);
    } catch (error) {
      console.error('account api failed', error);
      return failure(500, 'SERVER_ERROR', 'Server error.');
    }
  }

  // The whole HTTP request, as both transports see it: route, size limit, JSON body, then handle().
  async function handleHttp(store, ctx, request) {
    const url = new URL(request.url, 'http://localhost');
    const { path, query } = routeOf(request.method, url.pathname, url.searchParams);
    const text = request.bodyText || '';
    if (request.bodyTooLarge || text.length > MAX_BODY_BYTES) return failure(413, 'TOO_LARGE', 'Bodies must be under 16 KB.');
    let body = null;
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        return failure(400, 'INVALID', 'Body must be JSON.');
      }
    }
    const { method, origin, authorization, ipHash } = request;
    return handle(store, ctx, { method, path, query, origin, authorization, ipHash, body });
  }

  // Both transports answer with the same headers. Public reads are cacheable by anyone; account
  // routes only ever answer the site's own origin.
  function responseHeaders(origin, result, origins) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (result.cacheSeconds > 0 && result.status === 200) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cache-Control'] = `public, max-age=${result.cacheSeconds}`;
    } else {
      if (originAllowed(origin, origins)) headers['Access-Control-Allow-Origin'] = origin;
      headers.Vary = 'Origin';
      headers['Cache-Control'] = 'no-store';
    }
    return headers;
  }

  function preflightHeaders(origin, origins) {
    const headers = {
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type',
      'Access-Control-Max-Age': '600',
      Vary: 'Origin',
    };
    if (originAllowed(origin, origins)) headers['Access-Control-Allow-Origin'] = origin;
    return headers;
  }

  const accountApiExports = {
    MAX_BODY_BYTES,
    parseOrigins,
    routeOf,
    isApiPath,
    handle,
    handleHttp,
    responseHeaders,
    preflightHeaders,
    // tests reset the per-isolate limiter between cases
    resetLimits() {
      hits.clear();
    },
  };

  globalThis.BlendChessAccountApi = accountApiExports;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = accountApiExports;
  }
})();
