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
const {
  legacyPromaRoots, parseLegacyPromaSessionId, promaJournalSessionIds
} = require('../../src/shared/usage/legacyPromaSessions');
const { serializeSyncPayload } = require('../../src/shared/syncPayload');

const AT = new Date('2026-10-20T12:00:00Z');
const LATER = new Date('2026-10-20T12:05:00Z');
const LATEST = new Date('2026-10-20T12:10:00Z');
const NEWEST = new Date('2026-10-20T12:15:00Z');

const usageLine = (extra = {}, usage = { input_tokens: 1200, output_tokens: 340, cache_read_input_tokens: 500, cache_creation_input_tokens: 80 }) =>
  JSON.stringify({ type: 'assistant', _createdAt: '2026-10-20T10:00:00Z', message: { id: 'msg_1', model: 'claude-sonnet-4-5', usage }, ...extra });

// The released fork reported tm-contract.jsonl under /home/u with this
// namespace (sha256 of the normalized agent-sessions root).
test('legacy roots and ids reproduce the fork namespace', () => {
  for (const home of ['/home/u', '/home/u/', '/home/./u']) {
    assert.deepEqual(legacyPromaRoots([home], { platform: 'linux' }), [
      { namespace: 'e9dd485ca6f8', root: '/home/u/.proma/agent-sessions' }
    ]);
  }
  const [wsl] = legacyPromaRoots(['\\\\wsl$\\Ubuntu\\home\\u'], { platform: 'win32' });
  assert.equal(wsl.root, '\\\\wsl$\\Ubuntu\\home\\u\\.proma\\agent-sessions');
  assert.match(wsl.namespace, /^[0-9a-f]{12}$/);
  assert.deepEqual(parseLegacyPromaSessionId('tm-contract@e9dd485ca6f8'), { stem: 'tm-contract', namespace: 'e9dd485ca6f8' });
  assert.equal(parseLegacyPromaSessionId('tm-contract'), null);
});

test('journal session ids follow the upstream reader', t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'proma-journal-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const write = (stem, lines) => fs.writeFileSync(path.join(root, `${stem}.jsonl`), `${lines.join('\n')}\n`);
  write('stem-only', [usageLine()]);
  write('recorded', [usageLine({ session_id: ' sdk-1 ' }), usageLine({ sessionId: 'sdk-2' })]);
  write('pi', [JSON.stringify({ type: 'session', id: 'pi-header' }), usageLine({ session_id: 'ignored' })]);
  write('no-usage', ['{broken', usageLine({}, { input_tokens: 0 }),
    JSON.stringify({ type: 'assistant', message: { model: '<synthetic>', usage: { input_tokens: 9 } } })]);
  write('linked', [usageLine({ session_id: 'display-1' })]);
  fs.writeFileSync(path.join(path.dirname(root), 'agent-sessions.json'), JSON.stringify({
    sessions: [{ id: 'linked', sdkSessionId: 'native-1' }]
  }));
  t.after(() => fs.rmSync(path.join(path.dirname(root), 'agent-sessions.json'), { force: true }));

  assert.deepEqual([...promaJournalSessionIds(root, 'stem-only')], ['stem-only']);
  assert.deepEqual([...promaJournalSessionIds(root, 'recorded')], ['sdk-1', 'sdk-2']);
  assert.deepEqual([...promaJournalSessionIds(root, 'pi')], ['pi-header']);
  assert.deepEqual([...promaJournalSessionIds(root, 'no-usage')], []);
  assert.deepEqual([...promaJournalSessionIds(root, 'linked')], ['display-1', 'native-1']);
  assert.equal(promaJournalSessionIds(root, 'missing'), null);
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
  const home = path.join(dir, 'home');
  const [proma] = legacyPromaRoots([home], { platform: process.platform });
  fs.mkdirSync(proma.root, { recursive: true });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return {
    transform,
    roots: [proma],
    legacy: (stem) => `${stem}@${proma.namespace}`,
    journal: (stem, lines) => fs.writeFileSync(path.join(proma.root, `${stem}.jsonl`), `${lines.join('\n')}\n`),
    remove: (stem) => fs.rmSync(path.join(proma.root, `${stem}.jsonl`)),
    reopen() { transform.release(); store = createSessionUsageArchiveStore(options); return store; },
    peek(at) {
      const reader = createSessionUsageArchiveStore(options);
      try { return reader.read(at); } finally { reader.close(); }
    }
  };
}

const totals = (summary) => ['today', 'month', 'allTime'].map((name) => summary[name].totalTokens);

test('upgrading from the fork reader does not count a reported Proma journal twice', t => {
  const { transform, roots, legacy, journal, remove, reopen } = setup(t);
  journal('tm-contract', [usageLine()]);
  transform.transform(scan(AT, { [legacy('tm-contract')]: 2120 }, { sessionUsageArchiveFullScan: true }));

  const visible = transform.transform(scan(LATER, { 'tm-contract': 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.deepEqual(totals(visible), [2120, 2120, 2120]);
  assert.ok(Math.abs(visible.allTime.costUsd - 0.1) < 1e-9);
  assert.equal(Object.hasOwn(visible, 'legacyPromaRoots'), false);
  assert.equal(Object.hasOwn(serializeSyncPayload(visible).payload, 'legacyPromaRoots'), false);

  // Committed; once the journal is deleted the upstream row carries it.
  remove('tm-contract');
  const archive = reopen().read(LATEST);
  assert.equal(archive.sessions[`proma:${legacy('tm-contract')}`].periods.allTime.totalTokens, 0);
  assert.equal(applySessionUsageArchive(scan(LATEST, {}), archive, { now: LATEST }).allTime.totalTokens, 2120);
});

test('a journal in the same root the scan did not report keeps its fork usage', t => {
  const { transform, roots, legacy, journal } = setup(t);
  journal('reported', [usageLine()]);
  journal('unreadable', ['{corrupt']);
  journal('unmatched', [usageLine({ session_id: 'never-reported' })]);
  transform.transform(scan(AT, {
    [legacy('reported')]: 2120, [legacy('unreadable')]: 800, [legacy('unmatched')]: 300, [legacy('deleted')]: 500
  }, { sessionUsageArchiveFullScan: true }));
  const visible = transform.transform(scan(LATER, { reported: 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.deepEqual(totals(visible), [3720, 3720, 3720]);
});

test('usage handed to a linked native session retires its display journal', t => {
  const { transform, roots, legacy, journal } = setup(t);
  journal('linked', [usageLine({ session_id: 'display-1' })]);
  fs.writeFileSync(path.join(path.dirname(roots[0].root), 'agent-sessions.json'), JSON.stringify({
    sessions: [{ id: 'linked', sdkSessionId: 'native-1' }]
  }));
  transform.transform(scan(AT, { [legacy('linked')]: 2120 }, { sessionUsageArchiveFullScan: true }));
  const visible = transform.transform(scan(LATER, { 'native-1': 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.deepEqual(totals(visible), [2120, 2120, 2120]);
});

test('without Proma in the scan, roots it did not read, or a full scan, nothing is retired', t => {
  const { transform, roots, legacy, journal, peek } = setup(t);
  journal('tm-contract', [usageLine()]);
  transform.transform(scan(AT, { [legacy('tm-contract')]: 2120 }, { sessionUsageArchiveFullScan: true }));
  const forkUsage = () => peek(NEWEST).sessions[`proma:${legacy('tm-contract')}`].periods.allTime.totalTokens;
  // A binary without upstream Proma drops the id and reports nothing.
  transform.transform(scan(LATER, {}, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.equal(forkUsage(), 2120);
  // A root the scan did not read (no hint) proves nothing.
  transform.transform(scan(LATER, { 'tm-contract': 2120 }, { sessionUsageArchiveFullScan: true }));
  assert.equal(forkUsage(), 2120);
  // A Today-only tick proves nothing about the other periods.
  transform.transform(scan(LATER, { 'tm-contract': 2120 }, { sessionUsageArchiveFullScan: false, legacyPromaRoots: roots }));
  assert.equal(forkUsage(), 2120);
  // An older fork binary still reporting the fork id keeps it live.
  transform.transform(scan(LATEST, { [legacy('tm-contract')]: 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.equal(forkUsage(), 2120);
});

test('a scan that finished out of order never retires a newer fork observation', t => {
  const { transform, roots, legacy, journal, peek } = setup(t);
  journal('tm-contract', [usageLine()]);
  // An older process keeps reporting the fork id, and commits LATEST first.
  transform.transform(scan(LATEST, { [legacy('tm-contract')]: 2120 }, { sessionUsageArchiveFullScan: true }));
  // The upgraded process's scan started earlier and commits afterwards.
  transform.transform(scan(LATER, { 'tm-contract': 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  const stale = peek(LATEST).sessions[`proma:${legacy('tm-contract')}`];
  assert.equal(stale.periods.allTime.totalTokens, 2120);
  assert.equal(stale.periodWindows.allTime.capturedAt, LATEST.toISOString());
  // The next completed scan of the upgraded process retires it.
  const visible = transform.transform(scan(NEWEST, { 'tm-contract': 2120 }, { sessionUsageArchiveFullScan: true, legacyPromaRoots: roots }));
  assert.deepEqual(totals(visible), [2120, 2120, 2120]);
});

test('the collector reports the scanned Proma roots on full scans only', async t => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-proma-collector-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
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
  assert.deepEqual(full.legacyPromaRoots, legacyPromaRoots([homeDir], { platform: process.platform }));
  const watch = await collectUsageOnce({ ...options, now: LATER,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(LATER), todayPartitions: anchor.todayPartitions }
  });
  assert.equal(Object.hasOwn(watch, 'legacyPromaRoots'), false);
  const untracked = await collectUsageOnce({ ...options, clients: 'claude' });
  assert.equal(Object.hasOwn(untracked, 'legacyPromaRoots'), false);
});
