import test from 'node:test';
import assert from 'node:assert/strict';
import { lobbyLogic, lobbySession, accountApi, protocol } from '../shared.js';

const { TYPES } = protocol;
const SITE = 'https://blendchess.com';

// A stand-in for @simplewebauthn/server: a "signature" is valid when the response echoes the
// challenge and origin it was issued for. The real library is exercised end to end in a browser.
function fakeWebauthn() {
  let seq = 0;
  return {
    async generateRegistrationOptions(options) {
      seq += 1;
      return { challenge: `reg-${seq}`, rp: { id: options.rpID, name: options.rpName }, user: { name: options.userName }, excludeCredentials: options.excludeCredentials };
    },
    async verifyRegistrationResponse({ response, expectedChallenge, expectedOrigin, expectedRPID }) {
      const ok = response && response.challenge === expectedChallenge && response.origin === expectedOrigin && response.rpID === expectedRPID;
      if (!ok) throw new Error('bad registration');
      return {
        verified: true,
        registrationInfo: {
          credential: { id: response.id, publicKey: new Uint8Array([1, 2, 3, 4]), counter: 0, transports: ['internal'] },
          credentialBackedUp: true,
        },
      };
    },
    async generateAuthenticationOptions(options) {
      seq += 1;
      return { challenge: `auth-${seq}`, rpId: options.rpID, allowCredentials: [] };
    },
    async verifyAuthenticationResponse({ response, expectedChallenge, expectedOrigin, credential }) {
      const ok = response.challenge === expectedChallenge && response.origin === expectedOrigin
        && credential.publicKey.join() === '1,2,3,4';
      return { verified: ok, authenticationInfo: { newCounter: credential.counter + 1 } };
    },
  };
}

function makeLobby() {
  accountApi.resetLimits();
  const store = lobbyLogic.createMemoryStore();
  const conns = [];
  let roomSeq = 0;
  const hooks = {
    connections: () => conns.filter((conn) => !conn.closed),
    send: (conn, message) => conn.inbox.push(message),
    close: (conn, code) => {
      conn.closed = code;
    },
    save: () => {},
    createRatedRoom: async () => {
      roomSeq += 1;
      return { roomCode: `ROOM${String(roomSeq).padStart(2, '0')}`, tickets: { w: 'w'.repeat(24), b: 'b'.repeat(24) } };
    },
  };
  const ctx = { origins: accountApi.parseOrigins(''), webauthn: fakeWebauthn(), hooks };
  const call = (method, path, { token = '', origin = SITE, body = null, ipHash = 'net-1' } = {}) => accountApi.handle(store, ctx, {
    method,
    path,
    query: {},
    origin,
    authorization: token ? `Bearer ${token}` : '',
    ipHash,
    body,
  });
  const guest = async (nickname, ipHash = `net-${nickname}`) => {
    const conn = { id: `conn-${nickname}`, playerId: '', ipHash, inbox: [] };
    conns.push(conn);
    await lobbySession.hello(store, hooks, conn, { nickname });
    const ready = conn.inbox.find((message) => message.type === TYPES.LOBBY_READY);
    return { conn, token: ready.payload.token, player: ready.payload.player };
  };
  return { store, hooks, conns, call, guest };
}

async function registerPasskey(h, token, id = 'cred-1') {
  const options = await h.call('POST', '/api/auth/passkey/register/options', { token });
  assert.equal(options.status, 200);
  const { challengeId } = options.body;
  return h.call('POST', '/api/auth/passkey/register/verify', {
    token,
    body: {
      challengeId,
      label: 'Phone',
      response: { id, challenge: options.body.options.challenge, origin: SITE, rpID: 'blendchess.com' },
    },
  });
}

async function passkeyLogin(h, id = 'cred-1', overrides = {}) {
  const options = await h.call('POST', '/api/auth/passkey/login/options');
  return h.call('POST', '/api/auth/passkey/login/verify', {
    body: {
      challengeId: options.body.challengeId,
      response: { id, challenge: options.body.options.challenge, origin: SITE, ...overrides },
    },
  });
}

// --- Account keys ---------------------------------------------------------------

test('account keys are 120-bit, grouped, and forgiving about how they are typed', () => {
  const key = lobbyLogic.makeAccountKey();
  assert.match(key, /^BLND(-[0-9A-HJKMNP-TV-Z]{4}){6}$/);
  const body = key.slice(5).replace(/-/g, '');
  assert.equal(lobbyLogic.normalizeAccountKey(key), body);
  assert.equal(lobbyLogic.normalizeAccountKey(` ${key.toLowerCase()} `), body);
  assert.equal(lobbyLogic.normalizeAccountKey(body.replace(/0/g, 'O').replace(/1/g, 'I')), body);
  assert.equal(lobbyLogic.normalizeAccountKey('BLND-1234'), '');
  assert.equal(lobbyLogic.normalizeAccountKey(''), '');
  assert.notEqual(lobbyLogic.makeAccountKey(), key);
});

// --- Passkeys ---------------------------------------------------------------------

test('a passkey secures a guest account and signs in a new device as the same player', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const registered = await registerPasskey(h, ann.token);
  assert.equal(registered.status, 200);
  assert.equal(registered.body.player.secured, true);
  assert.equal(registered.body.security.passkeys.length, 1);
  assert.equal(registered.body.security.passkeys[0].label, 'Phone');
  const stored = h.store.getCredential('cred-1');
  assert.equal(stored.rpID, 'blendchess.com');
  assert.equal(stored.publicKey, 'AQIDBA');

  const login = await passkeyLogin(h);
  assert.equal(login.status, 200);
  assert.equal(login.body.player.id, ann.player.id);
  assert.notEqual(login.body.token, ann.token);
  assert.equal(h.store.getCredential('cred-1').counter, 1);
  const me = await h.call('GET', '/api/me', { token: login.body.token });
  assert.equal(me.body.security.sessions, 2);
});

test('passkey challenges are single-use, origin-bound and refuse strangers', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  await registerPasskey(h, ann.token);

  // Replaying the same challenge fails the second time.
  const options = await h.call('POST', '/api/auth/passkey/login/options');
  const body = { challengeId: options.body.challengeId, response: { id: 'cred-1', challenge: options.body.options.challenge, origin: SITE } };
  assert.equal((await h.call('POST', '/api/auth/passkey/login/verify', { body })).status, 200);
  assert.equal((await h.call('POST', '/api/auth/passkey/login/verify', { body })).body.error, 'CHALLENGE');

  // A challenge issued to one site cannot be redeemed from another allowed site.
  const crossSite = await h.call('POST', '/api/auth/passkey/login/options', { origin: 'https://www.blendchess.com' });
  const redeemed = await h.call('POST', '/api/auth/passkey/login/verify', {
    origin: SITE,
    body: { challengeId: crossSite.body.challengeId, response: { id: 'cred-1', challenge: crossSite.body.options.challenge, origin: SITE } },
  });
  assert.equal(redeemed.body.error, 'CHALLENGE');

  // www shares passkeys with the bare domain.
  assert.equal(crossSite.body.options.rpId, 'blendchess.com');

  assert.equal((await passkeyLogin(h, 'cred-unknown')).body.error, 'PASSKEY_UNKNOWN');
  assert.equal((await passkeyLogin(h, 'cred-1', { origin: 'https://evil.example' })).status, 401);
});

test('a registration challenge belongs to the account that asked for it', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const bob = await h.guest('Bob');
  const options = await h.call('POST', '/api/auth/passkey/register/options', { token: ann.token });
  const stolen = await h.call('POST', '/api/auth/passkey/register/verify', {
    token: bob.token,
    body: { challengeId: options.body.challengeId, response: { id: 'cred-x', challenge: options.body.options.challenge, origin: SITE, rpID: 'blendchess.com' } },
  });
  assert.equal(stolen.body.error, 'CHALLENGE');
  assert.equal(h.store.getCredential('cred-x'), null);
});

test('removing the last sign-in method takes a player off the leaderboard', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const record = h.store.getPlayer(ann.player.id);
  record.games = 3;
  await registerPasskey(h, ann.token);
  assert.equal(h.store.leaderboard(10).entries[0].name, 'Ann');

  const removed = await h.call('POST', '/api/auth/passkey/remove', { token: ann.token, body: { id: 'cred-1' } });
  assert.equal(removed.body.player.secured, false);
  assert.equal(h.store.getCredential('cred-1'), null);
  assert.equal(h.store.leaderboard(10).entries.length, 0);
  assert.equal((await h.call('POST', '/api/auth/passkey/remove', { token: ann.token, body: { id: 'cred-1' } })).status, 404);
});

// --- Sessions, origins and limits -------------------------------------------------------

test('a new account key retires the old one', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const first = (await h.call('POST', '/api/auth/key/create', { token: ann.token })).body.key;
  const second = (await h.call('POST', '/api/auth/key/create', { token: ann.token })).body.key;
  assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: first } })).status, 401);
  assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: second } })).status, 200);
  const removed = await h.call('POST', '/api/auth/key/remove', { token: ann.token });
  assert.equal(removed.body.security.hasKey, false);
  assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: second } })).status, 401);
});

test('signing out ends one session and closes its lobby sockets', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const out = await h.call('POST', '/api/auth/logout', { token: ann.token });
  assert.equal(out.status, 200);
  assert.equal(ann.conn.closed, 4001);
  assert.equal((await h.call('GET', '/api/me', { token: ann.token })).status, 401);
  assert.deepEqual(h.store.getPlayer(ann.player.id).sessions, []);
});

test('account routes demand the site origin; public reads do not', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  assert.equal((await h.call('GET', '/api/me', { token: ann.token, origin: '' })).status, 403);
  assert.equal((await h.call('GET', '/api/me', { token: ann.token, origin: 'https://blendchess.com.evil.example' })).status, 403);
  assert.equal((await h.call('GET', '/api/me', { token: ann.token, origin: 'http://localhost:8080' })).status, 200);
  assert.equal((await h.call('GET', '/api/me', { origin: SITE })).status, 401);

  const profile = await h.call('GET', '/api/players/ann', { origin: '' });
  assert.equal(profile.status, 200);
  assert.equal(profile.public, true);
  assert.equal(profile.body.player.name, 'Ann');
  assert.equal(profile.body.player.secured, false);
  assert.equal(profile.body.player.sessions, undefined, 'no private fields in public profiles');
  assert.equal(profile.body.player.keyHash, undefined);
  assert.equal((await h.call('GET', '/api/players/nobody', { origin: '' })).status, 404);
  assert.equal((await h.call('GET', '/api/games/not-an-id!', { origin: '' })).status, 404);

  const headers = accountApi.responseHeaders({ origin: SITE }, { status: 200, public: false }, accountApi.parseOrigins(''));
  assert.equal(headers['Access-Control-Allow-Origin'], SITE);
  assert.equal(headers['Cache-Control'], 'no-store');
  const foreign = accountApi.responseHeaders({ origin: 'https://evil.example' }, { status: 200, public: false }, accountApi.parseOrigins(''));
  assert.equal(foreign['Access-Control-Allow-Origin'], undefined);
});

test('failed sign-ins are rate limited per network', async () => {
  const h = makeLobby();
  for (let i = 0; i < 10; i += 1) {
    assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: 'BLND-0000-0000-0000-0000-0000-0000' }, ipHash: 'net-bad' })).status, 401);
  }
  assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: 'nope' }, ipHash: 'net-bad' })).status, 429);
  assert.equal((await h.call('POST', '/api/auth/key/login', { body: { key: 'nope' }, ipHash: 'net-good' })).status, 401);
});

test('pre-account identities keep working and join the session list', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  const record = h.store.getPlayer(ann.player.id);
  record.sessions = [];
  const conn = { id: 'conn-again', playerId: '', ipHash: 'net-1', inbox: [] };
  h.conns.push(conn);
  await lobbySession.hello(h.store, h.hooks, conn, { token: ann.token });
  assert.equal(conn.inbox[0].payload.player.id, ann.player.id);
  assert.equal(h.store.getPlayer(ann.player.id).sessions.length, 1);
});

test('renaming updates the name on the leaderboard', async () => {
  const h = makeLobby();
  const ann = await h.guest('Ann');
  h.store.getPlayer(ann.player.id).games = 1;
  await h.call('POST', '/api/auth/key/create', { token: ann.token });
  await lobbySession.hello(h.store, h.hooks, ann.conn, { token: ann.token, nickname: 'Annabel' });
  assert.equal(h.store.leaderboard(10).entries[0].name, 'Annabel');
  assert.equal((await h.call('GET', '/api/players/annabel', { origin: '' })).body.player.name, 'Annabel');
});

// --- Live games and history ------------------------------------------------------------

async function matchPair(h, { sameNetwork = false } = {}) {
  const a = await h.guest('Ann', 'net-a');
  const b = await h.guest('Bob', sameNetwork ? 'net-a' : 'net-b');
  await lobbySession.queue(h.store, h.hooks, a.conn, { control: '10+0' });
  await lobbySession.queue(h.store, h.hooks, b.conn, { control: '10+0' });
  const match = a.conn.inbox.find((message) => message.type === TYPES.MATCH_FOUND).payload;
  const colorOfA = match.color;
  const players = [
    { playerId: a.player.id, color: colorOfA },
    { playerId: b.player.id, color: colorOfA === 'w' ? 'b' : 'w' },
  ];
  return { a, b, match, players };
}

test('matched games are live and show on the leaderboard and profile until reported', async () => {
  const h = makeLobby();
  const { a, match, players } = await matchPair(h);
  h.store.getPlayer(a.player.id).games = 1;
  await h.call('POST', '/api/auth/key/create', { token: a.token });

  const live = await h.call('GET', '/api/live', { origin: '' });
  assert.equal(live.body.games.length, 1);
  assert.equal(live.body.games[0].roomCode, match.roomCode);
  assert.equal(live.body.games[0].control, '10+0');
  assert.equal((await h.call('GET', '/api/leaderboard', { origin: '' })).body.players[0].live, match.roomCode);
  const profile = await h.call('GET', '/api/players/ann', { origin: '' });
  assert.equal(profile.body.live.roomCode, match.roomCode);
  assert.equal(profile.body.live.color, match.color);

  const report = await lobbySession.report(h.store, h.hooks, {
    roomCode: match.roomCode,
    gameKey: `${match.roomCode}:1`,
    rated: true,
    control: '10+0',
    players,
    winner: match.color,
    result: 'checkmate',
    record: { startedAt: 1000, plies: [['e2', 'e4', 'e4', '', '', 0], ['zz', '<b>', 'x'.repeat(40), 'k', 'e4', 7], ['a7', 'a8', 'a8=Q', 'Q', '', 0]] },
  });
  assert.equal(report.ok, true);
  assert.deepEqual((await h.call('GET', '/api/live', { origin: '' })).body.games, []);

  const game = (await h.call('GET', `/api/games/${report.gameId}`, { origin: '' })).body.game;
  assert.equal(game.control, '10+0');
  assert.equal(game.result, 'checkmate');
  assert.equal(game.startedAt, 1000);
  // Plies are sanitised: bad squares and promotions dropped, SAN truncated, flags boolean.
  assert.deepEqual(game.plies[1], ['', '', 'x'.repeat(12), '', 'e4', 1]);
  assert.deepEqual(game.plies[2], ['a7', 'a8', 'a8=Q', 'Q', '', 0], 'promotions keep the engine\'s upper case');
  const after = (await h.call('GET', '/api/players/ann', { origin: '' })).body;
  assert.equal(after.live, null);
  assert.equal(after.games[0].outcome, 'win');
  assert.equal(after.games[0].opponent.name, 'Bob');
  assert.equal(after.games[0].moves, 2);
});

test('practice games are recorded without touching ratings; unknown rooms are refused for good', async () => {
  const h = makeLobby();
  const { a, b, match, players } = await matchPair(h, { sameNetwork: true });
  assert.equal(match.rated, false);
  assert.equal((await h.call('GET', '/api/live', { origin: '' })).body.games[0].rated, false);

  const forged = await lobbySession.report(h.store, h.hooks, {
    roomCode: 'OTHER1', gameKey: 'OTHER1:1', rated: false, players, winner: 'w', result: 'resign',
  });
  assert.equal(forged.ok, false);
  assert.equal(forged.final, true);

  const report = await lobbySession.report(h.store, h.hooks, {
    roomCode: match.roomCode, gameKey: `${match.roomCode}:1`, rated: false, players, winner: 'w', result: 'resign', record: { plies: [] },
  });
  assert.equal(report.ok, true);
  assert.equal(report.updates, null);
  assert.equal(h.store.getPlayer(a.player.id).rating, 1200);
  assert.equal(h.store.getPlayer(b.player.id).games, 0);
  const game = h.store.getGame(report.gameId);
  assert.equal(game.rated, false);
  assert.equal(game.white.before, game.white.after);
  assert.equal(h.store.getPlayer(a.player.id).recent[0], report.gameId);
});

test('a rematch puts the room back on the live list with colours swapped', async () => {
  const h = makeLobby();
  const { match, players } = await matchPair(h);
  await lobbySession.report(h.store, h.hooks, {
    roomCode: match.roomCode, gameKey: `${match.roomCode}:1`, rated: true, players, winner: null, result: 'mutualDraw',
  });
  const swapped = players.map((player) => ({ ...player, color: player.color === 'w' ? 'b' : 'w' }));
  const registered = await lobbySession.registerActive(h.store, {
    roomCode: match.roomCode, gameKey: `${match.roomCode}:2`, rated: true, control: '10+0', players: swapped,
  });
  assert.equal(registered.ok, true);
  const live = (await h.call('GET', '/api/live', { origin: '' })).body.games;
  assert.equal(live.length, 1);
  const annNowWhite = swapped.find((player) => player.color === 'w').playerId === h.store.nameOwner('ann');
  assert.equal(live[0].white.name, annNowWhite ? 'Ann' : 'Bob');
  await lobbySession.release(h.store, { roomCode: match.roomCode, players: swapped.map((player) => player.playerId) });
  assert.deepEqual((await h.call('GET', '/api/live', { origin: '' })).body.games, []);
});
