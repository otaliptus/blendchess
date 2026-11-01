(function installAccountApi() {
  const logic = globalThis.BlendChessLobbyLogic;
  const lobbySession = globalThis.BlendChessLobbySession;

  if (!logic) throw new Error('shared/lobby-logic.js must be loaded before account-api.js');
  if (!lobbySession) throw new Error('shared/lobby-session.js must be loaded before account-api.js');

  // The HTTP side of the lobby: accounts (passkeys, account keys, device sessions), profiles,
  // game records, live games and the leaderboard. Transport-agnostic like lobby-session.js:
  //
  // request = { method, path, origin, authorization, ipHash, body }   (body: parsed JSON or null)
  // ctx = {
  //   origins: allowed site origins (localhost is always allowed, for development),
  //   webauthn: { generateRegistrationOptions, verifyRegistrationResponse,
  //               generateAuthenticationOptions, verifyAuthenticationResponse },
  //   hooks: lobby hooks (connections(), close()), to drop sockets of a signed-out session,
  // }
  // Returns { status, body, public, cacheSeconds }.

  const RP_NAME = 'Blendchess';
  const DEFAULT_ORIGINS = ['https://blendchess.com', 'https://www.blendchess.com', 'https://blendchess.pages.dev'];
  const PROFILE_GAMES = 20;
  const LIVE_LIST_MAX = 50;
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

  function reply(status, body, { cacheSeconds = 0, isPublic = false } = {}) {
    return { status, body, public: isPublic, cacheSeconds };
  }

  function publicReply(body, cacheSeconds) {
    return reply(200, body, { cacheSeconds, isPublic: true });
  }

  function failure(status, error, message) {
    return reply(status, { error, message });
  }

  function cleanLabel(value) {
    return String(value || '').replace(/[\u0000-\u001f\u007f<>]/g, '').trim().slice(0, 24) || 'Passkey';
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
    const id = logic.makeToken(16);
    await store.saveChallenge(id, { ...data, expiresAt: Date.now() + logic.CHALLENGE_TTL_MS });
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

  // Sockets opened with a session that just ended are closed, so they cannot keep queueing.
  function dropSockets(ctx, predicate) {
    const hooks = ctx.hooks;
    if (!hooks || typeof hooks.connections !== 'function') return;
    for (const conn of hooks.connections()) {
      if (predicate(conn)) {
        try {
          hooks.close(conn, 4001, 'Signed out.');
        } catch {
          // already closed
        }
      }
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

  async function leaderboard(store, limitParam) {
    const limit = Math.min(100, Math.max(1, Number(limitParam) || 20));
    const data = await store.leaderboard(limit);
    const live = liveByPlayer(await lobbySession.liveGames(store));
    const players = data.entries.map((entry) => ({ ...entry, live: live.has(entry.id) ? live.get(entry.id).roomCode : null }));
    return publicReply({ players, total: data.total }, 10);
  }

  async function liveList(store) {
    const games = (await lobbySession.liveGames(store))
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, LIVE_LIST_MAX)
      .map(liveLine);
    return publicReply({ games }, 5);
  }

  async function profile(store, rawName) {
    const name = logic.cleanName(rawName, '');
    if (!name) return failure(404, 'NOT_FOUND', 'No such player.');
    const id = await store.nameOwner(name.toLowerCase());
    const record = id ? await store.getPlayer(id) : null;
    if (!record) return failure(404, 'NOT_FOUND', 'No such player.');
    const live = liveByPlayer(await lobbySession.liveGames(store)).get(record.id) || null;
    const ids = (record.recent || []).slice(0, PROFILE_GAMES);
    const games = ids.length ? await store.getGames(ids) : [];
    return publicReply({
      player: logic.summary(record),
      live: live ? { ...liveLine(live), color: live.w.id === record.id ? 'w' : 'b' } : null,
      games: games.map((game) => logic.gameLine(game, record.id)),
    }, 10);
  }

  async function gameById(store, id) {
    if (!GAME_ID_RE.test(id)) return failure(404, 'NOT_FOUND', 'No such game.');
    const game = await store.getGame(id);
    if (!game) return failure(404, 'NOT_FOUND', 'No such game.');
    // Finished games never change.
    return publicReply({ game: logic.publicGame(game) }, 86400);
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
    const now = Date.now();
    await store.saveCredential(credential.id, {
      playerId: record.id,
      publicKey: logic.toBase64Url(credential.publicKey),
      counter: Number(credential.counter) || 0,
      transports: Array.isArray(credential.transports) ? credential.transports.slice(0, 6) : [],
      rpID: challenge.rpID,
      label: cleanLabel(body.label),
      backedUp: Boolean(credentialBackedUp),
      createdAt: now,
      lastUsed: now,
    });
    record.passkeys = [...(record.passkeys || []), credential.id];
    await store.savePlayer(record);
    await store.bumpLeaderboard([record]);
    return reply(200, await meBody(store, record));
  }

  async function removePasskey(store, req, auth) {
    const id = req.body && typeof req.body.id === 'string' ? req.body.id : '';
    const record = auth.record;
    if (!id || !(record.passkeys || []).includes(id)) return failure(404, 'NOT_FOUND', 'No such passkey.');
    await store.removeCredential(id);
    record.passkeys = record.passkeys.filter((item) => item !== id);
    await store.savePlayer(record);
    await store.bumpLeaderboard([record]);
    return reply(200, await meBody(store, record));
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

  async function signedIn(store, record, method) {
    const { token } = await lobbySession.createSession(store, record, method);
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
          publicKey: logic.fromBase64Url(credential.publicKey),
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
    return signedIn(store, record, 'passkey');
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
    await store.savePlayer(record);
    await store.bumpLeaderboard([record]);
    return reply(200, { key, ...(await meBody(store, record)) });
  }

  async function removeKey(store, auth) {
    const record = auth.record;
    if (record.keyHash) await store.removeKey(record.keyHash);
    record.keyHash = '';
    record.keyCreatedAt = 0;
    await store.savePlayer(record);
    await store.bumpLeaderboard([record]);
    return reply(200, await meBody(store, record));
  }

  async function keyLogin(store, req, now) {
    const normalized = logic.normalizeAccountKey(req.body && req.body.key);
    const owner = normalized ? await store.keyOwner(await logic.accountKeyHash(normalized)) : null;
    const record = owner ? await store.getPlayer(owner) : null;
    if (!record) {
      hit('signin-failed', req.ipHash, now);
      return failure(401, 'KEY_INVALID', 'That account key is not valid.');
    }
    return signedIn(store, record, 'key');
  }

  async function logout(store, ctx, auth) {
    const { record, hash } = auth;
    await store.removeSession(hash);
    record.sessions = (record.sessions || []).filter((item) => item !== hash);
    await store.savePlayer(record);
    dropSockets(ctx, (conn) => conn.sessionHash === hash);
    return reply(200, { ok: true });
  }

  async function logoutOthers(store, ctx, auth) {
    const { record, hash } = auth;
    for (const other of record.sessions || []) {
      if (other !== hash) await store.removeSession(other);
    }
    record.sessions = [hash];
    await store.savePlayer(record);
    dropSockets(ctx, (conn) => conn.playerId === record.id && conn.sessionHash !== hash);
    return reply(200, await meBody(store, record));
  }

  // --- Router ----------------------------------------------------------------

  async function route(store, ctx, req) {
    const path = String(req.path || '').replace(/\/+$/, '');
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

    const auth = await lobbySession.sessionForToken(store, bearer(req), now);
    if (!auth) return failure(401, 'NOT_AUTHENTICATED', 'Sign in first.');

    if (req.method === 'GET' && path === '/api/me') return reply(200, await meBody(store, auth.record));
    if (req.method !== 'POST') return failure(404, 'NOT_FOUND', 'Unknown route.');

    const mutate = (work) => lobbySession.withLock('accounts', work);
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

  // Both transports answer with the same headers. Public reads are cacheable by anyone; account
  // routes only ever answer the site's own origin.
  function responseHeaders(req, result, origins) {
    const headers = { 'Content-Type': 'application/json; charset=utf-8' };
    if (result.public && result.status === 200) {
      headers['Access-Control-Allow-Origin'] = '*';
      headers['Cache-Control'] = `public, max-age=${result.cacheSeconds}`;
    } else {
      if (originAllowed(req.origin, origins)) headers['Access-Control-Allow-Origin'] = req.origin;
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
    DEFAULT_ORIGINS,
    parseOrigins,
    originAllowed,
    rpIdFor,
    handle,
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
