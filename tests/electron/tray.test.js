'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { formatTrayText, pickUsageTrayIconId } = require('../../src/electron/tray');
const {
  compactLimitSelection,
  pickConfiguredLimitProviders,
  pickConfiguredSessionLimits,
  pickLimitProviderByKindPriority,
  pickWorstLimitProvider
} = require('../../src/shared/trayText');

const stats = {
  periods: {
    today: {
      clients: { claude: 10, codex: 25 },
      clientCosts: { claude: 0.5, codex: 0.2 }
    },
    allTime: {
      clients: { claude: 100, codex: 40 },
      clientCosts: { claude: 1, codex: 2 }
    }
  }
};

test('usage tray icon picks the top token client for day and total token modes', () => {
  assert.equal(pickUsageTrayIconId(stats, 'tokens', ['claude', 'codex']), 'codex');
  assert.equal(pickUsageTrayIconId(stats, 'both', ['claude', 'codex']), 'codex');
  assert.equal(pickUsageTrayIconId(stats, 'tokensAll', ['claude', 'codex']), 'claude');
  assert.equal(pickUsageTrayIconId(stats, 'bothAll', ['claude', 'codex']), 'claude');
});

test('usage tray icon picks the top cost client for day and total cost modes', () => {
  assert.equal(pickUsageTrayIconId(stats, 'cost', ['claude', 'codex']), 'claude');
  assert.equal(pickUsageTrayIconId(stats, 'costAll', ['claude', 'codex']), 'codex');
});

test('usage tray icon falls back to token usage when cost breakdown is unavailable', () => {
  assert.equal(
    pickUsageTrayIconId({ periods: { today: { clients: { claude: 3, codex: 9 } } } }, 'cost', ['claude', 'codex']),
    'codex'
  );
});

test('usage tray icon leaves pure icon and bar modes to their existing icon paths', () => {
  assert.equal(pickUsageTrayIconId(stats, 'icon', ['claude', 'codex']), null);
  assert.equal(pickUsageTrayIconId(stats, 'bars', ['claude', 'codex']), null);
  assert.equal(pickUsageTrayIconId(stats, 'barsSession', ['claude', 'codex']), null);
});

test('usage tray icon returns null when the top client has no available icon', () => {
  assert.equal(
    pickUsageTrayIconId({ periods: { today: { clients: { unknown: 20, codex: 10 } } } }, 'tokens', ['codex']),
    null
  );
});

test('tray can show the first two configured session quotas as percentages', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'session', remainingPercent: 57 }] },
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 24 }] },
        { provider: 'cursor', status: 'ok', windows: [{ kind: 'session', remainingPercent: 91 }] }
      ]
    }
  };

  assert.equal(
    formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
      limitProviderOrder: 'claude,codex,cursor',
      limitProviders: 'claude,codex,cursor',
      showLimitUsed: false
    }),
    '24% · 57%'
  );
});

test('configured session quota picks keep provider ids for icon rendering', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'session', remainingPercent: 57 }] },
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 24 }] },
        { provider: 'cursor', status: 'ok', windows: [{ kind: 'session', remainingPercent: 91 }] }
      ]
    }
  };

  assert.deepEqual(
    pickConfiguredSessionLimits(limitStats, {
      limitProviderOrder: 'claude,codex,cursor',
      limitProviders: 'claude,codex,cursor',
      showLimitUsed: false
    }).map((pick) => [pick.provider, pick.percent]),
    [['claude', 24], ['codex', 57]]
  );
});

test('tray session quota text falls back to one provider session and weekly windows', () => {
  const limitStats = {
    limits: {
      providers: [
        {
          provider: 'codex',
          status: 'ok',
          windows: [
            { kind: 'session', remainingPercent: 6, usedPercent: 94 },
            { kind: 'weekly', remainingPercent: 1, usedPercent: 99 }
          ]
        },
        { provider: 'claude', status: 'notConfigured', windows: [] }
      ]
    }
  };

  assert.equal(
    formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
      limitProviderOrder: 'codex,claude',
      limitProviders: 'codex,claude',
      showLimitUsed: false
    }),
    '6% · 1%'
  );
  assert.equal(
    formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
      limitProviderOrder: 'codex,claude',
      limitProviders: 'codex,claude',
      showLimitUsed: true
    }),
    '94% · 99%'
  );
});

test('tray session quota text omits an unavailable weekly window', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'session', remainingPercent: 6 }] }
      ]
    }
  };

  assert.equal(
    formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
      limitProviderOrder: 'codex',
      limitProviders: 'codex',
      showLimitUsed: false
    }),
    '6%'
  );
});

test('tray primary quota modes promote a weekly-only provider', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 64, usedPercent: 36 }] }
      ]
    }
  };

  const [pick] = pickConfiguredLimitProviders(limitStats, {
    limitProviderOrder: 'codex',
    limitProviders: 'codex'
  });
  assert.equal(pick.primaryWindow.kind, 'weekly');
  assert.equal(pick.secondaryWindow, null);
  assert.equal(formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
    limitProviderOrder: 'codex',
    limitProviders: 'codex',
    showLimitUsed: false
  }), '64%');
  assert.equal(formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
    limitProviderOrder: 'codex',
    limitProviders: 'codex',
    showLimitUsed: true
  }), '36%');
});

test('session bar mode falls back to weekly only when no session exists', () => {
  const weeklyOnlyStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 82 }] },
        { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 4 }] }
      ]
    }
  };
  const mixedStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 4 }] },
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 90 }] }
      ]
    }
  };

  const weeklyPick = pickLimitProviderByKindPriority(weeklyOnlyStats, ['session', 'weekly']);
  assert.equal(weeklyPick.provider, 'codex');
  assert.equal(weeklyPick.primaryWindow.kind, 'weekly');
  assert.equal(weeklyPick.primaryWindow.remainingPercent, 4);
  assert.equal(weeklyPick.secondaryWindow, null);

  const sessionPick = pickLimitProviderByKindPriority(mixedStats, ['session', 'weekly']);
  assert.equal(sessionPick.provider, 'claude');
  assert.equal(sessionPick.primaryWindow.kind, 'session');
});

test('configured provider account selection prefers session over fallback windows', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', accountLabel: 'weekly', windows: [{ kind: 'weekly', remainingPercent: 5 }] },
        { provider: 'codex', status: 'ok', accountLabel: 'session', windows: [{ kind: 'session', remainingPercent: 80 }] }
      ]
    }
  };

  const [pick] = pickConfiguredLimitProviders(limitStats, {
    limitProviderOrder: 'codex',
    limitProviders: 'codex'
  });
  assert.equal(pick.providerRecord.accountLabel, 'session');
  assert.equal(pick.primaryWindow.kind, 'session');
});

test('configured provider selection preserves an explicit empty filter', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', windows: [{ kind: 'weekly', remainingPercent: 25 }] }
      ]
    }
  };

  assert.deepEqual(pickConfiguredLimitProviders(limitStats, {
    limitProviderOrder: [],
    limitProviders: []
  }), []);
  assert.deepEqual(pickConfiguredLimitProviders(limitStats, {
    limitProviderOrder: '',
    limitProviders: ''
  }), []);
});

test('compact provider windows preserve Claude session plus general weekly', () => {
  const selection = compactLimitSelection({
    provider: 'claude',
    status: 'ok',
    windows: [
      { kind: 'session', remainingPercent: 70 },
      { kind: 'weekly', remainingPercent: 80 },
      { kind: 'weekly', label: 'Fable', remainingPercent: 5 }
    ]
  });

  assert.equal(selection.primaryWindow.kind, 'session');
  assert.equal(selection.secondaryWindow.remainingPercent, 80);
  assert.equal(selection.secondaryWindow.label, undefined);
});

test('compact provider windows use billing as a final fallback and ignore non-meter rows', () => {
  const selection = compactLimitSelection({
    provider: 'cursor',
    status: 'ok',
    windows: [
      { kind: 'billing', label: 'Total', remainingPercent: 72 },
      { kind: 'billing', label: 'API', remainingPercent: 4 },
      { kind: 'billing', label: 'Credits', remainingPercent: 1, showMeter: false }
    ]
  });

  assert.equal(selection.primaryWindow.label, 'Total');
  assert.equal(selection.secondaryWindow, null);
});

test('compact provider windows choose the lowest pool when no aggregate exists', () => {
  const selection = compactLimitSelection({
    provider: 'antigravity',
    status: 'ok',
    windows: [
      { kind: 'weekly', label: 'Gemini Pro', remainingPercent: 72 },
      { kind: 'weekly', label: 'Gemini Flash', remainingPercent: 0 },
      { kind: 'weekly', label: 'Claude', remainingPercent: 35 }
    ]
  });

  assert.equal(selection.primaryWindow.label, 'Gemini Flash');
  assert.equal(selection.primaryWindow.remainingPercent, 0);
});

test('compact window policy covers every supported limits provider shape', () => {
  const sessionWeekly = ['claude', 'codex', 'minimax', 'zai', 'zaiteam', 'volcengine', 'kimi', 'ollama'];
  const billing = ['cursor', 'mimo', 'grok', 'copilot', 'kiro', 'qoder'];

  for (const provider of sessionWeekly) {
    const selection = compactLimitSelection({
      provider,
      status: 'ok',
      windows: [{ kind: 'session', remainingPercent: 70 }, { kind: 'weekly', remainingPercent: 60 }]
    });
    assert.equal(selection.primaryWindow.kind, 'session', provider);
    assert.equal(selection.secondaryWindow.kind, 'weekly', provider);
  }

  for (const provider of billing) {
    const selection = compactLimitSelection({
      provider,
      status: 'ok',
      windows: [{ kind: 'billing', remainingPercent: 55 }]
    });
    assert.equal(selection.primaryWindow.kind, 'billing', provider);
    assert.equal(selection.secondaryWindow, null, provider);
  }

  const antigravity = compactLimitSelection({
    provider: 'antigravity',
    status: 'ok',
    windows: [{ kind: 'weekly', label: 'Gemini', remainingPercent: 45 }]
  });
  assert.equal(antigravity.primaryWindow.kind, 'weekly');
  assert.equal(antigravity.secondaryWindow, null);

  const opencode = compactLimitSelection({
    provider: 'opencode',
    status: 'ok',
    windows: [{ kind: 'session', remainingPercent: 40 }, { kind: 'weekly', remainingPercent: 30 }, { kind: 'billing', remainingPercent: 20 }]
  });
  assert.equal(opencode.primaryWindow.kind, 'session');
  assert.equal(opencode.secondaryWindow.kind, 'weekly');

  assert.equal(compactLimitSelection({ provider: 'deepseek', status: 'ok', windows: [] }), null);
});

test('worst-provider resolver returns the window it actually selected', () => {
  const weekly = { kind: 'weekly', remainingPercent: 12 };
  const limitStats = {
    limits: {
      providers: [
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 60 }, weekly] },
        { provider: 'codex', status: 'ok', windows: [{ kind: 'session', remainingPercent: 30 }] }
      ]
    }
  };

  const pick = pickWorstLimitProvider(limitStats, { kind: 'weekly' });
  assert.equal(pick.provider, 'claude');
  assert.equal(pick.selectedWindow, weekly);
  assert.equal(pick.secondaryWindow, weekly);
});

test('kind-specific resolver can select billing from a mixed-window provider', () => {
  const billing = { kind: 'billing', label: 'Monthly', remainingPercent: 9 };
  const pick = pickWorstLimitProvider({
    limits: {
      providers: [{
        provider: 'opencode',
        status: 'ok',
        windows: [
          { kind: 'session', remainingPercent: 80 },
          { kind: 'weekly', remainingPercent: 70 },
          billing
        ]
      }]
    }
  }, { kind: 'billing' });

  assert.equal(pick.selectedWindow, billing);
  assert.equal(pick.remaining, 9);
});

test('tray session quota text keeps lowest-remaining account selection when showing used percent', () => {
  const limitStats = {
    limits: {
      providers: [
        { provider: 'codex', status: 'ok', accountLabel: 'main', windows: [{ kind: 'session', remainingPercent: 80 }] },
        { provider: 'codex', status: 'ok', accountLabel: 'work', windows: [{ kind: 'session', remainingPercent: 30 }] },
        { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 40 }] }
      ]
    }
  };

  assert.equal(
    formatTrayText(limitStats, 'limitsAllSessions', 'USD', {
      limitProviderOrder: 'codex,claude',
      limitProviders: 'codex,claude',
      showLimitUsed: true
    }),
    '70% · 60%'
  );
});

test('tray cost text uses the selected display currency', () => {
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'cost'), '$1.0000');
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'cost', 'TWD'), 'NT$31.50');
  assert.equal(formatTrayText({ periods: { today: { costUsd: 1, totalTokens: 12_000 } } }, 'both', 'HKD'), '12.0K · HK$7.80');
});
