'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
function load(file) {
  return require(path.resolve(__dirname, '../../src/shared', file));
}
test('Codex retention rejects different keyed workspaces but retains missing-key compatibility', () => {
  const policy = load('providers/codex/corePolicy.js').createRetentionPolicy({ normalizeLimitsSummary: x => x, timestampMs: Date.parse });
  const previous = { providers: [{ provider: 'codex', accountKey: 'A', accountEmail: 'same@example.com', status: 'ok', updatedAt: '2026-11-17T00:00:00Z', windows: [{ usedPercent: 20 }] }] };
  const current = key => ({ providers: [{ provider: 'codex', accountKey: key, accountEmail: 'same@example.com', status: 'unavailable', windows: [] }] });
  const merge = key => policy.mergeCodexTransientWindows(previous, current(key), Date.parse('2026-11-17T00:01:00Z')).providers[0];
  assert.equal(merge('B').windows.length, 0);
  assert.equal(merge('A').windows.length, 1);
  assert.equal(merge('').windows.length, 1);
});
test('Codex bundled Program Files executables are app candidates', () => {
  const { codexCommandSourceDetail } = load('providers/codex/limits.js');
  for (const root of ['Program Files', 'Program Files (x86)']) assert.equal(codexCommandSourceDetail(`C:\\${root}\\Codex\\resources\\codex.exe`, 'win32'), 'app');
  assert.equal(codexCommandSourceDetail('codex.cmd', 'win32'), 'cli');
});
test('Ollama dual credentials accept cookie-resolved proof and reject fallback keys', () => {
  const { isOllamaServerAccountKey } = load('providers/ollama/limits.js');
  const values = { ollamaApiKey: 'api', ollamaCookie: 'next-auth.session-token=test' };
  const fallback = require('../../src/shared/hashKey').hashKey('ollama', 'next-auth.session-token=test');
  assert.equal(isOllamaServerAccountKey('server', values, [fallback]), true);
  assert.equal(isOllamaServerAccountKey(fallback, values, [fallback]), false);
  assert.equal(isOllamaServerAccountKey('server', values, ['unrelated']), false);
});
test('OpenCode explicit alias chain prefers workspace regardless of lexical order', () => {
  const policy = load('providers/opencode/corePolicy.js').createComponentPolicy({ normalizeLimitWindow: x => x, normalizeAccountKeyAliases: (xs, key) => [...new Set(xs)].filter(x => x !== key), statusRank: () => 1, timestampMs: () => 1, providerWindowRank: () => 1, windowOrder: [] });
  const row = (key, aliases) => ({ provider: 'opencode', source: 'web', status: 'ok', accountKey: key, webAccountKey: key, accountKeyAliases: aliases, windows: [] });
  const workspace = row('z-workspace', ['a-cookie']);
  const cookie = row('a-cookie', []);
  for (const rows of [[workspace, cookie], [cookie, workspace]]) {
    const result = policy.mergeOpenCodeProviderComponents(rows);
    assert.equal(result.accountKey, 'z-workspace');
    assert.ok(result.accountKeyAliases.includes('a-cookie'));
  }
  assert.equal(policy.mergeOpenCodeProviderComponents([cookie]).accountKey, 'a-cookie');
  // Ambiguous roots or cycles preserve the established deterministic choice.
  for (const rows of [[row('z', ['f']), row('a', ['f'])], [row('z', ['a']), row('a', ['z'])]]) {
    assert.equal(policy.mergeOpenCodeProviderComponents(rows).accountKey, 'a');
    assert.equal(policy.mergeOpenCodeProviderComponents([...rows].reverse()).accountKey, 'a');
  }
  const merged = policy.mergeOpenCodeProviderComponents([workspace, cookie]);
  assert.equal(policy.groupOpenCodeCandidates([merged, cookie]).length, 1);

});
test('Muse web clear falls back to last good source after keyed sourceless failure and preserves CLI', async () => {
  const { createLimitsRuntime } = load('limits/runtime.js');
  let failed = false;
  const runtime = createLimitsRuntime({ limitProviders: ['muse'] }, { autoStart: false, cleanupGraceMs: 0,
    probeProvider: async () => failed ? [{ provider: 'muse', accountKey: 'web-key', status: 'unavailable', windows: [] }] : ['web', 'cli'].map(source => ({ provider: 'muse', accountKey: `${source}-key`, source, status: 'ok', windows: [{ kind: 'session', usedPercent: 20 }] })) });
  try {
    await runtime.refresh({ provider: 'muse' });
    failed = true;
    await runtime.refresh({ provider: 'muse', accountKey: 'web-key' });
    runtime.clear({ provider: 'muse', source: 'web' });
    assert.deepEqual(runtime.getSnapshot().providers.map(x => x.accountKey), ['cli-key']);
  } finally { runtime.stop(); }
});
