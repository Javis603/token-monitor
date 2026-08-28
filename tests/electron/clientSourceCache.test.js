'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clientSourceIdentity,
  clientSourceRequestKey,
  createClientSourceCache,
  readClientSources,
  readLatestClientSources,
  writeClientSources
} = require('../../src/electron/renderer/clientSourceCache');

function identity(clientId, observedAt, deviceId = 'device-a') {
  return { deviceId, clientId, observedAt };
}

test('client source cache keeps one observation per device and client', () => {
  const cache = createClientSourceCache();

  for (let index = 0; index < 100; index += 1) {
    writeClientSources(cache, identity('codex', `observation-${index}`), [{ id: 'codex-sessions', index }]);
  }

  assert.equal(cache.entries.size, 1);
  assert.equal(readClientSources(cache, identity('codex', 'observation-0')), null);
  assert.deepEqual(readClientSources(cache, identity('codex', 'observation-99')), [
    { id: 'codex-sessions', index: 99 }
  ]);
});

test('latest client sources are display-only within the same device and client', () => {
  const cache = createClientSourceCache();
  const sources = [{ id: 'codex-sessions', dir: '/old/path', exists: true }];
  writeClientSources(cache, identity('codex', 'old'), sources);

  assert.equal(readClientSources(cache, identity('codex', 'new')), null);
  assert.deepEqual(readLatestClientSources(cache, identity('codex', 'new')), sources);
  assert.equal(readLatestClientSources(cache, identity('claude', 'new')), null);
  assert.equal(readLatestClientSources(cache, identity('codex', '')), null);
  assert.equal(
    readLatestClientSources(cache, identity('codex', 'new', 'device-b')),
    null
  );
});

test('client source cache keeps a bounded slot for each client', () => {
  const cache = createClientSourceCache();

  writeClientSources(cache, identity('codex', 'a'), []);
  writeClientSources(cache, identity('claude', 'b'), [{ id: 'claude-projects' }]);

  assert.equal(cache.entries.size, 2);
  assert.deepEqual(readClientSources(cache, identity('codex', 'a')), []);
  assert.deepEqual(readClientSources(cache, identity('claude', 'b')), [{ id: 'claude-projects' }]);
});

test('client source cache clears slots when the local device changes', () => {
  const cache = createClientSourceCache();

  writeClientSources(cache, identity('codex', 'a', 'device-a'), [{ id: 'old' }]);
  writeClientSources(cache, identity('claude', 'b', 'device-b'), [{ id: 'new' }]);

  assert.equal(cache.entries.size, 1);
  assert.equal(readClientSources(cache, identity('codex', 'a', 'device-a')), null);
  assert.deepEqual(readClientSources(cache, identity('claude', 'b', 'device-b')), [{ id: 'new' }]);
});

test('client source request key includes the full health snapshot identity', () => {
  assert.equal(
    clientSourceRequestKey(identity('codex', 'observed-at')),
    'device-a|codex|observed-at'
  );
  assert.equal(clientSourceRequestKey(identity('', 'observed-at')), '');
  assert.equal(clientSourceRequestKey(identity('codex', '')), '');
});

test('placeholder source identities stay stable across unrelated health observations', () => {
  const untrackedBefore = clientSourceIdentity({
    deviceId: 'device-a',
    clientId: 'commandcode',
    observedAt: 'T1',
    hasObservation: false
  });
  const untrackedAfter = clientSourceIdentity({
    deviceId: 'device-a',
    clientId: 'commandcode',
    observedAt: 'T2',
    hasObservation: false
  });
  const waitingBefore = clientSourceIdentity({
    deviceId: 'device-a',
    clientId: 'codex',
    observedAt: 'T1',
    tracked: true,
    hasObservation: false
  });
  const waitingAfter = clientSourceIdentity({
    deviceId: 'device-a',
    clientId: 'codex',
    observedAt: 'T2',
    tracked: true,
    hasObservation: false
  });

  assert.equal(clientSourceRequestKey(untrackedBefore), 'device-a|commandcode|untracked');
  assert.equal(clientSourceRequestKey(untrackedAfter), 'device-a|commandcode|untracked');
  assert.equal(clientSourceRequestKey(waitingBefore), 'device-a|codex|waiting');
  assert.equal(clientSourceRequestKey(waitingAfter), 'device-a|codex|waiting');
  assert.equal(
    clientSourceRequestKey(clientSourceIdentity({
      deviceId: 'device-a',
      clientId: 'codex',
      observedAt: 'T2',
      tracked: true,
      hasObservation: true
    })),
    'device-a|codex|T2'
  );
});

test('client source cache refuses observations without a version stamp', () => {
  const cache = createClientSourceCache();
  const unstamped = identity('codex', '');

  writeClientSources(cache, unstamped, [{ id: 'stale' }]);

  assert.equal(cache.entries.size, 0);
  assert.equal(readClientSources(cache, unstamped), null);
  assert.equal(cache.entries.size, 0);
});
