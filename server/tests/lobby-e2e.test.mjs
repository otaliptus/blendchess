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

test('ranked lobby: queue, match, tickets, a rated game and a leaderboard', async () => {
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

  // No ticket, no seat; no spectators either.
  const intruder = await connect(`room=${roomCode}`);
  intruder.send('join_room', roomCode, { nickname: 'Intruder' });
  assert.equal((await intruder.next((message) => message.type === 'error')).payload.errorCode, 'TICKET_INVALID');
  const watcher = await connect(`room=${roomCode}`);
  watcher.send('join_room', roomCode, { spectator: true });
  assert.equal((await watcher.next((message) => message.type === 'error')).payload.errorCode, 'SPECTATOR_DISABLED');

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

  white.send('resign', roomCode);
  const over = await black.next((message) => isView(message) && message.payload.game.gameOver && message.payload.game.ratings);
  assert.equal(over.payload.game.winner, 'Black');
  assert.equal(over.payload.game.result, 'resign');
  assert.equal(over.payload.game.ratings.w.delta, -20);
  assert.equal(over.payload.game.ratings.b.delta, 20);

  const boardResponse = await fetch(`${HTTP_URL}/leaderboard?limit=10`);
  assert.equal(boardResponse.status, 200);
  const board = await boardResponse.json();
  const names = board.players.map((player) => player.name);
  assert.ok(names.includes(aliceReady.payload.player.name), `leaderboard lists Alice, got ${names}`);
  assert.ok(names.includes(bobReady.payload.player.name));
  assert.ok(board.total >= 2);
  // White resigned, so whoever sat as Black won the rating points.
  const whiteReady = whiteMatch === aliceMatch ? aliceReady : bobReady;
  const blackReady = whiteMatch === aliceMatch ? bobReady : aliceReady;
  const winnerEntry = board.players.find((player) => player.name === blackReady.payload.player.name);
  const loserEntry = board.players.find((player) => player.name === whiteReady.payload.player.name);
  assert.equal(winnerEntry.rating, 1220);
  assert.equal(winnerEntry.games, 1);
  assert.equal(winnerEntry.wins, 1);
  assert.equal(loserEntry.rating, 1180);
  assert.equal(loserEntry.losses, 1);

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
