'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { formatTrayText, pickUsageTrayIconId } = require('../../src/electron/tray');
const { pickConfiguredSessionLimits } = require('../../src/shared/trayText');

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
