import test from 'node:test';
import assert from 'node:assert/strict';
import { rating, lobbyLogic, lobbySession, protocol } from '../shared.js';

const { TYPES } = protocol;
const { createMemoryStore } = lobbyLogic;

function makeLobby() {
  const store = createMemoryStore();
  const conns = [];
  const created = [];
  let roomSeq = 0;
  const hooks = {
    connections: () => conns,
    send: (conn, message) => conn.inbox.push(message),
    close: () => {},
    save: () => {},
    createRatedRoom: async (match) => {
      roomSeq += 1;
      const roomCode = `T${String(roomSeq).padStart(5, '0')}`;
      const tickets = { w: `wticket${roomSeq}`.padEnd(24, 'w'), b: `bticket${roomSeq}`.padEnd(24, 'b') };
      created.push({ roomCode, match, tickets });
      return { roomCode, tickets };
    },
  };
  const add = (id, ipHash = 'ip-network-a') => {
    const conn = { id, playerId: '', ipHash, inbox: [] };
    conns.push(conn);
    return conn;
  };
  return { store, hooks, add, conns, created };
}

const last = (conn, type) => conn.inbox.filter((message) => message.type === type).at(-1);
const playerOf = (conn) => last(conn, TYPES.LOBBY_READY).payload.player;

async function pair(h, { control = '5+3', ipA = 'ip-a', ipB = 'ip-b' } = {}) {
  const a = h.add('conn-a', ipA);
  const b = h.add('conn-b', ipB);
  await lobbySession.hello(h.store, h.hooks, a, { nickname: 'Ann' });
  await lobbySession.hello(h.store, h.hooks, b, { nickname: 'Bob' });
  await lobbySession.queue(h.store, h.hooks, a, { control });
  await lobbySession.queue(h.store, h.hooks, b, { control });
  return { a, b, matchA: last(a, TYPES.MATCH_FOUND), matchB: last(b, TYPES.MATCH_FOUND) };
}

// --- Elo ------------------------------------------------------------------

test('elo deltas are symmetric, sign-correct and provisional-weighted', () => {
  assert.equal(rating.expectedScore(1200, 1200), 0.5);
  assert.equal(rating.ratingDelta(1200, 0, 1200, 1), 20); // K=40 while provisional
  assert.equal(rating.ratingDelta(1200, 0, 1200, 0), -20);
  assert.equal(rating.ratingDelta(1200, 0, 1200, 0.5), 0);
  assert.equal(rating.ratingDelta(1200, 50, 1200, 1), 12); // K=24 once established
  assert.ok(rating.ratingDelta(1200, 50, 1600, 1) > rating.ratingDelta(1200, 50, 1200, 1));

  const winner = { rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
  const loser = { rating: 1200, games: 0, wins: 0, losses: 0, draws: 0 };
  const up = rating.applyResult(winner, loser.rating, 1);
  const down = rating.applyResult(loser, 1200, 0);
  assert.equal(up.delta, 20);
  assert.equal(down.delta, -20);
  assert.equal(winner.wins, 1);
  assert.equal(loser.losses, 1);
});

test('ratings stay inside the floor and ceiling', () => {
  const record = { rating: 805, games: 40, wins: 0, losses: 40, draws: 0 };
  rating.applyResult(record, 900, 0);
  assert.equal(record.rating, rating.RATING_MIN);
});

// --- Matchmaking ----------------------------------------------------------

test('matching respects the control, the rating window and wait time', () => {
  const now = 1_000_000;
  const entry = (id, overrides) => ({
    playerId: id,
    connId: id,
    rating: 1200,
    control: '10+0',
    joinedAt: now,
    lastOpponent: '',
    lastOpponentAt: 0,
    ipHash: id,
    ...overrides,
  });

  assert.equal(lobbyLogic.takeMatches([entry('a', {}), entry('b', { control: '5+3' })], now).pairs.length, 0);
  assert.equal(lobbyLogic.takeMatches([entry('a', {}), entry('b', { rating: 1450 })], now).pairs.length, 0);
  assert.equal(lobbyLogic.takeMatches([entry('a', {}), entry('b', { rating: 1400 })], now + 20_000).pairs.length, 1);
  assert.equal(lobbyLogic.takeMatches([entry('a', {}), entry('b', {})], now).pairs.length, 1);
});

test('immediate rematches are avoided unless someone has waited a while', () => {
  const now = 2_000_000;
  const a = { playerId: 'a', connId: 'a', rating: 1200, control: '10+0', joinedAt: now, lastOpponent: 'b', lastOpponentAt: now - 5_000, ipHash: 'a' };
  const b = { playerId: 'b', connId: 'b', rating: 1200, control: '10+0', joinedAt: now, lastOpponent: 'a', lastOpponentAt: now - 5_000, ipHash: 'b' };
  assert.equal(lobbyLogic.takeMatches([a, b], now).pairs.length, 0);
  assert.equal(lobbyLogic.takeMatches([{ ...a, joinedAt: now - 40_000 }, b], now).pairs.length, 0,
    'one player having waited is not enough while the other just queued');
  assert.equal(lobbyLogic.takeMatches([{ ...a, joinedAt: now - 40_000 }, { ...b, joinedAt: now - 40_000 }], now).pairs.length, 1);
});

// --- Identities -----------------------------------------------------------

test('hello mints an identity and a token, and the token restores it', async () => {
  const h = makeLobby();
  const a = h.add('c1');
  await lobbySession.hello(h.store, h.hooks, a, { nickname: 'Ann' });
  const ready = last(a, TYPES.LOBBY_READY);
  assert.equal(ready.payload.player.rating, 1200);
  assert.equal(ready.payload.player.name, 'Ann');
  assert.ok(ready.payload.token && ready.payload.token.length >= 32);

  const b = h.add('c2');
  await lobbySession.hello(h.store, h.hooks, b, { token: ready.payload.token, nickname: 'Ann' });
  assert.equal(playerOf(b).id, ready.payload.player.id);
  assert.equal(last(b, TYPES.LOBBY_READY).payload.token, undefined, 'the token is not echoed back');

  const c = h.add('c3');
  await lobbySession.hello(h.store, h.hooks, c, { nickname: 'ann' });
  assert.notEqual(playerOf(c).name.toLowerCase(), 'ann', 'names are unique regardless of case');
});

test('new identities are rate limited per network', async () => {
  const h = makeLobby();
  for (let i = 0; i < lobbyLogic.NEW_PLAYER_LIMIT; i += 1) {
    const conn = h.add(`c-${i}`, 'one-network');
    await lobbySession.hello(h.store, h.hooks, conn, { nickname: `P${i}` });
    assert.equal(last(conn, TYPES.LOBBY_READY)?.payload.player.name.length > 0, true);
  }
  const extra = h.add('c-extra', 'one-network');
  await lobbySession.hello(h.store, h.hooks, extra, { nickname: 'Late' });
  assert.equal(last(extra, TYPES.LOBBY_ERROR).payload.errorCode, 'RATE_LIMIT');
});

// --- Queue and match ------------------------------------------------------

test('two queued players are matched into one room with opposite seats', async () => {
  const h = makeLobby();
  const { a, b, matchA, matchB } = await pair(h);
  assert.ok(matchA, 'white/black assignment is always communicated');
  assert.equal(matchA.payload.roomCode, matchB.payload.roomCode);
  assert.notEqual(matchA.payload.color, matchB.payload.color);
  assert.equal(matchA.payload.rated, true);
  const room = h.created.at(-1);
  assert.equal(matchA.payload.ticket, room.tickets[matchA.payload.color]);
  assert.equal(matchB.payload.ticket, room.tickets[matchB.payload.color]);
  assert.equal(matchA.payload.control, '5+3');
  assert.equal(h.store.getQueue().length, 0);
  assert.ok(h.store.getActiveGame(playerOf(a).id));
  assert.ok(h.store.getActiveGame(playerOf(b).id));
});

test('queueing twice is idempotent, and an unfinished game blocks ranked queueing', async () => {
  const h = makeLobby();
  const a = h.add('solo');
  await lobbySession.hello(h.store, h.hooks, a, { nickname: 'Solo' });
  await lobbySession.queue(h.store, h.hooks, a, { control: '10+0' });
  const first = last(a, TYPES.LOBBY_QUEUED);
  assert.equal(first.payload.waiting, 1);
  await lobbySession.queue(h.store, h.hooks, a, { control: '10+0' });
  assert.equal(last(a, TYPES.LOBBY_QUEUED).payload.waiting, 1);
  assert.equal(h.store.getQueue().length, 1);

  await lobbySession.queue(h.store, h.hooks, a, { control: '5+3' });
  assert.equal(h.store.getQueue().length, 1, 'switching control replaces the entry');

  await lobbySession.cancel(h.store, h.hooks, a);
  assert.equal(h.store.getQueue().length, 0);
  assert.equal(last(a, TYPES.LOBBY_CANCELLED).type, TYPES.LOBBY_CANCELLED);
});

test('players on the same network get an unrated practice game', async () => {
  const h = makeLobby();
  const { matchA, matchB, a, b } = await pair(h, { ipA: 'same', ipB: 'same' });
  assert.equal(matchA.payload.rated, false);
  assert.equal(matchB.payload.rated, false);
  assert.equal(h.store.getActiveGame(playerOf(a).id), null);
  assert.equal(h.store.getActiveGame(playerOf(b).id), null);
});

test('a disconnected socket leaves the queue', async () => {
  const h = makeLobby();
  const a = h.add('gone');
  await lobbySession.hello(h.store, h.hooks, a, { nickname: 'Gone' });
  await lobbySession.queue(h.store, h.hooks, a, { control: '10+0' });
  assert.equal(h.store.getQueue().length, 1);
  await lobbySession.handleClose(h.store, h.hooks, a);
  assert.equal(h.store.getQueue().length, 0);
});

test('simultaneous queueing never pairs anyone twice', async () => {
  const h = makeLobby();
  const conns = [];
  for (let i = 0; i < 4; i += 1) {
    const conn = h.add(`burst-${i}`, `ip-${i}`);
    conns.push(conn);
    await lobbySession.hello(h.store, h.hooks, conn, { nickname: `Burst${i}` });
  }
  await Promise.all(conns.map((conn) => lobbySession.queue(h.store, h.hooks, conn, { control: '10+0' })));
  const matches = conns.map((conn) => conn.inbox.filter((message) => message.type === TYPES.MATCH_FOUND));
  assert.ok(matches.every((list) => list.length === 1), 'every player is matched exactly once');
  const rooms = new Set(matches.flat().map((message) => message.payload.roomCode));
  assert.equal(rooms.size, 2);
  assert.equal(h.created.length, 2, 'exactly two rooms were reserved');
  assert.equal(h.store.getQueue().length, 0);
});

// --- Results --------------------------------------------------------------

test('a reported game moves both ratings exactly once', async () => {
  const h = makeLobby();
  const { a, b, matchA } = await pair(h);
  const gameKey = `${matchA.payload.roomCode}:1`;
  const players = [
    { playerId: playerOf(a).id, color: 'w' },
    { playerId: playerOf(b).id, color: 'b' },
  ];
  const report = await lobbySession.report(h.store, h.hooks, {
    roomCode: matchA.payload.roomCode,
    gameKey,
    players,
    winner: 'w',
    result: 'resign',
  });
  assert.equal(report.ok, true);
  assert.equal(report.updates.w.delta, 20);
  assert.equal(report.updates.b.delta, -20);
  assert.equal(h.store.getPlayer(playerOf(a).id).rating, 1220);
  assert.equal(h.store.getPlayer(playerOf(b).id).games, 1);

  const duplicate = await lobbySession.report(h.store, h.hooks, {
    roomCode: matchA.payload.roomCode,
    gameKey,
    players,
    winner: 'b',
    result: 'resign',
  });
  assert.equal(duplicate.duplicate, true);
  assert.equal(h.store.getPlayer(playerOf(a).id).rating, 1220, 'a duplicate report changes nothing');

  // Guests are rated but only secured accounts are listed.
  const board = h.store.leaderboard(10);
  assert.equal(board.total, 2);
  assert.equal(board.entries.length, 0);
  const winner = h.store.getPlayer(playerOf(a).id);
  winner.keyHash = 'secured';
  h.store.bumpLeaderboard([winner]);
  assert.equal(h.store.leaderboard(10).entries[0].rating, 1220);
  assert.equal(h.store.leaderboard(10).entries[0].secured, true);
  assert.equal(h.store.getActiveGame(playerOf(a).id), null);

  // The game is on both profiles' history.
  assert.equal(report.gameId, winner.recent[0].id);
  assert.equal(winner.recent[0].outcome, 'win');
  assert.equal(winner.recent[0].delta, 20);
  const game = h.store.getGame(report.gameId);
  assert.equal(game.white.after, 1220);
  assert.equal(game.black.after, 1180);
  assert.equal(game.result, 'resign');
  assert.equal(h.store.getPlayer(playerOf(b).id).recent[0].outcome, 'loss');
});

test('a report for a game the lobby did not arrange is refused', async () => {
  const h = makeLobby();
  const { a, b, matchA } = await pair(h);
  const players = [
    { playerId: playerOf(a).id, color: 'w' },
    { playerId: playerOf(b).id, color: 'b' },
  ];
  const wrongRoom = await lobbySession.report(h.store, h.hooks, {
    roomCode: 'ZZZZZZ',
    gameKey: 'ZZZZZZ:1',
    players,
    winner: 'w',
  });
  assert.equal(wrongRoom.ok, false);
  const wrongKey = await lobbySession.report(h.store, h.hooks, {
    roomCode: matchA.payload.roomCode,
    gameKey: `${matchA.payload.roomCode}:9`,
    players,
    winner: 'w',
  });
  assert.equal(wrongKey.ok, false);
  assert.equal(h.store.getPlayer(playerOf(a).id).rating, 1200);
});

test('a game released by a dead room frees both players without a rating change', async () => {
  const h = makeLobby();
  const { a, b, matchA } = await pair(h);
  const players = [playerOf(a).id, playerOf(b).id];
  const released = await lobbySession.release(h.store, { roomCode: matchA.payload.roomCode, players });
  assert.equal(released.released, 2);
  assert.equal(h.store.getActiveGame(players[0]), null);
  assert.equal(h.store.getPlayer(players[0]).rating, 1200);
});

test('a rematch registers the new game so queueing stays blocked', async () => {
  const h = makeLobby();
  const { a, b, matchA } = await pair(h);
  const players = [{ playerId: playerOf(a).id, color: 'b' }, { playerId: playerOf(b).id, color: 'w' }];
  const gameKey = `${matchA.payload.roomCode}:2`;
  const registered = await lobbySession.registerActive(h.store, { roomCode: matchA.payload.roomCode, gameKey, players });
  assert.equal(registered.ok, true);
  assert.equal(h.store.getActiveGame(players[0].playerId).gameKey, gameKey);
});
