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
const PORT = 39000 + Math.floor(Math.random() * 1000);
const sq = (name) => ({ r: 8 - Number(name[1]), c: 'abcdefgh'.indexOf(name[0]) });

// Set E2E_URL (e.g. ws://127.0.0.1:8787 from `wrangler dev`) to run the same suite against the Worker.
const EXTERNAL_URL = process.env.E2E_URL || '';
const BASE_URL = EXTERNAL_URL || `ws://127.0.0.1:${PORT}`;
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

// The Worker routes by query string (one Durable Object per room); the Node server ignores it.
async function connect(query = 'create=1') {
  const ws = new WebSocket(`${BASE_URL}/?${query}`);
  const inbox = [];
  const raw = [];
  ws.on('message', (data) => {
    raw.push(String(data));
    inbox.push(JSON.parse(data));
  });
  await new Promise((resolve) => ws.on('open', resolve));
  const client = {
    ws,
    inbox,
    raw,
    send(type, roomCode, payload = {}, playerId = '') {
      ws.send(JSON.stringify(protocol.createMessage(type, roomCode, playerId, payload)));
    },
    async next(predicate, timeout = 2000) {
      const started = Date.now();
      while (Date.now() - started < timeout) {
        const index = inbox.findIndex(predicate);
        if (index >= 0) return inbox.splice(0, index + 1).at(-1);
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      throw new Error('timed out waiting for message');
    },
    close: () => ws.close(),
  };
  return client;
}

const isView = (message) => message.type === 'game_state' && message.payload.game;

test('full online game over real sockets keeps hidden information hidden', async () => {
  const white = await connect();
  white.send('create_room', '', { nickname: 'Wendy' });
  const created = await white.next((message) => message.type === 'room_created');
  const code = created.roomCode;
  const black = await connect(`room=${code}`);

  black.send('join_room', code, { nickname: 'Boris' });
  const joined = await black.next((message) => message.type === 'room_joined');
  assert.equal(joined.payload.color, 'b');

  const spectator = await connect(`room=${code}`);
  spectator.send('join_room', code, { spectator: true });
  await spectator.next((message) => message.type === 'room_joined');
  const fogView = await spectator.next(isView);
  assert.equal(fogView.payload.game.board.flat().some(Boolean), false);

  black.raw.length = 0;
  white.send('move_intent', code, { from: sq('f2'), to: sq('f3') });
  const afterMove = await black.next((message) => isView(message) && message.payload.game.turn === 'b');
  assert.equal(afterMove.payload.game.board.flat().some((piece) => piece && piece.color === 'w'), false);
  assert.equal(black.raw.join('').includes('"san":"f3"'), false);

  // Black probes an illegal move; White must not learn the squares.
  white.raw.length = 0;
  black.send('move_intent', code, { from: sq('d8'), to: sq('d6') });
  await black.next((message) => message.type === 'move_rejected');
  await white.next((message) => isView(message) && message.payload.game.events.at(-1).kind === 'illegal');
  assert.equal(white.raw.join('').includes('"fromSquare"'), false);

  const turnIs = (turn) => (message) => isView(message) && message.payload.game.turn === turn;
  black.send('move_intent', code, { from: sq('e7'), to: sq('e5') });
  await white.next(turnIs('w'));
  white.send('move_intent', code, { from: sq('g2'), to: sq('g4') });
  await black.next(turnIs('b'));
  black.send('move_intent', code, { from: sq('d8'), to: sq('h4') });
  const mated = await white.next((message) => isView(message) && message.payload.game.gameOver);
  assert.equal(mated.payload.game.winner, 'Black');
  assert.equal(mated.payload.game.revealed, true);
  assert.equal(mated.payload.game.moves[3].san, 'Qh4#');
  const versionAtEnd = mated.payload.game.boardVersion;

  white.send('new_game', code);
  const rematch = await black.next((message) => isView(message) && message.payload.game.gameId === 2);
  assert.ok(rematch.payload.game.boardVersion > versionAtEnd);
  assert.equal(rematch.payload.game.you.color, 'w', 'colours swap for the rematch');

  white.close();
  black.close();
  spectator.close();
});

test('reconnect with resume token after a dropped connection', async () => {
  const white = await connect();
  white.send('create_room', '', {});
  const code = (await white.next((message) => message.type === 'room_created')).roomCode;
  let black = await connect(`room=${code}`);
  black.send('join_room', code, {});
  const identity = (await black.next((message) => message.type === 'room_joined')).payload;
  white.send('move_intent', code, { from: sq('e2'), to: sq('e4') });
  await black.next((message) => isView(message) && message.payload.game.turn === 'b');

  black.close();
  await white.next((message) => isView(message) && message.payload.game.players.some((seat) => seat.color === 'b' && !seat.connected));

  const stranger = await connect(`room=${code}`);
  stranger.send('join_room', code, {});
  const refused = await stranger.next((message) => message.type === 'error');
  assert.equal(refused.payload.errorCode, 'PLAYER_NOT_FOUND');

  black = await connect(`room=${code}`);
  black.send('join_room', code, { resume: true, resumeToken: identity.resumeToken }, identity.playerId);
  const back = await black.next((message) => message.type === 'room_joined');
  assert.equal(back.payload.color, 'b');
  black.send('move_intent', code, { from: sq('e7'), to: sq('e5') });
  const moved = await white.next((message) => isView(message) && message.payload.game.turn === 'w' && message.payload.game.moves.length === 2);
  assert.ok(moved);

  white.close();
  black.close();
  stranger.close();
});

test('rejects old protocol versions and unknown rooms', async () => {
  const client = await connect();
  client.ws.send(JSON.stringify({ type: 'create_room', payload: {}, version: '1.0.0' }));
  const mismatch = await client.next((message) => message.type === 'error');
  assert.equal(mismatch.payload.errorCode, 'VERSION_MISMATCH');
  client.send('join_room', 'ZZZZZZ', {});
  const unknown = await client.next((message) => message.type === 'error');
  assert.equal(unknown.payload.errorCode, 'UNKNOWN_ROOM');
  client.close();
});
