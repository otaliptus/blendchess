import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { protocol } from '../shared.js';

const require = createRequire(import.meta.url);
const WebSocket = require('ws');
const serverDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const PORT = 40000 + Math.floor(Math.random() * 1000);
const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });

const EXTERNAL_URL = process.env.E2E_URL || '';
const BASE_URL = EXTERNAL_URL || `ws://127.0.0.1:${PORT}`;
const HTTP_URL = BASE_URL.replace(/^ws/, 'http').replace(/\/$/, '');
let serverProcess;

test.before(async () => {
  if (EXTERNAL_URL) return;
  serverProcess = spawn(process.execPath, ['server.js'], { cwd: serverDir, env: { ...process.env, PORT: String(PORT) }, stdio: ['ignore', 'pipe', 'inherit'] });
  await new Promise((resolve, reject) => {
    serverProcess.stdout.on('data', (chunk) => { if (String(chunk).includes('listening')) resolve(); });
    serverProcess.on('exit', (code) => reject(new Error(`server exited with ${code}`)));
  });
});

test.after(() => serverProcess?.kill());

async function connect(query = '') {
  const ws = new WebSocket(`${BASE_URL}/?${query}`);
  const inbox = [];
  ws.on('message', (data) => inbox.push(JSON.parse(data)));
  ws.on('error', () => {});
  await new Promise((resolve) => ws.on('open', resolve));
  return {
    ws,
    inbox,
    send(type, roomCode, payload = {}, playerId = '') {
      ws.send(JSON.stringify(protocol.createMessage(type, roomCode, playerId, payload)));
    },
    async next(predicate, timeout = 4000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(0, index + 1).at(-1);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error(`timed out waiting for message; got ${JSON.stringify(inbox.at(-1))}`);
    },
    close: () => ws.close(),
  };
}

const isView = (message) => message.type === 'game_state' && message.payload.game;
const SITE = 'http://localhost:5173';
// Public reads may be served from the Worker's edge cache for a few seconds: poll until fresh.
async function eventually(check, timeout = 12_000) {
  const started = Date.now();
  for (;;) {
    if (await check()) return true;
    if (Date.now() - started > timeout) return false;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
const api = (path, { token, origin = SITE, method = 'GET', body } = {}) => fetch(`${HTTP_URL}${path}`, {
  method,
  headers: {
    ...(origin ? { Origin: origin } : {}),
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
    ...(body ? { 'Content-Type': 'application/json' } : {}),
  },
  body: body ? JSON.stringify(body) : undefined,
});

test('ranked lobby: queue, match, tickets, watching, a rated game, profiles and replays', async () => {
  const alice = await connect('lobby=1');
  const bob = await connect('lobby=1');
  alice.send('lobby_hello', '', { nickname: 'AliceRank' });
  const aliceReady = await alice.next((message) => message.type === 'lobby_ready');
  bob.send('lobby_hello', '', { nickname: 'BobRank' });
  const bobReady = await bob.next((message) => message.type === 'lobby_ready');
  assert.equal(aliceReady.payload.player.rating, 1200);
  assert.ok(aliceReady.payload.token, 'a new identity gets a token');

  alice.send('lobby_queue', '', { control: '5+3' });
  const queued = await alice.next((message) => message.type === 'lobby_queued');
  assert.equal(queued.payload.waiting, 1);
  bob.send('lobby_queue', '', { control: '5+3' });

  const aliceMatch = await alice.next((message) => message.type === 'match_found');
  const bobMatch = await bob.next((message) => message.type === 'match_found');
  const roomCode = aliceMatch.payload.roomCode;
  assert.equal(bobMatch.payload.roomCode, roomCode);
  assert.equal(aliceMatch.payload.rated, true);
  assert.equal(bobMatch.payload.rated, true);
  assert.notEqual(aliceMatch.payload.color, bobMatch.payload.color);
  assert.ok(aliceMatch.payload.ticket.length >= 20);
  assert.equal(aliceMatch.payload.control, '5+3');

  const seat = {
    [aliceMatch.payload.color]: { lobby: alice, match: aliceMatch },
    [bobMatch.payload.color]: { lobby: bob, match: bobMatch },
  };
  const whiteMatch = seat.w.match;
  const blackMatch = seat.b.match;

  // The lobby blocks a second ranked queue while this game is unfinished.
  alice.send('lobby_queue', '', { control: '5+3' });
  const blocked = await alice.next((message) => message.type === 'lobby_error');
  assert.equal(blocked.payload.errorCode, 'ALREADY_IN_GAME');

  // The game is on the live list for anyone to find.
  const live = await (await api('/api/live', { origin: '' })).json();
  const listed = live.games.find((game) => game.roomCode === roomCode);
  assert.ok(listed, 'the new game is live');
  assert.equal(listed.rated, true);
  assert.equal(listed.control, '5+3');

  // No ticket, no seat; but anyone may watch.
  const intruder = await connect(`room=${roomCode}`);
  intruder.send('join_room', roomCode, { nickname: 'Intruder' });
  assert.equal((await intruder.next((message) => message.type === 'error')).payload.errorCode, 'TICKET_INVALID');
  const watcher = await connect(`room=${roomCode}`);
  watcher.send('join_room', roomCode, { spectator: true, nickname: 'Fan' });
  assert.equal((await watcher.next((message) => message.type === 'room_joined')).payload.role, 'spectator');

  const white = await connect(`room=${roomCode}`);
  white.send('join_room', roomCode, { ticket: whiteMatch.payload.ticket });
  const whiteJoined = await white.next((message) => message.type === 'room_joined');
  assert.equal(whiteJoined.payload.color, 'w');
  const whiteView = await white.next(isView);
  assert.equal(whiteView.payload.game.rated, true);
  assert.ok(whiteView.payload.game.clock, 'a ranked game carries a clock');

  const black = await connect(`room=${roomCode}`);
  black.send('join_room', roomCode, { ticket: blackMatch.payload.ticket });
  const blackJoined = await black.next((message) => message.type === 'room_joined');
  assert.equal(blackJoined.payload.color, 'b');
  const readyView = await white.next((message) => isView(message) && !message.payload.game.waitingForStart);
  assert.equal(readyView.payload.game.players.find((player) => player.color === 'b').rating, bobReady.payload.player.rating);
  assert.equal(readyView.payload.game.clock.running, true);

  white.send('move_intent', roomCode, { from: sq('e2'), to: sq('e4') });
  await black.next((message) => isView(message) && message.payload.game.turn === 'b');
  black.send('move_intent', roomCode, { from: sq('e7'), to: sq('e5') });
  await white.next((message) => isView(message) && message.payload.game.turn === 'w' && message.payload.game.moves.length === 2);

  // The watcher (on a different network from both players) sees the whole board live.
  const watched = await watcher.next((message) => isView(message) && message.payload.game.moves.length === 2);
  assert.equal(watched.payload.game.revealed, true);
  assert.deepEqual(watched.payload.game.moves.map((move) => move.san), ['e4', 'e5']);

  white.send('resign', roomCode);
  const over = await black.next((message) => isView(message) && message.payload.game.gameOver && message.payload.game.ratings);
  assert.equal(over.payload.game.winner, 'Black');
  assert.equal(over.payload.game.result, 'resign');
  assert.equal(over.payload.game.ratings.w.delta, -20);
  assert.equal(over.payload.game.ratings.b.delta, 20);

  // The old path still answers; guests are rated and counted but only secured accounts are listed.
  const boardResponse = await fetch(`${HTTP_URL}/leaderboard?limit=10`);
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  assert.ok(board.total >= 2);
  assert.ok(!board.players.some((player) => player.name === aliceReady.payload.player.name), 'guests are not listed');

  // White resigned, so whoever sat as Black won the rating points. Both profiles show the game.
  const whiteReady = whiteMatch === aliceMatch ? aliceReady : bobReady;
  const blackReady = whiteMatch === aliceMatch ? bobReady : aliceReady;
  const winner = await (await api(`/api/players/${encodeURIComponent(blackReady.payload.player.name)}`, { origin: '' })).json();
  const loser = await (await api(`/api/players/${encodeURIComponent(whiteReady.payload.player.name)}`, { origin: '' })).json();
  assert.equal(winner.player.rating, 1220);
  assert.equal(winner.player.wins, 1);
  assert.equal(winner.player.peak, 1220);
  assert.equal(loser.player.rating, 1180);
  assert.equal(loser.player.losses, 1);
  assert.equal(winner.games[0].outcome, 'win');
  assert.equal(loser.games[0].outcome, 'loss');
  assert.equal(loser.games[0].delta, -20);
  assert.equal(winner.live, null, 'a finished game is no longer live');

  // Everyone in the room learns the record id, and the record replays the game.
  assert.equal(over.payload.game.recordId, winner.games[0].id);
  const record = await (await api(`/api/games/${winner.games[0].id}`, { origin: '' })).json();
  assert.equal(record.game.result, 'resign');
  assert.equal(record.game.winner, 'b');
  assert.deepEqual(record.game.plies.map((ply) => ply[2]), ['e4', 'e5']);
  const gone = await eventually(async () => !(await (await api('/api/live', { origin: '' })).json()).games.some((game) => game.roomCode === roomCode));
  assert.ok(gone, 'a finished game leaves the live list');

  // The rating also reaches the lobby socket, so the lobby UI updates without a reload.
  const ratingMessage = await alice.next((message) => message.type === 'lobby_rating');
  assert.equal(ratingMessage.payload.player.rating, aliceMatch.payload.color === 'b' ? 1220 : 1180);

  // With the game reported, Alice can queue for the next one.
  alice.send('lobby_queue', '', { control: '5+3' });
  const requeued = await alice.next((message) => message.type === 'lobby_queued');
  assert.equal(requeued.payload.waiting, 1);
  alice.send('lobby_cancel', '', {});
  await alice.next((message) => message.type === 'lobby_cancelled');

  for (const client of [alice, bob, white, black, intruder, watcher]) client.close();
});

test('lobby rejects unauthenticated queueing and oversized frames', async () => {
  const client = await connect('lobby=1');
  client.send('lobby_queue', '', { control: '10+0' });
  const unauth = await client.next((message) => message.type === 'lobby_error');
  assert.equal(unauth.payload.errorCode, 'NOT_AUTHENTICATED');

  // Over the transport limit: one backend answers with an error, the other drops the socket.
  const closed = new Promise((resolve) => client.ws.on('close', () => resolve({ kind: 'close' })));
  client.ws.send(JSON.stringify({ type: 'lobby_hello', payload: { nickname: 'x'.repeat(20_000) }, version: protocol.PROTOCOL_VERSION }));
  const outcome = await Promise.race([
    client.next((message) => message.type === 'error', 3000).then((message) => ({ kind: 'error', code: message.payload.errorCode })),
    closed,
    new Promise((resolve) => setTimeout(() => resolve({ kind: 'timeout' }), 3000)),
  ]);
  assert.notEqual(outcome.kind, 'timeout');
  if (outcome.kind === 'error') assert.equal(outcome.code, 'INVALID_PAYLOAD');
  client.close();
});

// Only meaningful against the Worker: the Node server has no internal routes at all.
test('internal Durable Object paths are not reachable from the internet', { skip: !EXTERNAL_URL }, async () => {
  for (const path of ['/report', '/active', '/release', '/reserve', '/revoke', '/limit/create']) {
    const response = await fetch(`${HTTP_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"roomCode":"ZZZZZZ","gameKey":"ZZZZZZ:1","players":[]}',
    });
    assert.notEqual(response.status, 200, `${path} must not answer like an internal endpoint`);
  }
});

test('accounts: an account key signs in a second device; signing out others ends the first', async () => {
  const first = await connect('lobby=1');
  first.send('lobby_hello', '', { nickname: 'KeyKeeper' });
  const ready = await first.next((message) => message.type === 'lobby_ready');
  const firstToken = ready.payload.token;
  assert.equal(ready.payload.player.secured, false);

  // Account routes only answer the site itself.
  assert.equal((await api('/api/me', { token: firstToken, origin: '' })).status, 403);
  assert.equal((await api('/api/me', { token: firstToken, origin: 'https://evil.example' })).status, 403);
  const preflight = await fetch(`${HTTP_URL}/api/auth/key/create`, {
    method: 'OPTIONS',
    headers: { Origin: SITE, 'Access-Control-Request-Method': 'POST', 'Access-Control-Request-Headers': 'authorization,content-type' },
  });
  assert.equal(preflight.status, 204);
  assert.equal(preflight.headers.get('access-control-allow-origin'), SITE);

  const created = await api('/api/auth/key/create', { token: firstToken, method: 'POST', body: {} });
  assert.equal(created.status, 200);
  const { key, player } = await created.json();
  assert.equal(player.secured, true);

  // The key works however it is typed.
  const loose = key.toLowerCase().replace(/-/g, ' ');
  const signedIn = await api('/api/auth/key/login', { method: 'POST', body: { key: loose } });
  assert.equal(signedIn.status, 200);
  const second = await signedIn.json();
  assert.equal(second.player.id, ready.payload.player.id);
  assert.notEqual(second.token, firstToken);

  const me = await (await api('/api/me', { token: second.token })).json();
  assert.equal(me.security.hasKey, true);
  assert.equal(me.security.sessions, 2);

  const wrong = await api('/api/auth/key/login', { method: 'POST', body: { key: 'BLND-0000-0000-0000-0000-0000-0000' } });
  assert.equal(wrong.status, 401);

  // Passkey sign-in starts with a challenge for this site's domain.
  const options = await (await api('/api/auth/passkey/login/options', { method: 'POST', body: {} })).json();
  assert.ok(options.challengeId);
  assert.equal(options.options.rpId, 'localhost');

  // Signing out the other devices revokes the first token and closes its lobby socket.
  const closed = new Promise((resolve) => first.ws.on('close', (code) => resolve(code)));
  const after = await (await api('/api/auth/logout-others', { token: second.token, method: 'POST', body: {} })).json();
  assert.equal(after.security.sessions, 1);
  assert.equal(await closed, 4001);
  assert.equal((await api('/api/me', { token: firstToken })).status, 401);

  // The second device's lobby hello lands on the same player without minting a new one.
  const again = await connect('lobby=1');
  again.send('lobby_hello', '', { token: second.token });
  const back = await again.next((message) => message.type === 'lobby_ready');
  assert.equal(back.payload.player.id, ready.payload.player.id);
  assert.equal(back.payload.token, undefined);

  assert.equal((await api('/api/auth/logout', { token: second.token, method: 'POST', body: {} })).status, 200);
  assert.equal((await api('/api/me', { token: second.token })).status, 401);
  again.close();
});

test('signing other devices out ends the old device’s game: socket closed, ticket refused', async () => {
  const ann = await connect('lobby=1');
  const bea = await connect('lobby=1');
  ann.send('lobby_hello', '', { nickname: 'RevokeAnn' });
  const annReady = await ann.next((message) => message.type === 'lobby_ready');
  bea.send('lobby_hello', '', { nickname: 'RevokeBea' });
  await bea.next((message) => message.type === 'lobby_ready');
  ann.send('lobby_queue', '', { control: '10+0' });
  await ann.next((message) => message.type === 'lobby_queued');
  bea.send('lobby_queue', '', { control: '10+0' });
  const annMatch = (await ann.next((message) => message.type === 'match_found')).payload;
  const beaMatch = (await bea.next((message) => message.type === 'match_found')).payload;
  const roomCode = annMatch.roomCode;

  const annGame = await connect(`room=${roomCode}&seat=1`);
  annGame.send('join_room', roomCode, { ticket: annMatch.ticket });
  await annGame.next((message) => message.type === 'room_joined');
  const beaGame = await connect(`room=${roomCode}&seat=1`);
  beaGame.send('join_room', roomCode, { ticket: beaMatch.ticket });
  await beaGame.next((message) => message.type === 'room_joined');

  // Ann's account gets a key; a second device signs in with it and signs every other device out.
  const { key } = await (await api('/api/auth/key/create', { token: annReady.payload.token, method: 'POST', body: {} })).json();
  const second = await (await api('/api/auth/key/login', { method: 'POST', body: { key } })).json();
  const closed = new Promise((resolve) => annGame.ws.on('close', (code) => resolve(code)));
  assert.equal((await api('/api/auth/logout-others', { token: second.token, method: 'POST', body: {} })).status, 200);
  assert.equal(await closed, 4001, 'the old device is thrown out of the game');

  // Neither the ticket nor a fresh connection gets the seat back.
  const retry = await connect(`room=${roomCode}&seat=1`);
  retry.send('join_room', roomCode, { ticket: annMatch.ticket });
  assert.equal((await retry.next((message) => message.type === 'error')).payload.errorCode, 'TICKET_INVALID');

  // Bea is unaffected and sees Ann as disconnected.
  const view = await beaGame.next((message) => isView(message) && message.payload.game.players.some((seat) => !seat.connected));
  assert.ok(view);
  for (const client of [ann, bea, beaGame, retry]) client.close();
});

test('playing a friend: an invite with options starts the game for whoever opens it', async () => {
  const ann = await connect('lobby=1');
  const bob = await connect('lobby=1');
  ann.send('lobby_hello', '', { nickname: 'InviteAnn' });
  await ann.next((message) => message.type === 'lobby_ready');
  bob.send('lobby_hello', '', { nickname: 'InviteBob' });
  await bob.next((message) => message.type === 'lobby_ready');

  ann.send('lobby_invite', '', { control: 'untimed', hardMode: true, party: false });
  const invited = (await ann.next((message) => message.type === 'lobby_invited')).payload;
  assert.equal(invited.rated, false);
  bob.send('lobby_accept', '', { code: invited.code });
  const annMatch = (await ann.next((message) => message.type === 'match_found')).payload;
  const bobMatch = (await bob.next((message) => message.type === 'match_found')).payload;
  assert.equal(annMatch.roomCode, bobMatch.roomCode);
  assert.equal(annMatch.clock, null);

  const roomCode = annMatch.roomCode;
  const annGame = await connect(`room=${roomCode}&seat=1`);
  annGame.send('join_room', roomCode, { ticket: annMatch.ticket });
  await annGame.next((message) => message.type === 'room_joined');
  const bobGame = await connect(`room=${roomCode}&seat=1`);
  bobGame.send('join_room', roomCode, { ticket: bobMatch.ticket });
  await bobGame.next((message) => message.type === 'room_joined');
  const view = (await bobGame.next((message) => isView(message) && !message.payload.game.waitingForStart)).payload.game;
  assert.equal(view.hardMode, true);
  assert.equal(view.rated, false);
  assert.equal(view.clock, null);

  // Party mode is off: a watcher stays in the fog.
  const watcher = await connect(`room=${roomCode}`);
  watcher.send('join_room', roomCode, { spectator: true });
  const watched = (await watcher.next(isView)).payload.game;
  assert.equal(watched.revealed, false);

  // A used invite is gone.
  bob.send('lobby_accept', '', { code: invited.code });
  assert.equal((await bob.next((message) => message.type === 'lobby_error')).payload.errorCode, 'INVITE_NOT_FOUND');
  for (const client of [ann, bob, annGame, bobGame, watcher]) client.close();
});
