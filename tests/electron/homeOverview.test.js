'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  homeActivityHeatmapLayout,
  homeDeviceRows,
  homeLimitAccounts,
  homeLimitAccountsForProviders,
  homeModelRows,
  homeToolRows,
  homeActivityWheelRoute,
  homeActivityScrollTarget,
  homeActivityScrollRecord,
  homeTrendSummary,
  pickHomeHistory,
  patchDailyToday,
  historyPreviewKey,
  shouldFetchHomeHistory
} = require('../../src/electron/renderer/homeOverview');

const historyWithDays = { daily: [{ date: '2026-06-01', tokens: 10, cost: 1 }], monthly: [], summary: {} };
const emptyHistory = { daily: [], monthly: [], summary: {} };

test('Home activity heatmap is a scaled copy of the dashboard heatmap', () => {
  assert.deepEqual(homeActivityHeatmapLayout(), { cell: 9, gap: 3, radius: 2 });

  const rendererDir = path.join(__dirname, '../../src/electron/renderer');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const dashboardCss = fs.readFileSync(path.join(rendererDir, 'dashboard.css'), 'utf8');
  const rule = (source, selector) => {
    const start = source.indexOf(`${selector} {`);
    assert.notEqual(start, -1, `missing CSS rule: ${selector}`);
    return source.slice(start, source.indexOf('}', start) + 1);
  };
  const fill = (source, selector) => /fill:\s*([^;]+);/.exec(rule(source, selector))?.[1];
  const levels = [
    ['.home-activity-canvas .heat', '.heat.lvl-0'],
    ['.home-activity-canvas .heat.lvl-1', '.heat.lvl-1'],
    ['.home-activity-canvas .heat.lvl-2', '.heat.lvl-2'],
    ['.home-activity-canvas .heat.lvl-3', '.heat.lvl-3'],
    ['.home-activity-canvas .heat.lvl-4', '.heat.lvl-4']
  ];

  for (const [homeSelector, dashboardSelector] of levels) {
    assert.equal(fill(css, homeSelector), fill(dashboardCss, dashboardSelector));
  }
  assert.doesNotMatch(rule(css, '.home-activity-scroll'), /padding-block/);
  assert.match(rule(css, '.home-activity-canvas .heat-bright-layer'), /pointer-events:\s*none/);
  assert.match(rule(css, '.home-activity-tooltip'), /position:\s*fixed/);
  assert.match(rule(css, '.home-activity-canvas .heat-month'), /fill:\s*rgba\(var\(--line-rgb\), 0\.5\)/);
});

test('Home module selection is independent from main view preferences', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function homeModuleIds\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'homeModuleIds exists');
  assert.doesNotMatch(match[1], /hiddenViewSet|effectiveViewDisplayOrderValue|VIEW_DISPLAY_OPTIONS/);
  assert.match(match[1], /hiddenHomeModuleSet|orderedHomeModules|HOME_MODULE_OPTIONS/);
  assert.match(rendererSource, /function renderHomeToolModule/);
  assert.match(rendererSource, /function renderHomeDeviceModule/);
});

test('Home activity uses a custom spotlight hover instead of native SVG titles', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function renderHomeTrendsModule\(\) \{([\s\S]*?)\n\}\n\nfunction renderHome/);
  assert.ok(match, 'renderHomeTrendsModule exists');
  assert.match(match[1], /setupHomeActivityHover\(activityScroll\)/);
  assert.match(match[1], /spotlightId:\s*'homeActivitySpotlight'/);
  assert.doesNotMatch(match[1], /titleOf:/);
});

test('Home activity tooltip is dismissed on Home rerender and when the view leaves Home', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  // The body-level tooltip only has scroller-local pointer handlers; DOM removal fires
  // no pointerleave, so the hover setup must expose a teardown other code can invoke.
  assert.match(rendererSource, /state\.homeActivityHoverTeardown\s*=\s*hide/);
  // Clearing the ref after teardown lets a discarded scroller closure be collected.
  const hideFn = rendererSource.match(/function hideHomeActivityTooltip\(\) \{([\s\S]*?)\n\}/);
  assert.ok(hideFn, 'hideHomeActivityTooltip exists');
  assert.match(hideFn[1], /state\.homeActivityHoverTeardown\s*=\s*null/);
  // renderHome replaces the scroller that owns those handlers — it must hide the tooltip
  // before rebuilding, or a cell hovered across a stats refresh leaves a stale tooltip.
  const renderHome = rendererSource.match(/function renderHome\(\) \{([\s\S]*?)\n\}\n\nfunction render\(\)/);
  assert.ok(renderHome, 'renderHome exists');
  assert.match(renderHome[1], /hideHomeActivityTooltip\(\)/);
  // Leaving Home for another view must also dismiss it (the panel is only CSS-hidden).
  const render = rendererSource.match(/function render\(\) \{([\s\S]*?)\n\}\n\nfunction setStatus/);
  assert.ok(render, 'render exists');
  assert.match(render[1], /breakdown !== 'home'[\s\S]*?hideHomeActivityTooltip\(\)/);
});

test('Home device rows keep only the local badge and mute stale devices without status text', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function renderHomeDeviceModule\(\) \{([\s\S]*?)\n\}\n\nfunction dailyWithHeatIntensity/);
  assert.ok(match, 'renderHomeDeviceModule exists');
  assert.match(match[1], /home-device-badge/);
  assert.match(match[1], /badge\.textContent = 'you'/);
  assert.match(match[1], /if \(row\.isLocal\)/);
  assert.match(match[1], /item\.classList\.add\('is-stale'\)/);
  assert.match(match[1], /item\.append\(mark, label, value\)/);
  assert.doesNotMatch(match[1], /home-list-aux/);
  assert.doesNotMatch(match[1], /t\('home\.localDevice'\)/);
  assert.doesNotMatch(match[1], /badge\.textContent = row\.isLocal \? t\('home\.localDevice'\) : t\('home\.staleDevice'\)/);
});

test('homeLimitAccounts keeps account windows together and sorts lowest remaining first', () => {
  const rows = homeLimitAccounts([
    {
      key: 'codex:1',
      providerId: 'codex',
      name: 'linus@example.com',
      color: '#49a3b0',
      windows: [
        { kind: 'session', usedPercent: 30 },
        { kind: 'weekly', usedPercent: 5 }
      ]
    },
    {
      key: 'codex:0',
      providerId: 'codex',
      name: 'javis@example.com',
      color: '#49a3b0',
      windows: [
        { kind: 'weekly', usedPercent: 57, resetDescription: '4d 13h' },
        { kind: 'session', usedPercent: 100, resetDescription: '32m' }
      ]
    }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'javis@example.com');
  assert.equal(rows[0].providerId, 'codex');
  assert.equal(rows[0].lowestRemaining, 0);
  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['session', 'weekly']);
  assert.deepEqual(rows[0].windows.map((window) => window.remainingPercent), [0, 43]);
  assert.equal(rows[1].lowestRemaining, 70);
});

test('homeLimitAccounts keeps a real billing remaining percentage fallback', () => {
  const rows = homeLimitAccounts([
    {
      key: 'opencode:0',
      name: 'OpenCode',
      windows: [
        { kind: 'billing', remainingPercent: 93, resetDescription: '15d 16h' },
        { kind: 'balance', showMeter: false, remaining: 20 }
      ]
    }
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].windows.map((window) => ({ kind: window.kind, remainingPercent: window.remainingPercent })), [
    { kind: 'billing', remainingPercent: 93 }
  ]);
});

test('homeLimitAccountsForProviders includes Grok billing and DeepSeek balance rows', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [
      {
        provider: 'grok',
        windows: [
          { kind: 'billing', label: 'Monthly', remainingPercent: 100, resetDescription: '2d 15h' }
        ]
      },
      {
        provider: 'deepseek',
        balance: { amount: 4.61, monthSpend: 0, currency: 'CNY' },
        windows: []
      }
    ],
    providerOptions: [
      { id: 'grok', label: 'Grok' },
      { id: 'deepseek', label: 'DeepSeek' }
    ],
    enabledProviderIds: ['grok', 'deepseek'],
    colors: { grok: '#9aa0aa', deepseek: '#4d72ff' },
    limit: 5
  });

  assert.deepEqual(rows.map((row) => row.providerId), ['grok', 'deepseek']);
  assert.deepEqual(rows[0].windows.map((window) => [window.kind, window.label, window.remainingPercent]), [
    ['billing', 'Monthly', 100]
  ]);
  assert.deepEqual(rows[1].windows.map((window) => [window.kind, window.label, window.remainingPercent, window.amount, window.currency, window.value]), [
    ['balance', 'balance', 100, 4.61, 'CNY', '']
  ]);
});

test('homeLimitAccountsForProviders includes MiMo Token Plan status and balance', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [
      {
        provider: 'mimo',
        windows: [],
        balance: { amount: 7.51, currency: 'CNY', planStatus: 'active', planUsed: 250, planLimit: 1000 }
      },
      {
        provider: 'mimo',
        windows: [{ kind: 'billing', label: 'Token Plan', remainingPercent: 100 }],
        balance: { amount: 7.51, currency: 'CNY', planStatus: 'expired' }
      }
    ],
    providerOptions: [{ id: 'mimo', label: 'MiMo' }],
    enabledProviderIds: ['mimo'],
    colors: { mimo: '#5daeea' },
    limit: 5
  });

  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['billing', 'balance']);
  assert.equal(rows[0].windows[0].remainingPercent, 75);
  assert.equal(rows[0].windows[1].amount, 7.51);
  assert.deepEqual(rows[1].windows.map((window) => [window.kind, window.planStatus]), [
    ['billing', 'expired'],
    ['balance', '']
  ]);
});

test('MiMo balance without plan data does not synthesize a Token Plan meter', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [{
      provider: 'mimo',
      accountKey: 'mimo-no-plan',
      status: 'ok',
      windows: [],
      balance: {
        amount: 9.61,
        currency: 'CNY',
        planStatus: null,
        planUsed: null,
        planLimit: null,
        planPercent: null
      }
    }],
    providerOptions: [{ id: 'mimo', label: 'MiMo' }],
    enabledProviderIds: ['mimo'],
    colors: { mimo: '#5daeea' },
    limit: 5
  });

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['balance']);
  assert.equal(rows[0].windows.some((window) => window.kind === 'billing'), false);
  assert.equal(rows[0].windows[0].amount, 9.61);
});

test('MiMo empty plan values do not synthesize a Token Plan meter', () => {
  const rows = homeLimitAccounts([
    {
      key: 'mimo-empty-plan',
      providerId: 'mimo',
      name: 'MiMo',
      windows: [],
      balance: {
        amount: 4.83,
        currency: 'CNY',
        planUsed: '',
        planLimit: '',
        planPercent: ''
      }
    }
  ]);

  assert.equal(rows.length, 1);
  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['balance']);
});

test('MiMo active unused plan keeps a real 100 percent remaining meter', () => {
  const rows = homeLimitAccounts([
    {
      key: 'mimo-active-plan',
      providerId: 'mimo',
      name: 'MiMo',
      windows: [],
      balance: {
        amount: 9.61,
        currency: 'CNY',
        planUsed: 0,
        planLimit: 1000,
        planPercent: 0
      }
    }
  ]);

  assert.equal(rows.length, 1);
  const billing = rows[0].windows.find((window) => window.kind === 'billing');
  assert.ok(billing);
  assert.equal(billing.remainingPercent, 100);
});

test('home limit windows ignore missing percentage values', () => {
  const rows = homeLimitAccounts([
    {
      key: 'missing-meter',
      providerId: 'mimo',
      windows: [{ kind: 'billing', usedPercent: null, remainingPercent: null }]
    }
  ]);

  assert.deepEqual(rows, []);
});

test('homeModelRows returns one-line token shares without cost fields', () => {
  const rows = homeModelRows([
    { name: 'claude-opus-4-8', value: 34_000_000, cost: 21.96, color: '#cc7c5e' },
    { name: 'gpt-5.5', value: 29_800_000, cost: 25.88, color: '#49a3b0' }
  ], 63_800_000);

  assert.deepEqual(rows, [
    { key: 'claude-opus-4-8', name: 'claude-opus-4-8', value: 34_000_000, share: 34_000_000 / 63_800_000, color: '#cc7c5e' },
    { key: 'gpt-5.5', name: 'gpt-5.5', value: 29_800_000, share: 29_800_000 / 63_800_000, color: '#49a3b0' }
  ]);
  assert.equal(Object.hasOwn(rows[0], 'cost'), false);
});

test('homeToolRows returns top current-period tools with shares', () => {
  const rows = homeToolRows([
    { key: 'codex', name: 'Codex', value: 120, color: '#49a3b0' },
    { key: 'claude', name: 'Claude Code', value: 300, color: '#cc7c5e' },
    { key: 'opencode', name: 'OpenCode', value: 0, color: '#9aa0aa' }
  ], 420, 2);

  assert.deepEqual(rows.map((row) => [row.key, row.value, row.share]), [
    ['claude', 300, 300 / 420],
    ['codex', 120, 120 / 420]
  ]);
});

test('homeDeviceRows uses display names, skips empty devices, and sorts by usage', () => {
  const rows = homeDeviceRows([
    { deviceId: 'remote-stale', hostname: 'Old PC', stale: true, periods: { today: { totalTokens: 900 } } },
    { deviceId: 'empty', displayName: 'Empty Device', stale: false, periods: { today: { totalTokens: 0 } } },
    { deviceId: 'local', displayName: 'macbook-m5', hostname: 'Javiss-MacBook-Air.local', stale: false, periods: { today: { totalTokens: 100 } } },
    { deviceId: 'remote-fresh', displayName: 'studio', hostname: 'Studio.local', stale: false, periods: { today: { totalTokens: 500 } } }
  ], { localDeviceId: 'local', period: 'today', limit: 3 });

  assert.deepEqual(rows.map((row) => [row.key, row.name, row.value, row.isLocal, row.isStale]), [
    ['remote-stale', 'remote-stale', 900, false, true],
    ['remote-fresh', 'studio', 500, false, false],
    ['local', 'macbook-m5', 100, true, false]
  ]);
});

test('homeLimitAccountsForProviders keeps provider order and filters hidden providers', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [
      { provider: 'codex', windows: [{ kind: 'session', usedPercent: 40 }] },
      { provider: 'opencode', windows: [{ kind: 'session', usedPercent: 90 }] }
    ],
    providerOptions: [
      { id: 'opencode', label: 'OpenCode' },
      { id: 'codex', label: 'Codex' }
    ],
    enabledProviderIds: ['opencode', 'codex'],
    hiddenProviderIds: ['opencode'],
    colors: { codex: '#49a3b0', opencode: '#9aa0aa' },
    limit: 5
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].providerId, 'codex');
  assert.equal(rows[0].name, 'Codex');
});

test('homeLimitAccountsForProviders can preserve configured provider order over remaining quota', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [
      { provider: 'grok', windows: [{ kind: 'billing', label: 'Monthly', remainingPercent: 100 }] },
      { provider: 'claude', windows: [{ kind: 'weekly', remainingPercent: 50 }] }
    ],
    providerOptions: [
      { id: 'grok', label: 'Grok' },
      { id: 'claude', label: 'Claude' }
    ],
    enabledProviderIds: ['grok', 'claude'],
    colors: { grok: '#9aa0aa', claude: '#cc7c5e' },
    limit: 3,
    sort: 'configured'
  });

  assert.deepEqual(rows.map((row) => row.providerId), ['grok', 'claude']);
});

test('homeTrendSummary returns the peak value and real date anchors', () => {
  const summary = homeTrendSummary([
    { date: '2026-05-07', tokens: 20 },
    { date: '2026-05-23', tokens: 80 },
    { date: '2026-06-20', tokens: 40 }
  ]);

  assert.deepEqual(summary, {
    peak: 80,
    dates: ['2026-05-07', '2026-05-23', '2026-06-20']
  });
});

test('homeActivityWheelRoute lets vertical wheel gestures continue to Home scrolling', () => {
  assert.equal(homeActivityWheelRoute({ deltaX: 2, deltaY: 40 }), 'home-vertical');
  assert.equal(homeActivityWheelRoute({ deltaX: 40, deltaY: 2 }), 'activity-horizontal');
  assert.equal(homeActivityWheelRoute({ deltaX: 0, deltaY: 40, shiftKey: true }), 'activity-horizontal');
});

test('homeActivityScrollTarget pins to the newest (right) edge while following the end', () => {
  // Laid out and overflowing: follow-end lands on the far right.
  assert.equal(homeActivityScrollTarget({ scrollWidth: 700, clientWidth: 300, followEnd: true, savedLeft: null }), 400);
  // Not laid out yet (scrollWidth === clientWidth) → max 0, target 0, but the
  // ResizeObserver re-applies once layout settles, so this is only transient.
  assert.equal(homeActivityScrollTarget({ scrollWidth: 300, clientWidth: 300, followEnd: true, savedLeft: null }), 0);
});

test('homeActivityScrollTarget restores and clamps a saved user position', () => {
  assert.equal(homeActivityScrollTarget({ scrollWidth: 700, clientWidth: 300, followEnd: false, savedLeft: 180 }), 180);
  // A saved offset wider than the current max is clamped, never overshoots.
  assert.equal(homeActivityScrollTarget({ scrollWidth: 700, clientWidth: 300, followEnd: false, savedLeft: 999 }), 400);
  // followEnd false with no saved offset falls back to the end.
  assert.equal(homeActivityScrollTarget({ scrollWidth: 700, clientWidth: 300, followEnd: false, savedLeft: null }), 400);
});

test('homeActivityScrollRecord ignores measurements taken before layout settles', () => {
  // No overflow yet (or panel hidden) → null, so a bogus 0 never overwrites state.
  assert.equal(homeActivityScrollRecord({ scrollLeft: 0, scrollWidth: 300, clientWidth: 300 }), null);
  assert.equal(homeActivityScrollRecord({ scrollLeft: 0, scrollWidth: 0, clientWidth: 0 }), null);
});

test('homeActivityScrollRecord captures a user scroll and whether it sits at the end', () => {
  assert.deepEqual(homeActivityScrollRecord({ scrollLeft: 180, scrollWidth: 700, clientWidth: 300 }), {
    scrollLeft: 180,
    followEnd: false
  });
  // At (or within 2px of) the far right → keep following the newest column.
  assert.deepEqual(homeActivityScrollRecord({ scrollLeft: 400, scrollWidth: 700, clientWidth: 300 }), {
    scrollLeft: 400,
    followEnd: true
  });
  assert.deepEqual(homeActivityScrollRecord({ scrollLeft: 399, scrollWidth: 700, clientWidth: 300 }), {
    scrollLeft: 399,
    followEnd: true
  });
});

test('pickHomeHistory prefers the full-year homeHistory when it has days', () => {
  assert.equal(pickHomeHistory(historyWithDays, { daily: [{ date: '2026-06-02', tokens: 5 }] }), historyWithDays);
});

test('pickHomeHistory falls back to the preview rather than shadowing it with an empty homeHistory', () => {
  // The #39 regression: a cold-start fetch that raced the collector cached an empty
  // homeHistory, which then hid the (now populated) stats preview behind `||`.
  const preview = { daily: [{ date: '2026-06-02', tokens: 5 }] };
  assert.equal(pickHomeHistory(emptyHistory, preview), preview);
  assert.equal(pickHomeHistory(null, preview), preview);
});

test('pickHomeHistory returns an empty-daily shape when both sources are empty', () => {
  assert.deepEqual(pickHomeHistory(null, null), { daily: [] });
  assert.equal(pickHomeHistory(emptyHistory, emptyHistory), emptyHistory);
});

test('patchDailyToday overwrites the frozen today bucket with the live headline total', () => {
  const daily = [
    { date: '2026-07-06', tokens: 200, cost: 2 },
    { date: '2026-07-07', tokens: 61_500_000, cost: 490 } // stale one-shot snapshot
  ];
  const patched = patchDailyToday(daily, '2026-07-07', 61_700_000, 492.5);
  const patchedToday = patched.find((d) => d.date === '2026-07-07');
  assert.equal(patchedToday.tokens, 61_700_000);
  assert.equal(patchedToday.cost, 492.5); // cost drives the heatmap intensity, patch it too
  assert.equal(patched.find((d) => d.date === '2026-07-06').tokens, 200); // past days untouched
  assert.equal(patched.length, 2);
  assert.equal(daily[1].tokens, 61_500_000); // input not mutated
});

test('patchDailyToday appends today with live cost so its heatmap cell is not empty', () => {
  const daily = [{ date: '2026-07-06', tokens: 200, cost: 2 }];
  const patched = patchDailyToday(daily, '2026-07-07', 61_700_000, 492.5);
  assert.equal(patched.length, 2);
  const appended = patched[patched.length - 1];
  assert.equal(appended.date, '2026-07-07');
  assert.equal(appended.tokens, 61_700_000);
  assert.equal(appended.cost, 492.5); // intensity uses cost — a 0 here renders today as empty
});

test('renderHomeTrendsModule patches the activity today cell with the live period total', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function renderHomeTrendsModule\(\) \{([\s\S]*?)\n\}\n\nfunction renderHome/);
  assert.ok(match, 'renderHomeTrendsModule exists');
  assert.match(match[1], /patchDailyToday\([\s\S]*?totalTokens/);
});

test('historyPreviewKey is empty for no days and changes as the daily tail moves', () => {
  assert.equal(historyPreviewKey(null), '');
  assert.equal(historyPreviewKey(emptyHistory), '');
  const key = historyPreviewKey(historyWithDays);
  assert.notEqual(key, '');
  assert.equal(historyPreviewKey(historyWithDays), key); // stable for the same data
  assert.notEqual(historyPreviewKey({ daily: [{ date: '2026-06-02', tokens: 99 }] }), key);
});

test('shouldFetchHomeHistory fetches on the first request', () => {
  assert.equal(shouldFetchHomeHistory({ homeHistory: null, requested: false, preview: null }), true);
});

test('shouldFetchHomeHistory refetches when an empty result raced the collector', () => {
  // Requested once during the race (preview was empty → lastPreviewKey ''), but the
  // preview now shows history exists — fetch again instead of sticking on the empty result.
  assert.equal(shouldFetchHomeHistory({
    homeHistory: emptyHistory, requested: true, preview: historyWithDays, lastPreviewKey: ''
  }), true);
});

test('shouldFetchHomeHistory does not refetch against the preview it already tried', () => {
  // A failed/empty full-history fetch must not loop: loadHomeHistory's finally always
  // re-renders Home, so refetching the same preview state would spin the IPC path.
  const key = historyPreviewKey(historyWithDays);
  assert.equal(shouldFetchHomeHistory({
    homeHistory: emptyHistory, requested: true, preview: historyWithDays, lastPreviewKey: key
  }), false);
});

test('shouldFetchHomeHistory retries once the preview changes after a failed attempt', () => {
  const staleKey = historyPreviewKey(historyWithDays);
  const newerPreview = { daily: [{ date: '2026-06-02', tokens: 42 }] };
  assert.equal(shouldFetchHomeHistory({
    homeHistory: emptyHistory, requested: true, preview: newerPreview, lastPreviewKey: staleKey
  }), true);
});

test('shouldFetchHomeHistory stops once the full history is held', () => {
  assert.equal(shouldFetchHomeHistory({ homeHistory: historyWithDays, requested: true, preview: historyWithDays }), false);
});

test('shouldFetchHomeHistory never polls a zero-usage account', () => {
  // Requested once, still no preview data — nothing to fetch, so don't poll on every render.
  assert.equal(shouldFetchHomeHistory({ homeHistory: emptyHistory, requested: true, preview: emptyHistory }), false);
  assert.equal(shouldFetchHomeHistory({ homeHistory: null, requested: true, preview: null }), false);
});
