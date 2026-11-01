import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const dataVersion = require('../../client/dataVersion.js');
const keys = { identity: 'identity', session: 'room', local: 'local', archive: 'archive' };
const main = 'wss://main.example';
const other = 'wss://other.example';
function fixture() {
  const data = new Map(Object.entries({
    identity: { token: 'main-token' },
    otherIdentity: { token: 'other-token' },
    room: { serverUrl: other, resumeToken: 'other-room' },
    local: { board: 'local-board' },
    archive: [{ mode: 'local' }, { mode: 'online' }, { mode: 'online', serverUrl: other }],
    unrelated: { value: 'keep' },
  }).map(([key, value]) => [key, JSON.stringify(value)]));
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value), removeItem: key => data.delete(key) };
  const apply = (version, serverUrl = main) => dataVersion.apply(storage, {
    version, serverUrl, defaultServerUrl: main, identityKey: serverUrl === main ? keys.identity : 'otherIdentity', keys,
  });
  return { data, storage, apply };
}

test('normal deployments adopt legacy browser data without clearing it', () => {
  const { data, apply } = fixture();
  const before = [...data];
  assert.equal(apply(1), false);
  assert.deepEqual([...data], before);
});

test('a full reset clears main-server game data once and preserves other servers', () => {
  const { data, storage, apply } = fixture();
  assert.equal(apply(2), true);
  assert.equal(data.has('identity'), false);
  assert.equal(data.has('local'), false);
  assert.ok(data.has('otherIdentity'));
  assert.ok(data.has('room'));
  assert.ok(data.has('unrelated'));
  assert.deepEqual(JSON.parse(data.get('archive')), [{ mode: 'online', serverUrl: other }]);
  storage.setItem('identity', JSON.stringify({ token: 'new-account' }));
  assert.equal(apply(2), false);
  assert.equal(apply(1), false, 'older code must not undo the reset marker');
  assert.equal(dataVersion.current(storage, main), 2);
  assert.equal(JSON.parse(data.get('identity')).token, 'new-account');
});

test('another server cannot reset the main account or local games', () => {
  const { data, apply } = fixture();
  assert.equal(apply(2, other), true);
  assert.ok(data.has('identity'));
  assert.ok(data.has('local'));
  assert.equal(data.has('otherIdentity'), false);
  assert.equal(data.has('room'), false);
  assert.deepEqual(JSON.parse(data.get('archive')), [{ mode: 'local' }, { mode: 'online' }]);
});

test('invalid versions do not wipe data, and unavailable browser storage has a safe default', () => {
  const { data, apply } = fixture();
  const before = [...data];
  for (const value of [undefined, null, '2', 0, -1, 1.5, Infinity]) assert.equal(apply(value), false);
  assert.deepEqual([...data], before);
  assert.equal(dataVersion.current({ getItem() { throw new Error('blocked'); } }, main), 1);
});
