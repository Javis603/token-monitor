'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { collectUsageOnce, localTodayKey, tokscaleCommand } = require('../../src/shared/collector');
const { collectWslUsage, discoverWslClaudeSources } = require('../../src/shared/wslUsage');

const home = '\\\\wsl$\\Ubuntu\\home\\alice';
const source = { home, roots: [`${home}\\.claude\\projects`, `${home}\\.claude\\transcripts`] };
const base = {
  clients: 'claude,synthetic', platform: 'win32', wslClaudeSharedScan: true,
  allTimeSince: '2020-01-01', deviceId: 'fixture', commandTimeoutMs: 30000,
  projectsEnabled: false, historyEnabled: false, limitsEnabled: false,
  probeWslState: () => 'ok'
};
const row = (client, input) => ({ client, sessionId: client, model: 'fixture', input, cost: input / 100 });

test('joint WSL periods discard only the already-owned Claude partition from Synthetic results', async () => {
  for (const shared of [true, false]) {
    const result = await collectUsageOnce({
      ...base,
      discoverWslClaudeSources: () => ({ homes: [home], sources: shared ? [source] : [], activeRoots: shared ? source.roots : [], sharedClaudeHomes: shared ? [home] : [] }),
      runTokscale: async ({ flags }) => ({ claudeCachedRoots: true, entries: flags.includes('--home')
        ? [row('claude', 100), row('opencode', 30)] : [row('claude', shared ? 120 : 20)] }),
      collectWslUsage: options => collectWslUsage(options, { existsSync: () => false, readdirSync: () => [] })
    });
    for (const period of ['today', 'month', 'allTime']) {
      assert.equal(result[period].totalTokens, 150, `${period}, shared=${shared}`);
      assert.equal(result[period].costUsd, 1.5);
      assert.deepEqual(result[period].clients, { claude: 120, opencode: 30 });
    }
  }
  // If all returned rows belong to Claude, the report's aggregate header must
  // not survive as unattributed fallback usage after excluding those rows.
  const result = await collectWslUsage({
    clients: 'claude,synthetic', homes: [home], sharedClaudeHomes: [home],
    runTokscale: async () => ({ totalTokens: 100, totalCost: 1, entries: [row('claude', 100)] })
  }, { existsSync: () => false, readdirSync: () => [] });
  assert.equal(result.bundle.today.totalTokens, 0);
});

test('discovery rechecks an empty running home, but never probes a stopped or unreachable home as active', () => {
  const probe = (running, readable) => {
    const paths = [];
    const result = discoverWslClaudeSources([source], {
      platform: 'win32', exec: cmd => cmd === 'reg' ? 'Lxss' : running ? 'Ubuntu\n' : '',
      existsSync: p => { paths.push(p); return false; },
      readdirSync: p => {
        paths.push(p);
        if (p === '\\\\wsl$\\Ubuntu\\home') return ['alice'];
        if (p === home && readable) return [];
        throw Object.assign(new Error('unreachable'), { code: 'EACCES' });
      }
    });
    assert.deepEqual(result.sources, [source]);
    if (!running) assert.deepEqual(paths, []);
    return result;
  };
  assert.deepEqual(probe(false, false).activeRoots, []);
  assert.deepEqual(probe(true, false).activeRoots, []);
  assert.deepEqual(probe(true, true).activeRoots, source.roots);
});

const binary = process.env.TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI;
const native = { skip: !binary && 'set TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI to the candidate binary', timeout: 120000 };
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-boundaries-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const host = path.join(root, 'host');
  const remote = path.join(root, 'remote');
  fs.mkdirSync(host);
  fs.mkdirSync(remote);
  const nativePath = p => p === '\\\\wsl$\\Ubuntu\\home' ? path.dirname(remote)
    : p.startsWith(home) ? path.join(remote, ...p.slice(home.length).split('\\').filter(Boolean)) : p;
  let running = true;
  let reachable = true;
  const deps = {
    platform: 'win32', exec: cmd => cmd === 'reg' ? 'Lxss' : running ? 'Ubuntu\n' : '',
    existsSync: p => reachable && p.startsWith(home) && fs.existsSync(nativePath(p)),
    readdirSync: p => {
      if (!running || !reachable) throw Object.assign(new Error('offline'), { code: 'EACCES' });
      if (p === '\\\\wsl$\\Ubuntu\\home') return ['alice'];
      if (!p.startsWith(home)) throw Object.assign(new Error('absent home'), { code: 'ENOENT' });
      return fs.readdirSync(nativePath(p));
    }
  };
  const writeClaude = (owner, id, input, model = 'claude-sonnet-4-6') => {
    const dir = path.join(owner, '.claude', 'projects', 'project');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `${id}.jsonl`), JSON.stringify({ type: 'assistant', sessionId: id,
      timestamp: new Date().toISOString(), requestId: `req-${id}`,
      message: { id: `msg-${id}`, model, usage: { input_tokens: input, output_tokens: 0 } }
    }) + '\n');
  };
  let captured;
  const run = input => {
    // Only the OS path/WSL discovery boundary is adapted on macOS. The scanner,
    // source plan, cache, period extraction, WSL merge and watch delta are real.
    const mapped = { ...input, claudeWslScan: input.claudeWslScan && { ...input.claudeWslScan,
      activeRoots: input.claudeWslScan.activeRoots.map(nativePath),
      sources: input.claudeWslScan.sources.map(s => ({ ...s, roots: s.roots.map(nativePath) }))
    } };
    const command = tokscaleCommand(mapped);
    const env = { ...command.env, HOME: host, CLAUDE_CONFIG_DIR: path.join(host, '.claude'),
      XDG_CACHE_HOME: path.join(root, 'cache'), XDG_DATA_HOME: path.join(host, '.local/share'),
      XDG_CONFIG_HOME: path.join(host, '.config'), TOKSCALE_CONFIG_DIR: path.join(root, 'config'),
      TOKSCALE_PRICING_CACHE_ONLY: '1',
      TOKSCALE_EXTRA_DIRS: (mapped.claudeWslScan?.activeRoots || []).map(p => `claude:${p}`).join(',') };
    return JSON.parse(execFileSync(binary, ['--json', '--no-spinner', '--client', input.clients,
      '--group-by', 'client,workspace,session,model', ...input.flags.map(nativePath)],
    { env, encoding: 'utf8', timeout: 30000, stdio: ['ignore', 'pipe', 'pipe'] }));
  };
  const options = {
    ...base, homeDir: host,
    discoverWslClaudeSources: previous => discoverWslClaudeSources(previous, deps),
    runTokscale: async input => run(input),
    collectWslUsage: options => collectWslUsage({ ...options, decoratePeriods: undefined }, deps),
    onAnchorComputed: value => { captured = value; }
  };
  return { host, remote, writeClaude, options, run,
    setState: (r, a) => { running = r; reachable = a; },
    captured: () => captured
  };
}
function check(summary, expected) {
  for (const period of ['today', 'month', 'allTime']) assert.equal(summary[period].totalTokens, expected, period);
}

test('native joint Claude plus Synthetic scan counts gateway once and retains other gateway sources', native, async t => {
  const f = fixture(t);
  f.writeClaude(f.host, 'host', 20);
  f.writeClaude(f.remote, 'gateway', 100, 'hf:deepseek-ai/DeepSeek-V3');
  const messages = path.join(f.remote, '.local/share/opencode/storage/message/project');
  fs.mkdirSync(messages, { recursive: true });
  fs.writeFileSync(path.join(messages, 'msg.json'), JSON.stringify({ id: 'msg-other', sessionID: 'other', role: 'assistant',
    modelID: 'hf:deepseek-ai/DeepSeek-V3', providerID: 'synthetic', cost: 0,
    tokens: { input: 30, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }, time: { created: Date.now() } }));
  const isolated = f.run({ clients: 'synthetic', flags: ['--today', '--home', home] });
  assert.equal(isolated.totalInput, 130, 'Synthetic selects both Claude and OpenCode gateway sources');
  const summary = await collectUsageOnce(f.options);
  check(summary, 150);
  assert.deepEqual(summary.today.clients, { claude: 120, opencode: 30 });
  const captured = f.captured();
  check(await collectUsageOnce({ ...f.options,
    todayOnlyAnchor: { dateKey: localTodayKey(), ...captured.windowsPeriods, claudeWslSources: captured.claudeWslSources },
    wslAnchor: captured.wslBundle,
    discoverWslClaudeSources: () => assert.fail('watch must not discover WSL')
  }), 150);
});

test('native discovery prunes an entire deleted source only when running and reachable, including the next watch', native, async t => {
  const f = fixture(t);
  f.writeClaude(f.host, 'host', 20);
  f.writeClaude(f.remote, 'remote', 100);
  const options = { ...f.options, clients: 'claude' };
  check(await collectUsageOnce(options), 120);
  const previous = f.captured().claudeWslSources;
  fs.rmSync(path.join(f.remote, '.claude'), { recursive: true });
  f.setState(false, false);
  check(await collectUsageOnce({ ...options, claudeWslSources: previous }), 120);
  f.setState(true, false);
  check(await collectUsageOnce({ ...options, claudeWslSources: previous }), 120);
  f.setState(true, true);
  check(await collectUsageOnce({ ...options, claudeWslSources: previous }), 20);
  const captured = f.captured();
  check(await collectUsageOnce({ ...options,
    todayOnlyAnchor: { dateKey: localTodayKey(), ...captured.windowsPeriods, claudeWslSources: captured.claudeWslSources },
    wslAnchor: captured.wslBundle,
    discoverWslClaudeSources: () => assert.fail('watch must not discover WSL')
  }), 20);
  f.writeClaude(f.remote, 'new', 40);
  check(await collectUsageOnce({ ...options, claudeWslSources: previous }), 60);
});
