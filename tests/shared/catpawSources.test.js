'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { catpawDataSources, catpawSourcesFingerprint, readWindowsFolders } = require('../../src/shared/providers/catpaw/paths');
const {
  startCollector, configFingerprint, collectorAnchorTrust, localTodayKey,
  watchIgnoreMatcher, watchPathsForClients, clientSourceChecks, isSelfWatchSqliteSidecarEvent
} = require('../../src/shared/collector');
const { deviceRecordFromAnchor } = require('../../src/shared/anchorSeed');
const { emptyPeriod } = require('../../src/shared/usage');

function fixture(t) {
  // Windows runners expose an 8.3 tmp path; the ignore matcher canonicalizes
  // its roots, so an uncanonicalized home would never appear contained.
  const homeDir = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-catpaw-'));
  const options = { homeDir, platform: 'darwin', env: {} };
  const roots = catpawDataSources(options).roots;
  for (const root of roots) fs.mkdirSync(root, { recursive: true });
  const previous = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = homeDir;
  t.after(() => {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previous;
    fs.rmSync(homeDir, { recursive: true, force: true });
  });
  const account = (scope, root = roots[0]) => path.join(root, `catpaw-memory-${scope}.db`);
  return { options, roots, account };
}

test('CatPaw discovers both editions and watches only direct account database families', t => {
  const f = fixture(t);
  const before = catpawSourcesFingerprint('catpaw', f.options);
  assert.deepEqual(watchPathsForClients('catpaw', f.options), f.roots);
  fs.writeFileSync(f.account('old-account'), '');
  fs.writeFileSync(f.account('new_account', f.roots[1]), '');
  fs.writeFileSync(f.account('anon'), '');
  fs.mkdirSync(path.join(f.roots[0], 'logs'));
  fs.writeFileSync(f.account('nested', path.join(f.roots[0], 'logs')), '');
  const sources = catpawDataSources(f.options);
  assert.deepEqual(sources.dbPaths, [f.account('old-account'), f.account('new_account', f.roots[1])].sort());
  assert.notEqual(catpawSourcesFingerprint('catpaw', f.options), before);
  assert.equal(catpawSourcesFingerprint('claude', f.options), '');
  assert.ok(clientSourceChecks('catpaw', f.options).catpaw.some(check => check.id === 'catpaw-db' && check.exists));
  const ignored = watchIgnoreMatcher('catpaw', f.options);
  for (const root of f.roots) {
    assert.equal(ignored(root), false);
    for (const suffix of ['', '-wal', '-shm']) {
      assert.equal(ignored(path.join(root, `catpaw-memory-future.db${suffix}`)), false);
    }
    for (const name of ['catpaw-memory-anon.db', 'auth.db', 'settings.json', 'logs', 'logs/catpaw-memory-nested.db']) {
      assert.equal(ignored(path.join(root, name)), true, name);
    }
    assert.equal(isSelfWatchSqliteSidecarEvent(f.account('future', root) + '-shm', { catpaw: f.roots }), true);
    assert.equal(isSelfWatchSqliteSidecarEvent(f.account('future', root) + '-wal', { catpaw: f.roots }), false);
    assert.equal(isSelfWatchSqliteSidecarEvent(f.account('future', root), { catpaw: f.roots }), false);
  }
});

test('CatPaw Windows profile, redirected home and explicit home follow the fork roots', () => {
  const options = {
    platform: 'win32', homeDir: 'C:/Users/profile', env: { APPDATA: 'Z:/wrong' },
    windowsFolders: { profile: 'C:/Users/profile', roaming: 'D:/Roaming' }
  };
  assert.equal(catpawDataSources(options).roots[0], path.join('D:/Roaming', 'catpaw-moon'));
  assert.equal(catpawDataSources({ ...options, env: {} }).roots[0], path.join('D:/Roaming', 'catpaw-moon'));
  const redirected = { ...options, env: { ...options.env, HOME: 'E:/CatPawHome' } };
  assert.equal(catpawDataSources(redirected).roots[0], path.join('E:/CatPawHome', 'AppData', 'Roaming', 'catpaw-moon'));
  assert.equal(catpawDataSources({ ...redirected, useEnvRoots: false }).roots[0], path.join(options.homeDir, 'AppData', 'Roaming', 'catpaw-moon'));
  assert.deepEqual(catpawDataSources({ ...options, platform: 'linux' }), { roots: [], dbPaths: [] });
});

test('native Windows folder reads decode Unicode and free successful and failed outputs', () => {
  const freed = [];
  let initialized = 0;
  let uninitialized = 0;
  const koffi = {
    load: () => ({ func: signature => {
      if (signature.includes('SHGetKnownFolderPath')) return (id, flags, token, out) => {
        assert.equal(flags, 0);
        assert.equal(token, null);
        const profile = id.toString('hex') === '8f856c5e220e60479afeea3317b67173';
        out[0] = profile ? 'profile-pointer' : 'roaming-pointer';
        return profile ? -1 : 0;
      };
      if (signature.includes('CoTaskMemFree')) return pointer => freed.push(pointer);
      if (signature.includes('CoInitializeEx')) return () => { initialized += 1; return 0; };
      if (signature.includes('CoUninitialize')) return () => { uninitialized += 1; };
      throw new Error(signature);
    } }),
    decode: (pointer, type, length) => {
      assert.equal(pointer, 'roaming-pointer');
      assert.equal(type, 'char16_t');
      assert.equal(length, -1);
      return 'D:/用户/漫游';
    }
  };
  assert.deepEqual(readWindowsFolders(koffi), { profile: null, roaming: 'D:/用户/漫游' });
  assert.deepEqual(freed, ['profile-pointer', 'roaming-pointer']);
  assert.equal(initialized, 1);
  assert.equal(uninitialized, 1);
});

test('unresolved Windows homes preserve directory case and parent components', () => {
  const options = {
    platform: 'win32', env: {}, homeDir: 'Z:/tm-missing/Alice',
    windowsFolders: { profile: 'Z:/tm-missing/Alice', roaming: 'Y:/Roaming' }
  };
  for (const home of ['Z:/TM-MISSING/ALICE', 'Z:/tm-missing/Alice/absent/..']) {
    const sources = catpawDataSources({ ...options, env: { HOME: home } });
    assert.equal(sources.roots[0], path.join(home, 'AppData', 'Roaming', 'catpaw-moon'));
  }
  const equivalent = catpawDataSources({ ...options, env: { HOME: 'z:\\tm-missing\\.\\Alice\\' } });
  assert.equal(equivalent.roots[0], path.join('Y:/Roaming', 'catpaw-moon'));
});

test('Windows native roots ignore independent APPDATA overrides', { skip: process.platform !== 'win32' }, () => {
  const native = readWindowsFolders();
  assert.ok(path.win32.isAbsolute(native.profile));
  assert.ok(path.win32.isAbsolute(native.roaming));
  const sources = catpawDataSources({ platform: 'win32', env: { APPDATA: 'Z:\\wrong' } });
  assert.deepEqual(sources.roots, ['catpaw-moon', 'catpaw-overseas'].map(edition => path.join(native.roaming, edition)));
});

test('account database additions and removals invalidate persisted and cold-start anchors', t => {
  const f = fixture(t);
  const options = { ...f.options, clients: 'catpaw', allTimeSince: '2024-01-01', pricingRevision: 'fixed', now: new Date() };
  const saved = {
    dateKey: localTodayKey(options.now), today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod(),
    configFingerprint: configFingerprint('catpaw', options.allTimeSince, true, '', '', null, 'fixed', options),
    fullScanAt: options.now.toISOString()
  };
  assert.ok(collectorAnchorTrust(saved, options));
  const seedOptions = { ...options, sourcePlatform: 'darwin', platform: 'darwin-arm64' };
  assert.ok(deviceRecordFromAnchor(saved, seedOptions));
  fs.writeFileSync(f.account('added'), '');
  assert.equal(collectorAnchorTrust(saved, options), null);
  assert.equal(deviceRecordFromAnchor(saved, seedOptions), null);
  saved.configFingerprint = configFingerprint('catpaw', options.allTimeSince, true, '', '', null, 'fixed', options);
  fs.unlinkSync(f.account('added'));
  assert.equal(collectorAnchorTrust(saved, options), null);
});

function collectorOptions(f, runTokscale, onUpdate) {
  return {
    ...f.options, clients: 'catpaw', deviceId: 'test-device', allTimeSince: '2024-01-01',
    pricingPath: path.join(f.options.homeDir, 'pricing.json'), binaryRevision: 'fork-a', intervalMs: 3600000,
    anchorPersistenceEnabled: false, watchEnabled: false, wslScanEnabled: false, projectsEnabled: false,
    historyEnabled: false, runTokscale, onUpdate
  };
}

test('account changes upgrade today-only watch ticks to full historical baselines', async t => {
  const f = fixture(t);
  let calls = 0;
  let totals = [10, 100, 1000];
  const updates = [];
  const handle = startCollector(collectorOptions(f, async () => {
    const input = totals[calls++ % 3];
    return { entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input, output: 0, cost: 0 }] };
  }, summary => updates.push(summary)));
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 3);
  await handle.tick('watch:catpaw', { todayOnly: true, targetClients: ['catpaw'] });
  assert.equal(calls, 4, 'unchanged sources keep the today-only delta');
  for (const add of [true, false]) {
    if (add) fs.writeFileSync(f.account('historical'), '');
    else fs.unlinkSync(f.account('historical'));
    totals = add ? [20, 500, 5000] : [10, 100, 1000];
    const before = calls;
    calls = 0;
    await handle.tick('watch:catpaw', { todayOnly: true, targetClients: ['catpaw'] });
    assert.equal(calls, 3, `source changes require full scans (prior calls: ${before})`);
    assert.deepEqual(['today', 'month', 'allTime'].map(period => updates.at(-1)[period].totalTokens), totals);
  }
});

test('account changes during serial scans discard mixed data and replay once', async t => {
  const f = fixture(t);
  let calls = 0;
  let tokens = 10;
  const updates = [];
  const handle = startCollector(collectorOptions(f, async () => {
    const input = tokens;
    if (++calls === 1) {
      fs.writeFileSync(f.account('added'), '');
      tokens = 50;
    }
    return { entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input, output: 0, cost: 0 }] };
  }, summary => updates.push(summary)));
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 6);
  assert.equal(updates.length, 1);
  for (const period of ['today', 'month', 'allTime']) assert.equal(updates[0][period].totalTokens, 50);
});

test('an account added then removed during serial scans still invalidates the mixed result', async t => {
  const f = fixture(t);
  let calls = 0;
  const updates = [];
  const previews = [];
  const handle = startCollector({
    ...collectorOptions(f, async () => {
      calls += 1;
      if (calls === 1) fs.writeFileSync(f.account('temporary'), '');
      if (calls === 3) fs.unlinkSync(f.account('temporary'));
      const input = calls === 2 ? 100 : 10;
      return { entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input, output: 0, cost: 0 }] };
    }, summary => updates.push(summary)),
    onPreview: summary => previews.push(summary)
  });
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 6, 'an observed change requires one replay even when the final source set matches');
  assert.equal(updates.length, 1);
  assert.deepEqual(['today', 'month', 'allTime'].map(period => updates[0][period].totalTokens), [10, 10, 10]);
  assert.ok(previews.every(preview => preview.month?.totalTokens !== 100));
});

test('CatPaw source checks remain active while a Dots visibility projection is pending', async t => {
  const f = fixture(t);
  let calls = 0;
  const updates = [];
  const handle = startCollector({
    ...collectorOptions(f, async () => {
      calls += 1;
      if (calls === 4) fs.writeFileSync(f.account('temporary'), '');
      if (calls === 6) fs.unlinkSync(f.account('temporary'));
      return { entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input: calls === 5 ? 100 : 10, output: 0, cost: 0 }] };
    }, summary => updates.push(summary)),
    clients: 'catpaw,codex', codexLocalUsageEnabled: false, sessionActivityPolling: false
  });
  t.after(() => handle.stop());
  await handle.whenIdle();
  fs.writeFileSync(f.account('historical'), '');
  await handle.setCodexDotsVisible(false);
  assert.equal(calls, 9, 'the visibility refresh must discard the mixed scan and replay once');
  assert.equal(updates.length, 2);
  assert.deepEqual(['today', 'month', 'allTime'].map(period => updates[1][period].totalTokens), [10, 10, 10]);
});

test('persisted CatPaw anchors retain the source set used by the scan', async t => {
  const f = fixture(t);
  const options = {
    ...collectorOptions(f, async () => ({
      entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input: 10, output: 0, cost: 0 }]
    })),
    anchorPersistenceEnabled: true
  };
  const mkdirSync = fs.mkdirSync;
  let added = false;
  const mkdir = t.mock.method(fs, 'mkdirSync', (dir, ...args) => {
    if (!added && dir === f.options.homeDir) {
      added = true;
      fs.writeFileSync(f.account('after-scan'), '');
    }
    return mkdirSync(dir, ...args);
  });
  let handle = startCollector(options);
  t.after(() => handle.stop());
  await handle.whenIdle();
  mkdir.mock.restore();
  handle.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(f.options.homeDir, 'collector-anchor.json'), 'utf8'));
  assert.equal(added, true);
  assert.equal(saved.allTime.totalTokens, 10);
  assert.equal(collectorAnchorTrust(saved, options), null, 'the new account was not part of the persisted baseline');
  let calls = 0;
  const updates = [];
  handle = startCollector({
    ...options,
    runTokscale: async ({ flags }) => {
      calls += 1;
      const input = flags.includes('--today') ? 20 : flags.includes('--month') ? 100 : 1000;
      return { entries: [{ client: 'catpaw', sessionId: 's', model: 'auto', input, output: 0, cost: 0 }] };
    },
    onUpdate: summary => updates.push(summary)
  });
  await handle.whenIdle();
  assert.equal(calls, 3, 'restart must establish a full baseline for the new source set');
  assert.deepEqual(['today', 'month', 'allTime'].map(period => updates[0][period].totalTokens), [20, 100, 1000]);
});

test('CatPaw source checks preserve the existing pricing replay rule for other clients', async t => {
  const f = fixture(t);
  const pricingPath = path.join(f.options.homeDir, 'pricing.json');
  const setPrice = price => fs.writeFileSync(pricingPath, JSON.stringify({ models: { test: { input_cost_per_million_tokens: price } } }));
  setPrice(1);
  let calls = 0;
  const updates = [];
  const handle = startCollector({
    ...collectorOptions(f, async () => {
      calls += 1;
      if (calls === 1 || calls === 4) setPrice(2);
      if (calls === 3) setPrice(1);
      fs.writeFileSync(f.account('unselected'), '');
      return { entries: [{ client: 'claude', sessionId: 's', model: 'test', input: 10, output: 0, cost: 0 }] };
    }, (summary, reason) => updates.push({ summary, reason })),
    clients: 'claude'
  });
  t.after(() => handle.stop());
  await handle.whenIdle();
  assert.equal(calls, 3, 'a restored pricing revision does not acquire a new replay rule');
  assert.equal(updates.length, 1);
  await handle.tick('manual');
  assert.equal(calls, 9, 'a changed final pricing revision still triggers the existing replay');
  assert.equal(updates.length, 2);
  assert.equal(updates[1].reason, 'pricing-change');
});
