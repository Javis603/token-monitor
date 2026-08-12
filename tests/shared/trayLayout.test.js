'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const trayTextApi = require('../../src/shared/trayText');

const {
  accountOptions,
  appendTrayLayoutItem,
  createDefaultTrayLayout,
  createTrayLayoutItem,
  formatResetCountdown,
  moveTrayLayoutItem,
  normalizeTrayLayout,
  preferredRowProvider,
  removeTrayLayoutItem,
  replaceTrayLayoutItem,
  resolveTrayLayout,
  selectSource,
  sourceWindowOptions,
  trayLayoutNeedsClock,
  windowKey,
  windowOptions
} = require('../../src/shared/trayLayout');

const now = Date.parse('2026-07-23T08:00:00.000Z');
const stats = {
  periods: {
    today: {
      totalTokens: 1_240_000,
      costUsd: 4.25,
      clients: { claude: 300_000, codex: 940_000 },
      clientCosts: { claude: 3.25, codex: 1 }
    },
    month: {
      totalTokens: 9_500_000,
      costUsd: 31,
      clients: { claude: 4_000_000, codex: 5_500_000 },
      clientCosts: { claude: 10, codex: 21 }
    },
    allTime: {
      totalTokens: 226_934_966,
      costUsd: 194.5,
      clients: { claude: 150_000_000, codex: 76_934_966 },
      clientCosts: { claude: 70, codex: 124.5 }
    }
  },
  limits: {
    providers: [
      {
        provider: 'codex',
        status: 'ok',
        sourceDetail: 'app',
        accountKey: 'active',
        accountEmail: 'active@example.com',
        windows: [
          { kind: 'session', label: '5-hour', remainingPercent: 72, resetsAt: '2026-07-23T08:42:00.000Z' },
          { kind: 'weekly', label: 'Weekly', remainingPercent: 64, resetsAt: '2026-07-29T10:00:00.000Z' }
        ]
      },
      {
        provider: 'codex',
        status: 'ok',
        sourceDetail: 'managed',
        accountKey: 'managed',
        accountEmail: 'managed@example.com',
        windows: [
          { kind: 'weekly', label: 'Weekly', remainingPercent: 18, resetsAt: '2026-07-24T11:07:00.000Z' }
        ]
      },
      {
        provider: 'claude',
        status: 'ok',
        accountKey: 'claude',
        accountLabel: 'Max',
        windows: [
          { kind: 'session', remainingPercent: 42, resetsAt: '2026-07-23T11:07:00.000Z' },
          { kind: 'weekly', remainingPercent: 81, resetsAt: '2026-07-29T10:00:00.000Z' }
        ]
      }
    ]
  }
};

test('tray layouts normalize to a versioned and bounded shape', () => {
  const malformed = {
    version: 99,
    items: [
      { id: 'one', type: 'icon', icon: 'provider', source: { provider: 'CODEX', accountMode: 'bad' } },
      { id: 'two', type: 'bars', rows: [{ provider: 'claude' }, { provider: 'codex' }, { provider: 'ignored' }] },
      { id: 'three', type: 'unknown' }
    ]
  };

  assert.deepEqual(normalizeTrayLayout(malformed), {
    version: 3,
    items: [
      {
        id: 'one',
        type: 'icon',
        style: 'providerIcon',
        icon: 'provider',
        autoMode: 'lowestLimit',
        period: 'today',
        source: { provider: 'codex', accountMode: 'lowest', accountKey: '', window: 'primary', valueMode: 'remaining' }
      },
      {
        id: 'two',
        type: 'bars',
        style: 'doubleBar',
        icon: 'first',
        rows: [
          { provider: 'claude', accountMode: 'lowest', accountKey: '', window: 'primary', valueMode: 'remaining' },
          { provider: 'codex', accountMode: 'lowest', accountKey: '', window: 'secondary', valueMode: 'remaining' }
        ]
      }
    ]
  });
});

test('tray layout normalization keeps twelve valid items and assigns unique ids', () => {
  const malformed = Array.from({ length: 12 }, (_, index) => (
    index % 2 === 0 ? null : { id: 'duplicate', type: 'text', metric: 'tokens' }
  ));
  const validTail = Array.from({ length: 12 }, (_, index) => ({
    id: index === 0 ? 'duplicate' : `tail-${index}`,
    type: 'text',
    metric: 'tokens'
  }));
  const normalized = normalizeTrayLayout({ items: [...malformed, ...validTail] });

  assert.equal(normalized.items.length, 12);
  assert.equal(new Set(normalized.items.map((item) => item.id)).size, 12);
  assert.deepEqual(normalized.items.slice(0, 3).map((item) => item.id), [
    'duplicate',
    'duplicate-2',
    'duplicate-3'
  ]);
  assert.equal(normalized.items.at(-1).id, 'tail-5');
});

test('tray layout editing keeps item ids stable and supports add, move, update and remove', () => {
  let layout = createDefaultTrayLayout();
  layout = appendTrayLayoutItem(layout, 'percentReset', { idFactory: () => 'quota' });
  layout = appendTrayLayoutItem(layout, 'doubleBar', { idFactory: () => 'bars' });
  assert.deepEqual(layout.items.map((item) => item.id), ['app-icon', 'quota', 'bars']);

  layout = moveTrayLayoutItem(layout, 'bars', 0);
  assert.deepEqual(layout.items.map((item) => item.id), ['bars', 'app-icon', 'quota']);

  layout = replaceTrayLayoutItem(layout, 'quota', {
    metric: 'reset',
    source: { provider: 'codex', accountMode: 'active', window: 'weekly' }
  });
  assert.equal(layout.items[2].id, 'quota');
  assert.equal(layout.items[2].metric, 'reset');
  assert.equal(layout.items[2].source.accountMode, 'active');

  layout = removeTrayLayoutItem(layout, 'app-icon');
  assert.deepEqual(layout.items.map((item) => item.id), ['bars', 'quota']);
});

test('tray layouts support optional shared icons, stacked values and configurable spacers', () => {
  const normalized = normalizeTrayLayout({
    version: 1,
    items: [
      {
        id: 'bars',
        type: 'bars',
        icon: 'none',
        rows: [{ provider: 'codex' }, { provider: 'claude' }]
      },
      {
        id: 'stack',
        type: 'stack',
        metric: 'reset',
        icon: 'second',
        fontStyle: 'menubar',
        alignment: 'left',
        rows: [{ provider: 'codex' }, { provider: 'claude' }]
      },
      {
        id: 'space',
        type: 'spacer',
        variant: 'dot',
        size: 'narrow'
      }
    ]
  });

  assert.equal(normalized.version, 3);
  assert.equal(normalized.items[0].icon, 'none');
  assert.equal(normalized.items[1].style, 'doubleReset');
  assert.equal(normalized.items[1].icon, 'second');
  assert.equal(normalized.items[1].fontStyle, 'menubar');
  assert.equal(normalized.items[1].alignment, 'left');
  assert.equal(normalized.items[2].style, 'separatorDot');
  assert.equal(normalized.items[2].variant, 'dot');
  assert.equal(normalized.items[2].size, 'narrow');

  assert.equal(createTrayLayoutItem('doublePercent').metric, 'percent');
  assert.equal(createTrayLayoutItem('doublePercent').fontStyle, 'normal');
  assert.equal(createTrayLayoutItem('doublePercent').alignment, 'right');
  assert.equal(createTrayLayoutItem('doubleReset').metric, 'reset');
  assert.equal(createTrayLayoutItem('doubleReset').alignment, 'left');
  assert.equal(createTrayLayoutItem('doubleInfo').metric, 'mixed');
  assert.deepEqual(createTrayLayoutItem('doubleInfo').rows.map((row) => row.metric), ['percent', 'reset']);
  assert.equal(normalizeTrayLayout({
    items: [{ id: 'info', type: 'stack', style: 'doubleInfo', rows: [] }]
  }).items[0].metric, 'mixed');
  assert.equal(createTrayLayoutItem('separatorDot').variant, 'dot');
  assert.equal(createTrayLayoutItem('spacer').size, 'regular');
  assert.equal(createTrayLayoutItem('tokens').fontStyle, 'normal');
  assert.equal(createTrayLayoutItem('customText').text, 'Text');
  assert.deepEqual(createTrayLayoutItem('doubleCustomText').lines, ['Text', 'Text']);
  assert.equal(createTrayLayoutItem('doubleCustomText').alignment, 'left');
  assert.equal(createTrayLayoutItem('doubleCustomText').icon, 'none');
  assert.equal(normalizeTrayLayout({
    items: [{ id: 'text', type: 'text', metric: 'tokens', fontStyle: 'invalid' }]
  }).items[0].fontStyle, 'normal');
  assert.equal(normalizeTrayLayout({
    items: [{ id: 'compact-font', type: 'text', metric: 'tokens', fontStyle: 'compactMono' }]
  }).items[0].fontStyle, 'compactMono');
  assert.equal(normalizeTrayLayout({
    items: [{ id: 'unreleased-font', type: 'text', metric: 'tokens', fontStyle: 'mono' }]
  }).items[0].fontStyle, 'normal');
  assert.equal(normalizeTrayLayout({
    items: [{ id: 'app-bars', type: 'bars', icon: 'app', rows: [{ provider: 'codex' }] }]
  }).items[0].icon, 'app');

  const customizedReset = normalizeTrayLayout({
    items: [{
      id: 'custom-reset',
      type: 'stack',
      metric: 'reset',
      alignment: 'right',
      alignmentCustomized: true,
      rows: [{ provider: 'codex' }, { provider: 'claude' }]
    }]
  }).items[0];
  assert.equal(customizedReset.alignment, 'right');
  assert.equal(customizedReset.alignmentCustomized, true);
});

test('two-line information resolves independently selected existing metrics', () => {
  const item = createTrayLayoutItem('doubleInfo', { idFactory: () => 'info' });
  item.rows[0] = {
    ...item.rows[0],
    provider: 'codex',
    accountMode: 'active',
    metric: 'percent'
  };
  item.rows[1] = {
    ...item.rows[1],
    metric: 'tokens',
    period: 'month'
  };

  const normalized = normalizeTrayLayout({ version: 2, items: [item] });
  assert.equal(normalized.items[0].style, 'doubleInfo');
  assert.equal(normalized.items[0].metric, 'mixed');
  assert.deepEqual(normalized.items[0].rows.map((row) => row.metric), ['percent', 'tokens']);
  assert.deepEqual(normalized.items[0].rows.map((row) => row.period), ['today', 'month']);

  const [resolved] = resolveTrayLayout(normalized, stats, { nowMs: now }).items;
  assert.deepEqual(resolved.rows.map((row) => row.text), ['72%', '9.5M']);
  assert.equal(resolved.rows[0].selection.provider, 'codex');
  assert.equal(resolved.rows[1].selection, null);
});

test('custom text items normalize and resolve without quota data', () => {
  const single = createTrayLayoutItem('customText', { idFactory: () => 'single-copy' });
  single.text = '  Build green  ';
  const stacked = createTrayLayoutItem('doubleCustomText', { idFactory: () => 'stacked-copy' });
  stacked.lines = ['Primary', 'Secondary'];
  stacked.alignment = 'right';
  stacked.alignmentCustomized = true;
  stacked.fontStyle = 'compactMono';

  const normalized = normalizeTrayLayout({ version: 2, items: [single, stacked] });
  assert.equal(normalized.items[0].style, 'customText');
  assert.equal(normalized.items[0].metric, 'custom');
  assert.equal(normalized.items[0].text, 'Build green');
  assert.equal(normalized.items[1].style, 'doubleCustomText');
  assert.deepEqual(normalized.items[1].lines, ['Primary', 'Secondary']);
  assert.equal(normalized.items[1].alignment, 'right');
  assert.equal(normalized.items[1].fontStyle, 'compactMono');

  const resolved = resolveTrayLayout(normalized, {}, { nowMs: now });
  assert.equal(resolved.items[0].text, 'Build green');
  assert.equal(resolved.items[0].available, true);
  assert.deepEqual(resolved.items[1].rows.map((row) => row.text), ['Primary', 'Secondary']);
  assert.equal(resolved.items[1].available, true);
});

test('active Codex account selection excludes managed accounts while lowest mode keeps them eligible', () => {
  assert.equal(selectSource(stats, {
    provider: 'codex',
    accountMode: 'active',
    window: 'primary'
  }).providerRecord.accountKey, 'active');

  assert.equal(selectSource(stats, {
    provider: 'codex',
    accountMode: 'lowest',
    window: 'primary'
  }).providerRecord.accountKey, 'managed');

  assert.equal(selectSource(stats, {
    provider: 'codex',
    accountMode: 'active',
    window: 'primary'
  }, {
    activeAccountKeys: { codex: 'managed' }
  }).providerRecord.accountKey, 'managed');

  assert.equal(selectSource(stats, {
    provider: 'claude',
    accountMode: 'active',
    window: 'primary'
  }).providerRecord.accountKey, 'claude');
});

test('specific account and exact window selectors do not silently fall back', () => {
  const weekly = stats.limits.providers[0].windows[1];
  assert.equal(selectSource(stats, {
    provider: 'codex',
    accountMode: 'specific',
    accountKey: 'active',
    window: windowKey(weekly)
  }).window.label, 'Weekly');

  assert.equal(selectSource(stats, {
    provider: 'codex',
    accountMode: 'specific',
    accountKey: 'missing',
    window: 'primary'
  }), null);
});

test('reset countdown formatting follows the compact issue 133 contract', () => {
  assert.equal(formatResetCountdown('2026-07-23T08:42:00.000Z', now), '42m');
  assert.equal(formatResetCountdown('2026-07-23T11:07:00.000Z', now), '3h 07m');
  assert.equal(formatResetCountdown('2026-07-29T10:00:00.000Z', now), '6d 2h');
  assert.equal(formatResetCountdown('not-a-date', now), '');
});

test('layout resolution uses real period, quota, reset and account data', () => {
  const layout = {
    version: 1,
    items: [
      createTrayLayoutItem('tokens', { idFactory: () => 'tokens' }),
      {
        ...createTrayLayoutItem('percentReset', { idFactory: () => 'quota' }),
        source: {
          provider: 'codex',
          accountMode: 'active',
          accountKey: '',
          window: 'primary',
          valueMode: 'remaining'
        }
      },
      {
        ...createTrayLayoutItem('account', { idFactory: () => 'account' }),
        source: {
          provider: 'codex',
          accountMode: 'specific',
          accountKey: 'managed',
          window: 'primary',
          valueMode: 'remaining'
        }
      }
    ]
  };

  const resolved = resolveTrayLayout(layout, stats, { currency: 'HKD', nowMs: now });
  assert.equal(resolved.items[0].text, '1.2M');
  assert.equal(resolved.items[1].text, '72% · 42m');
  assert.equal(resolved.items[2].text, 'managed@example.com');
});

test('cost items preserve legacy output and support compact per-item decimal choices', () => {
  const [migrated] = normalizeTrayLayout({
    version: 2,
    items: [{
      id: 'legacy-cost',
      type: 'text',
      style: 'cost',
      metric: 'cost',
      period: 'today',
      source: {}
    }]
  }).items;
  assert.equal(migrated.costFormat, 'full');
  assert.equal(migrated.costDecimals, 'auto');
  assert.equal(migrated.usageScope, 'all');

  const [versionThree] = normalizeTrayLayout({
    version: 3,
    items: [{
      id: 'version-three-cost',
      type: 'text',
      style: 'cost',
      metric: 'cost',
      period: 'today',
      costFormat: 'compact',
      costDecimals: 2,
      source: {}
    }]
  }).items;
  assert.equal(versionThree.costFormat, 'compact');
  assert.equal(versionThree.costDecimals, 2);
  assert.equal(versionThree.usageScope, 'all');

  const legacySmall = resolveTrayLayout({
    version: 2,
    items: [{
      id: 'legacy-small',
      type: 'text',
      style: 'cost',
      metric: 'cost',
      period: 'today',
      source: {}
    }]
  }, { periods: { today: { costUsd: 0.0049 } } }, { currency: 'USD' });
  assert.equal(legacySmall.items[0].text, '$0.0049');

  const compact = createTrayLayoutItem('cost', { idFactory: () => 'compact-cost' });
  compact.period = 'allTime';
  const full = { ...compact, id: 'full-cost', costFormat: 'full', costDecimals: 0 };
  const info = createTrayLayoutItem('doubleInfo', { idFactory: () => 'cost-info' });
  info.rows[1] = {
    ...info.rows[1],
    metric: 'cost',
    period: 'allTime',
    costFormat: 'compact',
    costDecimals: 1
  };

  const resolved = resolveTrayLayout({ version: 3, items: [compact, full, info] }, stats, {
    currency: 'HKD',
    nowMs: now
  });

  assert.equal(resolved.items[0].text, 'HK$1.52K');
  assert.equal(resolved.items[1].text, 'HK$1517');
  assert.equal(resolved.items[2].rows[1].text, 'HK$1.5K');

  const localized = resolveTrayLayout({ version: 3, items: [compact] }, stats, {
    currency: 'HKD',
    compactTokenUnits: 'localized',
    locale: 'zh-TW',
    nowMs: now
  });
  assert.equal(localized.items[0].text, 'HK$1517.10');
});

test('stacked quota values resolve two percentages or reset times independently', () => {
  const percent = createTrayLayoutItem('doublePercent', { idFactory: () => 'percent-stack' });
  percent.rows = [
    { ...percent.rows[0], provider: 'codex', accountMode: 'active', window: 'primary' },
    { ...percent.rows[1], provider: 'claude', accountMode: 'active', window: 'primary' }
  ];
  const reset = createTrayLayoutItem('doubleReset', { idFactory: () => 'reset-stack' });
  reset.rows = percent.rows;
  const spacer = createTrayLayoutItem('spacer', { idFactory: () => 'space' });

  const resolved = resolveTrayLayout({
    version: 2,
    items: [percent, reset, spacer]
  }, stats, { nowMs: now });

  assert.deepEqual(resolved.items[0].rows.map((row) => row.text), ['72%', '42%']);
  assert.deepEqual(resolved.items[1].rows.map((row) => row.text), ['42m', '3h 07m']);
  assert.equal(resolved.items[2].available, true);
});

test('tray layout clock runs only when displayed values contain a countdown', () => {
  const staticItems = [
    createTrayLayoutItem('appIcon'),
    createTrayLayoutItem('providerIcon'),
    createTrayLayoutItem('singleBar'),
    createTrayLayoutItem('doubleBar'),
    createTrayLayoutItem('doublePercent'),
    createTrayLayoutItem('percent'),
    createTrayLayoutItem('tokens'),
    createTrayLayoutItem('cost'),
    createTrayLayoutItem('customText'),
    createTrayLayoutItem('doubleCustomText'),
    createTrayLayoutItem('spacer'),
    createTrayLayoutItem('separatorDot')
  ];
  assert.equal(trayLayoutNeedsClock({ version: 2, items: staticItems }), false);
  assert.equal(trayLayoutNeedsClock(null), false);

  for (const style of ['reset', 'percentReset', 'doubleReset']) {
    assert.equal(
      trayLayoutNeedsClock({ version: 2, items: [createTrayLayoutItem(style)] }),
      true,
      style
    );
  }

  const staticInfo = createTrayLayoutItem('doubleInfo');
  staticInfo.rows[0].metric = 'tokens';
  staticInfo.rows[1].metric = 'cost';
  assert.equal(trayLayoutNeedsClock({ version: 2, items: [staticInfo] }), false);

  const dynamicInfo = createTrayLayoutItem('doubleInfo');
  dynamicInfo.rows[1].metric = 'percentReset';
  assert.equal(trayLayoutNeedsClock({ version: 2, items: [dynamicInfo] }), true);
});

test('automatic provider icons default to the lowest internal primary quota', () => {
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'provider-icon' });
  const resolved = resolveTrayLayout({
    version: 2,
    items: [icon]
  }, stats, { nowMs: now });

  assert.equal(icon.source.window, 'primary');
  assert.equal(resolved.items[0].provider, 'codex');
  assert.equal(resolved.items[0].available, true);
});

test('automatic provider icons can follow token or cost leaders for each period', () => {
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'usage-provider-icon' });
  icon.autoMode = 'tokens';
  icon.period = 'today';
  let resolved = resolveTrayLayout({ version: 2, items: [icon] }, stats, {
    availableProviderIds: ['claude', 'codex']
  });
  assert.equal(resolved.items[0].provider, 'codex');

  icon.period = 'allTime';
  resolved = resolveTrayLayout({ version: 2, items: [icon] }, stats, {
    availableProviderIds: ['claude', 'codex']
  });
  assert.equal(resolved.items[0].provider, 'claude');

  icon.autoMode = 'cost';
  icon.period = 'today';
  resolved = resolveTrayLayout({ version: 2, items: [icon] }, stats, {
    availableProviderIds: ['claude', 'codex']
  });
  assert.equal(resolved.items[0].provider, 'claude');

  icon.period = 'month';
  resolved = resolveTrayLayout({ version: 2, items: [icon] }, stats, {
    availableProviderIds: ['claude', 'codex']
  });
  assert.equal(resolved.items[0].provider, 'codex');
});

test('recent activity can drive provider icons and per-tool token or cost values', () => {
  const recentStats = {
    localRecentUsageActivity: {
      provider: 'openclaw',
      timestampMs: Date.parse('2026-07-23T07:59:00.000Z')
    },
    periods: {
      today: {
        totalTokens: 1_025,
        costUsd: 8.5,
        clients: { claude: 1_000, openclaw: 25 },
        clientCosts: { claude: 8, openclaw: 0.5 },
        sessions: {
          'claude:older': {
            client: 'claude',
            sessionId: 'older',
            lastUsedAt: '2026-07-23T07:00:00.000Z'
          },
          'openclaw:newer': {
            client: 'openclaw',
            sessionId: 'newer',
            lastUsedAt: '2026-07-23T07:59:00.000Z'
          }
        }
      }
    }
  };
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'recent-icon' });
  icon.autoMode = 'recent';
  const tokens = createTrayLayoutItem('tokens', { idFactory: () => 'recent-tokens' });
  tokens.usageScope = 'recent';
  const cost = createTrayLayoutItem('cost', { idFactory: () => 'recent-cost' });
  cost.usageScope = 'recent';

  const resolved = resolveTrayLayout({ version: 3, items: [icon, tokens, cost] }, recentStats, {
    availableProviderIds: ['claude', 'openclaw'],
    currency: 'USD'
  });

  assert.equal(resolved.items[0].provider, 'openclaw');
  assert.equal(resolved.items[1].provider, 'openclaw');
  assert.equal(resolved.items[1].text, '25');
  assert.equal(resolved.items[2].provider, 'openclaw');
  assert.equal(resolved.items[2].text, '$0.50');

  const info = createTrayLayoutItem('doubleInfo', { idFactory: () => 'recent-info' });
  info.rows = [
    { ...info.rows[0], metric: 'tokens', usageScope: 'recent' },
    { ...info.rows[1], metric: 'cost', usageScope: 'recent' }
  ];
  const resolvedInfo = resolveTrayLayout({ version: 3, items: [info] }, recentStats, {
    availableProviderIds: ['claude', 'openclaw'],
    currency: 'USD'
  }).items[0];
  assert.equal(resolvedInfo.rows[0].provider, 'openclaw');
  assert.equal(resolvedInfo.rows[1].provider, 'openclaw');
  assert.equal(preferredRowProvider(resolvedInfo.rows, 0), 'openclaw');
  assert.equal(preferredRowProvider([
    { provider: null, selection: null },
    { provider: null, selection: { provider: 'codex' } }
  ], 0), 'codex');

  recentStats.periods.today.sessions['claude:older'].lastUsedAt = '2026-07-23T08:00:00.000Z';
  recentStats.localRecentUsageActivity = {
    provider: 'claude',
    timestampMs: Date.parse('2026-07-23T08:00:00.000Z')
  };
  const switched = resolveTrayLayout({ version: 3, items: [icon, tokens, cost] }, recentStats, {
    availableProviderIds: ['claude', 'openclaw'],
    currency: 'USD'
  });
  assert.equal(switched.items[0].provider, 'claude');
  assert.equal(switched.items[1].text, '1.0K');
  assert.equal(switched.items[2].text, '$8.00');
});

test('recent activity uses a stable app or unavailable fallback without timestamps', () => {
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'recent-icon-fallback' });
  icon.autoMode = 'recent';
  const tokens = createTrayLayoutItem('tokens', { idFactory: () => 'recent-tokens-fallback' });
  tokens.usageScope = 'recent';

  const resolved = resolveTrayLayout({ version: 3, items: [icon, tokens] }, stats, {
    availableProviderIds: ['claude', 'codex']
  });

  assert.equal(resolved.items[0].provider, 'app');
  assert.equal(resolved.items[1].available, false);
  assert.equal(resolved.items[1].text, '--');
});

test('local Reasonix native activity selects aggregate Reasonix Token and Cost values', () => {
  const reasonixStats = {
    localRecentUsageActivity: {
      provider: 'reasonix',
      timestampMs: Date.parse('2026-08-12T10:05:00.000Z')
    },
    periods: {
      today: {
        totalTokens: 1_040,
        costUsd: 8.25,
        clients: { claude: 1_000, reasonix: 40 },
        clientCosts: { claude: 8, reasonix: 0.25 },
        sessions: {
          'claude:older': {
            client: 'claude',
            sessionId: 'older',
            lastUsedAt: '2026-08-12T10:00:00.000Z'
          }
        }
      }
    },
    nativeSessions: {
      today: {
        'reasonix:newer': {
          client: 'reasonix',
          sessionId: 'reasonix:newer',
          lastMessageAt: '2026-08-12T10:05:00.000Z',
          lastUsedAt: '2026-08-12T10:05:00.000Z',
          totalTokens: 999,
          reportedCostUsd: 99
        }
      },
      month: {},
      allTime: {}
    }
  };
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'reasonix-icon' });
  icon.autoMode = 'recent';
  const tokens = createTrayLayoutItem('tokens', { idFactory: () => 'reasonix-tokens' });
  tokens.usageScope = 'recent';
  const cost = createTrayLayoutItem('cost', { idFactory: () => 'reasonix-cost' });
  cost.usageScope = 'recent';

  const resolved = resolveTrayLayout({ version: 3, items: [icon, tokens, cost] }, reasonixStats, {
    availableProviderIds: ['claude', 'reasonix'],
    currency: 'USD'
  });

  assert.equal(resolved.items[0].provider, 'reasonix');
  assert.equal(resolved.items[1].text, '40');
  assert.equal(resolved.items[2].text, '$0.25');
});

test('one layout resolution reads the local recent provider only once', () => {
  const original = trayTextApi.pickRecentUsageProviderId;
  let calls = 0;
  trayTextApi.pickRecentUsageProviderId = (...args) => {
    calls += 1;
    return original(...args);
  };
  try {
    const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'once-icon' });
    icon.autoMode = 'recent';
    const tokens = createTrayLayoutItem('tokens', { idFactory: () => 'once-tokens' });
    tokens.usageScope = 'recent';
    const info = createTrayLayoutItem('doubleInfo', { idFactory: () => 'once-info' });
    info.rows[0] = { ...info.rows[0], metric: 'cost', usageScope: 'recent' };

    resolveTrayLayout({ version: 3, items: [icon, tokens, info] }, {
      localRecentUsageActivity: {
        provider: 'claude',
        timestampMs: Date.parse('2026-08-12T10:00:00.000Z')
      },
      periods: {
        today: {
          clients: { claude: 10 },
          clientCosts: { claude: 1 },
          sessions: {
            'claude:active': { client: 'claude', lastUsedAt: '2026-08-12T10:00:00.000Z' }
          }
        }
      }
    }, { availableProviderIds: ['claude'] });

    assert.equal(calls, 1);
  } finally {
    trayTextApi.pickRecentUsageProviderId = original;
  }
});

test('automatic provider icons keep a stable app fallback without matching data or artwork', () => {
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'fallback-provider-icon' });
  icon.autoMode = 'tokens';

  const unavailable = resolveTrayLayout({ version: 2, items: [icon] }, {
    periods: { today: { clients: { unknown: 10, codex: 5 } } }
  }, {
    availableProviderIds: ['codex']
  });
  assert.equal(unavailable.items[0].provider, 'app');
  assert.equal(unavailable.items[0].available, true);

  const empty = resolveTrayLayout({ version: 2, items: [icon] }, {}, {
    availableProviderIds: ['codex']
  });
  assert.equal(empty.items[0].provider, 'app');
  assert.equal(empty.items[0].available, true);
});

test('fixed provider icons remain available without live quota data', () => {
  const icon = createTrayLayoutItem('providerIcon', { idFactory: () => 'fixed-provider-icon' });
  icon.source.provider = 'kimi';
  const resolved = resolveTrayLayout({
    version: 2,
    items: [icon]
  }, stats, { nowMs: now });

  assert.equal(resolved.items[0].provider, 'kimi');
  assert.equal(resolved.items[0].available, true);
  assert.equal(resolved.items[0].selection, null);
});

test('provider account and window choices expose live data for visual pickers', () => {
  assert.deepEqual(accountOptions(stats, 'codex').map((option) => [option.value, option.label]), [
    ['active', 'active@example.com'],
    ['managed', 'managed@example.com']
  ]);
  assert.deepEqual(windowOptions(stats, 'codex', 'active').map((option) => [option.kind, option.label]), [
    ['session', '5-hour'],
    ['weekly', 'Weekly']
  ]);
});

test('source window choices show each real provider window once and prioritize the current selection', () => {
  const primary = sourceWindowOptions(stats, {
    provider: 'claude',
    accountMode: 'lowest',
    window: 'primary'
  });
  assert.deepEqual(primary.map((option) => option.kind), ['session', 'weekly']);

  const secondary = sourceWindowOptions(stats, {
    provider: 'claude',
    accountMode: 'lowest',
    window: 'secondary'
  });
  assert.deepEqual(secondary.map((option) => option.kind), ['weekly', 'session']);

  const automatic = sourceWindowOptions(stats, {
    provider: 'auto',
    accountMode: 'lowest',
    window: 'primary'
  });
  const identities = automatic.map((option) => (
    `${option.selection.provider}|${option.selection.providerRecord.accountKey}|${windowKey(option.window)}`
  ));
  assert.equal(new Set(identities).size, identities.length);
});

test('active account window choices exclude managed-only Codex windows', () => {
  const managedOnlyStats = structuredClone(stats);
  managedOnlyStats.limits.providers[1].windows.push({
    kind: 'billing',
    label: 'Managed billing',
    remainingPercent: 9
  });

  const choices = sourceWindowOptions(managedOnlyStats, {
    provider: 'codex',
    accountMode: 'active',
    window: 'primary'
  });

  assert.deepEqual(choices.map((option) => option.kind), ['session', 'weekly']);
  assert.ok(choices.every((option) => option.selection.providerRecord.accountKey === 'active'));
});
