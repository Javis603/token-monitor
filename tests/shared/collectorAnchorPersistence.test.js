'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

const {
  configFingerprint,
  collectUsageOnce,
  localTodayKey,
  qoderCnSourcesForClients,
  pricingFingerprint
} = require('../../src/shared/collector');

const { emptyPeriod } = require('../../src/shared/usage');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installInProcessWatchHost(test);

const baseOptions = {
  clients: 'claude',
  allTimeSince: '2024-01-01',
  commandTimeoutMs: 1000,
  deviceId: 'test-device',
  agentVersion: 'test',
  limitsEnabled: false,
  historyEnabled: false
};

test('configFingerprint normalizes clients and includes allTimeSince and project tracking', () => {
  const a = configFingerprint('claude, codex', '2024-01-01');
  const b = configFingerprint('claude,codex', '2024-01-01');
  // whitespace-normalised to the same value
  assert.equal(a, b, 'whitespace should be normalized');
  assert.match(a, /^claude,codex\|2024-01-01\|projects:on\|pricing:[0-9a-f]{64}$/);

  const c = configFingerprint('claude', '2024-01-01');
  assert.notEqual(a, c, 'different clients should differ');

  const d = configFingerprint('claude,codex', '2024-06-01');
  assert.notEqual(a, d, 'different allTimeSince should differ');

  const e = configFingerprint('claude,codex', '2024-01-01', false);
  assert.notEqual(a, e, 'project tracking changes should invalidate persisted anchors');
});

test('configFingerprint invalidates the anchor when the Qoder CN JSONL source moves', () => {
  const legacy = configFingerprint('qodercn', '2024-01-01', true, '/cn/local.db');
  assert.notEqual(
    configFingerprint('qodercn', '2024-01-01', true, '/cn/local.db', '/home/.qoder-cn/projects'),
    legacy,
    'an anchor captured before the JSONL source existed must not be trusted for month/allTime'
  );
  assert.notEqual(
    configFingerprint('qodercn', '2024-01-01', true, '/cn/local.db', '/moved/projects'),
    configFingerprint('qodercn', '2024-01-01', true, '/cn/local.db', '/home/.qoder-cn/projects'),
    'changing TOKEN_MONITOR_QODER_CN_PROJECTS_PATH must invalidate the anchor'
  );
  assert.equal(
    configFingerprint('qodercn', '2024-01-01', true, '/cn/local.db', ''),
    legacy,
    'an empty projects source keeps the pre-JSONL fingerprint byte-identical'
  );
});

test('qoderCnSourcesForClients resolves the JSONL projects dir alongside the legacy DB', () => {
  const sources = qoderCnSourcesForClients('qodercn', {
    homeDir: '/Users/test',
    platform: 'darwin',
    env: { TOKEN_MONITOR_QODER_CN_PROJECTS_PATH: '/custom/cn/projects' }
  });
  assert.equal(sources.projectsDir, path.resolve('/custom/cn/projects'));
  assert.match(sources.dbPath, /QoderCN/);
  assert.deepEqual(
    qoderCnSourcesForClients('claude', { homeDir: '/Users/test', platform: 'darwin', env: {} }),
    { dbPath: '', projectsDir: '' },
    'clients without qodercn resolve no sources and keep the fingerprint unchanged'
  );
});

test('configFingerprint handles undefined and empty clients', () => {
  const a = configFingerprint(undefined, '2024-01-01');
  assert.equal(a, `|2024-01-01|projects:on|pricing:${pricingFingerprint()}`, 'undefined clients should produce empty string before pipe');

  const b = configFingerprint('', '2024-01-01');
  assert.equal(b, `|2024-01-01|projects:on|pricing:${pricingFingerprint()}`, 'empty clients should produce same as undefined');

  const c = configFingerprint('claude', undefined);
  assert.match(c, /\|undefined\|projects:on\|pricing:[0-9a-f]{64}$/, 'undefined allTimeSince produces string "undefined"');
});

test('configFingerprint labels the Qoder CN database path explicitly', () => {
  const dbPath = path.join(os.tmpdir(), 'QoderCN', 'SharedClientCache', 'cache', 'db', 'local.db');
  const fingerprint = configFingerprint(
    'claude,qodercn',
    '2024-01-01',
    true,
    dbPath
  );
  assert.equal(
    fingerprint,
    `claude,qodercn|2024-01-01|projects:on|qodercn:${path.resolve(dbPath)}|pricing:${pricingFingerprint()}`
  );
});

test('configFingerprint invalidates the anchor when a custom scan path changes', () => {
  const scanPath = process.platform === 'win32' ? 'C:\\tmp\\claude-alt' : '/tmp/claude-alt';
  const other = process.platform === 'win32' ? 'C:\\tmp\\claude-other' : '/tmp/claude-other';
  const none = configFingerprint('claude', '2024-01-01', true, '', '');
  // No custom paths keeps the legacy fingerprint, so existing anchors stay valid on upgrade.
  assert.equal(configFingerprint('claude', '2024-01-01', true, '', '', {}), none);
  assert.equal(configFingerprint('claude', '2024-01-01', true, '', '', null), none);
  assert.equal(configFingerprint('claude', '2024-01-01', true, '', '', { claude: [] }), none);
  // Adding a path changes the fingerprint; a different path changes it again.
  const withPath = configFingerprint('claude', '2024-01-01', true, '', '', { claude: [scanPath] });
  assert.notEqual(withPath, none);
  assert.notEqual(configFingerprint('claude', '2024-01-01', true, '', '', { claude: [other] }), withPath);
});

test('anchored tick with valid anchor runs todayOnly scan and derives month/allTime', async () => {
  const dateKey = localTodayKey();

  // Establish a baseline anchor from a "previous full scan"
  const anchorToday = emptyPeriod();
  anchorToday.totalTokens = 50;
  anchorToday.clients = { claude: 50 };

  const anchorMonth = emptyPeriod();
  anchorMonth.totalTokens = 500;
  anchorMonth.clients = { claude: 500 };

  const anchorAllTime = emptyPeriod();
  anchorAllTime.totalTokens = 5000;
  anchorAllTime.clients = { claude: 5000 };

  const anchor = { dateKey, today: anchorToday, month: anchorMonth, allTime: anchorAllTime };

  // Stub tokscale to return a delta: today jumped from 50 to 130
  let tokscaleCalls = 0;
  async function stubTokscale() {
    tokscaleCalls += 1;
    return { entries: [{ client: 'claude', sessionId: 's1', model: 'claude-opus', input: 80, output: 0, cost: 0 }] };
  }

  const summary = await collectUsageOnce({
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    todayOnlyAnchor: anchor,
    wslAnchor: emptyWslBundle(),
    runTokscale: stubTokscale,
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] })
  });

  // Only one tokscale call (--today), not three
  assert.equal(tokscaleCalls, 1, 'anchored tick must only run one tokscale scan');

  // today = 80 (from stub; anchor was 50)
  assert.equal(summary.today.totalTokens, 80, 'today should come from fresh scan');

  // month = anchor month 500 + (today 80 - anchor today 50) = 530
  assert.equal(summary.month.totalTokens, 530, 'month should be derived via applyPeriodDelta');

  // allTime = anchor allTime 5000 + (today 80 - anchor today 50) = 5030
  assert.equal(summary.allTime.totalTokens, 5030, 'allTime should be derived via applyPeriodDelta');
});

test('anchored tick replaces a stale anchor title with the freshly resolved rename', async () => {
  const dateKey = localTodayKey();
  const sessionKey = 'cursor:conv-1';
  const makeSession = (title, totalTokens) => ({
    client: 'cursor',
    sessionId: 'conv-1',
    totalTokens,
    models: { 'cursor-model': totalTokens },
    ...(title ? { title } : {})
  });

  const anchorToday = emptyPeriod();
  anchorToday.totalTokens = 50;
  anchorToday.clients = { cursor: 50 };
  anchorToday.sessions = { [sessionKey]: makeSession('Old name', 50) };

  const anchorMonth = emptyPeriod();
  anchorMonth.totalTokens = 500;
  anchorMonth.clients = { cursor: 500 };
  anchorMonth.sessions = { [sessionKey]: makeSession('Old name', 500) };

  const anchorAllTime = emptyPeriod();
  anchorAllTime.totalTokens = 5000;
  anchorAllTime.clients = { cursor: 5000 };
  anchorAllTime.sessions = { [sessionKey]: makeSession('Old name', 5000) };

  const summary = await collectUsageOnce({
    clients: 'cursor',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'dev1',
    limitsEnabled: false,
    historyEnabled: false,
    todayOnlyAnchor: { dateKey, today: anchorToday, month: anchorMonth, allTime: anchorAllTime },
    runTokscale: async () => ({
      entries: [{ client: 'cursor', sessionId: 'conv-1', model: 'cursor-model', input: 55, output: 0, cost: 0 }]
    }),
    sessionMetadataDeps: {
      sessionMetadataResolvers: new Map([['cursor', (ids) => {
        assert.ok(ids.has('conv-1'));
        return new Map([['conv-1', { title: 'New name' }]]);
      }]])
    },
    collectWslUsage: async () => ({ bundle: { today: null, month: null, allTime: null, detected: [], homes: [] }, detected: [] })
  });

  assert.equal(summary.today.sessions[sessionKey].title, 'New name');
  assert.equal(summary.month.sessions[sessionKey].title, 'New name', 'a rename must reach the derived month window');
  assert.equal(summary.allTime.sessions[sessionKey].title, 'New name', 'a rename must reach the derived all-time window');
});

test('restart restores local T3 title provenance and clears deleted titles on the first watch scan', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-t3-anchor-'));
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  const updates = [];
  let deleted = false;
  let scans = 0;
  let handle;
  const options = {
    ...baseOptions, homeDir: tmpShared, projectsEnabled: false,
    intervalMs: 60 * 60 * 1000, watchEnabled: false, wslScanEnabled: false,
    runTokscale: async () => {
      scans++;
      return { entries: [{ client: 'claude', sessionId: 'native', model: 'claude-opus', input: 10, output: 0, cost: 0 }] };
    },
    sessionMetadataDeps: {
      sessionMetadataResolvers: new Map([['claude', (ids, { deps }) => {
        assert.ok(ids.has('native'));
        if (deleted) {
          deps.invalidatedTitleKeys.add('claude:native');
          return new Map();
        }
        return new Map([['native', { title: 'T3 title', t3Title: 'T3 title', titleOnly: true }]]);
      }]])
    },
    onUpdate: (summary) => updates.push(summary)
  };
  try {
    handle = freshCollector().startCollector(options);
    await waitForCondition(() => updates.length === 1);
    handle.stop();
    handle = null;
    assert.equal(scans, 3);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpShared, 'collector-anchor.json'), 'utf8'));
    assert.deepEqual(saved.t3Titles, { 'claude:native': 'T3 title' });
    assert.equal(Object.hasOwn(updates[0], 't3Titles'), false);
    assert.equal(Object.hasOwn(updates[0].today.sessions['claude:native'], 't3Title'), false);

    deleted = true;
    handle = freshCollector().startCollector(options);
    await waitForCondition(() => updates.length === 2);
    assert.equal(scans, 4, 'restart uses the persisted anchor and scans only today');
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(updates[1][period].sessions['claude:native'].title || '', '');
      assert.equal(updates[1][period].totalTokens, 10);
    }
  } finally {
    if (handle) handle.stop();
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

for (const update of ['deleted', 'renamed']) {
  test(`a confirmed T3 ${update} title survives reader failure and restart without moving usage anchors`, async () => {
    const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-t3-lifetime-'));
    const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
    process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
    let state = 'original';
    let scans = 0;
    let handle;
    const updates = [];
    const expected = update === 'deleted' ? '' : 'New T3 title';
    const options = {
      ...baseOptions, homeDir: tmpShared, projectsEnabled: false,
      intervalMs: 60 * 60 * 1000, watchEnabled: false, wslScanEnabled: false,
      runTokscale: async ({ flags }) => {
        scans++;
        const input = flags.includes('--month') ? 100 : flags.includes('--since') ? 1000 : state === 'original' ? 10 : 20;
        return { entries: [{ client: 'claude', sessionId: 'native', model: 'claude-opus', input, output: 0, cost: 0 }] };
      },
      sessionMetadataDeps: {
        sessionMetadataResolvers: new Map([['claude', (ids, { deps }) => {
          assert.ok(ids.has('native'));
          if (state === 'deleted' || (state === 'failure' && deps.t3Titles['claude:native'] === null)) {
            deps.invalidatedTitleKeys.add('claude:native');
            return new Map();
          }
          const title = state === 'failure' ? deps.t3Titles['claude:native'] : state === 'renamed' ? 'New T3 title' : 'Old T3 title';
          return title ? new Map([['native', { title, t3Title: title, titleOnly: true }]]) : new Map();
        }]])
      },
      onUpdate: (summary) => updates.push(summary)
    };
    const check = (summary) => {
      for (const period of ['today', 'month', 'allTime']) assert.equal(summary[period].sessions['claude:native'].title || '', expected);
      assert.equal(summary.today.totalTokens, 20);
      assert.equal(summary.month.totalTokens, 110);
      assert.equal(summary.allTime.totalTokens, 1010);
    };
    try {
      handle = freshCollector().startCollector(options);
      await waitForCondition(() => updates.length === 1);
      const file = path.join(tmpShared, 'collector-anchor.json');
      const original = JSON.parse(fs.readFileSync(file, 'utf8'));
      state = update;
      await handle.refreshClient('claude');
      check(updates.at(-1));
      const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
      assert.deepEqual(saved.todayT3Titles, { 'claude:native': update === 'deleted' ? null : 'New T3 title' });
      for (const period of ['today', 'month', 'allTime']) {
        const { title: _oldTitle, ...before } = original[period].sessions['claude:native'];
        const { title: _newTitle, ...after } = saved[period].sessions['claude:native'];
        assert.deepEqual(after, before);
        assert.equal(saved[period].totalTokens, original[period].totalTokens);
        assert.equal(saved[period].sessions['claude:native'].title || '', expected);
      }
      assert.equal(saved.fullScanAt, original.fullScanAt);
      const seed = require('../../src/shared/anchorSeed').deviceRecordFromAnchor(saved, {
        clients: 'claude', allTimeSince: baseOptions.allTimeSince, projectsEnabled: false, homeDir: tmpShared
      });
      for (const period of ['today', 'month', 'allTime']) assert.equal(seed[period].sessions['claude:native'].title || '', expected);
      state = 'failure';
      await handle.refreshClient('claude');
      check(updates.at(-1));
      assert.equal(fs.readFileSync(file, 'utf8'), JSON.stringify(saved), 'unchanged title state does not rewrite the anchor');
      handle.stop();
      handle = null;
      const beforeRestart = scans;
      const beforeUpdates = updates.length;
      handle = freshCollector().startCollector(options);
      await waitForCondition(() => updates.length > beforeUpdates);
      assert.equal(scans - beforeRestart, 1);
      check(updates.at(-1));
    } finally {
      if (handle) handle.stop();
      if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
      else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
      delete require.cache[collectorPath];
      fs.rmSync(tmpShared, { recursive: true, force: true });
    }
  });
}

test('full anchors persist local-only Reasonix native views alongside aggregate periods', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-anchor-'));
  const nativeView = {
    sessions: { today: { 'reasonix:session': { client: 'reasonix', totalTokens: 12 } }, month: {}, allTime: {} },
    projects: { today: { 'token monitor': { label: 'token-monitor', tokens: 12, clients: { reasonix: 12 } } }, month: {}, allTime: {} }
  };
  const nativeCache = { getView: () => nativeView };
  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      clients: 'reasonix',
      projectsEnabled: true,
      platform: 'linux',
      wslScanEnabled: false,
      reasonixNativeSessionsEnabled: true,
      reasonixNativeSessionCache: nativeCache,
      runTokscale: async () => ({ entries: [] }),
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: (summary) => updates.push(summary)
    });

    await waitForCondition(() => updates.length === 1);
    const saved = JSON.parse(fs.readFileSync(path.join(tmpShared, 'collector-anchor.json'), 'utf8'));
    assert.equal(saved.cursorAutoModelVersion, 1);
    assert.equal(saved.qoderCnModelVersion, 2);
    assert.deepEqual(saved.nativeSessions, nativeView.sessions);
    assert.deepEqual(saved.nativeProjects, nativeView.projects);
  } finally {
    if (handle) try { handle.stop(); } catch (_) {}
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}

function mkPeriod() {
  return { totalTokens: 50, costUsd: 0, clients: { claude: 50 }, clientCosts: {}, models: {}, modelCosts: {}, clientModels: {}, clientModelCosts: {}, sessions: {} };
}

test('restart reuse: anchor file on disk enables todayOnly on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-restart-'));
  const dateKey = localTodayKey();

  // Write a valid anchor file to the isolated shared dir
  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: new Date(Date.now() - 300000).toISOString() // 5 minutes ago — within the 1h safety window
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  // Mock spawn BEFORE freshCollector so the re-required module picks it up
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    // Wait for the first interval tick
    await waitForCondition(() => updates.length === 1);
    // With a valid anchor on disk, the first tick should be todayOnly (1 spawn)
    assert.equal(calls.length, 1, 'anchor from disk enables todayOnly — one spawn, not three');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('future fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-future-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: new Date(Date.now() + 3600000).toISOString() // 1 hour in the future
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Future fullScanAt should force a full 3-scan tick
    assert.equal(calls.length, 3, 'future fullScanAt forces full scan — three spawns, not one');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('missing fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-missing-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  // Valid anchor, but no fullScanAt field (old format or corrupted)
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01')
    // no fullScanAt — triggers lastFullScanAt = 0 → full scan
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Missing fullScanAt → lastFullScanAt = 0 → forces full scan
    assert.equal(calls.length, 3, 'missing fullScanAt forces full scan — three spawns');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('unparseable fullScanAt forces a full scan on first interval tick', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-bad-ts-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(path.join(tmpShared), { recursive: true });
  // Valid anchor, but fullScanAt is not a parseable date: Date.parse -> NaN,
  // Number.isFinite(NaN) is false, so lastFullScanAt stays 0 -> full scan.
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: null,
    configFingerprint: configFingerprint('claude', '2024-01-01'),
    fullScanAt: 'not-a-timestamp'
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    // Unparseable fullScanAt → lastFullScanAt = 0 → forces full scan
    assert.equal(calls.length, 3, 'unparseable fullScanAt forces full scan — three spawns');
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('WSL toggle off: persisted wslAnchor is not merged into warm previews', async () => {
  const tmpShared = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-off-'));
  const dateKey = localTodayKey();

  fs.mkdirSync(tmpShared, { recursive: true });
  // Seed a persisted anchor that still carries a WSL bundle, as if WSL scanning
  // was ON during the last full scan. No fullScanAt -> the first tick is a full
  // scan, so progressive previews fire (the only place wslAnchor is read without
  // the wslScanEnabled gate).
  const wslPeriod = { ...emptyPeriod(), totalTokens: 999, clients: { claude: 999 } };
  const anchorData = {
    dateKey,
    today: mkPeriod(), month: mkPeriod(), allTime: mkPeriod(),
    wslBundle: { today: wslPeriod, month: wslPeriod, allTime: wslPeriod },
    configFingerprint: configFingerprint('claude', '2024-01-01')
    // no fullScanAt -> forces a full scan on the first interval tick
  };
  fs.writeFileSync(path.join(tmpShared, 'collector-anchor.json'), JSON.stringify(anchorData));

  // Host scan returns empty entries -> host periods are 0. If the persisted WSL
  // bundle leaks into a preview it shows totalTokens 999 instead of 0.
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  childProcess.spawn = () => {
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  const originalSharedDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = tmpShared;
  let handle;
  try {
    const { startCollector } = freshCollector();
    const previews = [];
    const updates = [];
    handle = startCollector({
      ...baseOptions,
      wslScanEnabled: false,
      intervalMs: 60 * 60 * 1000,
      watchEnabled: false,
      onPreview: (p) => previews.push(p),
      onUpdate: () => updates.push(true)
    });

    await waitForCondition(() => updates.length === 1);
    assert.ok(previews.length >= 1, 'a full-scan tick must emit at least one preview');
    for (const p of previews) {
      assert.equal(p.today.totalTokens, 0, 'preview today must not carry the persisted WSL bundle when the toggle is off');
      if (p.month) assert.equal(p.month.totalTokens, 0, 'preview month must not carry persisted WSL when off');
    }
    // Final summary is host-only too (collectWsl is never called when off).
    handle.stop();
  } finally {
    childProcess.spawn = originalSpawn;
    if (originalSharedDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = originalSharedDir;
    if (handle) try { handle.stop(); } catch (_) {}
    delete require.cache[collectorPath];
    fs.rmSync(tmpShared, { recursive: true, force: true });
  }
});

test('cross-day anchor invalidation: stale dateKey triggers full scan', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = () => {
    calls.push('spawn');
    const { EventEmitter } = require('node:events');
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.stdin = { end: () => {} };
    child.kill = () => {};
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ entries: [] })));
      child.emit('close', 0);
    });
    return child;
  };

  try {
    const { collectUsageOnce } = freshCollector();
    const { emptyPeriod } = require('../../src/shared/usage');
    const anchor = { dateKey: '2020-01-01', today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
    await collectUsageOnce({ ...baseOptions, todayOnlyAnchor: anchor });
    assert.equal(calls.length, 3, 'stale dateKey anchor should trigger full 3-scan tick');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

function waitForCondition(predicate, timeoutMs = 4000) {
  if (predicate()) return Promise.resolve();
  return new Promise((resolve, reject) => {
    const startedAt = Date.now();
    const interval = setInterval(() => {
      if (predicate()) {
        clearInterval(interval);
        resolve();
      } else if (Date.now() - startedAt > timeoutMs) {
        clearInterval(interval);
        reject(new Error('Timed out waiting for condition'));
      }
    }, 5);
  });
}

test('anchor trust separates "cannot be reused" from "cannot be dated"', () => {
  // One policy, two consumers: startCollector reuses the periods and only loses
  // its incremental shortcut when the capture time is unusable, while the
  // widget's cold-start seed has nothing to stand on and declines. Keeping that
  // split in one function is what stops the two from drifting apart.
  const { collectorAnchorTrust, configFingerprint } = freshCollector();
  const now = new Date(2026, 7, 8, 10, 0, 0);
  const anchor = (overrides = {}) => ({
    dateKey: '2026-08-08',
    today: {}, month: {}, allTime: {},
    configFingerprint: configFingerprint('claude', '2024-01-01', true),
    fullScanAt: new Date(now.getTime() - 60_000).toISOString(),
    ...overrides
  });
  const options = { clients: 'claude', allTimeSince: '2024-01-01', projectsEnabled: true, now };

  assert.equal(collectorAnchorTrust(anchor(), options).capturedAtMs, now.getTime() - 60_000);

  // Unusable outright.
  assert.equal(collectorAnchorTrust(null, options), null);
  assert.equal(collectorAnchorTrust(anchor({ dateKey: '2026-08-07' }), options), null);
  assert.equal(collectorAnchorTrust(anchor({ allTime: null }), options), null);
  assert.equal(collectorAnchorTrust(anchor(), { ...options, clients: 'claude,codex' }), null);
  assert.equal(collectorAnchorTrust(anchor(), { ...options, projectsEnabled: false }), null);

  // A custom scan path added after the anchor was written invalidates it; an
  // anchor whose fingerprint already covers that path stays trusted.
  const scanPath = process.platform === 'win32' ? 'C:\\tmp\\claude-alt' : '/tmp/claude-alt';
  assert.equal(collectorAnchorTrust(anchor(), { ...options, customScanPaths: { claude: [scanPath] } }), null);
  const scannedAnchor = anchor({ configFingerprint: configFingerprint('claude', '2024-01-01', true, '', '', { claude: [scanPath] }) });
  assert.equal(
    collectorAnchorTrust(scannedAnchor, { ...options, customScanPaths: { claude: [scanPath] } }).capturedAtMs,
    now.getTime() - 60_000
  );

  // Usable, but undatable.
  assert.equal(collectorAnchorTrust(anchor({ fullScanAt: undefined }), options).capturedAtMs, null);
  assert.equal(collectorAnchorTrust(anchor({ fullScanAt: 'nope' }), options).capturedAtMs, null);
  const future = new Date(now.getTime() + 60_000).toISOString();
  assert.equal(collectorAnchorTrust(anchor({ fullScanAt: future }), options).capturedAtMs, null);
});

test('Cursor anchors from before the Auto model rename require a full scan', () => {
  const { collectorAnchorTrust, configFingerprint } = freshCollector();
  const now = new Date(2026, 7, 8, 10, 0, 0);
  const options = { clients: 'cursor', allTimeSince: '2024-01-01', now };
  const anchor = {
    dateKey: '2026-08-08', today: {}, month: {}, allTime: {},
    configFingerprint: configFingerprint('cursor', '2024-01-01'),
    fullScanAt: new Date(now.getTime() - 60_000).toISOString()
  };
  assert.equal(collectorAnchorTrust(anchor, options), null);
  assert.equal(collectorAnchorTrust({ ...anchor, cursorAutoModelVersion: 1 }, options).capturedAtMs, now.getTime() - 60_000);
});

test('Qoder CN anchors from before the app-side model mapping require a full scan', () => {
  const { collectorAnchorTrust, configFingerprint } = freshCollector();
  const now = new Date(2026, 7, 8, 10, 0, 0);
  const options = { clients: 'qodercn', allTimeSince: '2024-01-01', now };
  const anchor = {
    dateKey: '2026-08-08', today: {}, month: {}, allTime: {},
    configFingerprint: configFingerprint('qodercn', '2024-01-01'),
    fullScanAt: new Date(now.getTime() - 60_000).toISOString()
  };
  assert.equal(collectorAnchorTrust(anchor, options), null);
  assert.equal(collectorAnchorTrust({ ...anchor, qoderCnModelVersion: 1 }, options), null);
  assert.equal(collectorAnchorTrust({ ...anchor, qoderCnModelVersion: 2 }, options).capturedAtMs, now.getTime() - 60_000);
  // Other clients do not need the Qoder CN stamp.
  const codex = { ...anchor, configFingerprint: configFingerprint('codex', '2024-01-01') };
  assert.equal(collectorAnchorTrust(codex, { ...options, clients: 'codex' }).capturedAtMs, now.getTime() - 60_000);
});

test('flat catalog project provenance requires a full scan instead of guessing period sources', () => {
  const { collectorAnchorTrust, configFingerprint } = freshCollector();
  const now = new Date(2026, 7, 8, 10, 0, 0);
  const options = { clients: 'antigravity', allTimeSince: '2024-01-01', now };
  const anchor = {
    dateKey: '2026-08-08', today: {}, month: {}, allTime: {},
    configFingerprint: configFingerprint('antigravity', '2024-01-01'),
    fullScanAt: new Date(now.getTime() - 60000).toISOString(),
    catalogProjects: { 'antigravity:session': 'project-a' }
  };
  assert.equal(collectorAnchorTrust(anchor, options), null);
  assert.ok(collectorAnchorTrust({ ...anchor, catalogProjects: { today: { 'antigravity:session': 'project-a' }, month: {}, allTime: {} } }, options));
});

for (const scenario of ['cross-client', 'native', 'locked', 'partial', 'missing', 'empty', 'unsupported', 'corrupt']) test(`old persisted anchors retain identity migration through refresh and restart: ${scenario}`, async t => {
  const nativeChild = scenario === 'native';
  const retryable = ['locked', 'partial'].includes(scenario);
  const unavailable = ['missing', 'empty', 'unsupported', 'corrupt'].includes(scenario);
  const { DatabaseSync } = require('node:sqlite');
  const { normalizePeriod } = require('../../src/shared/usage');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-identity-anchor-'));
  const previousDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = home;
  let handle;
  let lock;
  t.after(() => {
    lock?.close();
    handle?.stop();
    if (previousDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previousDir;
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  });
  const native = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const childNative = nativeChild ? 'cccccccc-cccc-cccc-cccc-cccccccccccc' : 'opaque-devin';
  const childClient = nativeChild ? 'codex' : 'devin';
  const childId = nativeChild ? 'historical-child' : childNative;
  const childKey = `${childClient}:${childId}`;
  const historyDir = path.join(home, '.codex', 'sessions');
  fs.mkdirSync(historyDir, { recursive: true });
  fs.writeFileSync(path.join(historyDir, 'historical.jsonl'), JSON.stringify({ type: 'session_meta', payload: { id: native } }) + '\n');
  if (nativeChild) fs.writeFileSync(path.join(historyDir, `${childId}.jsonl`), JSON.stringify({ type: 'session_meta', payload: { id: childNative } }) + '\n');
  const dbPath = path.join(home, 't3.sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec(`CREATE TABLE orchestration_v2_projection_threads (thread_id TEXT PRIMARY KEY, deleted_at TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_provider_threads (provider_thread_id TEXT PRIMARY KEY, thread_id TEXT, driver TEXT, payload_json TEXT);
    CREATE TABLE orchestration_v2_projection_nodes (node_id TEXT PRIMARY KEY, thread_id TEXT, root_node_id TEXT, kind TEXT, provider_thread_id TEXT);`);
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, NULL, ?)').run('app-thread', '{}');
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run('provider', 'app-thread', 'codex',
    JSON.stringify({ nativeThreadRef: { nativeId: native, driver: 'codex', strength: 'strong' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_threads VALUES (?, NULL, ?)').run('devin-app', JSON.stringify({
    lineage: { parentThreadId: 'app-thread', relationshipToParent: 'subagent' },
    forkedFrom: { type: 'node', nodeId: 'task' }
  }));
  db.prepare('INSERT INTO orchestration_v2_projection_provider_threads VALUES (?, ?, ?, ?)').run('devin-provider', 'devin-app', nativeChild ? 'codex' : 'acpRegistry',
    JSON.stringify({ providerInstanceId: 'configured-devin', nativeThreadRef: { nativeId: childNative, driver: nativeChild ? 'codex' : 'acpRegistry', strength: 'strong' } }));
  db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run('root', 'app-thread', 'root', 'root_turn', 'provider');
  db.prepare('INSERT INTO orchestration_v2_projection_nodes VALUES (?, ?, ?, ?, ?)').run('task', 'app-thread', 'root', 'subagent', 'devin-provider');
  fs.writeFileSync(path.join(home, 'settings.json'), JSON.stringify({ providerInstances: { 'configured-devin': { driver: 'acpRegistry', config: { agentId: 'devin' } } } }));
  db.close();
  if (scenario === 'locked') { lock = new DatabaseSync(dbPath); lock.exec('BEGIN EXCLUSIVE'); }
  if (unavailable) {
    fs.rmSync(dbPath);
    if (scenario === 'corrupt') fs.writeFileSync(dbPath, 'not sqlite');
    else if (scenario !== 'missing') {
      const empty = new DatabaseSync(dbPath);
      if (scenario === 'unsupported') empty.exec('CREATE TABLE unrelated (id TEXT)');
      empty.close();
    }
  }
  const period = (history = false) => normalizePeriod({ totalTokens: history ? 40 : 10, costUsd: history ? 4 : 1,
    sessions: { 'codex:today': { client: 'codex', sessionId: 'today', totalTokens: 10, costUsd: 1 },
      ...(history ? { 'codex:historical': { client: 'codex', sessionId: 'historical', totalTokens: 10, costUsd: 1 },
        [childKey]: { client: childClient, sessionId: childId, totalTokens: 20, costUsd: 2,
          ...(nativeChild ? { parentSessionId: 'today' } : {}) } } : {}) } });
  const file = path.join(home, 'collector-anchor.json');
  const capturedAt = new Date().toISOString();
  const anchorPeriods = { today: period(), month: period(true), allTime: period(true) };
  if (nativeChild) for (const period of ['month', 'allTime']) anchorPeriods[period].sessions[childKey].parentClient = 'codex';
  fs.writeFileSync(file, JSON.stringify({ dateKey: localTodayKey(), ...anchorPeriods,
    configFingerprint: configFingerprint('codex', '2024-01-01', false), fullScanAt: capturedAt, sessionIdentityVersion: 1 }));
  const scans = [], resolved = [], updates = [];
  let relationReads = 0;
  let failLater = scenario === 'partial';
  const identityTargets = [];
  const codexMetadata = require('../../src/shared/providers/codex/sessionMetadata');
  const originalIdentities = codexMetadata.resolveSessionIdentities;
  codexMetadata.resolveSessionIdentities = (ids, context) => { identityTargets.push([...ids]); return originalIdentities(ids, context); };
  t.after(() => { codexMetadata.resolveSessionIdentities = originalIdentities; });
  class ObservedDatabase extends DatabaseSync {
    prepare(sql) {
      if (failLater && sql.includes('SELECT cp.thread_id')) {
        throw Object.assign(new Error('database is locked'), { errcode: 5 });
      }
      if (sql.includes('SELECT p.driver,') && !sql.includes('1 AS historical')) relationReads++;
      return super.prepare(sql);
    }
  }
  const options = { ...baseOptions, clients: 'codex', homeDir: home, projectsEnabled: false,
    intervalMs: 3600000, watchEnabled: false, wslScanEnabled: false, sessionActivityPolling: false,
    runTokscale: async ({ flags }) => {
      scans.push(flags);
      return { entries: [{ client: 'codex', sessionId: 'today', model: 'gpt-test', input: 20, output: 0, cost: 2 }] };
    },
    sessionMetadataDeps: { env: {}, sqlite: { DatabaseSync: ObservedDatabase }, t3DbPaths: [dbPath], sessionMetadataResolvers: new Map([['codex', ids => {
      resolved.push(...ids);
      return new Map([...ids].map(id => [id, { nativeSessionId: native }]));
    }]]) },
    onUpdate: summary => updates.push(summary) };
  handle = freshCollector().startCollector(options);
  await waitForCondition(() => updates.length === 1);
  await handle.whenIdle();
  const { sessionRowsForPeriod, groupSessionRows } = require('../../src/electron/renderer/sessionRows');
  const checkFamily = summary => {
    for (const period of ['month', 'allTime']) {
      const child = summary[period].sessions[childKey];
      assert.ok(['today', 'historical'].includes(child.parentSessionId));
      assert.equal(child.parentClient, nativeChild ? undefined : 'codex');
      if (nativeChild) assert.equal(child.parentSessionId, 'today', 'native parent takes precedence over the T3-selected historical parent');
      const [group, ...others] = groupSessionRows(sessionRowsForPeriod(summary[period]));
      assert.equal(others.length, 0);
      assert.equal(group.subagentCount, 1);
      assert.equal(group.groupRows.length, 3);
      assert.equal(group.value, 50);
      assert.equal(group.cost, 5);
    }
  };
  if (retryable || unavailable) {
    assert.equal(updates[0].month.sessions[childKey].parentSessionId, undefined);
    assert.equal(updates[0].month.sessions[childKey].t3ThreadId, undefined, 'no partial T3 identity is applied');
    const failed = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(failed.sessionIdentityVersion, retryable ? 1 : 2);
    assert.equal(failed.month.sessions[childKey].parentSessionId, undefined);
    assert.equal(failed.month.totalTokens, 40);
    assert.equal(failed.fullScanAt, capturedAt);
  } else checkFamily(updates[0]);
  if (retryable) {
    handle.stop(); handle = null;
    handle = freshCollector().startCollector(options);
    await waitForCondition(() => updates.length === 2);
    await handle.whenIdle();
    assert.equal(updates[1].month.sessions[childKey].parentSessionId, undefined, 'restart while blocked still publishes no partial link');
    assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).sessionIdentityVersion, 1, 'restart preserves the pending upgrade');
  }
  lock?.exec('ROLLBACK'); lock?.close(); lock = null;
  failLater = false;
  const migrationsAfterFirst = identityTargets.length;
  assert.equal(relationReads, scenario === 'locked' || unavailable ? 0 : scenario === 'partial' ? 2 : 1, 'one migration relationship read');
  assert.equal(scans.length, retryable ? 2 : 1, 'migration uses the ordinary today scan, never new historical token scans');
  await handle.tick('watch', { todayOnly: true });
  await handle.whenIdle();
  assert.equal(updates.length, retryable ? 3 : 2);
  if (!unavailable) checkFamily(updates.at(-1));
  else {
    assert.equal(updates[1].month.sessions['codex:historical'].nativeSessionId, native);
    assert.equal(identityTargets.length, migrationsAfterFirst, 'terminal absence does not resolve historical identities again');
  }
  assert.equal(relationReads, unavailable ? 0 : scenario === 'locked' ? 1 : scenario === 'partial' ? 3 : 2, 'one lookup per eligible tick');
  assert.equal(resolved.includes('historical'), false, 'migration only reads identity headers, never full historical metadata');
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(saved.sessionIdentityVersion, 2);
  assert.equal(saved.fullScanAt, capturedAt, 'metadata migration does not pretend to be a new full scan');
  assert.equal(saved.today.totalTokens, 10, 'frozen delta baseline is retained');
  assert.equal(saved.month.totalTokens, 40);
  assert.equal(saved.month.sessions['codex:historical'].nativeSessionId, native);
  assert.equal(saved.month.sessions['codex:historical'].t3ThreadId, unavailable ? undefined : 'app-thread');
  assert.equal(saved.month.sessions[childKey].t3ThreadId, unavailable ? undefined : 'devin-app', 'version-one anchors receive the child app identity');
  for (const period of ['month', 'allTime']) {
    assert.equal(saved[period].sessions[childKey].parentSessionId, updates.at(-1)[period].sessions[childKey].parentSessionId);
    assert.equal(saved[period].sessions[childKey].parentClient, nativeChild || unavailable ? undefined : 'codex', 'same-client links remove the redundant old namespace');
  }
  assert.equal(updates[0].month.totalTokens, 50, 'today delta is applied exactly once');
  assert.equal(updates[0].month.costUsd, 5);
  handle.stop();
  handle = null;
  resolved.length = 0;
  handle = freshCollector().startCollector(options);
  await waitForCondition(() => updates.length === (retryable ? 4 : 3));
  await handle.whenIdle();
  if (!unavailable) checkFamily(updates.at(-1));
  else assert.equal(identityTargets.length, migrationsAfterFirst, 'restart does not repeat terminal historical migration');
  assert.equal(relationReads, unavailable ? 0 : scenario === 'locked' ? 2 : scenario === 'partial' ? 4 : 3, 'restart preserves the single-read watch path');
  assert.deepEqual(scans, Array.from({ length: retryable ? 4 : 3 }, () => ['--today']), 'migration, next tick and restart scan only today');
  assert.equal(resolved.includes('historical'), false, 'upgraded anchors do not reread historical transcripts each tick');
  assert.equal(updates.at(-1).month.totalTokens, 50, 'warm restart never reapplies an already counted delta');
  assert.equal(updates.at(-1).month.sessions['codex:historical'].t3ThreadId, unavailable ? undefined : 'app-thread');
  assert.deepEqual(JSON.parse(fs.readFileSync(file, 'utf8')), saved, 'refresh and restart preserve the migrated anchor and frozen baseline');
});
