import { DurableObject } from 'cloudflare:workers';
import * as webauthn from '@simplewebauthn/server';

const protocol = globalThis.BlendChessProtocol;
const logic = globalThis.BlendChessLobbyLogic;
const lobbySession = globalThis.BlendChessLobbySession;
const accountApi = globalThis.BlendChessAccountApi;
if (!protocol || !logic || !lobbySession || !accountApi) throw new Error('shared modules must load before lobby.js');
const { ROOM_CODE_ALPHABET, ROOM_CODE_LENGTH, createError, parseEnvelope } = protocol;

const MAX_SOCKETS = 2000;
const MAX_SOCKETS_PER_IP = 6;
const MAX_MESSAGE_BYTES = 8 * 1024;
const RATE_LIMIT_WINDOW_MS = 1000;
const RATE_LIMIT_MAX_MESSAGES = 30;
const MATCH_TICK_MS = 5000;
const CREATE_WINDOW_MS = 60 * 1000;
const CREATE_PER_IP = 12;
const CREATE_GLOBAL = 400;
const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const PRUNE_INTERVAL_MS = 24 * 60 * 60 * 1000;
const MAX_API_BODY_BYTES = 16 * 1024;

function makeRoomCode() {
  const bytes = new Uint8Array(ROOM_CODE_LENGTH);
  crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => ROOM_CODE_ALPHABET[byte % ROOM_CODE_ALPHABET.length]).join('');
}

function messageByteLength(data) {
  return typeof data === 'string' ? new TextEncoder().encode(data).length : data.byteLength;
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'no-store',
    },
  });
}

// The same interface as shared/lobby-logic.js createMemoryStore(), backed by Durable Object
// storage so a rating survives eviction. Small values, per-key writes, tiny read cache.
class StorageLobbyStore {
  constructor(storage) {
    this.storage = storage;
    this.cache = new Map();
  }

  // Bounded insert-order cache: enough to absorb a burst without growing for the life of the object.
  remember(key, value) {
    this.cache.set(key, value);
    if (this.cache.size > 2000) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) this.cache.delete(oldest);
    }
  }

  async read(key) {
    if (this.cache.has(key)) return this.cache.get(key);
    const value = (await this.storage.get(key)) ?? null;
    this.remember(key, value);
    return value;
  }

  async write(key, value) {
    this.remember(key, value);
    await this.storage.put(key, value);
  }

  async remove(key) {
    this.cache.delete(key);
    await this.storage.delete(key);
  }

  async getPlayer(id) {
    return id ? this.read(`player:${id}`) : null;
  }

  async savePlayer(record) {
    await this.write(`player:${record.id}`, record);
  }

  async getSession(hash) {
    const value = await this.read(`session:${hash}`);
    if (value) return value;
    // Identities minted before accounts existed: token:<hash> -> playerId.
    const legacy = await this.read(`token:${hash}`);
    return typeof legacy === 'string' ? { playerId: legacy, method: 'guest', createdAt: 0, lastUsed: 0 } : null;
  }

  async saveSession(hash, data) {
    await this.write(`session:${hash}`, data);
  }

  async removeSession(hash) {
    await this.remove(`session:${hash}`);
    await this.remove(`token:${hash}`);
  }

  async getCredential(id) {
    return this.read(`cred:${id}`);
  }

  async saveCredential(id, data) {
    await this.write(`cred:${id}`, data);
  }

  async removeCredential(id) {
    await this.remove(`cred:${id}`);
  }

  async keyOwner(hash) {
    return this.read(`key:${hash}`);
  }

  async saveKey(hash, playerId) {
    await this.write(`key:${hash}`, playerId);
  }

  async removeKey(hash) {
    await this.remove(`key:${hash}`);
  }

  // Passkey challenges are stored, not kept in memory: the object can hibernate while someone is
  // still at the passkey prompt. They bypass the read cache and are deleted once used.
  async getChallenge(id) {
    const value = await this.storage.get(`chal:${id}`);
    return value && value.expiresAt > Date.now() ? value : null;
  }

  async saveChallenge(id, data) {
    await this.storage.put(`chal:${id}`, data);
    await this.sweepChallenges();
  }

  async removeChallenge(id) {
    await this.storage.delete(`chal:${id}`);
  }

  // Challenge ids start with their expiry, so everything before "now" is expired. Each new challenge
  // sweeps up to 128 old ones, which keeps up with however many are being created.
  async sweepChallenges() {
    const end = `chal:${Date.now().toString(36).padStart(9, '0')}`;
    const expired = await this.storage.list({ prefix: 'chal:', end, limit: 128 });
    if (expired.size) await this.storage.delete([...expired.keys()]);
  }

  async getGame(id) {
    return this.read(`game:${id}`);
  }

  async getGames(ids) {
    const games = await Promise.all(ids.map((id) => this.read(`game:${id}`)));
    return games.filter(Boolean);
  }

  async saveGame(game) {
    await this.write(`game:${game.id}`, game);
  }

  async getLive() {
    return ((await this.read('live')) || []).map((entry) => ({ ...entry }));
  }

  async saveLive(entries) {
    await this.write('live', entries.slice(0, logic.LIVE_MAX));
  }

  async nameOwner(lower) {
    return this.read(`name:${lower}`);
  }

  async saveName(lower, id) {
    await this.write(`name:${lower}`, id);
  }

  async removeName(lower) {
    await this.remove(`name:${lower}`);
  }

  async getQueue() {
    return (await this.read('queue')) || [];
  }

  async saveQueue(entries) {
    await this.write('queue', entries.slice(0, logic.MAX_QUEUE + 10));
  }

  async getActiveGame(playerId) {
    return this.read(`active:${playerId}`);
  }

  async saveActiveGame(playerId, game) {
    await this.write(`active:${playerId}`, game);
  }

  async clearActiveGame(playerId) {
    await this.remove(`active:${playerId}`);
  }

  async creationCount(ipHash, since) {
    const list = (await this.read(`ip:${ipHash}`)) || [];
    return list.filter((at) => at >= since).length;
  }

  async recordCreation(ipHash, at) {
    const list = ((await this.read(`ip:${ipHash}`)) || []).filter((stamp) => at - stamp < logic.NEW_PLAYER_WINDOW_MS);
    list.push(at);
    await this.write(`ip:${ipHash}`, list.slice(-logic.NEW_PLAYER_LIMIT * 2));
  }

  async getReport(key) {
    return this.read(`report:${key}`);
  }

  async saveReport(key, data) {
    await this.write(`report:${key}`, data);
  }

  // Keeps a small sorted board instead of scanning every player on each request.
  async bumpLeaderboard(records = []) {
    // Entries from before accounts (or from accounts that later removed their sign-in methods)
    // carry no `secured`: they are dropped here and filtered out on read.
    const top = ((await this.read('top')) || []).filter((entry) => entry && entry.secured);
    const stats = (await this.read('stats')) || { ranked: 0 };
    for (const record of records) {
      const index = top.findIndex((entry) => entry.id === record.id);
      if (index >= 0) top.splice(index, 1);
      // Only secured accounts are listed; every player with a game counts towards the total.
      if (logic.onLeaderboard(record)) top.push(logic.summary(record));
      if (record.games > 0 && !(await this.read(`played:${record.id}`))) {
        await this.write(`played:${record.id}`, 1);
        stats.ranked += 1;
      }
    }
    top.sort((a, b) => b.rating - a.rating || b.games - a.games);
    await this.write('top', top.slice(0, logic.LEADERBOARD_SIZE));
    await this.write('stats', stats);
  }

  async leaderboard(limit) {
    const top = ((await this.read('top')) || []).filter((entry) => entry && entry.secured);
    const stats = (await this.read('stats')) || { ranked: 0 };
    return { entries: top.slice(0, limit), total: stats.ranked };
  }

  async rankedCount() {
    return ((await this.read('stats')) || { ranked: 0 }).ranked;
  }
}

// One global lobby: identity, queue, matchmaking, ratings. Every room and every leaderboard
// request goes through here, but it holds no game state.
export class LobbyHub extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.ctx = ctx;
    this.env = env;
    this.store = new StorageLobbyStore(ctx.storage);
    this.origins = accountApi.parseOrigins(env && env.SITE_ORIGINS);
    this.rates = new Map();
    this.creationHits = new Map();
    this.globalHits = [];
    this.closing = new Set();
    this.chains = new Map();
    // Internal writes (results, rematches, releases) are applied one at a time so two rooms can
    // never race the same rating update.
    this.internalChain = Promise.resolve();
    ctx.blockConcurrencyWhile(async () => {
      await this.reconcileQueue();
      await this.scheduleAlarm();
    });
  }

  conn(ws) {
    return { ...(ws.deserializeAttachment() || {}), ws };
  }

  liveConns() {
    return this.ctx.getWebSockets().map((ws) => this.conn(ws)).filter((conn) => !this.closing.has(conn.id));
  }

  hooks() {
    return {
      connections: () => this.liveConns(),
      send: (conn, message) => {
        try {
          conn.ws.send(JSON.stringify(message));
        } catch {
          // socket already gone; its close handler cleans up
        }
      },
      close: (conn, code, reason) => {
        try {
          conn.ws.close(code, reason);
        } catch {
          // already closed
        }
      },
      save: (conn) => {
        const { ws, ...meta } = conn;
        try {
          ws.serializeAttachment(meta);
        } catch {
          // closed sockets can't take attachments
        }
      },
      createRatedRoom: (match) => this.createRatedRoom(match),
      newPlayerLimit: this.env.NEW_PLAYER_LIMIT,
    };
  }

  // A reserved room lives in its own Durable Object; the lobby only hands out the tickets.
  async createRatedRoom(match) {
    const spec = logic.controlOf(match.control);
    if (!spec) return null;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const roomCode = makeRoomCode();
      const tickets = { w: logic.makeToken(), b: logic.makeToken() };
      const body = JSON.stringify({
        roomCode,
        rated: match.rated,
        control: spec.id,
        clock: { baseMs: spec.baseMs, incMs: spec.incMs },
        seats: match.seats.map((seat) => ({ ...seat, ticket: tickets[seat.color] || '' })),
      });
      const stub = this.env.GAME_HUB.get(this.env.GAME_HUB.idFromName(roomCode));
      let response;
      try {
        response = await stub.fetch('https://room.internal/reserve', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body,
        });
      } catch {
        return null;
      }
      if (response.status === 409) continue;
      if (!response.ok) return null;
      return { roomCode, tickets };
    }
    return null;
  }

  // After an eviction, queue rows whose socket is gone are dropped.
  async reconcileQueue() {
    const entries = await this.store.getQueue();
    if (!entries.length) return;
    const connected = new Set(this.liveConns().filter((conn) => conn.playerId).map((conn) => conn.playerId));
    const live = entries.filter((entry) => connected.has(entry.playerId));
    if (live.length !== entries.length) await this.store.saveQueue(live);
  }

  // The alarm either retries matching while someone waits, or comes back once a day to prune
  // old report markers. It is always in the future.
  async scheduleAlarm() {
    const entries = await this.store.getQueue();
    const next = entries.length ? Date.now() + MATCH_TICK_MS : Date.now() + PRUNE_INTERVAL_MS;
    await this.ctx.storage.setAlarm(next);
  }

  async fetch(request) {
    const url = new URL(request.url);

    // The public HTTP API (/api/*), forwarded by index.js with the caller's network hash.
    if (url.pathname.startsWith('/api/') || url.pathname === '/leaderboard') return this.api(request, url);

    // Internal calls from room Durable Objects and the Worker router. External clients cannot
    // reach these paths: index.js never forwards them.
    if (url.pathname === '/report' && request.method === 'POST') {
      return this.runInternal(async () => {
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, reason: 'INVALID' }, 400);
        return json(await lobbySession.report(this.store, this.hooks(), body));
      });
    }
    if (url.pathname === '/active' && request.method === 'POST') {
      return this.runInternal(async () => {
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, reason: 'INVALID' }, 400);
        return json(await lobbySession.registerActive(this.store, body));
      });
    }
    if (url.pathname === '/release' && request.method === 'POST') {
      return this.runInternal(async () => {
        const body = await request.json().catch(() => null);
        if (!body) return json({ ok: false, reason: 'INVALID' }, 400);
        return json(await lobbySession.release(this.store, body));
      });
    }
    if (url.pathname === '/limit/create' && (request.method === 'GET' || request.method === 'POST')) {
      const ipHash = request.headers.get('X-IP-Hash') || 'unknown';
      return this.checkCreate(ipHash) ? json({ ok: true }) : json({ ok: false }, 429);
    }

    const upgrade = request.headers.get('Upgrade');
    if (!upgrade || upgrade.toLowerCase() !== 'websocket') {
      return new Response('Blendchess lobby. Connect a WebSocket with ?lobby=1.', { status: 200 });
    }

    const ipHash = request.headers.get('X-IP-Hash') || 'unknown';
    const sockets = this.ctx.getWebSockets();
    if (sockets.length >= MAX_SOCKETS) return new Response('Lobby is full.', { status: 429 });
    const sameIp = sockets.filter((ws) => {
      const attachment = ws.deserializeAttachment();
      return attachment && attachment.ipHash === ipHash;
    }).length;
    if (sameIp >= MAX_SOCKETS_PER_IP) return new Response('Too many connections from this network.', { status: 429 });

    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.ctx.acceptWebSocket(server);
    server.serializeAttachment({ id: crypto.randomUUID(), playerId: '', ipHash, role: 'lobby' });
    return new Response(null, { status: 101, webSocket: client });
  }

  async api(request, url) {
    const req = {
      method: request.method,
      path: url.pathname === '/leaderboard' ? '/api/leaderboard' : url.pathname,
      query: { limit: url.searchParams.get('limit') },
      origin: request.headers.get('Origin') || '',
      authorization: request.headers.get('Authorization') || '',
      ipHash: request.headers.get('X-IP-Hash') || 'unknown',
      body: null,
    };
    let result = null;
    if (request.method === 'POST') {
      const text = await request.text();
      if (text.length > MAX_API_BODY_BYTES) {
        result = { status: 413, body: { error: 'TOO_LARGE' }, public: false, cacheSeconds: 0 };
      } else if (text) {
        try {
          req.body = JSON.parse(text);
        } catch {
          result = { status: 400, body: { error: 'INVALID', message: 'Body must be JSON.' }, public: false, cacheSeconds: 0 };
        }
      }
    }
    if (!result) {
      result = await accountApi.handle(this.store, {
        origins: this.origins,
        webauthn,
        hooks: this.hooks(),
        revokeSeats: (rooms) => this.revokeSeats(rooms),
      }, req);
    }
    return new Response(JSON.stringify(result.body), {
      status: result.status,
      headers: accountApi.responseHeaders(req, result, this.origins),
    });
  }

  // Signed-out sessions lose their seats: each room cancels them and closes their game sockets.
  async revokeSeats(rooms) {
    await Promise.all(rooms.map(async ({ roomCode, sessions }) => {
      try {
        await this.env.GAME_HUB.get(this.env.GAME_HUB.idFromName(roomCode)).fetch('https://room.internal/revoke', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ sessions }),
        });
      } catch (error) {
        console.error('seat revocation failed', roomCode, error);
      }
    }));
  }

  runInternal(work) {
    const task = this.internalChain.then(work);
    this.internalChain = task.catch(() => {});
    return task;
  }

  // Room creation is the expensive operation: cap it globally and per network.
  checkCreate(ipHash) {
    const now = Date.now();
    const hits = (this.creationHits.get(ipHash) || []).filter((at) => now - at < CREATE_WINDOW_MS);
    this.globalHits = this.globalHits.filter((at) => now - at < CREATE_WINDOW_MS);
    const allowed = hits.length < CREATE_PER_IP && this.globalHits.length < CREATE_GLOBAL;
    if (allowed) {
      hits.push(now);
      this.globalHits.push(now);
    }
    this.creationHits.set(ipHash, hits);
    if (this.creationHits.size > 2000) {
      for (const [key, list] of this.creationHits) {
        if (!list.some((at) => now - at < CREATE_WINDOW_MS)) this.creationHits.delete(key);
      }
    }
    return allowed;
  }

  isRateLimited(connId) {
    const now = Date.now();
    const recent = (this.rates.get(connId) || []).filter((timestamp) => now - timestamp <= RATE_LIMIT_WINDOW_MS);
    const limited = recent.length >= RATE_LIMIT_MAX_MESSAGES;
    if (!limited) recent.push(now);
    this.rates.set(connId, recent);
    return limited;
  }

  // One socket's messages must be handled in order (a rename before a queue), but different
  // players never wait for each other.
  webSocketMessage(ws, data) {
    const key = (ws.deserializeAttachment() || {}).id || 'anonymous';
    const previous = this.chains.get(key) || Promise.resolve();
    const task = previous.then(() => this.processMessage(ws, data));
    const guarded = task.catch((error) => console.error('lobby message failed', error));
    this.chains.set(key, guarded);
    guarded.then(() => {
      if (this.chains.get(key) === guarded) this.chains.delete(key);
    });
    return guarded;
  }

  async processMessage(ws, data) {
    const conn = this.conn(ws);
    const hooks = this.hooks();
    const sendError = (code, message) => hooks.send(conn, createError('', conn.playerId || '', code, message));

    if (messageByteLength(data) > MAX_MESSAGE_BYTES) {
      sendError(protocol.ERROR_CODES.INVALID_PAYLOAD, 'Message exceeds size limit.');
      return;
    }
    if (this.isRateLimited(conn.id)) {
      sendError(protocol.ERROR_CODES.RATE_LIMIT, 'Too many requests. Slow down.');
      return;
    }

    const parsed = parseEnvelope(typeof data === 'string' ? data : new TextDecoder().decode(data));
    if (!parsed.ok) {
      sendError(parsed.code, parsed.message);
      return;
    }

    try {
      await lobbySession.handleMessage(this.store, hooks, conn, parsed.envelope);
    } catch (error) {
      console.error('lobby message failed', error);
      sendError(protocol.ERROR_CODES.INVALID_PAYLOAD, 'Server error.');
    }
    await this.scheduleAlarm();
  }

  async handleDisconnect(ws) {
    const conn = this.conn(ws);
    this.closing.add(conn.id);
    this.rates.delete(conn.id);
    try {
      await lobbySession.handleClose(this.store, this.hooks(), conn);
    } finally {
      this.closing.delete(conn.id);
    }
    await this.scheduleAlarm();
  }

  async webSocketClose(ws, code) {
    await this.handleDisconnect(ws);
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'closed');
    } catch {
      // the runtime may already have completed the close handshake
    }
  }

  async webSocketError(ws) {
    await this.handleDisconnect(ws);
  }

  async alarm() {
    try {
      await lobbySession.tryMatch(this.store, this.hooks());
      await this.pruneReportsIfDue();
    } catch (error) {
      console.error('lobby alarm failed', error);
    }
    await this.scheduleAlarm();
  }

  // Once a day: drop report markers older than a week.
  async pruneReportsIfDue() {
    const last = (await this.ctx.storage.get('lastPrune')) || 0;
    const now = Date.now();
    if (now - last < PRUNE_INTERVAL_MS) return;
    let cursor;
    for (let page = 0; page < 5; page += 1) {
      const batch = await this.ctx.storage.list({ prefix: 'report:', limit: 1000, startAfter: cursor });
      for (const [key, value] of batch) {
        if (value && now - (value.at || 0) > REPORT_TTL_MS) await this.store.remove(key);
      }
      if (batch.size < 1000) break;
      cursor = [...batch.keys()].at(-1);
    }
    await this.ctx.storage.put('lastPrune', now);
  }
}
