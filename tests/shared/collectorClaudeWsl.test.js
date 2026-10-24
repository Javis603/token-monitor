'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectUsageOnce, collectorAnchorTrust, configFingerprint, localTodayKey, startCollector, tokscaleCommand } = require('../../src/shared/collector');
const { collectWslUsage, discoverWslClaudeSources, emptyWslBundle } = require('../../src/shared/wslUsage');

const home = '\\\\wsl$\\Ubuntu\\home\\alice';
const source = { home, roots: [`${home}\\.claude\\projects`, `${home}\\.claude\\transcripts`] };
const plan = { homes: [home], sources: [source], activeRoots: source.roots, sharedClaudeHomes: [home] };
const row = (client, input) => ({ client, sessionId: 'session', model: 'fixture', input, output: 0, cost: 0 });
const base = {
  clients: 'claude,gemini', allTimeSince: '2025-01-01', commandTimeoutMs: 1000,
  deviceId: 'fixture', platform: 'win32', wslClaudeSharedScan: true,
  projectsEnabled: false, historyEnabled: false, limitsEnabled: false,
  probeWslState: () => 'ok',
  discoverWslClaudeSources: () => plan
};

test('joint Claude periods omit the isolated copy and retain independent WSL client usage', async () => {
  const calls = [];
  let captured;
  const summary = await collectUsageOnce({
    ...base,
    runTokscale: async (input) => {
      calls.push(input);
      return { claudeCachedRoots: true, entries: [row('claude', 150)] };
    },
    collectWslUsage: (options) => collectWslUsage({
      ...options,
      runTokscale: async (input) => {
        assert.equal(input.clients, 'gemini', 'Claude is never scanned again in the isolated WSL call');
        return { entries: [row('gemini', 9)] };
      },
      decoratePeriods: (periods) => {
        for (const period of Object.values(periods)) {
          if (!period.sessions['claude:session']) continue;
          Object.assign(period.sessions['claude:session'], {
            title: 'WSL transcript', contextTokens: 123, contextWindow: 200000, turnEnded: false,
            lastUsedAt: new Date().toISOString()
          });
        }
      }
    }, { existsSync: (p) => p === source.roots[0], readdirSync: () => [] }),
    onAnchorComputed: (value) => { captured = value; }
  });
  for (const period of ['today', 'month', 'allTime']) {
    assert.equal(summary[period].totalTokens, 159);
    assert.deepEqual(summary[period].clients, { claude: 150, gemini: 9 });
    assert.equal(captured.wslBundle[period].clients.claude, undefined);
    assert.equal(captured.wslBundle[period].sessions['claude:session'].totalTokens, 0);
    assert.equal(summary[period].sessions['claude:session'].contextTokens, 123);
    assert.equal(summary[period].sessions['claude:session'].turnEnded, false);
  }
  assert.equal(calls.length, 3);
  assert.ok(calls.every((input) => input.claudeWslScan === plan));
  assert.deepEqual(captured.claudeWslSources, [source]);
  assert.ok(summary.wslStatus.withData.includes('claude'));
  const warmed = await collectUsageOnce({
    ...base,
    todayOnlyAnchor: { dateKey: localTodayKey(), ...captured.windowsPeriods, claudeWslSources: captured.claudeWslSources },
    wslAnchor: captured.wslBundle, wslStatus: captured.wslStatus,
    runTokscale: async () => ({ claudeCachedRoots: true, entries: [row('claude', 155)] }),
    collectWslUsage: () => assert.fail('watch tick must reuse metadata without reading WSL')
  });
  assert.equal(warmed.today.totalTokens, 164);
  assert.equal(warmed.today.sessions['claude:session'].contextTokens, 123);
});

test('watch ticks use cached WSL sources with one today scan and no discovery', async () => {
  const calls = [];
  let previous;
  await collectUsageOnce({
    ...base,
    runTokscale: async () => ({ claudeCachedRoots: true, entries: [row('claude', 150)] }),
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: ['claude'] }),
    onAnchorComputed: (value) => { previous = value; }
  });
  const anchor = { dateKey: localTodayKey(), ...previous.windowsPeriods, claudeWslSources: previous.claudeWslSources };
  const summary = await collectUsageOnce({
    ...base, todayOnlyAnchor: anchor, wslAnchor: previous.wslBundle,
    wslStatus: previous.wslStatus,
    discoverWslClaudeSources: () => assert.fail('watch tick discovered WSL'),
    collectWslUsage: () => assert.fail('watch tick rescanned WSL'),
    runTokscale: async (input) => {
      calls.push(input);
      return { claudeCachedRoots: true, entries: [row('claude', 155)] };
    }
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].flags, ['--today']);
  assert.deepEqual(calls[0].claudeWslScan.activeRoots, []);
  assert.deepEqual(calls[0].claudeWslScan.sources, [source]);
  assert.equal(summary.month.totalTokens, 155);
  assert.equal(summary.allTime.totalTokens, 155);
});

test('WSL refresh rebuilds old days and a legacy anchor cannot enter the joint delta path', async () => {
  for (const refreshWsl of [false, true]) {
    let captured;
    const calls = [];
    await collectUsageOnce({
      ...base, refreshWsl,
      todayOnlyAnchor: { dateKey: localTodayKey(), ...emptyWslBundle(), ...(refreshWsl ? { claudeWslSources: [source] } : {}) },
      wslAnchor: emptyWslBundle(),
      runTokscale: async (input) => { calls.push(input); return { claudeCachedRoots: true, entries: [row('claude', 150)] }; },
      collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
      onAnchorComputed: (value) => { captured = value; }
    });
    assert.equal(calls.length, 3);
    assert.equal(captured.fullScan, true);
    assert.deepEqual(captured.claudeWslSources, [source]);
  }
});

test('WSL off and non-Windows scans never inject joint roots; fingerprint rejects joint anchors', async () => {
  for (const override of [{ wslScanEnabled: false }, { platform: 'darwin' }]) {
    const inputs = [];
    await collectUsageOnce({
      ...base, ...override,
      discoverWslClaudeSources: () => assert.fail('unexpected WSL discovery'),
      runTokscale: async (input) => { inputs.push(input); return { entries: [] }; },
      collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] })
    });
    assert.ok(inputs.every((input) => !input.claudeWslScan));
  }
  const fingerprint = (options) => configFingerprint('claude', '2025-01-01', true, '', '', null, 'price', options, '');
  assert.notEqual(fingerprint(base), fingerprint({ ...base, wslScanEnabled: false }));
  assert.notEqual(fingerprint(base), fingerprint({ ...base, wslClaudeSharedScan: false }));
});

test('source discovery freezes stopped homes without touching them and preserves unsupported Desktop scans', () => {
  const paths = [];
  const deps = {
    platform: 'win32', exec: (cmd) => cmd === 'reg' ? 'Lxss' : '',
    existsSync: (p) => { paths.push(p); return false; }, readdirSync: () => []
  };
  assert.deepEqual(discoverWslClaudeSources([source], deps), {
    homes: [], sources: [source], activeRoots: [], sharedClaudeHomes: []
  });
  assert.deepEqual(paths, []);
  const desktop = `${home}\\.config\\Claude\\IndexedDB\\https_claude.ai_0.indexeddb.leveldb`;
  const fallback = discoverWslClaudeSources([source], {
    ...deps, exec: (cmd) => cmd === 'reg' ? 'Lxss' : 'Ubuntu\n',
    readdirSync: (p) => p === '\\\\wsl$\\Ubuntu\\home' ? ['alice'] : [],
    existsSync: (p) => p === desktop || p === source.roots[0]
  });
  assert.deepEqual(fallback.homes, [home]);
  assert.deepEqual(fallback.sources, []);
  assert.deepEqual(fallback.sharedClaudeHomes, []);
});

test('command-scoped joint roots preserve custom roots without changing the parent environment', () => {
  const before = { ...process.env };
  const command = tokscaleCommand({ claudeWslScan: plan });
  assert.ok(command.env.TOKSCALE_EXTRA_DIRS.includes(`claude:${source.roots[0]}`));
  assert.deepEqual(JSON.parse(command.env.TOKSCALE_CACHED_CLAUDE_DIRS), source.roots);
  assert.equal(tokscaleCommand().env.TOKSCALE_CACHED_CLAUDE_DIRS, undefined);
  assert.deepEqual({ ...process.env }, before);
});

test('an older actual scanner response cannot silently drop the isolated WSL contribution', async () => {
  await assert.rejects(collectUsageOnce({
    ...base,
    runTokscale: async () => ({ entries: [row('claude', 120)] }),
    collectWslUsage: () => assert.fail('unsupported joint result reached the WSL merge')
  }), /does not support shared Claude WSL sources/);
});

test('restart retains the joint source set, and a subsequent watch tick uses the new full anchor', { timeout: 10000 }, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-anchor-'));
  const previousDir = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = root;
  let handle;
  let reads = [];
  let previousSources;
  let count = 150;
  const options = {
    ...base, homeDir: root, intervalMs: 3600000, watchEnabled: false, sessionActivityPolling: false,
    runTokscale: async (input) => {
      reads.push(input);
      return { claudeCachedRoots: true, entries: [row('claude', count)] };
    },
    collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
    discoverWslClaudeSources: (previous) => { previousSources = previous; return plan; }
  };
  const start = () => new Promise((resolve) => {
    handle = startCollector({ ...options, onUpdate: resolve });
  });
  try {
    await start();
    await handle.whenIdle();
    await handle.stop();
    const saved = JSON.parse(fs.readFileSync(path.join(root, 'collector-anchor.json'), 'utf8'));
    assert.deepEqual(saved.claudeWslSources, [source]);
    assert.equal(collectorAnchorTrust(saved, { ...options, wslScanEnabled: false }), null);
    count = 195;
    reads = [];
    const restarted = await start();
    await handle.whenIdle();
    assert.deepEqual(previousSources, [source]);
    assert.equal(restarted.allTime.totalTokens, 195);
    assert.equal(reads.length, 3, 'interval refresh rebuilds every joint period');
    reads = [];
    count = 200;
    await handle.tick('watch', { todayOnly: true });
    await handle.whenIdle();
    assert.equal(reads.length, 1);
    assert.deepEqual(reads[0].claudeWslScan.activeRoots, []);
    // The full refresh must have replaced the anchor even though the outer
    // interval scheduler originally requested an anchored Today tick.
    const after = JSON.parse(fs.readFileSync(path.join(root, 'collector-anchor.json'), 'utf8'));
    assert.equal(after.allTime.totalTokens, 195);
    await handle.stop();
    // Root selection outlives daily delta anchors and pricing changes.
    after.dateKey = '2020-01-01';
    after.configFingerprint = 'old-pricing';
    fs.writeFileSync(path.join(root, 'collector-anchor.json'), JSON.stringify(after));
    previousSources = null;
    await start();
    await handle.whenIdle();
    assert.deepEqual(previousSources, [source], 'stale daily totals must not lose offline source identities');
  } finally {
    if (handle) await handle.stop();
    if (previousDir === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previousDir;
    fs.rmSync(root, { recursive: true, force: true });
  }
});

const nativeBinary = process.env.TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI;
test('actual CLI deduplicates periods and History through full, watch, refresh and offline scans', {
  skip: !nativeBinary && 'set TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI to the candidate binary',
  timeout: 120000
}, async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-wsl-'));
  try {
    const host = path.join(root, 'host');
    const originalRoot = path.join(root, 'wsl', '.claude', 'projects', 'original');
    const mirrorRoot = path.join(host, '.claude', 'projects', 'ssh-session');
    for (const dir of [originalRoot, mirrorRoot]) fs.mkdirSync(dir, { recursive: true });
    const at = new Date().toISOString();
    const event = (id, tokens) => JSON.stringify({
      type: 'assistant', sessionId: 'session', timestamp: at, requestId: `req_${id}`,
      message: { id: `msg_${id}`, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens, output_tokens: 0 } }
    }) + '\n';
    const original = path.join(originalRoot, 'session.jsonl');
    const mirror = path.join(mirrorRoot, 'session.jsonl');
    fs.writeFileSync(original, event('shared', 100) + event('remote', 30));
    fs.writeFileSync(mirror, event('shared', 100) + event('host', 20));
    const fixtureSource = { home: path.join(root, 'wsl'), roots: [originalRoot] };
    let active = [originalRoot];
    let captured;
    const run = (input, graph = false) => {
      const command = tokscaleCommand(input);
      const env = {
        ...command.env, HOME: host, CLAUDE_CONFIG_DIR: path.join(host, '.claude'),
        TOKSCALE_CONFIG_DIR: path.join(root, 'config'), TOKSCALE_PRICING_CACHE_ONLY: '1',
        TOKSCALE_EXTRA_DIRS: (input.claudeWslScan?.activeRoots || []).map((dir) => `claude:${dir}`).join(',')
      };
      const args = graph ? ['graph', '--client', 'claude', '--no-spinner']
        : ['--json', '--no-spinner', '--client', 'claude', '--group-by', 'client,workspace,session,model', ...input.flags];
      return JSON.parse(execFileSync(nativeBinary, args, { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
    };
    const options = {
      ...base, clients: 'claude', homeDir: host, historyEnabled: true, includeHistory: true,
      discoverWslClaudeSources: () => ({
        homes: active.length ? [fixtureSource.home] : [], sources: [fixtureSource],
        activeRoots: active, sharedClaudeHomes: active.length ? [fixtureSource.home] : []
      }),
      runTokscale: async (input) => run(input),
      runGraph: async (input) => run(input, true),
      collectWslUsage: async () => ({ bundle: emptyWslBundle(), detected: [] }),
      onAnchorComputed: (value) => { captured = value; }
    };
    const check = (summary, tokens) => {
      for (const name of ['today', 'month', 'allTime']) assert.equal(summary[name].totalTokens, tokens, name);
      assert.equal(summary.history.daily.reduce((total, day) => total + day.tokens, 0), tokens, 'History');
    };
    const separateHost = run({ flags: ['--today'] });
    const separateWsl = run({ flags: ['--today', '--home', fixtureSource.home] });
    assert.equal(separateHost.totalInput + separateWsl.totalInput, 250, 'the existing separate-scan sum repeats the shared 100');
    check(await collectUsageOnce(options), 150);
    const anchor = { dateKey: localTodayKey(), ...captured.windowsPeriods, claudeWslSources: captured.claudeWslSources };
    fs.writeFileSync(original, event('shared', 100) + event('remote', 70));
    fs.writeFileSync(mirror, event('shared', 100) + event('host', 20) + event('new', 5));
    check(await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, wslAnchor: emptyWslBundle() }), 155);
    check(await collectUsageOnce({ ...options, todayOnlyAnchor: anchor, refreshWsl: true }), 195);
    const gone = path.join(originalRoot, 'gone.jsonl');
    fs.writeFileSync(gone, event('deleted-session', 100));
    check(await collectUsageOnce(options), 295);
    fs.unlinkSync(gone);
    check(await collectUsageOnce(options), 195);
    const prunedAnchor = { dateKey: localTodayKey(), ...captured.windowsPeriods, claudeWslSources: captured.claudeWslSources };
    check(await collectUsageOnce({ ...options, todayOnlyAnchor: prunedAnchor, wslAnchor: emptyWslBundle() }), 195);
    fs.writeFileSync(original, '{"type":"assistant","message":');
    check(await collectUsageOnce({ ...options, claudeWslSources: [fixtureSource] }), 195);
    active = [];
    fs.rmSync(originalRoot, { recursive: true });
    check(await collectUsageOnce({ ...options, claudeWslSources: [fixtureSource] }), 195);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
