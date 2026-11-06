'use strict';

// End-to-end: settings → limitsConfigFromSettings → LimitsRuntime/collector →
// fetchClaudeLimits. A regression for the Electron path where the Claude card
// showed "Not signed in" (credential notConfigured) despite
// claudeDesktopLocalOnly being on — the flag must survive config assembly and
// a blanked deps.env must not reopen the credential/keychain/network lanes.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { limitsConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { collectLimitsOnce } = require('../../src/shared/limits/collector');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { readClaudeCredentials } = require('../../src/shared/providers/claude/limits');

const ORG = 'c73395ca-5813-4db2-be67-856718144237';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function desktopHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-runtime-'));
  // Linux layout: keeps the pre-toggle OAuth probe off the macOS keychain
  // lane while still exercising Desktop path resolution.
  const root = path.join(home, '.config', 'Claude');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plan-usage-history.json'), JSON.stringify({
    version: 2,
    samples: [{ t: NOW - 60_000, org: ORG, u: { fh: 97, sd: 59 } }]
  }));
  return { home, root };
}

function guardedDeps(home, env) {
  const touches = [];
  const guard = (name) => (...args) => {
    touches.push([name, args[0]]);
    throw new Error(`local-only runtime path reached ${name}`);
  };
  return {
    touches,
    deps: {
      platform: 'linux',
      homeDir: home,
      env,
      now: () => NOW,
      fetch: guard('fetch'),
      spawn: guard('spawn'),
      execFile: guard('execFile'),
      readMacKeychain: guard('readMacKeychain'),
      readWindowsCredential: guard('readWindowsCredential')
    }
  };
}

test('limitsConfigFromSettings carries the setting and the env kill switch', () => {
  assert.equal(
    limitsConfigFromSettings({ claudeDesktopLocalOnly: true }, { env: {} }).claudeDesktopLocalOnly,
    true
  );
  assert.equal(
    limitsConfigFromSettings({ claudeDesktopLocalOnly: false }, {
      env: { TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: '1' }
    }).claudeDesktopLocalOnly,
    true
  );
  assert.equal(
    limitsConfigFromSettings({}, { env: {} }).claudeDesktopLocalOnly,
    false
  );
});

test('collectLimitsOnce with the setting returns Desktop windows and never touches credentials', async () => {
  const { home } = desktopHome();
  const cfg = limitsConfigFromSettings({
    limitsEnabled: true,
    limitProviders: 'claude',
    claudeDesktopLocalOnly: true
  }, { env: {} });
  const { deps, touches } = guardedDeps(home, {});
  const summary = await collectLimitsOnce(cfg, deps);
  assert.equal(summary.providers.length, 1);
  assert.equal(summary.providers[0].status, 'ok');
  assert.equal(summary.providers[0].source, 'local');
  assert.equal(summary.providers[0].sourceDetail, 'app');
  assert.deepEqual(
    summary.providers[0].windows.map((window) => [window.kind, window.usedPercent]),
    [['session', 97], ['weekly', 59]]
  );
  assert.deepEqual(touches, []);
});

test('LimitsRuntime resolveConfigSnapshot path honors a later local-only toggle', async () => {
  const { home } = desktopHome();
  const settings = {
    limitsEnabled: true,
    limitProviders: 'claude',
    claudeDesktopLocalOnly: false
  };
  const { deps, touches } = guardedDeps(home, {});
  const runtime = createLimitsRuntime(
    limitsConfigFromSettings(settings, { env: {} }),
    {
      ...deps,
      autoStart: false,
      autoRetry: false,
      resolveConfigSnapshot: () => limitsConfigFromSettings(settings, { env: {} })
    }
  );
  await runtime.refresh({ provider: 'claude' }, 'manual');
  assert.equal(runtime.getSnapshot().providers[0]?.status, 'notConfigured');

  settings.claudeDesktopLocalOnly = true;
  // Match Electron: reconfigure so the runtime options carry the flag, then
  // clear+refresh the provider scope (settingsLimitInvalidationPlan).
  runtime.reconfigure(limitsConfigFromSettings(settings, { env: {} }));
  touches.length = 0;
  runtime.clear({ provider: 'claude' }, 'settings-change');
  await runtime.refresh({ provider: 'claude' }, 'settings-change');
  const row = runtime.getSnapshot().providers[0];
  assert.equal(row?.status, 'ok', JSON.stringify(row));
  assert.equal(row.source, 'local');
  assert.deepEqual(row.windows.map((window) => window.usedPercent), [97, 59]);
  assert.deepEqual(touches, []);
});

test('empty deps.env with process-env kill switch still takes the Desktop lane', async () => {
  const { home } = desktopHome();
  const previous = process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY;
  process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY = '1';
  try {
    const cfg = limitsConfigFromSettings({
      limitsEnabled: true,
      limitProviders: 'claude',
      claudeDesktopLocalOnly: false
    }, { env: {} });
    // Config assembly itself consults context.env (empty here), so the flag on
    // options stays false — the fetcher must still honor process.env.
    assert.equal(cfg.claudeDesktopLocalOnly, false);
    const { deps, touches } = guardedDeps(home, {}); // sanitized empty env
    const summary = await collectLimitsOnce(cfg, deps);
    assert.equal(summary.providers[0].status, 'ok');
    assert.equal(summary.providers[0].source, 'local');
    assert.deepEqual(touches, []);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY;
    else process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY = previous;
  }
});

test('readClaudeCredentials never reaches the macOS keychain under local-only', async () => {
  const touches = [];
  await assert.rejects(readClaudeCredentials({
    env: {},
    platform: 'darwin',
    claudeDesktopLocalOnly: true,
    readMacKeychain: async () => { touches.push('keychain'); return ''; }
  }), (error) => error.status === 'disabled');
  assert.deepEqual(touches, []);
});

test('toggling claudeDesktopLocalOnly scopes a limits reconfigure', () => {
  const { classifySettingsChange } = require('../../src/electron/runtimeConfig');
  const change = classifySettingsChange(
    { claudeDesktopLocalOnly: false, limitProviders: 'claude' },
    { claudeDesktopLocalOnly: true, limitProviders: 'claude' }
  );
  assert.equal(change.limitsReconfigure, true);
  assert.deepEqual(change.limitScopes, [{ provider: 'claude' }]);
});
