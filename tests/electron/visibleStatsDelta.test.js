'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { createRendererSnapshots } = require('../../src/electron/statsPublisher');
const { applyStatsDelta, buildStatsDelta, fingerprintStats } = require('../../src/shared/statsDelta');

const root = path.join(__dirname, '../..');
const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const renderer = fs.readFileSync(path.join(root, 'src/electron/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(root, 'src/electron/renderer/index.html'), 'utf8');

test('main sends visible session changes as a delta from a compact fingerprint', () => {
  assert.match(main, /require\('\.\.\/shared\/statsDelta'\)/);
  assert.match(main, /let lastRendererStatsFingerprint = null/);
  assert.match(main, /buildStatsDelta\(lastRendererStatsFingerprint, copy\)/);
  assert.match(main, /data: \{ \.\.\.data, statsDelta: built\.delta \}/);
  assert.match(main, /lastRendererStatsFingerprint = rendererFingerprint/);
  assert.match(main, /const fingerprint = fingerprintStats\(copy\)/);
  assert.match(main, /lastRendererStatsFingerprint = fingerprint/);
  assert.match(main, /event\.sender === mainWindow\.webContents/);
  assert.match(main, /if \(win === mainWindow\) lastRendererStatsFingerprint = null/);
});

test('the renderer applies a delta and falls back to a full read on a base mismatch', () => {
  assert.match(html, /<script src="\.\.\/\.\.\/shared\/statsDelta\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/);
  assert.match(renderer, /window\.TokenMonitorStatsDelta\?\.applyStatsDelta\(state\.stats, payload\.data\.statsDelta\)/);
  assert.match(renderer, /statsDeltaResyncPending/);
  assert.match(renderer, /void refreshStats\(\{ deltaResync: true \}\)\.catch\(\(\) => \{\}\)\.finally/);
});

test('a dropped delta recovers from the published base without reading the offline Hub', async () => {
  const sender = {};
  let getStats;
  const snapshots = createRendererSnapshots({ source: () => context.hubModeGeneration });
  const context = {
    hubModeGeneration: 1,
    mainWindow: { isDestroyed: () => false, webContents: sender },
    rendererSnapshots: snapshots,
    rendererStats: value => value,
    electronPresentationStats: value => value,
    fingerprintStats,
    ipcMain: { handle: (_name, handler) => { getStats = handler; } },
    statsPushRevision: 0,
    fetchStats: () => { throw new Error('Hub offline'); }
  };
  const start = main.indexOf("ipcMain.handle('stats:get',");
  vm.runInNewContext(main.slice(start, main.indexOf("ipcMain.handle('devices:delete',", start)), context);
  const stamp = total => {
    const stats = { periods: { today: { sessions: { 'claude:s1': { total } } } } };
    return snapshots.stamp(stats, stats);
  };
  const old = stamp(1);
  const missed = stamp(2);
  const latest = stamp(3);
  const built = buildStatsDelta(fingerprintStats(missed), latest);
  context.lastRendererStatsFingerprint = built.fingerprint;
  assert.equal(applyStatsDelta(old, built.delta), null);
  const recovered = await getStats({ sender }, { deltaResync: true });
  assert.equal(recovered.snapshot.id, latest.snapshot.id);
  const next = buildStatsDelta(context.lastRendererStatsFingerprint, stamp(4));
  assert.equal(applyStatsDelta(recovered, next.delta).periods.today.sessions['claude:s1'].total, 4);

  // Other full snapshot reads can evict the renderer's last sent base
  // without advancing its fingerprint.
  context.lastRendererStatsFingerprint = next.fingerprint;
  stamp(5);
  stamp(6);
  stamp(7);
  assert.equal(snapshots.get(next.fingerprint.snapshot.id), null);
  assert.equal(await getStats({ sender }, { deltaResync: true }), null);

  const fresh = stamp(8);
  const publication = buildStatsDelta(context.lastRendererStatsFingerprint, fresh);
  assert.equal(publication.delta, null, 'the next publication must send a full snapshot');
  assert.equal(fresh.periods.today.sessions['claude:s1'].total, 8);

  context.lastRendererStatsFingerprint = publication.fingerprint;
  context.hubModeGeneration += 1;
  assert.equal(await getStats({ sender }, { deltaResync: true }), null);
  assert.equal(context.lastRendererStatsFingerprint, publication.fingerprint);
});

test('a missed alias presentation does not match the next delta base', () => {
  const snapshots = createRendererSnapshots({ source: () => 1 });
  const stats = { periods: {} };
  const projection = model => ({ periods: { today: { sessions: { 'claude:s1': { model } } } } });
  const before = projection('original');
  const after = projection('alias');
  const old = snapshots.stamp(stats, before, before);
  const missed = snapshots.stamp(stats, after, after);
  const next = snapshots.stamp({ periods: {} }, after, after);
  const { delta } = buildStatsDelta(fingerprintStats(missed), next);
  assert.equal(applyStatsDelta(old, delta), null);
  assert.equal(applyStatsDelta(missed, delta).periods.today.sessions['claude:s1'].model, 'alias');
});
