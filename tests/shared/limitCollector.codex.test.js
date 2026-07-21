'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const { codexCommandCandidates, codexCommandSourceDetail, createLimitsCollector, fetchCodexLimits, mapCodexRateLimitsToProvider } = require('../../src/shared/limitCollector');
const { hashAccountKey } = require('../../src/shared/codexAuth');

function dirent(name, directory = true) {
  return {
    name,
    isDirectory: () => directory
  };
}

test('Codex command candidates include legacy and ChatGPT-bundled macOS apps', () => {
  const legacy = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgpt = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const candidates = codexCommandCandidates({}, 'darwin');

  assert.deepEqual(candidates.slice(0, 2), [legacy, chatgpt]);
  assert.equal(candidates.at(-1), 'codex');
  assert.equal(codexCommandSourceDetail(legacy, 'darwin'), 'app');
  assert.equal(codexCommandSourceDetail(chatgpt, 'darwin'), 'app');
});

test('Codex command candidates preserve an explicit command override on macOS', () => {
  assert.deepEqual(
    codexCommandCandidates({ TOKEN_MONITOR_CODEX_COMMAND: '/custom/codex' }, 'darwin'),
    ['/custom/codex']
  );
});

test('Codex command candidates include Microsoft Store app installs on Windows', () => {
  const programFiles = 'C:\\Program Files';
  const appxDir = path.win32.join(programFiles, 'WindowsApps');
  const oldAppxPackage = 'OpenAI.Codex_26.601.2237.0_x64__2p2nqsd0c76g0';
  const appxPackage = 'OpenAI.Codex_26.602.4764.0_x64__2p2nqsd0c76g0';
  const expectedResourceCli = path.win32.join(appxDir, appxPackage, 'app', 'resources', 'codex.exe');
  const expectedAppExe = path.win32.join(appxDir, appxPackage, 'app', 'Codex.exe');
  const oldAppExe = path.win32.join(appxDir, oldAppxPackage, 'app', 'Codex.exe');

  const candidates = codexCommandCandidates({
    ProgramFiles: programFiles,
    APPDATA: 'C:\\Users\\Javis\\AppData\\Roaming'
  }, 'win32', {
    readdirSync: (dir) => {
      assert.equal(dir, appxDir);
      return [dirent(oldAppxPackage), dirent(appxPackage), dirent('Other.App_1.0.0_x64__id')];
    }
  });

  assert.equal(candidates.includes(expectedResourceCli), true);
  assert.equal(candidates.includes(expectedAppExe), true);
  assert.ok(candidates.indexOf(expectedResourceCli) < candidates.indexOf(expectedAppExe));
  assert.ok(candidates.indexOf(expectedResourceCli) < candidates.indexOf(oldAppExe));
});

test('Codex command candidates include app-managed local binaries on Windows', () => {
  const localAppData = 'C:\\Users\\Javis\\AppData\\Local';
  const localBin = path.win32.join(localAppData, 'OpenAI', 'Codex', 'bin');
  const packageBin = path.win32.join(
    localAppData,
    'Packages',
    'OpenAI.Codex_2p2nqsd0c76g0',
    'LocalCache',
    'Local',
    'OpenAI',
    'Codex',
    'bin'
  );
  const expectedLocal = path.win32.join(localBin, 'codex.exe');
  const expectedLocalVersioned = path.win32.join(localBin, '716dda49c14d31a0', 'codex.exe');
  const expectedPackage = path.win32.join(packageBin, 'codex.exe');
  const expectedAlias = path.win32.join(localAppData, 'Microsoft', 'WindowsApps', 'codex.exe');
  const impossibleNodeCandidate = path.win32.join(localBin, 'node.exe', 'codex.exe');
  const impossibleCodexExeCandidate = path.win32.join(localBin, 'codex.exe', 'codex.exe');

  const candidates = codexCommandCandidates({
    LOCALAPPDATA: localAppData
  }, 'win32', {
    readdirSync: (dir) => {
      if (dir === localBin) {
        return [
          dirent('716dda49c14d31a0'),
          dirent('codex.exe', false),
          dirent('node.exe', false),
          dirent('rg.exe', false)
        ];
      }
      if (dir === path.win32.join(localAppData, 'Packages')) {
        return [dirent('OpenAI.Codex_2p2nqsd0c76g0'), dirent('Other.App')];
      }
      if (dir === packageBin) return [];
      return [];
    }
  });

  assert.equal(candidates.includes(expectedLocal), true);
  assert.equal(candidates.includes(expectedLocalVersioned), true);
  assert.equal(candidates.includes(expectedPackage), true);
  assert.equal(candidates.includes(impossibleNodeCandidate), false);
  assert.equal(candidates.includes(impossibleCodexExeCandidate), false);
  assert.ok(candidates.indexOf(expectedLocal) < candidates.indexOf(expectedAlias));
});

test('Codex command source detail separates app-managed binaries from CLI commands', () => {
  assert.equal(
    codexCommandSourceDetail('C:\\Users\\Javis\\AppData\\Local\\OpenAI\\Codex\\bin\\codex.exe', 'win32'),
    'app'
  );
  assert.equal(
    codexCommandSourceDetail('C:\\Program Files\\WindowsApps\\OpenAI.Codex_26.602.4764.0_x64__id\\app\\resources\\codex.exe', 'win32'),
    'app'
  );
  assert.equal(
    codexCommandSourceDetail('C:\\Users\\Javis\\AppData\\Roaming\\npm\\codex.cmd', 'win32'),
    'cli'
  );
  assert.equal(codexCommandSourceDetail('codex.cmd', 'win32'), 'cli');
  assert.equal(codexCommandSourceDetail('/Applications/Codex.app/Contents/Resources/codex', 'darwin'), 'app');
});

test('Codex provider preserves source detail for renderer labels', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'user@example.com', planType: 'plus' },
    rateLimits: {
      primary: {
        usedPercent: 12,
        resetsAt: '2026-06-01T00:00:00Z',
        windowDurationMins: 300
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.source, 'rpc');
  assert.equal(provider.sourceDetail, 'app');
  assert.equal(provider.accountEmail, 'user@example.com');
});

test('Codex provider reads quota windows from alternate rate limit ids', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'user@example.com', planType: 'plus' },
    rateLimits: { planType: 'plus' },
    rateLimitsByLimitId: {
      'gpt-5.4': {
        primary: {
          usedPercent: 10,
          resetsAt: '2026-06-01T05:00:00Z',
          windowDurationMins: 300
        },
        secondary: {
          usedPercent: 25,
          resetsAt: '2026-06-07T00:00:00Z',
          windowDurationMins: 10080
        }
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.status, 'ok');
  assert.deepEqual(provider.windows.map((window) => window.kind), ['session', 'weekly']);
  assert.equal(provider.windows[0].remainingPercent, 90);
  assert.equal(provider.windows[1].remainingPercent, 75);
});

test('Codex provider does not guess between conflicting alternate rate limit ids', () => {
  const snapshots = {
    'gpt-5.4': {
      primary: {
        usedPercent: 1,
        resetsAt: '2026-06-01T05:00:00Z',
        windowDurationMins: 300
      },
      secondary: {
        usedPercent: 0,
        resetsAt: '2026-06-08T00:00:00Z',
        windowDurationMins: 10080
      }
    },
    'gpt-5.4-mini': {
      primary: {
        usedPercent: 100,
        resetsAt: '2026-06-01T02:00:00Z',
        windowDurationMins: 300
      },
      secondary: {
        usedPercent: 100,
        resetsAt: '2026-06-03T00:00:00Z',
        windowDurationMins: 10080
      }
    }
  };

  for (const entries of [Object.entries(snapshots), Object.entries(snapshots).reverse()]) {
    const provider = mapCodexRateLimitsToProvider({
      account: { email: 'user@example.com', planType: 'plus' },
      rateLimits: { planType: 'plus' },
      rateLimitsByLimitId: Object.fromEntries(entries)
    }, {
      source: 'rpc',
      sourceDetail: 'app',
      updatedAt: '2026-06-01T00:00:00Z'
    });

    assert.equal(provider.status, 'ok');
    assert.deepEqual(provider.windows, []);
  }
});

test('Codex provider keeps agreed alternate windows without inheriting conflicting metadata', () => {
  const window = {
    usedPercent: 10,
    resetsAt: '2026-06-01T05:00:00Z',
    windowDurationMins: 300
  };
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'user@example.com' },
    rateLimitsByLimitId: {
      'gpt-5.4': {
        planType: 'plus',
        primary: window,
        rateLimitResetCredits: { availableCount: 2 }
      },
      'gpt-5.4-mini': {
        planType: 'team',
        primary: { ...window },
        rateLimitResetCredits: { availableCount: 3 }
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.windows[0].remainingPercent, 90);
  assert.equal(provider.accountLabel, '');
  assert.equal(provider.resetCredits, null);
});

test('Codex provider preserves alternate metadata when every bucket agrees', () => {
  const window = {
    usedPercent: 10,
    resetsAt: '2026-06-01T05:00:00Z',
    windowDurationMins: 300
  };
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'user@example.com' },
    rateLimitsByLimitId: {
      'gpt-5.4': {
        planType: 'Plus',
        primary: window,
        rateLimitResetCredits: { availableCount: 2 }
      },
      'gpt-5.4-mini': {
        plan_type: 'plus',
        primary: { ...window },
        rate_limit_reset_credits: { available_count: 2 }
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.accountLabel, 'Plus');
  assert.equal(provider.resetCredits.availableCount, 2);
});

test('Codex provider keeps successful empty quota reads as ok', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'user@example.com', planType: 'plus' },
    rateLimits: { planType: 'plus' },
    rateLimitsByLimitId: {}
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Plus');
  assert.deepEqual(provider.windows, []);
});

test('Codex provider supports managed-account source detail', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { email: 'managed@example.com', planType: 'plus' },
    rateLimits: {
      primary: {
        usedPercent: 8,
        resetsAt: '2026-06-01T00:00:00Z',
        windowDurationMins: 300
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'managed',
    accountKey: 'sha256:managed',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.sourceDetail, 'managed');
  assert.equal(provider.accountKey, 'sha256:managed');
  assert.equal(provider.accountEmail, 'managed@example.com');
});

function codexPayload(email, sourceDetail) {
  return {
    account: { email, planType: 'plus' },
    rateLimits: { primary: { usedPercent: 12, resetsAt: '2026-06-01T05:00:00Z', windowDurationMins: 300 } },
    sourceDetail
  };
}

function codexProvider(accountKey, accountEmail, remainingPercent, updatedAt) {
  return {
    provider: 'codex',
    accountKey,
    accountEmail,
    accountLabel: 'Plus',
    status: 'ok',
    source: 'rpc',
    sourceDetail: 'managed',
    updatedAt,
    windows: [
      {
        kind: 'session',
        usedPercent: 100 - remainingPercent,
        remainingPercent,
        resetsAt: '2026-06-01T05:00:00Z',
        windowMinutes: 300
      }
    ]
  };
}

function makeIdToken(payload) {
  const seg = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
  return `${seg({ alg: 'none' })}.${seg(payload)}.`;
}

// The live account's auth.json is never read in tests unless a test opts in.
const noLiveAuth = { readFileSync: () => { throw new Error('no auth.json'); } };

test('fetchCodexLimits returns one provider per managed Codex account', async () => {
  const seenHomes = [];
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'one', email: 'one@example.com', homePath: '/tmp/token-monitor-codex/one' },
      { id: 'two', email: 'two@example.com', homePath: '/tmp/token-monitor-codex/two' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    readCodexRpc: async (deps) => {
      // No live login configured in this scenario; only the managed homes resolve.
      if (!deps.env.CODEX_HOME) throw Object.assign(new Error('Codex account not configured'), { status: 'notConfigured' });
      seenHomes.push(deps.env.CODEX_HOME);
      const email = deps.env.CODEX_HOME.endsWith('/one') ? 'one@example.com' : 'two@example.com';
      return codexPayload(email);
    }
  });

  assert.deepEqual(seenHomes, ['/tmp/token-monitor-codex/one', '/tmp/token-monitor-codex/two']);
  assert.equal(providers.length, 2);
  assert.deepEqual(providers.map((provider) => provider.accountEmail), ['one@example.com', 'two@example.com']);
  assert.deepEqual(providers.map((provider) => provider.sourceDetail), ['managed', 'managed']);
});

test('fetchCodexLimits can refresh only the requested managed Codex account', async () => {
  const seenHomes = [];
  const providers = await fetchCodexLimits({
    limitRefreshScope: {
      provider: 'codex',
      accountKey: 'sha256:target',
      accountEmail: 'target@example.com',
      accountLabel: '',
      sourceDetail: 'managed'
    },
    codexManagedAccounts: [
      { id: 'other', accountKey: 'sha256:other', email: 'other@example.com', homePath: '/tmp/token-monitor-codex/other' },
      { id: 'target', accountKey: 'sha256:target', email: 'target@example.com', homePath: '/tmp/token-monitor-codex/target' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    readCodexRpc: async (deps) => {
      const home = deps.env.CODEX_HOME || '<live>';
      seenHomes.push(home);
      return home === '<live>'
        ? codexPayload('live@example.com', 'app')
        : codexPayload('target@example.com');
    }
  });

  assert.deepEqual(seenHomes, ['/tmp/token-monitor-codex/target']);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountKey, 'sha256:target');
  assert.equal(providers[0].accountEmail, 'target@example.com');
  assert.equal(providers[0].sourceDetail, 'managed');
});

test('fetchCodexLimits does not fall back to live account when scoped accounts normalize away', async () => {
  const seenHomes = [];
  const providers = await fetchCodexLimits({
    includeLiveCodexAccount: false,
    codexManagedAccounts: [
      { id: 'target', email: 'target@example.com', homePath: '' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    readCodexRpc: async (deps) => {
      seenHomes.push(deps.env.CODEX_HOME || '<live>');
      return codexPayload('live@example.com', 'app');
    }
  });

  assert.deepEqual(seenHomes, []);
  assert.deepEqual(providers, []);
});

test('createLimitsCollector scoped snapshot preserves unrelated providers and accounts', async () => {
  const oldAt = '2026-06-01T00:00:00.000Z';
  const newAt = '2026-06-01T00:01:00.000Z';
  const calls = [];
  const collector = createLimitsCollector({
    limitsEnabled: true,
    limitProviders: 'claude,codex',
    previousLimits: {
      updatedAt: oldAt,
      refreshMs: 300000,
      providers: [
        { provider: 'claude', accountKey: 'claude-a', status: 'ok', updatedAt: oldAt, windows: [] },
        { provider: 'codex', accountKey: 'codex-a', status: 'ok', updatedAt: oldAt, windows: [{ kind: 'session', usedPercent: 10 }] },
        { provider: 'codex', accountKey: 'codex-b', status: 'ok', updatedAt: oldAt, windows: [{ kind: 'session', usedPercent: 20 }] }
      ]
    }
  }, {
    now: () => Date.parse(newAt),
    providerFetchers: {
      claude: async () => {
        calls.push('claude');
        throw new Error('unrelated provider must not refresh');
      },
      codex: async (options) => {
        calls.push(`codex:${options.limitRefreshScope.accountKey}`);
        return {
          provider: 'codex',
          accountKey: 'codex-b',
          status: 'ok',
          updatedAt: newAt,
          windows: [{ kind: 'session', usedPercent: 30 }]
        };
      }
    }
  });

  const summary = await collector.refreshScope({
    provider: 'codex',
    accountKey: 'codex-b',
    accountEmail: '',
    accountLabel: '',
    sourceDetail: ''
  });

  assert.deepEqual(calls, ['codex:codex-b']);
  assert.equal(summary.providers.find((provider) => provider.accountKey === 'claude-a').updatedAt, oldAt);
  assert.equal(summary.providers.find((provider) => provider.accountKey === 'codex-a').windows[0].usedPercent, 10);
  assert.equal(summary.providers.find((provider) => provider.accountKey === 'codex-b').windows[0].usedPercent, 30);
});

test('LimitsRuntime compatibility treats a successful empty Codex refresh as authoritative', async () => {
  let now = Date.parse('2026-06-01T00:00:00Z');
  let calls = 0;
  const collector = createLimitsCollector({
    limitProviders: 'codex',
    limitsRefreshMs: 60_000
  }, {
    now: () => now,
    providerFetchers: {
      codex: async () => {
        calls += 1;
        const provider = codexProvider('sha256:codex-a', 'a@example.com', 80, new Date(now).toISOString());
        return calls === 1 ? provider : { ...provider, windows: [] };
      }
    }
  });

  const first = await collector.snapshot(true);
  now = Date.parse('2026-06-01T00:05:00Z');
  const second = await collector.snapshot(true);

  assert.equal(first.providers[0].windows.length, 1);
  assert.equal(second.providers[0].status, 'ok');
  assert.equal(second.providers[0].windows.length, 0);
  assert.equal(second.providers[0].updatedAt, '2026-06-01T00:05:00.000Z');
});

test('LimitsRuntime compatibility retains Codex windows while exposing a transient attempt status', async () => {
  let now = Date.parse('2026-06-01T00:00:00Z');
  let calls = 0;
  const collector = createLimitsCollector({
    limitProviders: 'codex',
    limitsRefreshMs: 60_000
  }, {
    now: () => now,
    providerFetchers: {
      codex: async () => {
        calls += 1;
        if (calls === 1) {
          return codexProvider('sha256:codex-live', 'live@example.com', 80, new Date(now).toISOString());
        }
        throw Object.assign(new Error('temporary Codex RPC failure'), { status: 'unavailable' });
      }
    }
  });

  const first = await collector.snapshot(true);
  now = Date.parse('2026-06-01T00:05:00Z');
  const second = await collector.snapshot(true);

  assert.equal(first.providers[0].windows[0].remainingPercent, 80);
  assert.equal(second.providers[0].status, 'unavailable');
  assert.equal(second.providers[0].accountKey, 'sha256:codex-live');
  assert.equal(second.providers[0].accountEmail, 'live@example.com');
  assert.equal(second.providers[0].source, 'rpc');
  assert.equal(second.providers[0].windows[0].remainingPercent, 80);
  assert.equal(second.providers[0].updatedAt, '2026-06-01T00:00:00.000Z');
});

test('LimitsRuntime compatibility seeds last-good windows across a transient first refresh', async () => {
  // Switching the active Codex account reloads the collector (startMode), which
  // used to reset the in-memory transient-window cache. Seeding it from the last
  // published limits keeps each account's bars through the cold RPC/token-refresh
  // probe that commonly fails on the first tick right after a switch.
  const now = Date.parse('2026-06-01T00:02:00Z');
  const seededAt = '2026-06-01T00:00:00.000Z';
  const collector = createLimitsCollector({
    limitProviders: 'codex',
    limitsRefreshMs: 60_000,
    previousLimits: {
      updatedAt: seededAt,
      providers: [
        codexProvider('sha256:codex-a', 'a@example.com', 80, seededAt),
        codexProvider('sha256:codex-b', 'b@example.com', 55, seededAt),
        codexProvider('sha256:codex-c', 'c@example.com', 30, seededAt)
      ]
    }
  }, {
    now: () => now,
    providerFetchers: {
      codex: async () => ([
        codexProvider('sha256:codex-a', 'a@example.com', 80, new Date(now).toISOString()),
        codexProvider('sha256:codex-b', 'b@example.com', 55, new Date(now).toISOString()),
        {
          provider: 'codex',
          accountKey: 'sha256:codex-c',
          accountEmail: 'c@example.com',
          status: 'unavailable',
          source: 'rpc',
          updatedAt: new Date(now).toISOString(),
          windows: []
        }
      ])
    }
  });

  const first = await collector.snapshot(true);
  const c = first.providers.find((provider) => provider.accountKey === 'sha256:codex-c');

  assert.equal(c.status, 'unavailable');
  assert.equal(c.windows.length, 1);
  assert.equal(c.windows[0].remainingPercent, 30);
  assert.equal(c.updatedAt, seededAt);
});

test('fetchCodexLimits skips disabled managed Codex accounts', async () => {
  const seenHomes = [];
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'one', email: 'one@example.com', homePath: '/tmp/token-monitor-codex/one', enabled: true },
      { id: 'two', email: 'two@example.com', homePath: '/tmp/token-monitor-codex/two', enabled: false }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    readCodexRpc: async (deps) => {
      if (!deps.env.CODEX_HOME) throw Object.assign(new Error('Codex account not configured'), { status: 'notConfigured' });
      seenHomes.push(deps.env.CODEX_HOME);
      return codexPayload('one@example.com');
    }
  });

  assert.deepEqual(seenHomes, ['/tmp/token-monitor-codex/one']);
  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountEmail, 'one@example.com');
});

test('fetchCodexLimits keeps the live system account visible alongside managed accounts', async () => {
  const seenHomes = [];
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'two', email: 'two@example.com', homePath: '/tmp/token-monitor-codex/two' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    ...noLiveAuth,
    readCodexRpc: async (deps) => {
      const home = deps.env.CODEX_HOME || '<live>';
      seenHomes.push(home);
      return home === '<live>'
        ? codexPayload('live@example.com', 'app')
        : codexPayload('two@example.com');
    }
  });

  // The live login (the account the Codex app uses) is probed first and stays visible.
  assert.deepEqual(seenHomes, ['<live>', '/tmp/token-monitor-codex/two']);
  assert.deepEqual(providers.map((provider) => provider.accountEmail), ['live@example.com', 'two@example.com']);
  assert.deepEqual(providers.map((provider) => provider.sourceDetail), ['app', 'managed']);
});

test('fetchCodexLimits does not show the live account twice when it is also managed', async () => {
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'a', email: 'a@example.com', homePath: '/tmp/token-monitor-codex/a' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    ...noLiveAuth,
    readCodexRpc: async (deps) => codexPayload('a@example.com', deps.env.CODEX_HOME ? undefined : 'app')
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountEmail, 'a@example.com');
  assert.equal(providers[0].sourceDetail, 'app');
});

test('fetchCodexLimits dedups the live account against the same managed account by account id (no email needed)', async () => {
  const sharedKey = hashAccountKey('acct_shared');
  const idToken = makeIdToken({ chatgpt_account_id: 'acct_shared' }); // no email claim
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'm', email: '', accountKey: sharedKey, homePath: '/tmp/token-monitor-codex/m' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    codexAuthPath: '/fake/.codex/auth.json',
    readFileSync: () => JSON.stringify({ tokens: { id_token: idToken } }),
    readCodexRpc: async (deps) => ({
      account: { planType: 'plus' },
      rateLimits: { primary: { usedPercent: 3, resetsAt: '2026-06-01T05:00:00Z', windowDurationMins: 300 } },
      sourceDetail: deps.env.CODEX_HOME ? undefined : 'app'
    })
  });

  assert.equal(providers.length, 1);
  assert.equal(providers[0].accountKey, sharedKey);
  assert.equal(providers[0].sourceDetail, 'app'); // the live representation is kept
});

test('fetchCodexLimits fills the live account email from auth.json when the RPC omits it', async () => {
  const idToken = makeIdToken({ email: 'live@example.com', chatgpt_account_id: 'acct_live' });
  const providers = await fetchCodexLimits({
    codexManagedAccounts: [
      { id: 'm', email: 'managed@example.com', accountKey: 'sha256:managed', homePath: '/tmp/token-monitor-codex/m' }
    ]
  }, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    codexAuthPath: '/fake/.codex/auth.json',
    readFileSync: (p) => {
      assert.equal(p, '/fake/.codex/auth.json');
      return JSON.stringify({ tokens: { id_token: idToken } });
    },
    readCodexRpc: async (deps) => {
      // Live RPC returns no email (the real-world bug); managed home returns its own.
      if (!deps.env.CODEX_HOME) {
        return { account: { planType: 'plus' }, rateLimits: { primary: { usedPercent: 2, resetsAt: '2026-06-01T05:00:00Z', windowDurationMins: 300 } }, sourceDetail: 'app' };
      }
      return codexPayload('managed@example.com');
    }
  });

  const live = providers.find((provider) => provider.sourceDetail === 'app');
  assert.ok(live, 'live account should be present');
  assert.equal(live.accountEmail, 'live@example.com');
  assert.match(live.accountKey, /^sha256:[0-9a-f]{64}$/);
});

test('fetchCodexLimits retries empty Codex quota reads on the same RPC session', async () => {
  const { EventEmitter } = require('node:events');
  let spawns = 0;
  let rateLimitReads = 0;
  const providers = await fetchCodexLimits({}, {
    now: () => Date.parse('2026-06-01T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    codexCommand: 'codex',
    codexEmptyQuotaRetryDelayMs: 0,
    ...noLiveAuth,
    spawn: () => {
      spawns += 1;
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(line) {
          const message = JSON.parse(String(line));
          const respond = (result) => {
            queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
          };
          if (message.method === 'initialize') respond({});
          if (message.method === 'account/rateLimits/read') {
            rateLimitReads += 1;
            respond(rateLimitReads === 1
              ? {
                  rateLimits: { planType: 'plus' },
                  rateLimitsByLimitId: {}
                }
              : {
                  rateLimits: {
                    primary: {
                      usedPercent: 4,
                      resetsAt: '2026-06-01T05:00:00Z',
                      windowDurationMins: 300
                    }
                  }
                });
          }
          if (message.method === 'account/read') respond({ account: { email: 'live@example.com', planType: 'plus' } });
        }
      };
      child.kill = () => {};
      return child;
    }
  });

  assert.equal(spawns, 1);
  assert.equal(rateLimitReads, 2);
  assert.equal(providers.status, 'ok');
  assert.equal(providers.accountLabel, 'Plus');
  assert.equal(providers.windows[0].remainingPercent, 96);
});

test('fetchCodexLimits gives Codex RPC a generous default timeout', async () => {
  const { EventEmitter } = require('node:events');
  const originalSetTimeout = global.setTimeout;
  const delays = [];
  global.setTimeout = (fn, delay, ...args) => {
    delays.push(delay);
    return originalSetTimeout(fn, delay, ...args);
  };
  try {
    const provider = await fetchCodexLimits({}, {
      now: () => Date.parse('2026-06-01T00:00:00Z'),
      env: { PATH: '/usr/bin' },
      codexCommand: 'codex',
      ...noLiveAuth,
      spawn: () => {
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
          write(line) {
            const message = JSON.parse(String(line));
            const respond = (result) => {
              queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
            };
            if (message.method === 'initialize') respond({});
            if (message.method === 'account/rateLimits/read') {
              respond({
                rateLimits: {
                  primary: {
                    usedPercent: 4,
                    resetsAt: '2026-06-01T05:00:00Z',
                    windowDurationMins: 300
                  }
                }
              });
            }
            if (message.method === 'account/read') respond({ account: { email: 'live@example.com', planType: 'plus' } });
          }
        };
        child.kill = () => {};
        return child;
      }
    });

    assert.equal(provider.status, 'ok');
    assert.ok(delays.some((delay) => delay >= 20_000), `expected a Codex RPC timeout >= 20000ms, got ${delays.join(', ')}`);
  } finally {
    global.setTimeout = originalSetTimeout;
  }
});

test('fetchCodexLimits does not retry usage-based Codex plans without quota windows', async () => {
  const { EventEmitter } = require('node:events');
  const cases = [
    { planType: 'enterprise_cbp_usage_based', label: 'Enterprise' },
    { planType: 'self serve business usage based', label: 'Business' }
  ];

  for (const { planType, label } of cases) {
    let spawns = 0;
    let rateLimitReads = 0;
    const providers = await fetchCodexLimits({}, {
      now: () => Date.parse('2026-06-01T00:00:00Z'),
      env: { PATH: '/usr/bin' },
      codexCommand: 'codex',
      codexEmptyQuotaRetryDelayMs: 0,
      ...noLiveAuth,
      spawn: () => {
        spawns += 1;
        const child = new EventEmitter();
        child.stdout = new EventEmitter();
        child.stderr = new EventEmitter();
        child.stdin = {
          write(line) {
            const message = JSON.parse(String(line));
            const respond = (result) => {
              queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
            };
            if (message.method === 'initialize') respond({});
            if (message.method === 'account/rateLimits/read') {
              rateLimitReads += 1;
              respond({
                rateLimits: { planType },
                rateLimitsByLimitId: {}
              });
            }
            if (message.method === 'account/read') respond({ account: { email: 'live@example.com', planType } });
          }
        };
        child.kill = () => {};
        return child;
      }
    });

    assert.equal(spawns, 1);
    assert.equal(rateLimitReads, 1);
    assert.equal(providers.status, 'ok');
    assert.equal(providers.accountLabel, label);
    assert.deepEqual(providers.windows, []);
  }
});

test('Codex exhausted quota remains a live provider with zero remaining window', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { planType: 'plus' },
    rateLimits: {
      rateLimitReachedType: 'primary',
      primary: {
        usedPercent: 100,
        resetsAt: '2026-06-01T05:00:00Z',
        windowDurationMins: 300
      },
      secondary: {
        usedPercent: 39,
        resetsAt: '2026-06-06T00:00:00Z',
        windowDurationMins: 10080
      }
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-01T00:00:00Z'
  });

  assert.equal(provider.status, 'ok');
  assert.equal(provider.accountLabel, 'Plus');
  assert.equal(provider.windows[0].kind, 'session');
  assert.equal(provider.windows[0].remainingPercent, 0);
  assert.equal(provider.windows[1].kind, 'weekly');
  assert.equal(provider.windows[1].remainingPercent, 61);
});

test('Codex provider preserves manual reset credits from RPC payload', () => {
  const provider = mapCodexRateLimitsToProvider({
    account: { planType: 'plus' },
    rateLimits: {
      primary: {
        usedPercent: 54,
        resetsAt: 1782801999,
        windowDurationMins: 300
      },
      secondary: {
        usedPercent: 8,
        resetsAt: 1783388799,
        windowDurationMins: 10080
      }
    },
    rateLimitResetCredits: {
      availableCount: 2,
      nextExpiresAt: '2026-07-18T23:00:00Z',
      expirations: [
        '2026-07-18T23:00:00Z',
        '2026-07-19T01:00:00Z'
      ]
    }
  }, {
    source: 'rpc',
    sourceDetail: 'app',
    updatedAt: '2026-06-30T00:00:00Z'
  });

  assert.deepEqual(provider.resetCredits, {
    availableCount: 2,
    nextExpiresAt: '2026-07-18T23:00:00.000Z',
    expirations: [
      '2026-07-18T23:00:00.000Z',
      '2026-07-19T01:00:00.000Z'
    ]
  });
});

test('fetchCodexLimits keeps reset credits returned by the Codex RPC reader', async () => {
  const { EventEmitter } = require('node:events');
  const providers = await fetchCodexLimits({}, {
    now: () => Date.parse('2026-06-30T00:00:00Z'),
    env: { PATH: '/usr/bin' },
    codexCommand: 'codex',
    ...noLiveAuth,
    spawn: () => {
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      child.stdin = {
        write(line) {
          const message = JSON.parse(String(line));
          const respond = (result) => {
            queueMicrotask(() => child.stdout.emit('data', `${JSON.stringify({ id: message.id, result })}\n`));
          };
          if (message.method === 'initialize') respond({});
          if (message.method === 'account/rateLimits/read') {
            respond({
              rateLimits: {
                primary: { usedPercent: 54, resetsAt: '2026-06-30T05:00:00Z', windowDurationMins: 300 },
                secondary: { usedPercent: 8, resetsAt: '2026-07-07T00:00:00Z', windowDurationMins: 10080 }
              },
              rateLimitResetCredits: { availableCount: 2 }
            });
          }
          if (message.method === 'account/read') respond({ account: { email: 'live@example.com', planType: 'plus' } });
        }
      };
      child.kill = () => {};
      return child;
    }
  });

  assert.equal(providers.resetCredits.availableCount, 2);
});

test('fetchCodexLimits augments reset credits expiry from the Codex OAuth endpoint', async () => {
  const idToken = makeIdToken({ email: 'live@example.com', chatgpt_account_id: 'acct_live' });
  const fetches = [];
  const providers = await fetchCodexLimits({}, {
    now: () => Date.parse('2026-06-30T00:00:00Z'),
    env: { PATH: '/usr/bin', CODEX_HOME: '/tmp/token-monitor-codex/live' },
    codexAuthPath: '/tmp/token-monitor-codex/live/auth.json',
    codexCommand: 'codex',
    readFileSync: (file) => {
      if (String(file).endsWith('auth.json')) {
        return JSON.stringify({ tokens: { access_token: 'access-token', id_token: idToken } });
      }
      if (String(file).endsWith('config.toml')) {
        return 'chatgpt_base_url = "https://chatgpt.com/backend-api/"\n';
      }
      throw new Error(`unexpected read ${file}`);
    },
    fetch: async (url, options) => {
      fetches.push({ url, options });
      return {
        ok: true,
        status: 200,
        json: async () => ({
          credits: [
            {
              id: 'expired',
              status: 'available',
              expires_at: '2026-06-17T00:39:53Z'
            },
            {
              id: 'later',
              status: 'available',
              expires_at: '2026-07-18T00:39:53.731630Z'
            },
            {
              id: 'earlier',
              status: 'available',
              expires_at: '2026-07-12T04:03:43.263391Z'
            },
            {
              id: 'future-status',
              status: 'future_status',
              expires_at: '2026-07-10T04:03:43Z'
            }
          ],
          available_count: 2
        })
      };
    },
    readCodexRpc: async () => ({
      account: { email: 'live@example.com', planType: 'plus' },
      rateLimits: {
        primary: { usedPercent: 54, resetsAt: '2026-06-30T05:00:00Z', windowDurationMins: 300 }
      },
      rateLimitResetCredits: { availableCount: 2 },
      sourceDetail: 'app'
    })
  });

  assert.equal(fetches.length, 1);
  assert.equal(fetches[0].url, 'https://chatgpt.com/backend-api/wham/rate-limit-reset-credits');
  assert.equal(fetches[0].options.headers.authorization, 'Bearer access-token');
  assert.equal(fetches[0].options.headers['chatgpt-account-id'], 'acct_live');
  assert.equal(fetches[0].options.headers['openai-beta'], 'codex-1');
  assert.equal(fetches[0].options.headers.originator, 'Codex Desktop');
  assert.deepEqual(providers.resetCredits, {
    availableCount: 2,
    nextExpiresAt: '2026-07-12T04:03:43.263Z',
    expirations: [
      '2026-07-12T04:03:43.263Z',
      '2026-07-18T00:39:53.731Z'
    ]
  });
});

test('LimitsRuntime compatibility snapshot probes initially and reuses the configured TTL', async () => {
  let now = Date.parse('2026-07-21T00:00:00.000Z');
  let calls = 0;
  const collector = createLimitsCollector({
    limitProviders: ['codex'],
    limitsRefreshMs: 60_000
  }, {
    now: () => now,
    providerFetchers: {
      codex: async () => {
        calls += 1;
        return codexProvider('sha256:codex-a', 'a@example.com', 80, new Date(now).toISOString());
      }
    }
  });

  assert.equal((await collector.snapshot()).providers.length, 1);
  assert.equal(calls, 1);
  now += 59_999;
  await collector.snapshot();
  assert.equal(calls, 1);
  now += 1;
  await collector.snapshot();
  assert.equal(calls, 2);
  collector.stop();
});
