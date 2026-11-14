'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { normalizePeriod } = require('../../src/shared/usage');
const { CLIENT_IDENTITY_GENERATION } = require('../../src/shared/clientIdentitySplits');
const {
  applySessionUsageArchive,
  captureSessionUsageArchive,
  normalizeSessionUsageArchive,
  updateSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const AT = new Date('2026-11-14T12:00:00.000Z');
const PERIODS = ['today', 'month', 'allTime'];

function session(client, sessionId, totalTokens = 90) {
  return { client, sessionId, totalTokens, inputTokens: totalTokens - 10,
    outputTokens: 10, costUsd: totalTokens / 100, models: { synthetic: totalTokens } };
}

function summary(sessions, fullScan = true) {
  const totalTokens = sessions.reduce((sum, row) => sum + row.totalTokens, 0);
  const costUsd = sessions.reduce((sum, row) => sum + row.costUsd, 0);
  return {
    updatedAt: AT.toISOString(),
    sessionUsageArchiveFullScan: fullScan,
    ...Object.fromEntries(PERIODS.map(name => [name, normalizePeriod({
      totalTokens, costUsd, sessions: Object.fromEntries(sessions.map(row => [`${row.client}:${row.sessionId}`, row]))
    })]))
  };
}

function legacyArchive() {
  const archive = captureSessionUsageArchive({}, summary([session('pi', 'parent'), session('pi', 'fork')]), AT);
  for (const entry of Object.values(archive.sessions)) delete entry.clientIdentityGeneration;
  return archive;
}

function fixture(t, parentReference = 'parent') {
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-legacy-pi-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  const root = path.join(homeDir, '.omp', 'agent', 'sessions', 'bucket');
  fs.mkdirSync(root, { recursive: true });
  const parent = path.join(root, '2026-11-02T10-00-00_parent.jsonl');
  const fork = path.join(root, '2026-11-02T11-00-00_fork.jsonl');
  fs.writeFileSync(parent, JSON.stringify({ type: 'session', id: 'parent' }) + '\n');
  fs.writeFileSync(fork, [
    JSON.stringify({ type: 'title', title: 'synthetic' }),
    JSON.stringify({ type: 'session', id: 'fork', parentSession: parentReference === 'path' ? parent : parentReference })
  ].join('\n') + '\n');
  return { homeDir, root, parent, fork };
}

function assertOnlyParent(visible) {
  for (const period of PERIODS) {
    assert.equal(visible[period].totalTokens, 90, period);
    assert.equal(visible[period].costUsd, 0.9, period);
    assert.deepEqual(Object.keys(visible[period].sessions), ['omp:parent'], period);
  }
}

for (const parentReference of ['parent', 'path']) {
  test(`pre-split Pi fork with an OMP parent ${parentReference} is not replayed`, t => {
    const { homeDir } = fixture(t, parentReference);
    const archive = legacyArchive();
    const live = summary([session('omp', 'parent')]);
    assertOnlyParent(applySessionUsageArchive(live, archive, { homeDir, now: AT }));
    assertOnlyParent(applySessionUsageArchive(structuredClone(live), archive, {
      homeDir, now: AT, canonical: true, canonicalSummary: true, mutate: true
    }));
    assert.equal(archive.sessions['pi:fork'].supersededBy, undefined, 'projection stays read-only');
  });
}

test('a fork with new native usage keeps its own OMP row once', t => {
  const { homeDir } = fixture(t);
  const live = summary([session('omp', 'parent'), session('omp', 'fork', 20)]);
  const archive = captureSessionUsageArchive(legacyArchive(), live, AT, { homeDir });
  const visible = applySessionUsageArchive(live, archive, { homeDir, now: AT });
  for (const period of PERIODS) {
    assert.equal(visible[period].totalTokens, 110);
    assert.deepEqual(Object.keys(visible[period].sessions).sort(), ['omp:fork', 'omp:parent']);
  }
  assert.equal(archive.sessions['pi:fork'].supersededBy, undefined);
});

test('reconciliation persists across capture, SQLite reload, previews and lost source files', t => {
  const { homeDir, root } = fixture(t);
  const databasePath = path.join(homeDir, 'archive.sqlite');
  const legacyPath = path.join(homeDir, 'archive.json');
  fs.writeFileSync(legacyPath, JSON.stringify(legacyArchive()));
  const store = createSessionUsageArchiveStore({ databasePath, path: legacyPath, homeDir });
  const transform = createUsageTransform({ store, getSettings: () => ({ clients: 'pi,omp' }) });
  t.after(() => store.close());
  assertOnlyParent(transform.transform(summary([session('omp', 'parent')])));
  assert.equal(store.read(AT).sessions['pi:fork'].supersededBy, 'omp:parent');
  assert.equal(store.read(AT).sessions['omp:parent'].clientIdentityGeneration, CLIENT_IDENTITY_GENERATION);
  store.release();
  fs.rmSync(root, { recursive: true });
  const reloaded = store.read(AT);
  assert.equal(reloaded.sessions['pi:fork'].supersededBy, 'omp:parent');
  assertOnlyParent(transform.transform(summary([session('omp', 'parent')])));
  // Both sessions are now source-deleted. Replay the retained OMP observation
  // once, including when no complete live scan is available for a preview.
  assertOnlyParent(transform.project(summary([], false), reloaded, AT));
  assertOnlyParent(transform.transform(summary([], false)));
});

for (const scenario of ['missing-parent', 'missing-parent-file', 'missing-fork', 'wrong-header', 'outside-root', 'post-split', 'watch', 'partial', 'live-pi', 'older-scan']) {
  test(`retains Pi history when reconciliation is unsupported: ${scenario}`, t => {
    const { homeDir, fork, parent } = fixture(t);
    const archive = legacyArchive();
    if (scenario === 'missing-parent-file') fs.unlinkSync(parent);
    if (scenario === 'missing-fork') fs.unlinkSync(fork);
    if (scenario === 'wrong-header') fs.writeFileSync(fork, JSON.stringify({ type: 'session', id: 'other', parentSession: 'parent' }));
    if (scenario === 'outside-root') {
      const outside = path.join(homeDir, 'parent.jsonl');
      fs.copyFileSync(parent, outside);
      fs.writeFileSync(fork, JSON.stringify({ type: 'session', id: 'fork', parentSession: outside }));
    }
    if (scenario === 'post-split') archive.sessions['pi:fork'].clientIdentityGeneration = CLIENT_IDENTITY_GENERATION;
    const live = summary(scenario === 'missing-parent' ? [] : [session('omp', 'parent')], scenario !== 'watch');
    if (scenario === 'older-scan') live.updatedAt = '2026-11-14T11:00:00.000Z';
    if (scenario === 'partial') delete live.allTime;
    if (scenario === 'live-pi') {
      for (const period of PERIODS) live[period].sessions['pi:fork'] = session('pi', 'fork');
    }
    const { archive: captured } = updateSessionUsageArchive(archive, live, AT, { homeDir });
    assert.equal(captured.sessions['pi:fork'].supersededBy, undefined);
    const visible = applySessionUsageArchive(live, captured, { homeDir, now: AT });
    assert.equal(visible.month.sessions['pi:fork'].totalTokens, 90);
    assert.equal(Boolean(visible.month.sessions['pi:fork'].archived), scenario !== 'live-pi');
  });
}

test('identity generation survives normalization and a fresh Pi observation clears obsolete parentage', t => {
  const { homeDir } = fixture(t);
  const live = summary([session('omp', 'parent')]);
  let archive = captureSessionUsageArchive(legacyArchive(), live, AT, { homeDir });
  assert.equal(archive.sessions['pi:fork'].supersededBy, 'omp:parent');
  archive = captureSessionUsageArchive(archive, summary([session('pi', 'fork')]), AT, { homeDir });
  const row = normalizeSessionUsageArchive(archive).sessions['pi:fork'];
  assert.equal(row.clientIdentityGeneration, CLIENT_IDENTITY_GENERATION);
  assert.equal(row.supersededBy, undefined);
});
