'use strict';

// Claude Desktop local-only mode must not enter any networked Claude lane.
// The dependency bag below answers only the keys the local path needs; every
// other key (fetch, spawn, keychain and credential readers, …) is a tripwire,
// and the Web cookie / OAuth token / CLI that would otherwise be used are all
// configured, so a fall-through would trip it.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claudeDesktopLocalOnly,
  fetchClaudeLimits,
  listClaudeWebOrganizations
} = require('../../src/shared/providers/claude/limits');
const claudeAccount = require('../../src/shared/providers/claude/account');

const ORG = '11111111-2222-4333-8444-555555555555';
const NOW = Date.parse('2026-10-19T12:00:00.000Z');

function tripwireDeps(values) {
  const touched = [];
  const deps = new Proxy(values, {
    get(target, key) {
      if (Object.hasOwn(target, key)) return target[key];
      if (typeof key === 'symbol' || key === 'then') return undefined;
      touched.push(String(key));
      return () => { throw new Error(`local-only mode reached deps.${String(key)}`); };
    },
    has(target, key) { return Object.hasOwn(target, key); }
  });
  return { deps, touched };
}

function recordingFs(root) {
  const reads = [];
  const wrap = (name) => (file, ...args) => {
    reads.push(String(file));
    return fs[name](file, ...args);
  };
  return {
    reads,
    api: {
      ...fs,
      openSync: wrap('openSync'),
      readFileSync: wrap('readFileSync'),
      readdirSync: wrap('readdirSync'),
      statSync: wrap('statSync'),
      existsSync: wrap('existsSync')
    },
    assertConfined() {
      for (const file of reads) {
        assert.ok(path.resolve(file).startsWith(root), `read outside the Desktop root: ${file}`);
        assert.doesNotMatch(file, /credential|keychain|\.claude\.json|oauth/i, file);
      }
    }
  };
}

function desktopHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-local-only-'));
  const root = path.join(home, '.config', 'Claude');
  fs.mkdirSync(root, { recursive: true });
  fs.writeFileSync(path.join(root, 'plan-usage-history.json'), JSON.stringify({
    version: 2,
    samples: [{ t: NOW - 60_000, org: ORG, u: { fh: 42, sd: 17 } }]
  }));
  return { home, root };
}

const NETWORK_ENV = {
  CLAUDE_WEB_COOKIE: 'sessionKey=sk-ant-sid01-fake',
  CLAUDE_CODE_OAUTH_TOKEN: 'sk-ant-oat01-fake',
  TOKEN_MONITOR_CLAUDE_COMMAND: '/nonexistent/claude'
};

test('the switch reads the setting or the env var, and the env var cannot be overridden off', () => {
  assert.equal(claudeDesktopLocalOnly({}, {}), false);
  assert.equal(claudeDesktopLocalOnly({}, { claudeDesktopLocalOnly: true }), true);
  assert.equal(claudeDesktopLocalOnly({ TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: '1' }, {}), true);
  assert.equal(claudeDesktopLocalOnly({ TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: 'true' }, { claudeDesktopLocalOnly: false }), true);
  assert.equal(claudeDesktopLocalOnly({ TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: '0' }, {}), false);
  // deps.claudeDesktopLocalOnly is how credential form probes pass the flag
  // after blanking env so a sibling credential cannot answer for a bad paste.
  assert.equal(claudeDesktopLocalOnly({}, {}, { claudeDesktopLocalOnly: true }), true);
});

test('a sanitized deps.env cannot defeat the process-env kill switch', () => {
  const previous = process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY;
  process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY = '1';
  try {
    // Empty object is truthy, so `deps.env || process.env` would pick it and
    // hide the kill switch without the process.env fall-through.
    assert.equal(claudeDesktopLocalOnly({}, { claudeDesktopLocalOnly: false }), true);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY;
    else process.env.TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY = previous;
  }
});

for (const [name, options, env] of [
  ['setting', { claudeDesktopLocalOnly: true, claudeWebCookie: 'sessionKey=sk-ant-sid01-fake' }, { ...NETWORK_ENV }],
  ['env var', { claudeWebCookie: 'sessionKey=sk-ant-sid01-fake' }, { ...NETWORK_ENV, TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: '1' }]
]) {
  test(`local-only via ${name} returns the Desktop row and never touches a networked lane`, async () => {
    const { home, root } = desktopHome();
    const recorder = recordingFs(root);
    const { deps, touched } = tripwireDeps({
      env, homeDir: home, platform: 'linux', now: () => NOW, fs: recorder.api, claudeDesktopRoots: undefined
    });
    const originalFetch = globalThis.fetch;
    globalThis.fetch = () => { throw new Error('global fetch reached in local-only mode'); };
    try {
      const provider = await fetchClaudeLimits(options, deps);
      assert.equal(provider.status, 'ok');
      assert.equal(provider.source, 'local');
      assert.equal(provider.sourceDetail, 'app');
      assert.deepEqual(provider.windows.map(({ kind, usedPercent }) => [kind, usedPercent]), [['session', 42], ['weekly', 17]]);
    } finally {
      globalThis.fetch = originalFetch;
    }
    assert.deepEqual(touched, [], 'no dependency beyond the local reader was used');
    recorder.assertConfined();
  });
}

test('local-only without Desktop data is notConfigured, still without a networked fallback', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-local-only-empty-'));
  const { deps, touched } = tripwireDeps({
    env: { ...NETWORK_ENV, TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: '1' },
    homeDir: home, platform: 'linux', now: () => NOW, fs: undefined, claudeDesktopRoots: undefined
  });
  const provider = await fetchClaudeLimits({}, deps);
  assert.equal(provider.status, 'notConfigured');
  assert.deepEqual(touched, []);
});

test('organization discovery is refused in local-only mode', async () => {
  const { deps, touched } = tripwireDeps({ env: {}, claudeDesktopLocalOnly: true });
  await assert.rejects(listClaudeWebOrganizations('sessionKey=sk-ant-sid01-fake', deps), (error) => error.status === 'disabled');
  const viaEnv = tripwireDeps({ env: { TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY: 'yes' }, claudeDesktopLocalOnly: undefined });
  await assert.rejects(listClaudeWebOrganizations('sessionKey=sk-ant-sid01-fake', viaEnv.deps), (error) => error.status === 'disabled');
  assert.deepEqual([...touched, ...viaEnv.touched], []);
});

test('the account fields are declared settings with env fallbacks', () => {
  const fields = Object.fromEntries((claudeAccount.fields || claudeAccount.account?.fields || []).map((field) => [field.key, field]));
  assert.ok(fields.claudeDesktopLocalOnly, 'claudeDesktopLocalOnly field');
  assert.deepEqual(fields.claudeDesktopLocalOnly.envFallback, ['TOKEN_MONITOR_CLAUDE_DESKTOP_LOCAL_ONLY']);
  assert.equal(fields.claudeDesktopLocalOnly.normalize(true), true);
  assert.equal(fields.claudeDesktopLocalOnly.normalize('0'), false);
  assert.equal(fields.claudeDesktopLocalOnly.configNormalize('1'), true);
  assert.ok(fields.claudeDesktopOrgId, 'claudeDesktopOrgId field');
  assert.deepEqual(fields.claudeDesktopOrgId.envFallback, ['TOKEN_MONITOR_CLAUDE_DESKTOP_ORG_ID']);
});

test('readClaudeCredentials refuses to touch the keychain in local-only mode', async () => {
  const { readClaudeCredentials } = require('../../src/shared/providers/claude/limits');
  const { deps, touched } = tripwireDeps({
    env: {},
    platform: 'darwin',
    claudeDesktopLocalOnly: true,
    readMacKeychain: () => { throw new Error('keychain'); }
  });
  await assert.rejects(readClaudeCredentials(deps), (error) => error.status === 'disabled');
  assert.deepEqual(touched, []);
});
