'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  REASONIX_CLIENT,
  REASONIX_SOURCE_CHECK_ID,
  cleanEnvDir,
  resolveReasonixHome,
  resolveReasonixStatsDir
} = require('../../src/shared/reasonixPaths');
const {
  clientSourceChecks,
  clientSourceRoots,
  clientWatchCandidates,
  deriveClientHealth,
  watchPathsForClients
} = require('../../src/shared/collector');
const {
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  normalizeClientName,
  normalizeModelName,
  normalizeModelNameForClient,
  normalizePeriod
} = require('../../src/shared/usage');
const { parseGraphResult, normalizeHistory } = require('../../src/shared/history');
const { captureDailyHistoryArchive, graphFromDailyHistoryArchive } = require('../../src/shared/dailyHistoryArchive');
const { syncPayload } = require('../../src/shared/syncPayload');
const { collectWslUsage, homeHasData } = require('../../src/shared/wslUsage');

const REASONIX_ROW = {
  client: 'reasonix',
  model: 'deepseek-chat',
  sessionId: 'reasonix-stats:/Users/alice/.reasonix/stats/2026-08-07.jsonl',
  input: 80,
  output: 30,
  cacheRead: 20,
  cacheWrite: 0,
  reasoning: 10,
  messageCount: 1,
  costUsd: 0.25
};

test('Reasonix path resolution follows state, home, then platform defaults', () => {
  assert.equal(REASONIX_CLIENT, 'reasonix');
  assert.equal(REASONIX_SOURCE_CHECK_ID, 'reasonix-stats');
  assert.equal(resolveReasonixHome({ platform: 'darwin', homeDir: '/Users/alice', env: {} }), '/Users/alice/.reasonix');
  assert.equal(resolveReasonixStatsDir({ platform: 'linux', homeDir: '/home/alice', env: {} }), '/home/alice/.reasonix/stats');
  assert.equal(
    resolveReasonixStatsDir({
      platform: 'win32',
      homeDir: String.raw`C:\Users\alice`,
      env: { APPDATA: String.raw`C:\Users\alice\AppData\Roaming` }
    }),
    String.raw`C:\Users\alice\AppData\Roaming\reasonix\stats`
  );
  assert.equal(
    resolveReasonixStatsDir({
      platform: 'linux',
      homeDir: '/home/alice',
      env: { REASONIX_HOME: '/srv/reasonix', REASONIX_STATE_HOME: '/var/lib/reasonix-state' }
    }),
    '/var/lib/reasonix-state/stats'
  );
  assert.equal(
    resolveReasonixStatsDir({ platform: 'linux', homeDir: '/home/alice', env: { REASONIX_HOME: '/srv/reasonix' } }),
    '/srv/reasonix/stats'
  );
});

test('Reasonix path cleaning matches the official environment-directory forms', () => {
  const linuxEnv = { HOME: '/home/alice', REASONIX_ROOT: '/srv/reasonix' };
  assert.equal(
    cleanEnvDir('${HOME}/.reasonix/./stats/../stats', { env: linuxEnv, platform: 'linux', cwdDir: '/workspace' }),
    '/home/alice/.reasonix/stats'
  );
  assert.equal(
    cleanEnvDir('${MISSING:-fallback/./stats}', { env: linuxEnv, platform: 'linux', cwdDir: '/workspace' }),
    '/workspace/fallback/stats'
  );
  assert.equal(
    cleanEnvDir('${REASONIX_ROOT}/../reasonix', { env: linuxEnv, platform: 'linux', cwdDir: '/workspace' }),
    '/srv/reasonix'
  );
  assert.equal(
    cleanEnvDir('~/reasonix/../stats', { env: linuxEnv, homeDir: '/home/alice', platform: 'linux', cwdDir: '/workspace' }),
    '/home/alice/stats'
  );
  assert.equal(
    cleanEnvDir('relative/./reasonix/../stats', { env: linuxEnv, platform: 'linux', cwdDir: '/workspace' }),
    '/workspace/relative/stats'
  );
  assert.equal(cleanEnvDir('/', { env: linuxEnv, platform: 'linux', cwdDir: '/workspace' }), '/');

  const windowsEnv = { USERPROFILE: String.raw`C:\Users\alice` };
  assert.equal(
    cleanEnvDir(String.raw`~\reasonix\..\stats`, { env: windowsEnv, homeDir: String.raw`C:\Users\alice`, platform: 'win32', cwdDir: String.raw`C:\workspace` }),
    String.raw`C:\Users\alice\stats`
  );
  assert.equal(
    cleanEnvDir(String.raw`relative\.\reasonix\..\stats`, { env: windowsEnv, platform: 'win32', cwdDir: String.raw`C:\workspace` }),
    String.raw`C:\workspace\relative\stats`
  );
});

test('Reasonix environment references expand only the original value once', () => {
  assert.equal(
    cleanEnvDir('${REASONIX_HOME}', {
      env: { REASONIX_HOME: '${REASONIX_ROOT}', REASONIX_ROOT: '/srv/reasonix' },
      platform: 'linux',
      cwdDir: '/workspace'
    }),
    '/workspace/${REASONIX_ROOT}'
  );
});

test('Reasonix is a normalized tracked client', () => {
  assert.equal(normalizeClientName('Reasonix'), 'reasonix');
  assert.equal(normalizeClientName('reasonix-stats'), 'reasonix');
});

test('Reasonix model prefix normalization is scoped to explicit client context', () => {
  assert.equal(normalizeModelName('deepseek/deepseek-v3'), 'deepseek/deepseek-v3');
  assert.equal(normalizeModelNameForClient('deepseek/deepseek-v4-flash', 'reasonix'), 'deepseek-v4-flash');
  assert.equal(normalizeModelNameForClient('deepseek-flash/deepseek-v4-flash', 'reasonix'), 'deepseek-v4-flash');
  assert.equal(normalizeModelNameForClient('deepseek/deepseek-v3', 'codex'), 'deepseek/deepseek-v3');

  const period = extractUsageFromTokscale({ entries: [{
    client: 'codex',
    model: 'deepseek/deepseek-v3',
    input: 10,
    output: 2
  }] });
  assert.equal(period.models['deepseek/deepseek-v3'], 12);
  assert.equal(period.models['deepseek-v3'], undefined);

  const normalized = normalizePeriod({
    models: { 'deepseek/deepseek-v3': 1 },
    clientModels: {
      reasonix: { 'deepseek/deepseek-v4-flash': 2 },
      codex: { 'deepseek/deepseek-v3': 3 }
    }
  });
  assert.equal(normalized.models['deepseek/deepseek-v3'], 1);
  assert.equal(normalized.clientModels.reasonix['deepseek-v4-flash'], 2);
  assert.equal(normalized.clientModels.codex['deepseek/deepseek-v3'], 3);
});

test('Reasonix reasoning is additive without changing other client semantics', () => {
  const reasonix = extractUsageFromTokscale({ entries: [REASONIX_ROW] });
  assert.equal(reasonix.totalTokens, 140);
  assert.equal(reasonix.cacheReadTokens, 20);
  assert.equal(reasonix.outputTokens, 40);
  assert.equal(reasonix.clientOutputs.reasonix, 40);
  assert.equal(reasonix.modelOutputs['deepseek-chat'], 40);
  assert.equal(reasonix.totalTokens - reasonix.cacheReadTokens - reasonix.outputTokens, 80);
  assert.equal(reasonix.clients.reasonix, 140);
  assert.equal(reasonix.models['deepseek-chat'], 140);
  assert.equal(reasonix.clientModels.reasonix['deepseek-chat'], 140);
  assert.equal(reasonix.costUsd, 0.25);
  assert.equal(reasonix.clientCosts.reasonix, 0.25);
  assert.equal(reasonix.modelCosts['deepseek-chat'], 0.25);
  assert.equal(reasonix.clientModelCosts.reasonix['deepseek-chat'], 0.25);

  for (const client of ['codex', 'claude']) {
    const period = extractUsageFromTokscale({ entries: [{
      ...REASONIX_ROW,
      client,
      model: client === 'codex' ? 'gpt-5' : 'claude-sonnet-4'
    }] });
    assert.equal(period.totalTokens, 130, `${client} reasoning must remain informational`);
    assert.equal(period.outputTokens, 30, `${client} output-family must remain unchanged`);
    assert.equal(period.clientOutputs[client], 30, `${client} output-family must remain unchanged`);
  }
});

test('Reasonix partitions merge exactly across aggregate, client, and model totals', () => {
  const bundle = extractUsageBundleFromTokscale({ entries: [REASONIX_ROW] });
  assert.equal(bundle.period.totalTokens, 140);
  assert.equal(bundle.byClient.reasonix.totalTokens, 140);
  assert.equal(bundle.byClient.reasonix.clients.reasonix, 140);
  assert.equal(bundle.byClient.reasonix.models['deepseek-chat'], 140);
  assert.equal(bundle.byClient.reasonix.clientModels.reasonix['deepseek-chat'], 140);
  assert.deepEqual(bundle.period.sessions, {});
  assert.deepEqual(bundle.byClient.reasonix.sessions, {});
});

test('Reasonix history uses additive reasoning while existing clients stay unchanged', () => {
  const graph = {
    contributions: [{
      date: '2026-08-07',
      clients: [
        { client: 'reasonix', modelId: 'deepseek-chat', tokens: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0, reasoning: 10 }, cost: 0.25, messages: 1 },
        { client: 'codex', modelId: 'gpt-5', tokens: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0, reasoning: 10 }, cost: 0.5, messages: 1 }
      ]
    }]
  };
  const parsed = parseGraphResult(graph);
  assert.equal(parsed.contributions[0].tokens, 270);
  assert.equal(parsed.contributions[0].perClient.reasonix.tokens, 140);
  assert.equal(parsed.contributions[0].perClient.codex.tokens, 130);
  assert.equal(parsed.contributions[0].perModel['deepseek-chat'].tokens, 140);
  assert.equal(parsed.contributions[0].perModel['gpt-5'].tokens, 130);
  assert.equal(parsed.contributions[0].outputTokens, 70);
  assert.equal(parsed.contributions[0].perClient.reasonix.outputTokens, 40);
  assert.equal(parsed.contributions[0].perClient.codex.outputTokens, 30);
  assert.equal(parsed.contributions[0].messages, 1);
  assert.equal(parsed.contributions[0].perClient.reasonix.messages, 0);
  assert.equal(parsed.contributions[0].perClient.codex.messages, 1);
  const history = normalizeHistory(parsed, { todayKey: '2026-08-07' });
  assert.equal(history.daily[0].tokens, 270);
  assert.equal(history.daily[0].perClient.reasonix.tokens, 140);
  assert.equal(history.daily[0].perModel['deepseek-chat'].tokens, 140);
  assert.equal(history.daily[0].messages, 1);
  assert.equal(history.daily[0].perClient.reasonix.messages, 0);
  assert.equal(history.summary.messages, 1);
  assert.equal(history.summary.totalTokens, 270);
});

test('Reasonix daily history archive preserves its additive total', () => {
  const archive = captureDailyHistoryArchive({}, {
    contributions: [{
      date: '2026-08-07',
      clients: [{
        client: 'reasonix',
        modelId: 'deepseek-chat',
        tokens: { input: 80, output: 30, cacheRead: 20, cacheWrite: 0, reasoning: 10 },
        cost: 0,
        messages: 1
      }]
    }]
  }, { todayKey: '2026-08-07' });
  const restored = normalizeHistory(parseGraphResult(graphFromDailyHistoryArchive([], archive, { todayKey: '2026-08-07' })), {
    todayKey: '2026-08-07'
  });
  assert.equal(restored.daily[0].perClient.reasonix.tokens, 140);
  assert.equal(restored.daily[0].perModel['deepseek-chat'].tokens, 140);
  assert.equal(restored.daily[0].tokenComponentsAvailable, true);
  assert.equal(restored.daily[0].outputTokens, 40);
  assert.equal(restored.daily[0].perClient.reasonix.messages, 0);
  assert.equal(restored.summary.messages, 0);
  assert.equal(restored.summary.totalTokens, 140);
});

test('Reasonix synthetic stats sessions never enter periods or sync payloads', () => {
  const period = extractUsageFromTokscale({ entries: [REASONIX_ROW] });
  assert.deepEqual(Object.keys(period.sessions), []);
  assert.deepEqual(Object.keys(period.projects), []);

  const normalized = normalizePeriod({
    totalTokens: 140,
    clients: { reasonix: 140 },
    sessions: { [REASONIX_ROW.sessionId]: { client: 'reasonix', sessionId: REASONIX_ROW.sessionId, totalTokens: 140 } }
  });
  assert.deepEqual(Object.keys(normalized.sessions), []);

  const payload = syncPayload({
    today: {
      totalTokens: 140,
      sessions: {
        [REASONIX_ROW.sessionId]: { client: 'reasonix', sessionId: REASONIX_ROW.sessionId, totalTokens: 140 },
        'codex:real-session': { client: 'codex', sessionId: 'real-session', totalTokens: 5 }
      }
    },
    month: { sessions: { 'reasonix:reasonix-stats:/Users/alice/.reasonix/stats/2026-08-07.jsonl': { totalTokens: 140 } } },
    allTime: { sessions: { [REASONIX_ROW.sessionId]: { client: 'reasonix', totalTokens: 140 } } }
  });
  const body = JSON.stringify(payload);
  assert.doesNotMatch(body, /reasonix-stats:/);
  assert.doesNotMatch(body, /\.reasonix[\\/]stats/);
  assert.ok(payload.today.sessions['codex:real-session']);
  assert.deepEqual(Object.keys(payload.month.sessions), []);
  assert.equal(Object.hasOwn(payload.allTime, 'sessions'), false);
});

test('Reasonix stats path is shared by watcher and client health', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'reasonix-home-'));
  const previousStateHome = process.env.REASONIX_STATE_HOME;
  const previousReasonixHome = process.env.REASONIX_HOME;
  const originalHomedir = os.homedir;
  const stateHome = path.join(home, 'relocated-state');
  const statsDir = path.join(stateHome, 'stats');
  fs.mkdirSync(statsDir, { recursive: true });
  os.homedir = () => home;
  process.env.REASONIX_STATE_HOME = stateHome;
  delete process.env.REASONIX_HOME;
  try {
    const expected = [{ id: REASONIX_SOURCE_CHECK_ID, dir: statsDir }];
    assert.deepEqual(clientSourceRoots('reasonix').reasonix, expected);
    assert.deepEqual(clientWatchCandidates('reasonix').reasonix, [statsDir]);
    assert.deepEqual(watchPathsForClients('reasonix'), [statsDir]);
    const checks = clientSourceChecks('reasonix');
    assert.deepEqual(checks.reasonix, [{ id: REASONIX_SOURCE_CHECK_ID, exists: true }]);
    const health = deriveClientHealth('reasonix', { clients: {} }, { sourceChecks: checks });
    assert.equal(health.clients.reasonix.source.state, 'detected');
    assert.equal(health.clients.reasonix.overall, 'waiting');
  } finally {
    os.homedir = originalHomedir;
    if (previousStateHome === undefined) delete process.env.REASONIX_STATE_HOME;
    else process.env.REASONIX_STATE_HOME = previousStateHome;
    if (previousReasonixHome === undefined) delete process.env.REASONIX_HOME;
    else process.env.REASONIX_HOME = previousReasonixHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('WSL Reasonix is neither discovered nor passed to the WSL Tokscale scan', async () => {
  const home = '\\\\wsl$\\Ubuntu\\home\\alice';
  assert.deepEqual(homeHasData(home, (value) => value === `${home}\\.reasonix\\stats`), []);
  const calls = [];
  const { detected } = await collectWslUsage({
    clients: 'reasonix,claude',
    trackedClients: 'reasonix,claude',
    allTimeSince: '2025-01-01',
    runTokscale: async (options) => {
      calls.push(options.clients);
      return { entries: [] };
    }
  }, {
    platform: 'win32',
    exec: (cmd) => (cmd === 'reg' ? 'Lxss' : 'Ubuntu\n'),
    readdirSync: () => ['alice'],
    existsSync: (value) => value === `${home}\\.claude\\projects`
  });
  assert.deepEqual(detected, ['claude']);
  assert.deepEqual(calls, ['claude', 'claude', 'claude']);
});
