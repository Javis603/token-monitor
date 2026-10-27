'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { extractUsageFromTokscale, normalizePeriod } = require('../../src/shared/usage');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { isForkEraPromaSession } = require('../../src/shared/providers/proma/sessionGuard');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

// Report entries from the released fork build (324d5136) and the upstream
// reader (token-monitor-f52a392c) over the same Proma homes.
const FIXTURES = require('../fixtures/proma-fork-upgrade.json');

const AT = new Date('2026-10-27T05:00:00Z');
const LATER = new Date('2026-10-27T05:05:00Z');
const LATEST = new Date('2026-10-27T05:10:00Z');

function scan(entries, at, extra = {}) {
  const period = extractUsageFromTokscale({ entries });
  return { updatedAt: at.toISOString(), today: period, month: period, allTime: period, sessionUsageArchiveFullScan: true, ...extra };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-fork-archive-'));
  const options = { databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'legacy.json') };
  let store = createSessionUsageArchiveStore(options);
  let transform = createUsageTransform({ store, getSettings: () => ({ projectsEnabled: false }), log: () => {} });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    transform: (summary) => transform.transform(summary),
    restart() {
      transform.release();
      store = createSessionUsageArchiveStore(options);
      transform = createUsageTransform({ store, getSettings: () => ({ projectsEnabled: false }), log: () => {} });
    },
    stored: (at) => store.read(at).sessions
  };
}

const total = (entries) => entries.reduce((sum, e) => sum + e.input + e.output + e.cacheRead + e.cacheWrite + e.reasoning, 0);
const totals = (summary) => ['today', 'month', 'allTime'].map((name) => summary[name].totalTokens);

test('fork ids are recognized exactly; upstream and other ids are not', () => {
  for (const { fork } of Object.values(FIXTURES)) {
    for (const entry of fork) assert.equal(isForkEraPromaSession('proma', entry.sessionId), true, entry.sessionId);
  }
  for (const { upstream } of Object.values(FIXTURES)) {
    for (const entry of upstream) assert.equal(isForkEraPromaSession('proma', entry.sessionId), false, entry.sessionId);
  }
  for (const sessionId of [
    '8a6f3c2e-4b1d-4e8a-9c7f-1d2e3f4a5b6c', 'tm-contract', 'a@b@0123456789ab', 'stem@0123456789AB',
    'stem@0123456789a', 'stem@0123456789abc', '@0123456789ab', ''
  ]) {
    assert.equal(isForkEraPromaSession('proma', sessionId), false, sessionId);
  }
  assert.equal(isForkEraPromaSession('claude', 'stem@0123456789ab'), false);
});

// Approved scope: the upgraded totals are what upstream reports now. Fork-era
// rows stay stored with their values but are not replayed, so usage only such
// a row held (the Pi header SDK record, the corrupted journal, camelCase
// records) is not part of the new totals.
for (const [name, expected] of Object.entries({
  normal: 2120,
  sdkDedup: 2120,
  piHeader: 15,
  corrupt: 2120,
  appendedAfterCamelCase: 100,
  partialOverlap: 100,
  continuedSession: 150
})) {
  test(`${name}: upgraded totals count upstream once and keep the fork rows stored`, t => {
    const { fork, upstream } = FIXTURES[name];
    assert.equal(total(upstream), expected);
    const archive = setup(t);
    archive.transform(scan(fork, AT));
    assert.deepEqual(totals(archive.transform(scan(upstream, LATER))), [expected, expected, expected]);

    archive.restart();
    assert.deepEqual(totals(archive.transform(scan(upstream, LATEST))), [expected, expected, expected]);
    const stored = archive.stored(LATEST);
    for (const entry of fork) {
      const row = stored[`proma:${entry.sessionId}`];
      assert.equal(row.periods.allTime.totalTokens, entry.input + entry.output + entry.cacheRead + entry.cacheWrite, entry.sessionId);
    }
  });
}

test('upstream-keyed Proma usage is retained after its journal is gone', t => {
  const { fork, upstream } = FIXTURES.normal;
  const archive = setup(t);
  archive.transform(scan(fork, AT));
  archive.transform(scan(upstream, LATER));
  archive.restart();
  const visible = archive.transform(scan([], LATEST));
  assert.deepEqual(totals(visible), [2120, 2120, 2120]);
  assert.deepEqual(Object.keys(visible.allTime.sessions), ['proma:tm-contract']);
});

test('fork-era rows never reach the visible summary or the sync payload', t => {
  const { fork, upstream } = FIXTURES.corrupt;
  const archive = setup(t);
  archive.transform(scan(fork, AT));
  const visible = archive.transform(scan(upstream, LATER));
  const forkKeys = fork.map((entry) => `proma:${entry.sessionId}`);
  for (const name of ['today', 'month', 'allTime']) {
    for (const key of forkKeys) assert.equal(Object.hasOwn(visible[name].sessions, key), false, `${name} ${key}`);
  }
  const payload = JSON.stringify(serializeSyncPayload(visible).payload);
  for (const entry of fork) assert.equal(payload.includes(entry.sessionId), false, entry.sessionId);
});

test('other clients keep replaying archived sessions the scan no longer reports', t => {
  const archive = setup(t);
  const claude = (tokens) => normalizePeriod({
    totalTokens: tokens, costUsd: 0,
    sessions: tokens ? { 'claude:one': { client: 'claude', sessionId: 'one', totalTokens: tokens, costUsd: 0 } } : {}
  });
  const summary = (tokens, at) => ({
    updatedAt: at.toISOString(), today: claude(tokens), month: claude(tokens), allTime: claude(tokens), sessionUsageArchiveFullScan: true
  });
  archive.transform(summary(100, AT));
  archive.restart();
  assert.deepEqual(totals(archive.transform(summary(0, LATER))), [100, 100, 100]);
});
