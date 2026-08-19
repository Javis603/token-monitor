'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionTimestamps } = require('../../src/shared/collector');
const { indexDshSessionHeaders } = require('../../src/shared/dshSessionFiles');

const collectorPath = require.resolve('../../src/shared/collector');
function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

test('applySessionTimestamps fills OpenCode session start/last from injected DB meta', () => {
  const periods = {
    today: {
      sessions: {
        'opencode:ses_abc': { client: 'opencode', sessionId: 'ses_abc', startedAt: '', lastUsedAt: '' }
      }
    }
  };
  const readOpencodeMeta = (ids) => {
    assert.ok(ids.has('ses_abc'));
    return new Map([['ses_abc', {
      startedAt: '2026-06-04T10:00:00.000Z',
      lastUsedAt: '2026-06-04T10:05:00.000Z',
      title: 'Greeting'
    }]]);
  };

  applySessionTimestamps(periods, '/no/such/home', { readOpencodeMeta });

  const s = periods.today.sessions['opencode:ses_abc'];
  assert.strictEqual(s.startedAt, '2026-06-04T10:00:00.000Z');
  assert.strictEqual(s.lastUsedAt, '2026-06-04T10:05:00.000Z');
});

test('applySessionTimestamps leaves non-opencode sessions to the file path (no DB reader call)', () => {
  const periods = {
    today: {
      sessions: {
        'claude:abc-123': { client: 'claude', sessionId: 'abc-123', startedAt: '', lastUsedAt: '' }
      }
    }
  };
  let called = false;
  const readOpencodeMeta = () => { called = true; return new Map(); };

  applySessionTimestamps(periods, '/no/such/home', { readOpencodeMeta });

  assert.strictEqual(called, false, 'opencode reader must not run when there are no opencode sessions');
});

test('applySessionTimestamps reuses resolved metadata across progressive periods', () => {
  const cache = { metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set() };
  const calls = [];
  const readOpencodeMeta = (ids) => {
    calls.push([...ids]);
    return new Map([...ids].map((id) => [id, { projectPath: `/work/${id}` }]));
  };
  const today = { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' }
  } };
  const month = { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' },
    'opencode:s2': { client: 'opencode', sessionId: 's2' }
  } };

  applySessionTimestamps({ today }, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps({ today, month }, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps({ today, month }, '/home/test', { ...cache, readOpencodeMeta });

  assert.deepEqual(calls, [['s1'], ['s2']]);
  assert.equal(month.sessions['opencode:s1'].projectLabel, 's1');
  assert.equal(month.sessions['opencode:s2'].projectLabel, 's2');
});

test('applySessionTimestamps does not re-read an unchanged session file on the next tick', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tick-'));
  const realOpen = fs.openSync;
  try {
    const dir = path.join(home, '.claude', 'projects', '-work-app');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'sess-1.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ cwd: '/work/app', timestamp: '2026-07-13T10:00:00.000Z' })}\n`);

    let opens = 0;
    fs.openSync = (target, ...rest) => { if (target === file) opens += 1; return realOpen(target, ...rest); };

    // Each collector tick rebuilds the per-tick dedup caches, so persistence
    // must survive a fresh deps object — that is what a real interval tick sees.
    // applySessionTimestamps mutates the periods object in place.
    const tick = () => {
      const periods = { today: { sessions: { 'claude:sess-1': { client: 'claude', sessionId: 'sess-1' } } } };
      applySessionTimestamps(periods, home, {
        metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set()
      });
      return periods.today.sessions['claude:sess-1'];
    };

    tick(); // first tick warms the caches
    opens = 0;
    const unchanged = tick(); // second tick, file untouched
    assert.equal(opens, 0, 'an unchanged session file must not be re-read on the next tick');
    assert.equal(unchanged.projectLabel, 'app');
    assert.equal(unchanged.lastUsedAt, '2026-07-13T10:00:00.000Z');

    // A grown session (new size/mtime) must invalidate the cache and refresh lastUsedAt.
    fs.appendFileSync(file, `${JSON.stringify({ cwd: '/work/app', timestamp: '2026-07-13T11:30:00.000Z' })}\n`);
    opens = 0;
    const grown = tick();
    assert.ok(opens > 0, 'a changed session file must be re-read');
    assert.equal(grown.lastUsedAt, '2026-07-13T11:30:00.000Z');
  } finally {
    fs.openSync = realOpen;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('applySessionTimestamps fills DSH session start/last from the transcript header and mtime', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-ts-'));
  try {
    const dir = path.join(home, '.dsh', 'sessions', 'proj', 'session-abc');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.jsonl');
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id: 'session-abc', createdAt: 1750000000000 })}\n`);
    const mtime = new Date('2026-07-01T12:00:00.000Z');
    fs.utimesSync(file, mtime, mtime);

    const periods = { today: { sessions: {
      'dsh:session-abc': { client: 'dsh', sessionId: 'session-abc' }
    } } };
    applySessionTimestamps(periods, home, {
      metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(),
      dshSessionFileCache: new Map()
    });

    const session = periods.today.sessions['dsh:session-abc'];
    assert.equal(session.startedAt, new Date(1750000000000).toISOString());
    assert.equal(session.lastUsedAt, mtime.toISOString());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('applySessionTimestamps retries a DSH session whose transcript is not yet on disk', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-miss-'));
  try {
    const cache = {
      metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(),
      dshSessionFileCache: new Map()
    };
    const periods = { today: { sessions: {
      'dsh:session-new': { client: 'dsh', sessionId: 'session-new' }
    } } };

    // First tick: the transcript has not been flushed to disk yet.
    applySessionTimestamps(periods, home, { ...cache, retryMisses: true });
    assert.equal(periods.today.sessions['dsh:session-new'].startedAt, undefined);

    // The file lands before the next tick.
    const dir = path.join(home, '.dsh', 'sessions', 'proj', 'session-new');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'session.jsonl'),
      `${JSON.stringify({ type: 'session', id: 'session-new', createdAt: 1750000000000 })}\n`
    );

    // Real ticks always pass retryMisses: true (collector.js's decorateLocalPeriods),
    // so a DSH session must not be permanently written off after one miss the
    // way the pre-fix generic fallback used to (it unconditionally poisoned
    // resolvedSessionKeys for any client without a dedicated resolver).
    applySessionTimestamps(periods, home, { ...cache, retryMisses: true });
    assert.equal(periods.today.sessions['dsh:session-new'].startedAt, new Date(1750000000000).toISOString());
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// DSH sessions are deliberately excluded from resolvedSessionKeys (so
// lastUsedAt keeps refreshing), which means every DSH id in scope is looked
// up again on every tick. That is only affordable if the lookup is a single
// walk over the DSH sessions tree shared by every id, not one walk per id —
// the O(ids x files) shape this regression guards against.
test('applySessionTimestamps walks the DSH sessions tree once per tick, not once per session id', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-index-'));
  try {
    const root = path.join(home, '.dsh', 'sessions');
    for (const id of ['s1', 's2', 's3']) {
      const dir = path.join(root, 'proj', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id, createdAt: 1750000000000 })}\n`);
    }

    let calls = 0;
    const countingIndex = (options) => { calls += 1; return indexDshSessionHeaders(options); };
    const periods = { today: { sessions: {
      'dsh:s1': { client: 'dsh', sessionId: 's1' },
      'dsh:s2': { client: 'dsh', sessionId: 's2' },
      'dsh:s3': { client: 'dsh', sessionId: 's3' }
    } } };

    applySessionTimestamps(periods, home, {
      metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(),
      dshSessionFileCache: new Map(),
      indexDshSessionHeaders: countingIndex
    });

    assert.equal(calls, 1, 'the sessions tree must be walked once, not once per session id');
    for (const id of ['s1', 's2', 's3']) {
      assert.equal(periods.today.sessions[`dsh:${id}`].startedAt, new Date(1750000000000).toISOString());
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// DSH sessions never join resolvedSessionKeys, so every known id is in scope
// again on the next tick — without a cache that would mean walking the whole
// tree on every tick forever, the exact perceived-UI-stutter cost this file's
// own comments describe avoiding for claude/codex. A known session's file
// path never changes, so a second tick for the same ids must not re-walk.
test('applySessionTimestamps does not re-walk the DSH tree for already-known sessions on the next tick', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-cache-'));
  try {
    const dir = path.join(home, '.dsh', 'sessions', 'proj', 's1');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id: 's1', createdAt: 1750000000000 })}\n`);

    let calls = 0;
    const countingIndex = (options) => { calls += 1; return indexDshSessionHeaders(options); };
    const cache = {
      metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(),
      dshSessionFileCache: new Map(), retryMisses: true,
      indexDshSessionHeaders: countingIndex
    };
    const tick = () => applySessionTimestamps(
      { today: { sessions: { 'dsh:s1': { client: 'dsh', sessionId: 's1' } } } }, home, cache
    );

    tick();
    assert.equal(calls, 1, 'first tick resolves the unknown id via one walk');
    tick();
    assert.equal(calls, 1, 'second tick must reuse the cached file path, not walk again');
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// The test above proves sessionTimestampMap's own caching logic works when a
// caller shares one deps object across calls — but collectUsageOnce (what a
// real collector tick actually calls) used to rebuild dshSessionFileCache
// fresh every time, which would have made that caching a no-op in production
// regardless of how correct the logic above is. This drives two real
// collectUsageOnce() calls, the way startCollector's tick loop does, with
// nothing shared between them except process-wide module state, and asserts
// the DSH sessions tree is only ever walked on the first one.
test('collectUsageOnce does not re-walk the DSH sessions tree on a second real tick', async () => {
  const { collectUsageOnce } = freshCollector();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-e2e-'));
  const sessionsRoot = path.join(home, '.dsh', 'sessions');
  const realReaddirSync = fs.readdirSync;
  try {
    const dir = path.join(sessionsRoot, 'proj', 'session-e2e');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id: 'session-e2e', createdAt: 1750000000000 })}\n`);

    // dshSessionFiles() walks the tree via fs.readdirSync(dir, {withFileTypes}).
    // Counting only calls rooted under the DSH sessions dir isolates "the
    // tree was walked" from every other readdirSync call a full tick makes
    // (tokscale client discovery, WSL probing, etc).
    let walks = 0;
    fs.readdirSync = (target, ...rest) => {
      if (typeof target === 'string' && target.startsWith(sessionsRoot)) walks += 1;
      return realReaddirSync(target, ...rest);
    };

    const stubTokscale = async () => ({
      entries: [{ client: 'dsh', sessionId: 'session-e2e', model: 'deepseek-v4-flash', input: 10, output: 5, cost: 0.001 }]
    });
    const baseOptions = {
      clients: 'dsh',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false,
      historyEnabled: false,
      homeDir: home,
      runTokscale: stubTokscale,
      collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] })
    };

    const first = await collectUsageOnce(baseOptions);
    assert.equal(first.today.sessions['dsh:session-e2e'].startedAt, new Date(1750000000000).toISOString());
    const walksAfterFirstTick = walks;
    assert.ok(walksAfterFirstTick > 0, 'the first real tick must discover the session via the tree walk');

    const second = await collectUsageOnce(baseOptions);
    assert.equal(second.today.sessions['dsh:session-e2e'].startedAt, new Date(1750000000000).toISOString());
    assert.equal(walks, walksAfterFirstTick, 'a second collectUsageOnce() call must not rebuild and re-walk the DSH tree');
  } finally {
    fs.readdirSync = realReaddirSync;
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

// dshPaths.js's resolveDshHome checks env.DSH_HOME before the homeDir it is
// given. `home` here is a scoped WSL distro, not this machine's own profile —
// a host-configured DSH_HOME leaking in would silently redirect the lookup
// back to the host path instead of the WSL one being decorated, the same
// class of bug tokscale's own use_env_roots: false (lib.rs) exists to avoid.
test('scopedHome DSH lookup ignores a host DSH_HOME override', () => {
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-wsl-'));
  const hostDshHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-host-'));
  try {
    const dir = path.join(wslHome, '.dsh', 'sessions', 'proj', 'session-wsl');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id: 'session-wsl', createdAt: 1750000000000 })}\n`);
    // hostDshHome deliberately has no matching session: if DSH_HOME leaked
    // through, the lookup would resolve here instead and find nothing.

    const periods = { today: { sessions: {
      'dsh:session-wsl': { client: 'dsh', sessionId: 'session-wsl' }
    } } };

    applySessionTimestamps(periods, wslHome, {
      metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set(),
      dshSessionFileCache: new Map(),
      scopedHome: true,
      env: { DSH_HOME: hostDshHome }
    });

    assert.equal(periods.today.sessions['dsh:session-wsl'].startedAt, new Date(1750000000000).toISOString());
  } finally {
    fs.rmSync(wslHome, { recursive: true, force: true });
    fs.rmSync(hostDshHome, { recursive: true, force: true });
  }
});

// One collector process decorates both the native home and every running WSL
// distro's home, and a cloned/migrated home can carry the same session id with
// a different header (and therefore a different createdAt). The DSH cache key
// must include the resolved sessions root, not just the session id — a bare-id
// key would let the second root reuse the first root's file path and
// timestamps.
test('applySessionTimestamps scopes the DSH cache by sessions root, not just session id', () => {
  const { applySessionTimestamps: applyFresh } = freshCollector();
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-native-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-wsl2-'));
  try {
    const id = 'session-shared';
    const nativeCreatedAt = 1750000000000;
    const wslCreatedAt = 1759999999999;
    for (const [home, createdAt] of [[nativeHome, nativeCreatedAt], [wslHome, wslCreatedAt]]) {
      const dir = path.join(home, '.dsh', 'sessions', 'proj', id);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'session.jsonl'), `${JSON.stringify({ type: 'session', id, createdAt })}\n`);
    }

    // No dshSessionFileCache injected on purpose: both calls share the
    // process-wide module cache, so the composite key is what keeps them apart.
    const nativePeriods = { today: { sessions: { [`dsh:${id}`]: { client: 'dsh', sessionId: id } } } };
    applyFresh(nativePeriods, nativeHome, { env: {} });
    assert.equal(nativePeriods.today.sessions[`dsh:${id}`].startedAt, new Date(nativeCreatedAt).toISOString());

    const wslPeriods = { today: { sessions: { [`dsh:${id}`]: { client: 'dsh', sessionId: id } } } };
    applyFresh(wslPeriods, wslHome, { scopedHome: true, env: {} });
    assert.equal(wslPeriods.today.sessions[`dsh:${id}`].startedAt, new Date(wslCreatedAt).toISOString());
  } finally {
    delete require.cache[collectorPath];
    fs.rmSync(nativeHome, { recursive: true, force: true });
    fs.rmSync(wslHome, { recursive: true, force: true });
  }
});

// An entry whose header was unreadable at index time falls back to the
// directory name, so it carries no createdAt and startedAt degrades to mtime.
// The header can later be rewritten (a torn first write followed by a complete
// one), so once the file's stat fingerprint changes the known path must be
// re-read to recover the real createdAt rather than staying pinned to that
// stale mtime forever.
test('applySessionTimestamps recovers createdAt once a torn header becomes readable', () => {
  const { applySessionTimestamps: applyFresh } = freshCollector();
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-dsh-recover-'));
  try {
    const id = 'session-recover';
    const dir = path.join(home, '.dsh', 'sessions', 'proj', id);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'session.jsonl');

    fs.writeFileSync(file, 'this is not a session header at all\n');
    const mtime1 = new Date('2026-07-01T10:00:00.000Z');
    fs.utimesSync(file, mtime1, mtime1);

    const tick = () => {
      const periods = { today: { sessions: { [`dsh:${id}`]: { client: 'dsh', sessionId: id } } } };
      applyFresh(periods, home, { env: {} });
      return periods.today.sessions[`dsh:${id}`];
    };

    const first = tick();
    assert.equal(first.startedAt, mtime1.toISOString(), 'no readable header yet, so startedAt falls back to mtime');

    const createdAt = 1750000000000;
    fs.writeFileSync(file, `${JSON.stringify({ type: 'session', id, createdAt })}\n`);
    const mtime2 = new Date('2026-07-01T11:00:00.000Z');
    fs.utimesSync(file, mtime2, mtime2);

    const second = tick();
    assert.equal(second.startedAt, new Date(createdAt).toISOString(), 'the rewritten header must be re-read to recover createdAt');
  } finally {
    delete require.cache[collectorPath];
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('applySessionTimestamps retries a progressive miss in the final pass', () => {
  const cache = { metadataCache: new Map(), resolvedSessionKeys: new Set(), attemptedSessionKeys: new Set() };
  const periods = { today: { sessions: {
    'opencode:s1': { client: 'opencode', sessionId: 's1' }
  } } };
  let reads = 0;
  const readOpencodeMeta = () => {
    reads += 1;
    return reads === 1 ? new Map() : new Map([['s1', { projectPath: '/work/project' }]]);
  };

  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta });
  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta });
  assert.equal(reads, 1, 'intermediate periods should not repeat a known miss');
  assert.equal(periods.today.sessions['opencode:s1'].projectId, undefined);

  applySessionTimestamps(periods, '/home/test', { ...cache, readOpencodeMeta, retryMisses: true });
  assert.equal(reads, 2, 'the final pass should retry a prior miss once');
  assert.equal(periods.today.sessions['opencode:s1'].projectLabel, 'project');
});
