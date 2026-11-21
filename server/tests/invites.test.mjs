import test from 'node:test';
import assert from 'node:assert/strict';
import { lobbyLogic, lobbySession, protocol, rl, session } from '../shared.js';

const { TYPES, ERROR_CODES } = protocol;

function makeLobby() {
  const store = lobbyLogic.createMemoryStore();
  const conns = [];
  const created = [];
  let roomSeq = 0;
  const hooks = {
    connections: () => conns.filter((conn) => !conn.closed),
    send: (conn, message) => conn.inbox.push(message),
    close: (conn) => {
      conn.closed = true;
    },
    save: () => {},
    createRatedRoom: async (match) => {
      roomSeq += 1;
      const roomCode = `F${String(roomSeq).padStart(5, '0')}`;
      const tickets = { w: 'w'.repeat(24), b: 'b'.repeat(24) };
      created.push({ roomCode, match, tickets });
      return { roomCode, tickets };
    },
  };
  const player = async (name, ipHash = `net-${name}`) => {
    const conn = { id: `conn-${name}`, playerId: '', ipHash, inbox: [] };
    conns.push(conn);
    await lobbySession.hello(store, hooks, conn, { nickname: name });
    return conn;
  };
  return { store, hooks, created, player };
}

const last = (conn, type) => conn.inbox.filter((message) => message.type === type).at(-1);
const send = (h, conn, type, payload = {}) => lobbySession.handleMessage(h.store, h.hooks, conn, protocol.createMessage(type, '', '', payload));

test('an invite starts a ranked game with the friend who opens it', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, { control: '5+3' });
  const invited = last(ann, TYPES.LOBBY_INVITED).payload;
  assert.match(invited.code, /^[A-Z2-9]{6}$/);
  assert.equal(invited.rated, true);
  assert.equal(invited.spectatorView, 'open', 'party mode is on unless turned off');

  await send(h, bob, TYPES.LOBBY_ACCEPT, { code: invited.code.toLowerCase() });
  const forAnn = last(ann, TYPES.MATCH_FOUND).payload;
  const forBob = last(bob, TYPES.MATCH_FOUND).payload;
  assert.equal(forAnn.roomCode, forBob.roomCode);
  assert.notEqual(forAnn.color, forBob.color);
  assert.equal(forAnn.rated, true);
  assert.deepEqual(forAnn.clock, { baseMs: 300_000, incMs: 3000 });
  assert.equal(forBob.opponent.name, 'Ann');

  const { match } = h.created[0];
  assert.equal(match.control, '5+3');
  assert.equal(match.hardMode, false);
  assert.ok(h.store.getActiveGame(ann.playerId), 'a ranked friend game blocks the queue like any other');
  assert.equal(h.store.getLive()[0].roomCode, forAnn.roomCode);
  assert.deepEqual(h.store.getInvites().filter((item) => !item.started), [], 'an invite is used up');

  // A used invite cannot start a second game.
  const carl = await h.player('Carl');
  await send(h, carl, TYPES.LOBBY_ACCEPT, { code: invited.code });
  assert.equal(last(carl, TYPES.LOBBY_ERROR).payload.errorCode, ERROR_CODES.INVITE_NOT_FOUND);
});

test('friends on the same network play a ranked game when they ask for one', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann', 'home');
  const bob = await h.player('Bob', 'home');
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code: last(ann, TYPES.LOBBY_INVITED).payload.code });
  assert.equal(last(bob, TYPES.MATCH_FOUND).payload.rated, true);
  assert.equal(h.created[0].match.control, '10+0', 'rapid by default');
});

test('invite options: unranked, hard mode, no party mode, no clock', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, { control: 'untimed', rated: true, hardMode: true, party: false });
  const invited = last(ann, TYPES.LOBBY_INVITED).payload;
  assert.equal(invited.rated, false, 'a game without a clock is never ranked');
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code: invited.code });

  const found = last(bob, TYPES.MATCH_FOUND).payload;
  assert.equal(found.rated, false);
  assert.equal(found.clock, null);
  assert.equal(found.hardMode, true);
  assert.deepEqual(h.created[0].match, { ...h.created[0].match, control: 'untimed', rated: false, hardMode: true, spectatorView: 'fog' });
  assert.equal(h.store.getActiveGame(ann.playerId), null, 'unranked games do not block the queue');
  assert.equal(h.store.getLive()[0].control, 'untimed');
});

test('your own invite and an unknown code are refused', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  const { code } = last(ann, TYPES.LOBBY_INVITED).payload;

  await send(h, ann, TYPES.LOBBY_ACCEPT, { code });
  assert.equal(last(ann, TYPES.LOBBY_ERROR).payload.errorCode, ERROR_CODES.INVITE_NOT_FOUND);
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code: 'ZZZZZZ' });
  assert.equal(last(bob, TYPES.LOBBY_ERROR).payload.errorCode, ERROR_CODES.INVITE_NOT_FOUND);
  assert.equal(h.created.length, 0);
});

// Sharing a link on a phone sends the inviter to another app, and the browser drops the lobby
// socket. The invite must outlive that socket: the game starts when the friend arrives, and the
// inviter is handed their seat when they come back.
test('an invite survives the inviter dropping off; their seat is handed over when they return', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, { control: '5+3' });
  const { code } = last(ann, TYPES.LOBBY_INVITED).payload;
  const token = last(ann, TYPES.LOBBY_READY).payload.token;

  ann.closed = true;
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code });
  const forBob = last(bob, TYPES.MATCH_FOUND).payload;
  assert.equal(h.created.length, 1, 'the game starts without waiting for the inviter');
  assert.equal(h.created[0].match.joinWindowMs, lobbyLogic.INVITE_TTL_MS, 'the inviter gets the invite lifetime to arrive');

  // Back from the other app: a new socket says hello and names the invite it is waiting on.
  const back = { id: 'conn-ann-2', playerId: '', ipHash: 'net-Ann', inbox: [] };
  h.hooks.connections = () => [back, bob];
  await lobbySession.hello(h.store, h.hooks, back, { token, inviteCode: code });
  const forAnn = last(back, TYPES.MATCH_FOUND).payload;
  assert.equal(forAnn.roomCode, forBob.roomCode);
  assert.notEqual(forAnn.color, forBob.color);
  assert.equal(forAnn.ticket, h.created[0].tickets[forAnn.color]);
  assert.equal(forAnn.opponent.name, 'Bob');

  // Handed over once: a later hello does not send the player back into that room.
  const again = { id: 'conn-ann-3', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, again, { token, inviteCode: code });
  assert.equal(last(again, TYPES.MATCH_FOUND), undefined);
  assert.equal(last(again, TYPES.LOBBY_READY).payload.invite, null);
});

test('the inviter is told the game started even if their socket missed the match', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  const { code } = last(ann, TYPES.LOBBY_INVITED).payload;
  const token = last(ann, TYPES.LOBBY_READY).payload.token;
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code });
  const pushed = last(ann, TYPES.MATCH_FOUND).payload;

  // A half-dead socket swallowed that message; the reconnect asks again.
  const back = { id: 'conn-ann-2', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, back, { token, inviteCode: code });
  assert.equal(last(back, TYPES.MATCH_FOUND).payload.ticket, pushed.ticket);

  // Without the code (an older client, or one that moved on) nothing is replayed.
  const plain = { id: 'conn-ann-3', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, plain, { token });
  assert.equal(last(plain, TYPES.MATCH_FOUND), undefined);
});

test('hello reports whether the invite a client waits on is still open', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  await send(h, ann, TYPES.LOBBY_INVITE, { control: '5+3', hardMode: true });
  const { code } = last(ann, TYPES.LOBBY_INVITED).payload;
  const token = last(ann, TYPES.LOBBY_READY).payload.token;

  const back = { id: 'conn-ann-2', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, back, { token, inviteCode: code });
  const ready = last(back, TYPES.LOBBY_READY).payload;
  assert.equal(ready.invite.code, code);
  assert.equal(ready.invite.control, '5+3');
  assert.equal(ready.invite.hardMode, true);

  const other = { id: 'conn-ann-3', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, other, { token, inviteCode: 'ZZZZZZ' });
  assert.equal(last(other, TYPES.LOBBY_READY).payload.invite, null);

  // Someone else's code is not yours to wait on.
  const bob = await h.player('Bob');
  const bobBack = { id: 'conn-bob-2', playerId: '', ipHash: 'net-Bob', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, bobBack, { token: last(bob, TYPES.LOBBY_READY).payload.token, inviteCode: code });
  assert.equal(last(bobBack, TYPES.LOBBY_READY).payload.invite, null);
});

test('a cancel made offline rides along with the next hello', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  const bob = await h.player('Bob');
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  const { code } = last(ann, TYPES.LOBBY_INVITED).payload;
  const token = last(ann, TYPES.LOBBY_READY).payload.token;
  await send(h, ann, TYPES.LOBBY_QUEUE, { control: '5+3' });
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  const second = last(ann, TYPES.LOBBY_INVITED).payload.code;

  // Only the named invite goes; a hello never touches the queue or another code.
  const back = { id: 'conn-ann-2', playerId: '', ipHash: 'net-Ann', inbox: [] };
  await lobbySession.hello(h.store, h.hooks, back, { token, cancelInvite: code });
  assert.equal(h.store.getInvites().length, 1);
  await lobbySession.hello(h.store, h.hooks, back, { token, cancelInvite: second });
  assert.deepEqual(h.store.getInvites(), []);
  await send(h, bob, TYPES.LOBBY_ACCEPT, { code: second });
  assert.equal(last(bob, TYPES.LOBBY_ERROR).payload.errorCode, ERROR_CODES.INVITE_NOT_FOUND);
  assert.equal(h.created.length, 0);
});

test('a room reserved for an invite waits the invite lifetime for a player to arrive', () => {
  const seats = [
    { color: 'w', playerId: 'p-w', nickname: 'Ann', rating: 1200 },
    { color: 'b', playerId: 'p-b', nickname: 'Bob', rating: 1200 },
  ];
  const tickets = { w: 'w'.repeat(24), b: 'b'.repeat(24) };
  const invited = rl.createRoomState('ROOMXX');
  rl.applyReservation(invited, lobbyLogic.reservationFor({ control: '10+0', joinWindowMs: lobbyLogic.INVITE_TTL_MS, seats }, 'ROOMXX', tickets));
  assert.equal(rl.joinDeadline(invited) - invited.reservedAt, lobbyLogic.INVITE_TTL_MS);
  const matched = rl.createRoomState('ROOMYY');
  rl.applyReservation(matched, lobbyLogic.reservationFor({ control: '10+0', seats }, 'ROOMYY', tickets));
  assert.equal(rl.joinDeadline(matched) - matched.reservedAt, rl.JOIN_DEADLINE_MS, 'matchmaking keeps the short no-show window');
});

test('one thing at a time: inviting leaves the queue, queueing or cancelling withdraws the invite', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  await send(h, ann, TYPES.LOBBY_QUEUE, { control: '10+0' });
  assert.equal(h.store.getQueue().length, 1);
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  assert.equal(h.store.getQueue().length, 0);
  assert.equal(h.store.getInvites().length, 1);

  await send(h, ann, TYPES.LOBBY_INVITE, {});
  assert.equal(h.store.getInvites().length, 1, 'a new invite replaces the old one');

  await send(h, ann, TYPES.LOBBY_QUEUE, { control: '10+0' });
  assert.equal(h.store.getInvites().length, 0);
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  await send(h, ann, TYPES.LOBBY_CANCEL, {});
  assert.equal(h.store.getInvites().length, 0);
  assert.ok(last(ann, TYPES.LOBBY_CANCELLED));
});

test('a ranked invite waits for an unfinished ranked game; an unranked one does not', async () => {
  const h = makeLobby();
  const ann = await h.player('Ann');
  h.store.saveActiveGame(ann.playerId, { roomCode: 'OLD001', gameKey: 'OLD001:1', at: Date.now() });
  await send(h, ann, TYPES.LOBBY_INVITE, {});
  assert.equal(last(ann, TYPES.LOBBY_ERROR).payload.errorCode, ERROR_CODES.ALREADY_IN_GAME);
  await send(h, ann, TYPES.LOBBY_INVITE, { rated: false });
  assert.equal(last(ann, TYPES.LOBBY_INVITED).payload.rated, false);
});

test('a reserved room takes the invite options: hard mode, watchers in the fog, no clock', () => {
  const reservation = lobbyLogic.reservationFor({
    control: 'untimed',
    rated: true,
    hardMode: true,
    spectatorView: 'fog',
    seats: [
      { color: 'w', playerId: 'p-w', nickname: 'Ann', rating: 1200 },
      { color: 'b', playerId: 'p-b', nickname: 'Bob', rating: 1200 },
    ],
  }, 'ROOMXX', { w: 'w'.repeat(24), b: 'b'.repeat(24) });
  assert.equal(reservation.rated, false);
  assert.equal(reservation.clock, null);
  assert.equal(lobbyLogic.reservationFor({ control: '3+0', seats: [] }, 'ROOMXX', {}), null);

  const state = rl.createRoomState('ROOMXX');
  rl.applyReservation(state, reservation);
  assert.equal(state.hardMode, true);
  assert.equal(state.spectatorView, 'fog');
  assert.equal(state.clock, null);

  const conns = [];
  const hooks = { connections: () => conns, send: (conn, message) => conn.inbox.push(message), close: () => {}, save: () => {}, makeResumeToken: () => 'token' };
  const watcher = { id: 'watch', role: null, playerId: '', inbox: [] };
  conns.push(watcher);
  session.joinRoom(state, hooks, watcher, protocol.createMessage(TYPES.JOIN_ROOM, 'ROOMXX', '', { spectator: true }));
  const view = watcher.inbox.at(-1).payload.game;
  assert.equal(view.revealed, false, 'without party mode, watchers stay in the fog');
});
