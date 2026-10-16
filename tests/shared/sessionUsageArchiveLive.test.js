'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { DatabaseSync } = require('node:sqlite');
const { normalizePeriod } = require('../../src/shared/usage');
const {
  applySessionUsageArchive, captureSessionUsageArchive, sessionUsageArchiveDate, updateSessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');
const { createSessionUsageArchiveStore, readSessionUsageArchiveSnapshot } = require('../../src/shared/usage/sessionUsageArchiveStore');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const AT = new Date('2026-07-09T12:00:00Z');
const LATER = new Date(AT.getTime() + 1000);
function period(tokens, client = 'claude') {
  return normalizePeriod(tokens === null ? {} : {
    totalTokens: tokens, costUsd: tokens / 100,
    sessions: { [`${client}:one`]: { client, sessionId: 'one', totalTokens: tokens, costUsd: tokens / 100 } }
  });
}
function summary(tokens, at = AT, client = 'claude') {
  return { updatedAt: at.toISOString(), today: period(tokens, client), month: period(tokens, client), allTime: period(tokens, client) };
}
function setup(t, storeOptions = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-live-'));
  const options = { databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'legacy.json'), ...storeOptions };
  let store = createSessionUsageArchiveStore(options);
  const transform = createUsageTransform({ store, getSettings: () => ({ projectsEnabled: false }), log: () => {} });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { transform, store, reopen() { transform.release(); store = createSessionUsageArchiveStore(options); return store; } };
}

test('a lower live observation replaces the whole stored session and survives absence', t => {
  const { transform, reopen } = setup(t);
  transform.transform(summary(100));
  assert.equal(transform.transform(summary(20, LATER)).allTime.totalTokens, 20);
  const archive = reopen().read(LATER);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 20);
  assert.equal(applySessionUsageArchive(summary(null, LATER), archive, { now: LATER }).allTime.totalTokens, 20);
});

test('an explicit live zero is committed and survives SQLite reload and later omission', t => {
  const { transform, reopen } = setup(t);
  transform.transform(summary(100));
  assert.equal(transform.transform(summary(0, LATER)).allTime.totalTokens, 0);
  const archive = reopen().read(LATER);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 0);
  assert.equal(applySessionUsageArchive(summary(null, LATER), archive, { now: LATER }).allTime.totalTokens, 0);
});

test('a completed full scan clears stale short-window usage only for identities still observed', t => {
  const { transform, reopen } = setup(t);
  transform.transform(summary(100));
  const current = { ...summary(20, LATER), today: period(null), sessionUsageArchiveFullScan: true };
  const visible = transform.transform(current);
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.allTime.totalTokens, 20);
  const archive = reopen().read(LATER);
  assert.equal(applySessionUsageArchive(summary(null, LATER), archive, { now: LATER }).today.totalTokens, 0);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 20);
});

test('Today-only and missing identities never clear lifetime or unscanned periods', t => {
  const { transform, reopen } = setup(t);
  transform.transform(summary(100));
  transform.transform({ updatedAt: LATER.toISOString(), today: period(5) });
  const archive = reopen().read(LATER);
  assert.equal(archive.sessions['claude:one'].periods.today.totalTokens, 5);
  assert.equal(archive.sessions['claude:one'].periods.month.totalTokens, 100);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 100);
  assert.equal(applySessionUsageArchive(summary(null, LATER), archive, { now: LATER }).allTime.totalTokens, 100);
});

test('a preview is read-only until the full collection succeeds', () => {
  let captures = 0;
  const archive = captureSessionUsageArchive({}, summary(100), AT);
  const transform = createUsageTransform({
    store: { capture() { captures++; return { archive }; } },
    readSnapshot: () => archive,
    getSettings: () => ({ projectsEnabled: false }), log: () => {}
  });
  assert.equal(transform.transform(summary(20, LATER), 'progress', { preview: true }).allTime.totalTokens, 20);
  assert.equal(captures, 0);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 100);
});

test('a preview reads its own store and leaves the committed observation unchanged', t => {
  const { transform, store } = setup(t);
  transform.transform(summary(100));
  const current = summary(20, LATER, 'codex');
  assert.equal(transform.transform(current, 'progress', { preview: true }).allTime.totalTokens, 120);
  const archive = store.read(LATER);
  assert.equal(archive.sessions['claude:one'].periods.allTime.totalTokens, 100);
  assert.equal(archive.sessions['codex:one'], undefined, 'preview must not capture a new identity');
});

test('a cold preview reads legacy JSON without migrating it or creating SQLite', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-preview-'));
  const options = { databasePath: path.join(dir, 'archive.sqlite'), path: path.join(dir, 'legacy.json') };
  const store = createSessionUsageArchiveStore(options);
  const transform = createUsageTransform({ store, getSettings: () => ({ projectsEnabled: false }) });
  t.after(() => { store.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  const current = summary(20, LATER, 'codex');
  assert.equal(transform.transform(current, 'progress', { preview: true }).allTime.totalTokens, 20);
  assert.equal(fs.existsSync(options.databasePath), false);
  const legacy = JSON.stringify(captureSessionUsageArchive({}, summary(100), AT));
  fs.writeFileSync(options.path, legacy);
  assert.equal(transform.transform(current, 'progress', { preview: true }).allTime.totalTokens, 120);
  assert.equal(fs.readFileSync(options.path, 'utf8'), legacy);
  assert.equal(fs.existsSync(options.databasePath), false, 'preview must not open the archive writer');
});

test('released micode archive keys do not duplicate a current mimo session or its retained peer', () => {
  const archive = captureSessionUsageArchive({}, summary(100, AT, 'mimo'), AT);
  archive.sessions['micode:one'] = structuredClone(archive.sessions['mimo:one']);
  const live = applySessionUsageArchive(summary(20, LATER, 'mimo'), archive, { canonical: true, now: LATER });
  assert.equal(live.allTime.totalTokens, 20);
  const absent = applySessionUsageArchive(summary(null, LATER, 'mimo'), archive, { canonical: true, now: LATER });
  assert.equal(absent.allTime.totalTokens, 100);
});

test('alias observations choose the newest whole period, including zero, in either order', () => {
  for (const zero of [false, true]) {
    const old = captureSessionUsageArchive({}, summary(100, AT, 'mimo'), AT).sessions['mimo:one'];
    const recent = captureSessionUsageArchive({}, summary(zero ? 0 : 20, LATER, 'mimo'), LATER).sessions['mimo:one'];
    assert.ok(recent);
    for (const reverse of [false, true]) {
      const rows = [['micode:one', old], ['mimo:one', recent]];
      if (reverse) rows.reverse();
      const archive = { version: 1, sessions: Object.fromEntries(rows) };
      for (const canonical of [false, true]) {
        const visible = applySessionUsageArchive(summary(null, LATER, 'mimo'), archive, { canonical, now: LATER });
        assert.equal(visible.allTime.totalTokens, zero ? 0 : 20);
        assert.equal(visible.allTime.costUsd, zero ? 0 : 0.2);
      }
    }
  }
});

test('headless projection consumes the full-scan hint without publishing it', t => {
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/agent/agent.js'), 'utf8');
  const start = source.indexOf('function summaryWithSessionUsageArchive(');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const { serializeSyncPayload } = require('../../src/shared/syncPayload');
  for (const sessionUsageArchiveEnabled of [false, true]) {
    for (const dryRun of [false, true]) {
      const { store } = setup(t);
      const archive = captureSessionUsageArchive({}, summary(100), AT);
      store.capture(summary(100), AT);
      const context = { sessionUsageArchiveEnabled, dryRun, projectsEnabled: false,
        sessionUsageArchive: archive, sessionUsageArchiveStore: store, cursorUsageEvents: undefined,
        sessionUsageArchiveDate, updateSessionUsageArchive, applySessionUsageArchive,
        readSessionUsageArchiveSnapshot: () => archive };
      vm.runInNewContext(body, context);
      const current = { ...summary(20, LATER), today: period(null), sessionUsageArchiveFullScan: true };
      const visible = context.summaryWithSessionUsageArchive(current, LATER);
      assert.equal(visible.today.totalTokens, 0);
      assert.equal(visible.allTime.totalTokens, 20);
      assert.equal(Object.hasOwn(visible, 'sessionUsageArchiveFullScan'), false);
      assert.equal(Object.hasOwn(serializeSyncPayload(visible).payload, 'sessionUsageArchiveFullScan'), false);
    }
  }
});

test('headless capture failure preserves committed usage and publication until recovery', async t => {
  let failCommit = false;
  class FailingDatabase extends DatabaseSync {
    exec(sql) {
      if (failCommit && sql === 'COMMIT') throw new Error('synthetic archive commit failure');
      return super.exec(sql);
    }
  }
  const { store } = setup(t, { DatabaseSync: FailingDatabase });
  const source = fs.readFileSync(path.resolve(__dirname, '../../src/agent/agent.js'), 'utf8');
  const start = source.indexOf('function summaryWithSessionUsageArchive(');
  const body = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const context = { sessionUsageArchiveEnabled: true, dryRun: false, projectsEnabled: false,
    sessionUsageArchiveStore: store, sessionUsageArchiveDate, applySessionUsageArchive,
    console: { error() {} } };
  vm.runInNewContext(body, context);
  const { runAgent } = require('../../src/agent/runtime');
  let delivery, limits;
  const records = [], posted = [];
  const runtime = runAgent({
    transformUsage: context.summaryWithSessionUsageArchive,
    onRecord: record => records.push(record), deliver: async record => posted.push(record)
  }, { deviceRuntimeDeps: {
    createUsageRuntime(options) { delivery = options; return { stop() {} }; },
    createLimitsRuntime(_options, deps) { limits = deps; return { stop() {} }; }
  } });
  t.after(() => runtime.stop());
  delivery.onUpdate(summary(100), 'startup');
  await runtime.flush();
  assert.equal(records.length, 1);
  assert.equal(posted[0].allTime.totalTokens, 100);
  failCommit = true;
  let captureError;
  try { delivery.onUpdate(summary(20, LATER), 'manual'); } catch (error) { captureError = error; }
  await runtime.flush();
  const snapshot = () => readSessionUsageArchiveSnapshot({
    databasePath: store.databasePath, path: store.legacyPath, strict: true
  });
  assert.equal(snapshot().sessions['claude:one'].periods.allTime.totalTokens, 100);
  assert.equal(posted.length, 1, `disk retained100 but failed capture published${posted.at(-1).allTime.totalTokens}`);
  assert.equal(records.length, 1);
  assert.match(captureError?.message || '', /synthetic archive commit failure/);
  assert.equal(runtime.getSnapshot().allTime.totalTokens, 100);
  limits.onUpdate({ providers: [], updatedAt: LATER.toISOString() });
  await runtime.flush();
  assert.equal(posted.at(-1).allTime.totalTokens, 100, 'limits-only delivery retains committed usage');
  failCommit = false;
  delivery.onUpdate(summary(20, new Date(AT.getTime() + 2000)), 'manual');
  await runtime.flush();
  assert.equal(runtime.getSnapshot().allTime.totalTokens, 20);
  assert.equal(posted.at(-1).allTime.totalTokens, 20);
  assert.equal(snapshot().sessions['claude:one'].periods.allTime.totalTokens, 20);
});

test('an incomplete full-scan hint cannot turn an unscanned period into zero', () => {
  const archive = captureSessionUsageArchive({}, summary(100), AT);
  const current = { updatedAt: LATER.toISOString(), allTime: period(20), sessionUsageArchiveFullScan: true };
  const next = captureSessionUsageArchive(archive, current, LATER);
  assert.equal(next.sessions['claude:one'].periods.today.totalTokens, 100);
  assert.equal(next.sessions['claude:one'].periods.month.totalTokens, 100);
  assert.equal(next.sessions['claude:one'].periods.allTime.totalTokens, 20);
});

test('filtering out another client preserves its archive even when session IDs match', t => {
  const { transform, reopen } = setup(t);
  transform.transform(summary(100));
  const current = { ...summary(20, LATER, 'codex'), sessionUsageArchiveFullScan: true };
  const visible = transform.transform(current);
  assert.equal(visible.allTime.totalTokens, 120);
  assert.equal(visible.allTime.sessions['claude:one'].totalTokens, 100);
  assert.equal(visible.allTime.sessions['codex:one'].totalTokens, 20);
  assert.equal(reopen().read(LATER).sessions['claude:one'].periods.allTime.totalTokens, 100);
});

test('collector marks only completed full reports; failures and anchored watch retain the committed archive', async t => {
  const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
  const { transform, store } = setup(t);
  const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-collector-'));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  let tokens = 100, emptyToday = false, failMonth = false, anchor;
  const calls = [];
  const options = {
    clients: 'claude', allTimeSince: '2026-01-01', deviceId: 'fixture', now: AT,
    homeDir, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false,
    codexLocalUsageEnabled: false, historyEnabled: false,
    sessionMetadataDeps: { sessionMetadataResolvers: new Map() }, lookupModelPricing: async () => null,
    onAnchorComputed: value => { anchor = value; },
    runGraph: async () => { throw new Error('unexpected graph request'); },
    runTokscale: async ({ flags }) => {
      calls.push(flags);
      if (failMonth && flags.includes('--month')) throw new Error('synthetic scan failure');
      return { entries: emptyToday && flags.includes('--today') ? [] : [
        { client: 'claude', sessionId: 'one', model: 'fixture', input: tokens, output: 0, cost: tokens / 100 }
      ] };
    }
  };
  const initial = await collectUsageOnce(options);
  assert.equal(initial.sessionUsageArchiveFullScan, true);
  transform.transform(initial);
  tokens = 20; emptyToday = true;
  const current = await collectUsageOnce({ ...options, now: LATER });
  const visible = transform.transform(current);
  assert.equal(visible.today.totalTokens, 0);
  assert.equal(visible.allTime.totalTokens, 20);
  assert.equal('sessionUsageArchiveFullScan' in visible, false);
  const before = structuredClone(store.read(LATER));
  failMonth = true;
  await assert.rejects(collectUsageOnce({ ...options, now: LATER }), /synthetic scan failure/);
  assert.deepEqual(store.read(LATER), before);
  failMonth = false; calls.length = 0;
  const watch = await collectUsageOnce({ ...options, now: LATER,
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(LATER), todayPartitions: anchor.todayPartitions }
  });
  assert.equal(watch.sessionUsageArchiveFullScan, false);
  assert.equal(calls.length, 1);
  assert.ok(calls[0].includes('--today'));
  assert.equal(transform.transform(watch).allTime.totalTokens, 20);
});

for (const correction of [null, 20]) {
  test(`an omitted anchored session retains ${correction ?? 100} after SQLite reload and an empty full scan`, async t => {
    const { collectUsageOnce, localTodayKey } = require('../../src/shared/collector');
    const { transform, reopen } = setup(t);
    const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), 'archive-watch-absence-'));
    t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
    let tokens = 100, anchor;
    const calls = [];
    const options = {
      clients: 'claude', allTimeSince: '2026-01-01', deviceId: 'fixture',
      homeDir, env: {}, osInfo: {}, projectsEnabled: false, wslScanEnabled: false,
      codexLocalUsageEnabled: false, historyEnabled: false,
      sessionMetadataDeps: { sessionMetadataResolvers: new Map() }, lookupModelPricing: async () => null,
      onAnchorComputed: value => { anchor = value; },
      runGraph: async () => { throw new Error('unexpected graph request'); },
      runTokscale: async ({ flags }) => {
        calls.push(flags);
        return { entries: tokens === null ? [] : [
          { client: 'claude', sessionId: 'one', model: 'fixture', input: tokens, output: 0, cost: tokens / 100 }
        ] };
      }
    };
    const scan = (now, watch = false) => collectUsageOnce({ ...options, now,
      ...(watch ? { todayOnlyAnchor: {
        ...anchor.windowsPeriods, dateKey: localTodayKey(now), todayPartitions: anchor.todayPartitions
      } } : {})
    });
    const values = record => ['today', 'month', 'allTime'].map(name => record[name].totalTokens);
    const initial = await scan(AT);
    assert.equal(initial.sessionUsageArchiveFullScan, true);
    assert.deepEqual(values(transform.transform(initial)), [100, 100, 100]);
    if (correction !== null) {
      tokens = correction;
      const current = await scan(LATER, true);
      assert.equal(current.sessionUsageArchiveFullScan, false);
      assert.equal(current.today.sessions['claude:one'].totalTokens, correction,
        'the scanner still explicitly identifies the corrected session');
      assert.deepEqual(values(transform.transform(current)), [correction, correction, correction]);
    }
    tokens = null;
    calls.length = 0;
    const omittedAt = new Date(AT.getTime() + 2000);
    const omitted = await scan(omittedAt, true);
    assert.equal(omitted.sessionUsageArchiveFullScan, false);
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('--today'));
    assert.equal(omitted.today.sessions['claude:one'], undefined);
    for (const name of ['month', 'allTime']) {
      assert.equal(omitted[name].sessions['claude:one'].totalTokens, 0,
        'the anchor delta retains a synthetic zero row for the absent identity');
    }
    transform.transform(omitted);
    const restarted = reopen();
    const retained = restarted.read(omittedAt).sessions['claude:one'];
    const emptyAt = new Date(AT.getTime() + 3000);
    const empty = await scan(emptyAt);
    assert.equal(empty.sessionUsageArchiveFullScan, true);
    assert.deepEqual(values(empty), [0, 0, 0]);
    const restartedTransform = createUsageTransform({
      store: restarted, getSettings: () => ({ projectsEnabled: false }), log: () => {}
    });
    const expected = correction ?? 100;
    assert.deepEqual(values(restartedTransform.transform(empty)), [expected, expected, expected]);
    for (const name of ['today', 'month', 'allTime']) {
      assert.equal(retained.periods[name].totalTokens, expected, `${name} survives close/reopen`);
    }
  });
}

for (const fullScan of [false, true]) {
  test(`an identified zero DTO survives SQLite reload (full scan: ${fullScan})`, t => {
    const { transform, reopen } = setup(t);
    transform.transform(summary(100));
    // Test the archive's identified-observation boundary. Zero-token/zero-cost
    // scanner entries are discarded by the existing usage extractor.
    const current = { ...summary(0, LATER), sessionUsageArchiveFullScan: fullScan };
    if (fullScan) current.today = period(null);
    assert.equal(transform.transform(current).allTime.totalTokens, 0);
    const archive = reopen().read(LATER);
    for (const name of ['today', 'month', 'allTime']) assert.equal(archive.sessions['claude:one'].periods[name].totalTokens, 0);
    assert.equal(applySessionUsageArchive(summary(null, LATER), archive, { now: LATER }).allTime.totalTokens, 0);
  });
}

test('watch zero confirmation uses the canonical client and session identity', t => {
  for (const [retainedClient, todayClient, expected] of [
    ['claude', 'codex', 100],
    ['mimo', 'micode', 0]
  ]) {
    const { transform, reopen } = setup(t);
    transform.transform(summary(100, AT, retainedClient));
    const current = { ...summary(0, LATER, retainedClient), today: period(0, todayClient),
      sessionUsageArchiveFullScan: false };
    transform.transform(current);
    const archive = reopen().read(LATER);
    for (const name of ['month', 'allTime']) {
      assert.equal(archive.sessions[`${retainedClient}:one`].periods[name].totalTokens, expected);
    }
  }
});
