'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizePeriod } = require('../../src/shared/usage');
const { applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { legacyPromaSessionKeys } = require('../../src/shared/usage/legacyPromaSessions');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

const AT = new Date('2026-10-20T12:00:00Z');
const LATER = new Date('2026-10-20T12:05:00Z');
const LATEST = new Date('2026-10-20T12:10:00Z');

// The released fork reported tm-contract.jsonl under /home/u as this id; the
// namespace is sha256 of the normalized agent-sessions root.
test('legacy keys reproduce the fork ids of the journals that still exist', () => {
  const readdirSync = (root) => {
    if (root === '/home/u/.proma/agent-sessions') return ['tm-contract.jsonl', 'notes.txt'];
    if (root === '\\\\wsl$\\Ubuntu\\home\\u\\.proma\\agent-sessions') return ['wsl-session.jsonl'];
    throw Object.assign(new Error('missing'), { code: 'ENOENT' });
  };
  assert.deepEqual(legacyPromaSessionKeys(['/home/u', '/home/u', '/home/empty'], { platform: 'linux', readdirSync }), [
    'proma:tm-contract@e9dd485ca6f8'
  ]);
  const [wslKey] = legacyPromaSessionKeys(['\\\\wsl$\\Ubuntu\\home\\u'], { platform: 'win32', readdirSync });
  assert.match(wslKey, /^proma:wsl-session@[0-9a-f]{12}$/);
  assert.notEqual(wslKey.split('@')[1], 'e9dd485ca6f8');
});

function prom(sessions) {
  const entries = Object.entries(sessions);
  return normalizePeriod({
    totalTokens: entries.reduce((sum, [, tokens]) => sum + tokens, 0),
    costUsd: entries.reduce((sum, [, tokens]) => sum + tokens / 21200, 0),
    sessions: Object.fromEntries(entries.map(([sessionId, tokens]) => [`proma:${sessionId}`, {
      client: 'proma', sessionId, totalTokens: tokens, costUsd: tokens / 21200
    }]))
  });
}

function scan(at, sessions, extra = {}) {
  return { updatedAt: at.toISOString(), today: prom(sessions), month: prom(sessions), allTime: prom(sessions), ...extra };
}

function setup(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proma-'));
  const options = { databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'legacy.json') };
  let store = createSessionUsageArchiveStore(options);
  const transform = createUsageTransform({ store, getSettings: () => ({ projectsEnabled: false }), log: () => {} });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { transform, reopen() { transform.release(); store = createSessionUsageArchiveStore(options); return store; } };
}

const LEGACY = 'tm-contract@e9dd485ca6f8';

test('upgrading from the fork reader does not count an archived Proma session twice', t => {
  const { transform, reopen } = setup(t);
  // Released fork build: the journal is reported under its fork id.
  transform.transform(scan(AT, { [LEGACY]: 2120 }, { sessionUsageArchiveFullScan: true }));

  // Upstream reader: the same journal arrives under its upstream id.
  const upgraded = scan(LATER, { 'tm-contract': 2120 }, {
    sessionUsageArchiveFullScan: true,
    legacyPromaSessionKeys: [`proma:${LEGACY}`]
  });
  const visible = transform.transform(upgraded);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(visible[name].totalTokens, 2120, name);
    assert.ok(Math.abs(visible[name].costUsd - 0.1) < 1e-9, name);
  }
  assert.equal(Object.hasOwn(visible, 'legacyPromaSessionKeys'), false);
  assert.equal(Object.hasOwn(serializeSyncPayload(visible).payload, 'legacyPromaSessionKeys'), false);

  // The retirement is committed, and the upstream row carries the history once
  // the journal is deleted and no longer scanned.
  const archive = reopen().read(LATEST);
  assert.equal(archive.sessions[`proma:${LEGACY}`].periods.allTime.totalTokens, 0);
  assert.equal(applySessionUsageArchive(scan(LATEST, {}), archive, { now: LATEST }).allTime.totalTokens, 2120);
});

test('a fork-keyed Proma session whose journal is gone keeps replaying', t => {
  const { transform } = setup(t);
  transform.transform(scan(AT, { [LEGACY]: 2120, 'deleted@e9dd485ca6f8': 500 }, { sessionUsageArchiveFullScan: true }));
  const visible = transform.transform(scan(LATER, { 'tm-contract': 2120 }, {
    sessionUsageArchiveFullScan: true,
    legacyPromaSessionKeys: [`proma:${LEGACY}`]
  }));
  assert.equal(visible.allTime.totalTokens, 2620);
});

test('only a completed full scan retires fork rows, and never one it still reports', t => {
  const { transform } = setup(t);
  transform.transform(scan(AT, { [LEGACY]: 2120 }, { sessionUsageArchiveFullScan: true }));
  const legacyKeys = [`proma:${LEGACY}`];
  // An older fork binary still reports the fork id: it stays live.
  assert.equal(transform.transform(scan(LATER, { [LEGACY]: 2120 }, {
    sessionUsageArchiveFullScan: true, legacyPromaSessionKeys: legacyKeys
  })).allTime.totalTokens, 2120);
  // A Today-only tick proves nothing about the other periods.
  const watch = transform.transform(scan(LATEST, { 'tm-contract': 2120 }, {
    sessionUsageArchiveFullScan: false, legacyPromaSessionKeys: legacyKeys
  }));
  assert.equal(watch.allTime.totalTokens, 4240);
});

test('the collector lists fork journals only after a full scan reported Proma usage', async t => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proma-collector-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const journals = path.join(homeDir, '.proma', 'agent-sessions');
  fs.mkdirSync(journals, { recursive: true });
  fs.writeFileSync(path.join(journals, 'tm-contract.jsonl'), '');
  let anchor;
  const options = {
    clients: 'proma', allTimeSince: '2026-01-01', deviceId: 'fixture', now: AT,
    homeDir, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false,
    codexLocalUsageEnabled: false, historyEnabled: false,
    sessionMetadataDeps: { sessionMetadataResolvers: new Map() }, lookupModelPricing: async () => null,
    onAnchorComputed: value => { anchor = value; },
    runGraph: async () => { throw new Error('unexpected graph request'); },
    runTokscale: async () => ({ entries: [
      { client: 'proma', sessionId: 'tm-contract', model: 'fixture', input: 2120, output: 0, cost: 0.1 }
    ] })
  };
  const full = await collectUsageOnce(options);
  assert.deepEqual(full.legacyPromaSessionKeys, legacyPromaSessionKeys([homeDir], { platform: process.platform }));
  assert.equal(full.legacyPromaSessionKeys.length, 1);
  const watch = await collectUsageOnce({ ...options, now: LATER,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(LATER), todayPartitions: anchor.todayPartitions }
  });
  assert.equal(Object.hasOwn(watch, 'legacyPromaSessionKeys'), false);
  const untracked = await collectUsageOnce({ ...options, clients: 'claude' });
  assert.equal(Object.hasOwn(untracked, 'legacyPromaSessionKeys'), false);
  // A binary without upstream Proma drops the id and reports nothing for it:
  // the journals exist, but no replacement usage was reported.
  const unsupported = await collectUsageOnce({ ...options, runTokscale: async () => ({ entries: [] }) });
  assert.deepEqual(unsupported.legacyPromaSessionKeys, []);
});
