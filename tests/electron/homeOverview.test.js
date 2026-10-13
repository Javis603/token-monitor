'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  homeActivityHeatmapLayout,
  activityStatsForPeriod,
  homeDeviceRows,
  homeLimitAccounts,
  homeLimitAccountsForProviders,
  homeLimitsAwaitingFirstData,
  homeModelRows,
  longRangePeakDayTokens,
  homeToolRows,
  homeActivityWheelRoute,
  homeActivityScrollTarget,
  homeActivityScrollRecord,
  homeTrendSummary,
  pickHomeHistory,
  patchDailyToday,
  historyPreviewKey,
  homeHistorySignature,
  shouldFetchHomeHistory,
  shouldRetryHomeHistory,
  homeHistoryFetchOutcome
} = require('../../src/electron/renderer/homeOverview');
const { limitProviderCompactWindows } = require('../../src/electron/renderer/limits/providerPresentation');
const limitProviderOrderApi = require('../../src/electron/renderer/limits/providerOrder');

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
  const homeActivityHoverRule = css.match(
    /\.home-activity-canvas \.heat\[data-active="true"\],\s*\.home-activity-canvas \.heat:hover\s*\{([^}]*)\}/
  );
  assert.ok(homeActivityHoverRule, 'Home activity hover rule exists');
  assert.doesNotMatch(homeActivityHoverRule[1], /transform\s*:\s*scale/);
  assert.match(
    css,
    /\.home-activity-scroll\.is-restoring-hover \.heat,\s*\.home-activity-scroll\.is-restoring-hover \.heat-bright-layer\s*\{[^}]*transition:\s*none/
  );
  assert.match(rule(css, '.home-activity-tooltip'), /position:\s*fixed/);
  assert.match(rule(css, '.home-activity-tooltip'), /background:\s*rgba\(var\(--panel-rgb\), 0\.58\)/);
  assert.match(rule(css, '.home-activity-tooltip'), /backdrop-filter:\s*blur\(10px\) saturate\(120%\)/);
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
  assert.match(match[1], /tokenIntensity/);
  assert.match(rendererSource, /computeHeatmapIntensities\(daily\)/);
});

test('Home activity tooltip survives Home rerenders and is dismissed when the view leaves Home', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  // The body-level tooltip only has scroller-local pointer handlers; DOM removal fires
  // no pointerleave, so the hover setup must expose a teardown other code can invoke.
  assert.match(rendererSource, /state\.homeActivityHoverPoint\s*=\s*\{\s*x:\s*clientX,\s*y:\s*clientY\s*\}/);
  assert.match(rendererSource, /state\.homeActivityHoverDate\s*=\s*cell\.dataset\.d/);
  assert.match(rendererSource, /state\.homeActivityHoverTeardown\s*=\s*\(\{\s*preserveHover/);
  assert.match(rendererSource, /state\.homeActivityHoverRestore\s*=\s*\(\)\s*=>/);
  assert.match(rendererSource, /candidate\.dataset\.d\s*===\s*date/);
  assert.match(rendererSource, /stillHovered[\s\S]*?showAtPoint\(point\.x,\s*point\.y,\s*cell\)/);
  // Clearing the ref after teardown lets a discarded scroller closure be collected.
  const hideFn = rendererSource.match(/function hideHomeActivityTooltip\(\{ preserveHover = false \} = \{\}\) \{([\s\S]*?)\n\}/);
  assert.ok(hideFn, 'hideHomeActivityTooltip exists');
  assert.match(hideFn[1], /state\.homeActivityHoverTeardown\s*=\s*null/);
  assert.match(hideFn[1], /state\.homeActivityHoverRestore\s*=\s*null/);
  // renderHome replaces the scroller on live stats refreshes. Preserve the pointer point,
  // restore the attached scroller position before measuring the new cell, and repeat the
  // hover restoration after ResizeObserver confirms that layout has settled.
  const renderHome = rendererSource.match(/function renderHome\(\) \{([\s\S]*?)\n\}\n\nfunction render\(\)/);
  assert.ok(renderHome, 'renderHome exists');
  assert.match(renderHome[1], /hideHomeActivityTooltip\(\{\s*preserveHover:\s*true\s*\}\)/);
  assert.match(
    renderHome[1],
    /replaceChildren\(\.\.\.nodes\)[\s\S]*?applyHomeActivityScroll\(activityScroller\)[\s\S]*?homeActivityHoverRestore\(\)/
  );
  const trendsModule = rendererSource.match(/function renderHomeTrendsModule\(\) \{([\s\S]*?)\n\}\n\nfunction renderHome/);
  assert.ok(trendsModule, 'renderHomeTrendsModule exists');
  assert.match(
    trendsModule[1],
    /setupHomeActivityScroller\(activityScroll,\s*\(\)\s*=>\s*\{[\s\S]*?homeActivityHoverRestore\?\.\(\)[\s\S]*?animateHomeHistoryVisuals/
  );
  assert.match(trendsModule[1], /homeActivityHoverPoint[\s\S]*?homeActivityHoverDate[\s\S]*?classList\.add\('is-restoring-hover'\)/);
  assert.match(
    renderHome[1],
    /homeActivityHoverRestore\(\)[\s\S]*?requestAnimationFrame\(\(\)\s*=>\s*activityScroller\.classList\.remove\('is-restoring-hover'\)\)/
  );
  assert.match(rendererSource, /homeActivityProgrammaticScrollers\.add\(scroller\)[\s\S]*?scroller\.scrollLeft\s*=\s*target/);
  assert.match(
    rendererSource,
    /addEventListener\('scroll',\s*\(\)\s*=>\s*\{[\s\S]*?homeActivityProgrammaticScrollers\.delete\(scroller\)[\s\S]*?homeActivityHoverRestore\?\.\(\)[\s\S]*?hide\(\)/
  );
  // Leaving Home for another view must also dismiss it (the panel is only CSS-hidden).
  const render = rendererSource.match(/function render\(\) \{([\s\S]*?)\n\}\n\nfunction setStatus/);
  assert.ok(render, 'render exists');
  assert.match(render[1], /breakdown !== 'home'[\s\S]*?hideHomeActivityTooltip\(\)/);
});

test('Home activity preserves a gap spotlight across rebuilds and fades it when the pointer leaves the replaced scroller', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const setup = source.match(/function setupHomeActivityHover\(scroller\) \{[\s\S]*?\n\}/)?.[0];
  const hide = source.match(/function hideHomeActivityTooltip\(\{ preserveHover = false \} = \{\}\) \{[\s\S]*?\n\}/)?.[0];
  assert.ok(setup && hide, 'the actual hover lifecycle is available');
  const fields = new Map();
  const tooltip = {
    dataset: {},
    setAttribute() {},
    querySelector(selector) {
      if (!fields.has(selector)) fields.set(selector, { textContent: '' });
      return fields.get(selector);
    }
  };
  const frames = new Map();
  const documentMoves = new Set();
  let frameId = 0;
  class HitTarget {
    closest() { return null; }
  }
  const createScroller = () => {
    const classes = new Set();
    const handlers = new Map();
    const attributes = new Map();
    const gradient = { setAttribute(name, value) { attributes.set(name, value); } };
    const cell = Object.assign(new HitTarget(), {
      dataset: { d: '2026-10-07', t: '40' },
      closest() { return this; },
      setAttribute(name, value) { this[name] = value; },
      removeAttribute(name) { delete this[name]; },
      getBoundingClientRect: () => ({ left: 0, top: 0, right: 9, bottom: 9, width: 9, height: 9 })
    });
    const rect = { left: 0, top: 0, right: 100, bottom: 50, width: 100, height: 50 };
    const svg = Object.assign(new HitTarget(), {
      viewBox: { baseVal: { x: 0, y: 0, width: 100, height: 50 } },
      querySelector: () => gradient,
      getBoundingClientRect: () => rect
    });
    const canvas = {
      querySelector: () => svg,
      querySelectorAll: () => [cell],
      contains: (target) => target === cell
    };
    const scroller = {
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        contains: (name) => classes.has(name)
      },
      querySelector: () => canvas,
      contains: (target) => target === scroller || target === svg || target === cell,
      getBoundingClientRect: () => rect,
      addEventListener(name, callback) { handlers.set(name, callback); }
    };
    return { scroller, cell, svg, attributes, fire(name, event) { handlers.get(name)?.(event); } };
  };
  const state = {};
  const context = {
    state,
    Element: HitTarget,
    homeActivityProgrammaticScrollers: new WeakSet(),
    homeActivityTooltipEl: () => tooltip,
    moveHomeActivityTooltip() {},
    formatCompact: String,
    prefersReducedMotion: () => false,
    requestAnimationFrame(callback) { frames.set(++frameId, callback); return frameId; },
    cancelAnimationFrame(id) { frames.delete(id); },
    document: {
      querySelector: () => tooltip,
      addEventListener(name, callback) { if (name === 'pointermove') documentMoves.add(callback); },
      removeEventListener(name, callback) { if (name === 'pointermove') documentMoves.delete(callback); }
    }
  };
  const moveDocument = (target) => {
    for (const callback of documentMoves) callback({ target });
  };
  vm.runInNewContext(setup + '\n' + hide, context);
  let current = createScroller();
  context.setupHomeActivityHover(current.scroller);
  current.fire('pointermove', { clientX: 5, clientY: 5, target: current.cell });
  assert.equal(tooltip.dataset.visible, 'true');
  // The real heatmap uses 9px cells with 3px gaps. A hit in the gap targets SVG.
  current.fire('pointermove', { clientX: 10.5, clientY: 5, target: current.svg });
  assert.equal(current.scroller.classList.contains('is-spotlight-visible'), true);
  assert.equal(tooltip.dataset.visible, 'false');
  assert.equal(state.homeActivityHoverDate, '');
  for (let refresh = 0; refresh < 2; refresh += 1) {
    context.hideHomeActivityTooltip({ preserveHover: true });
    assert.equal(frames.size, 0, 'the replaced SVG retains no queued light movement');
    assert.equal(documentMoves.size, 0, 'a replaced scroller releases its document listener');
    current = createScroller();
    context.setupHomeActivityHover(current.scroller);
    assert.equal(documentMoves.size, 1, 'refreshes keep one live document listener');
    state.homeActivityHoverRestore();
    moveDocument(current.svg);
    assert.equal(current.scroller.classList.contains('is-spotlight-visible'), true, 'poll restores a stationary gap light');
    assert.equal(current.attributes.get('cx'), '10.5');
    assert.equal(current.attributes.get('cy'), '5');
    assert.equal(tooltip.dataset.visible, 'false', 'a gap never invents a tooltip date');
    assert.equal(state.homeActivityHoverDate, '');
    assert.equal(current.cell['data-active'], undefined);
  }
  // Chromium can omit pointerleave after replacing a stationary hovered node.
  // The next move over an unrelated Home module must still dismiss the light.
  moveDocument(new HitTarget());
  assert.equal(current.scroller.classList.contains('is-spotlight-visible'), false);
  assert.equal(current.attributes.get('cx'), '10.5', 'exit retains the last gradient position for the opacity fade');
  assert.equal(current.attributes.get('cy'), '5');
  assert.equal(frames.size, 0);
  assert.equal(state.homeActivitySpotlightPoint, null);
  context.hideHomeActivityTooltip({ preserveHover: true });
  assert.equal(documentMoves.size, 0);
  current = createScroller();
  context.setupHomeActivityHover(current.scroller);
  state.homeActivityHoverRestore();
  assert.equal(current.scroller.classList.contains('is-spotlight-visible'), false, 'leaving the heatmap clears the saved light');
  assert.equal(tooltip.dataset.visible, 'false');
  context.hideHomeActivityTooltip();
  assert.equal(documentMoves.size, 0, 'leaving Home removes the final listener');
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
      name: 'secondary@example.com',
      color: '#49a3b0',
      windows: [
        { kind: 'session', usedPercent: 30 },
        { kind: 'weekly', usedPercent: 5 }
      ]
    },
    {
      key: 'codex:0',
      providerId: 'codex',
      name: 'primary@example.com',
      color: '#49a3b0',
      windows: [
        { kind: 'weekly', usedPercent: 57, resetDescription: '4d 13h' },
        { kind: 'session', usedPercent: 100, resetDescription: '32m' }
      ]
    }
  ]);

  assert.equal(rows.length, 2);
  assert.equal(rows[0].name, 'primary@example.com');
  assert.equal(rows[0].providerId, 'codex');
  assert.equal(rows[0].lowestRemaining, 0);
  assert.deepEqual(rows[0].windows.map((window) => window.kind), ['session', 'weekly']);
  assert.deepEqual(rows[0].windows.map((window) => window.remainingPercent), [0, 43]);
  assert.equal(rows[1].lowestRemaining, 70);
});

test('Home keeps canonical Codex quotas ahead of named additional windows', () => {
  const windows = [
    { kind: 'session', label: '5-hour', remainingPercent: 40 },
    { kind: 'weekly', label: 'Weekly', remainingPercent: 70 },
    { kind: 'session', label: 'Session', limitId: 'gpt-reserve', additional: true, remainingPercent: 100 },
    { kind: 'weekly', label: 'Weekly', limitId: 'gpt-reserve', additional: true, remainingPercent: 100 }
  ];
  const [row] = homeLimitAccounts([{
    key: 'codex:0',
    providerId: 'codex',
    name: 'Codex',
    windows: limitProviderCompactWindows('codex', windows)
  }]);

  assert.deepEqual(row.windows.map((window) => window.label), ['5-hour', 'Weekly']);
});

test('Home keeps Volcengine 5-hour and Daily as its two compact windows', () => {
  const [row] = homeLimitAccounts([{
    key: 'volcengine:0',
    providerId: 'volcengine',
    name: 'Agent Plan Medium',
    windows: [
      { kind: 'billing', remainingPercent: 40 },
      { kind: 'weekly', remainingPercent: 50 },
      { kind: 'daily', remainingPercent: 60 },
      { kind: 'session', remainingPercent: 70 }
    ]
  }]);

  assert.deepEqual(row.windows.map((window) => window.kind), ['session', 'daily']);
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

test('homeLimitAccounts keeps Zed Edit Predictions and Token Spend as two quota windows', () => {
  const [row] = homeLimitAccounts([{
    key: 'zed:0',
    providerId: 'zed',
    name: 'Zed',
    windows: [
      {
        kind: 'billing',
        limitId: 'zed.token-spend',
        label: 'Token Spend',
        used: 2.5,
        limit: 10,
        usedPercent: 25,
        showMeter: true
      },
      {
        kind: 'billing',
        limitId: 'zed.edit-predictions',
        label: 'Edit Predictions',
        usedPercent: 0,
        detail: 'Unlimited',
        value: 'Unlimited',
        showMeter: true
      }
    ]
  }]);

  assert.equal(row.providerId, 'zed');
  assert.deepEqual(row.windows.map((window) => ({
    label: window.label,
    remainingPercent: window.remainingPercent,
    showMeter: window.showMeter,
    detail: window.detail,
    value: window.value,
    resetsAt: window.resetsAt
  })), [
    {
      label: 'Token Spend',
      remainingPercent: 75,
      showMeter: true,
      detail: '',
      value: '',
      resetsAt: undefined
    },
    {
      label: 'Edit Predictions',
      remainingPercent: 100,
      showMeter: true,
      detail: 'Unlimited',
      value: 'Unlimited',
      resetsAt: undefined
    }
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
        windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 4.61, currency: 'CNY' }]
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
  assert.deepEqual(rows[1].windows.map((window) => [window.kind, window.metric, window.label, window.remainingPercent, window.remaining, window.currency, window.value]), [
    ['billing', 'credits', 'Balance', 100, 4.61, 'CNY', '']
  ]);
});

test('homeLimitsAwaitingFirstData is false once every enabled provider has reported', () => {
  const awaiting = homeLimitsAwaitingFirstData({
    providers: [{ provider: 'claude' }, { provider: 'zai' }],
    providerOptions: [{ id: 'claude' }, { id: 'zai' }],
    enabledProviderIds: ['claude', 'zai']
  });
  assert.equal(awaiting, false);
});

test('homeLimitsAwaitingFirstData is true when an enabled provider has no entry yet (cold start)', () => {
  const awaiting = homeLimitsAwaitingFirstData({
    providers: [{ provider: 'claude' }],
    providerOptions: [{ id: 'claude' }, { id: 'zai' }],
    enabledProviderIds: ['claude', 'zai']
  });
  assert.equal(awaiting, true);
});

test('homeLimitsAwaitingFirstData is false when every candidate provider is hidden', () => {
  assert.equal(homeLimitsAwaitingFirstData({
    providers: [],
    providerOptions: [{ id: 'claude' }],
    enabledProviderIds: ['claude'],
    hiddenProviderIds: ['claude']
  }), false);
});

test('homeLimitsAwaitingFirstData is false when no provider is enabled', () => {
  assert.equal(homeLimitsAwaitingFirstData({
    providers: [],
    providerOptions: [{ id: 'claude' }],
    enabledProviderIds: []
  }), false);
});

for (const { name, settings, expected } of [
  { name: 'limits are globally disabled', settings: { limitsEnabled: false, limitProviders: 'claude' }, expected: 'home.noLimits' },
  { name: 'all providers are deselected', settings: { limitsEnabled: true, limitProviders: '' }, expected: 'home.noLimits' },
  { name: 'an enabled provider is awaiting its first data', settings: { limitsEnabled: true, limitProviders: 'claude' }, expected: 'home.limitsInitializing' }
]) {
  test(`Home limits empty-state copy when ${name}`, () => {
    const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
    const functions = ['configuredLimitProviderSelection', 'enabledLimitProviderSet', 'homeLimitRows', 'renderHomeLimitModule']
      .map((functionName) => {
        const start = source.indexOf(`function ${functionName}(`);
        assert.notEqual(start, -1, `${functionName} exists`);
        const end = source.indexOf('\n}\n', start);
        assert.notEqual(end, -1, `${functionName} closes`);
        return source.slice(start, end + 2);
      }).join('\n');
    const body = { children: [], append(element) { this.children.push(element); } };
    vm.runInNewContext(`${functions}\nrenderHomeLimitModule();`, {
      state: { settings, stats: { limits: { providers: [] } } },
      LIMIT_PROVIDERS: [{ id: 'claude', label: 'Claude' }],
      DEFAULT_LIMIT_PROVIDER_ORDER: 'claude',
      limitProviderOrderApi,
      homeOverviewApi: { homeLimitAccountsForProviders, homeLimitsAwaitingFirstData },
      clientColors: {},
      hiddenHomeLimitProviderSet: () => new Set(),
      homeModuleShell: () => ({ module: {}, body }),
      document: { createElement: () => ({}) },
      t: (key) => key
    });
    assert.equal(body.children.length, 1);
    assert.equal(body.children[0].textContent, expected);
  });
}

test('homeLimitAccountsForProviders includes MiMo Token Plan status and balance', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [
      {
        provider: 'mimo',
        windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 7.51, currency: 'CNY' }],
        balance: { amount: 7.51, currency: 'CNY', planStatus: 'active', planUsed: 250, planLimit: 1000 }
      },
      {
        provider: 'mimo',
        windows: [
          { kind: 'billing', label: 'Token Plan', remainingPercent: 100 },
          { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 7.51, currency: 'CNY' }
        ],
        balance: { amount: 7.51, currency: 'CNY', planStatus: 'expired' }
      }
    ],
    providerOptions: [{ id: 'mimo', label: 'MiMo' }],
    enabledProviderIds: ['mimo'],
    colors: { mimo: '#5daeea' },
    limit: 5
  });

  assert.deepEqual(rows[0].windows.map((window) => window.metric), ['', 'credits']);
  assert.equal(rows[0].windows[0].remainingPercent, 75);
  assert.equal(rows[0].windows[1].remaining, 7.51);
  assert.deepEqual(rows[1].windows.map((window) => [window.metric, window.planStatus]), [
    ['', 'expired'],
    ['credits', '']
  ]);
});

test('MiMo balance without plan data does not synthesize a Token Plan meter', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [{
      provider: 'mimo',
      accountKey: 'mimo-no-plan',
      status: 'ok',
      windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.61, currency: 'CNY' }],
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
  // Only the balance survives — no Token Plan meter was invented for it.
  assert.deepEqual(rows[0].windows.map((window) => window.metric), ['credits']);
  assert.equal(rows[0].windows[0].remaining, 9.61);
});

test('MiMo empty plan values do not synthesize a Token Plan meter', () => {
  const rows = homeLimitAccounts([
    {
      key: 'mimo-empty-plan',
      providerId: 'mimo',
      name: 'MiMo',
      windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 4.83, currency: 'CNY' }],
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
  // Only the balance survives — no Token Plan meter was invented for it.
  assert.deepEqual(rows[0].windows.map((window) => window.metric), ['credits']);
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
    { name: 'gpt-5.5', value: 29_800_000, cost: 25.88, color: '#49a3b0' },
    { name: 'cost-only', value: 0, cost: 3.25, color: '#9aa0aa' }
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

test('Home retains the source mark for fully attributed unknown usage', () => {
  const rows = homeModelRows([
    { key: 'unknown', name: 'unknown', value: 200, color: '#49a3b0', modelSource: 'codex' }
  ], 200);
  assert.equal(rows[0].modelSource, 'codex');
  assert.equal(rows[0].name, 'unknown');
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

test('Home retains each account plan through quota sorting without borrowing another account plan', () => {
  const presentation = require('../../src/electron/renderer/limits/providerPresentation');
  const rows = homeLimitAccountsForProviders({
    providers: [
      { provider: 'codex', accountEmail: 'pro@example.com', planLabel: 'Pro More', windows: [{ kind: 'weekly', remainingPercent: 93 }] },
      { provider: 'codex', accountEmail: 'plus@example.com', planLabel: 'Plus', windows: [{ kind: 'weekly', remainingPercent: 30 }] },
      { provider: 'zed', planLabel: 'Zed Student', windows: [{ kind: 'monthly', remainingPercent: 60 }] },
      { provider: 'claude', windows: [{ kind: 'session', remainingPercent: 70 }] }
    ],
    providerOptions: [{ id: 'codex', label: 'Codex' }, { id: 'zed', label: 'Zed' }, { id: 'claude', label: 'Claude' }],
    enabledProviderIds: ['codex', 'zed', 'claude'],
    limit: 4,
    accountName: (provider) => provider.accountEmail || provider.provider,
    accountPlan: (provider) => presentation.limitProviderPlanDisplayLabel(provider, provider.planLabel)
  });
  assert.deepEqual(rows.map((row) => [row.name, row.plan]), [
    ['plus@example.com', 'Plus'], ['zed', 'Student'], ['claude', ''], ['pro@example.com', 'Pro More']
  ]);
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

test('homeLimitAccountsForProviders preserves per-account adapter visuals', () => {
  const rows = homeLimitAccountsForProviders({
    providers: [{
      provider: 'thirdparty',
      adapterId: 'sub2api',
      windows: [{ kind: 'billing', metric: 'credits', remaining: 12.5, currency: 'USD' }]
    }],
    providerOptions: [{ id: 'thirdparty', label: 'Third-party APIs' }],
    enabledProviderIds: ['thirdparty'],
    colors: { thirdparty: '#8090A6' },
    accountColor: (provider, _id, fallback) => provider.adapterId === 'sub2api' ? '#39D9E7' : fallback,
    accountIcon: (provider) => provider.adapterId
  });

  assert.equal(rows[0].color, '#39D9E7');
  assert.equal(rows[0].iconId, 'sub2api');
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

test('Home activity ignores browser-driven scroll churn and keeps the newest edge visible', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = rendererSource.indexOf('const homeActivityProgrammaticScrollers');
  const end = rendererSource.indexOf('function homeActivityTooltipEl');
  assert.ok(start !== -1 && end > start, 'the real activity scroller placement code is available');
  const state = { homeActivityScrollLeft: null, homeActivityFollowEnd: true, homeActivityResizeObserver: null };
  let resizeCallback = null;
  const observed = [];
  class ResizeObserver {
    constructor(callback) { resizeCallback = callback; }
    observe(target) { observed.push(target); }
    disconnect() {}
  }
  const createScroller = () => {
    const listeners = new Map();
    const classes = new Set();
    const canvas = {};
    const scroller = {
      scrollLeft: 0,
      scrollWidth: 0,
      clientWidth: 0,
      canvas,
      classList: {
        add: (name) => classes.add(name),
        remove: (name) => classes.delete(name),
        toggle: (name, force) => { if (force) classes.add(name); else classes.delete(name); },
        contains: (name) => classes.has(name)
      },
      querySelector: (selector) => (selector === '.home-activity-canvas' ? canvas : null),
      addEventListener(name, callback) { listeners.set(name, callback); },
      setLayout(scrollWidth, clientWidth) { scroller.scrollWidth = scrollWidth; scroller.clientWidth = clientWidth; },
      fire(name, event = {}) {
        event.preventDefault ||= () => { event.defaultPrevented = true; };
        listeners.get(name)?.(event);
        return event.defaultPrevented === true;
      }
    };
    return scroller;
  };
  const sandbox = {
    state,
    ResizeObserver,
    homeOverviewApi: { homeActivityScrollTarget, homeActivityScrollRecord }
  };
  // setupHomeActivityScroller/applyHomeActivityScroll are the real functions; the
  // script also brings the real placement bookkeeping (WeakSet/WeakMap) with it.
  vm.runInNewContext(rendererSource.slice(start, end), sandbox);
  const resize = () => resizeCallback?.();

  const scroller = createScroller();
  sandbox.setupHomeActivityScroller(scroller);
  assert.deepEqual(observed, [scroller, scroller.canvas], 'viewport and canvas are observed so size and data changes retain scroll placement');

  // Wide window: every date fits inside the module, nothing overflows.
  scroller.setLayout(680, 680);
  resize();
  assert.equal(scroller.scrollLeft, 0);

  // The window narrows until the dates overflow. Chromium re-clamps the offset (still 0)
  // and emits a scroll event before the observer callback runs. With no user intent the
  // newest (right) edge must stay visible instead of the oldest column.
  scroller.setLayout(610, 333);
  scroller.fire('scroll');
  assert.equal(scroller.scrollLeft, 277, 'a layout re-clamp does not strand the heatmap at the oldest edge');
  assert.equal(state.homeActivityFollowEnd, true);
  assert.equal(state.homeActivityScrollLeft, null, 'a browser re-clamp is not persisted as a user position');

  // The observer callback and any delayed event from that placement must agree.
  resize();
  scroller.fire('scroll');
  assert.equal(scroller.scrollLeft, 277);
  assert.equal(state.homeActivityFollowEnd, true);

  // Chromium can lay out a wide canvas and clamp the offset, then return to the
  // original width before scroll/ResizeObserver delivery. Final geometry is unchanged,
  // so comparing only its dimensions mistakes the delayed clamp for a user scroll.
  scroller.setLayout(700, 700);
  scroller.scrollLeft = 0;
  scroller.setLayout(610, 333);
  scroller.fire('scroll');
  assert.equal(scroller.scrollLeft, 277, 'same-frame width round trips still follow the newest edge');
  assert.equal(state.homeActivityFollowEnd, true);
  assert.equal(state.homeActivityScrollLeft, null);

  // A real drag away from the end is the user browsing history: persist that offset.
  scroller.fire('pointerdown', { button: 0, pointerType: 'mouse', clientX: 300, pointerId: 1, preventDefault() {} });
  scroller.fire('pointermove', { clientX: 400, pointerId: 1, preventDefault() {} });
  assert.equal(scroller.scrollLeft, 177);
  scroller.fire('scroll');
  assert.equal(state.homeActivityScrollLeft, 177);
  assert.equal(state.homeActivityFollowEnd, false);

  // Widening clamps 177 -> 110. That is the browser, not the user: the browsing offset
  // survives the clamp and returns when the window narrows again.
  scroller.setLayout(610, 500);
  scroller.scrollLeft = 110;
  scroller.fire('scroll');
  assert.equal(state.homeActivityScrollLeft, 177, 'a clamped offset does not overwrite the browsing position');
  assert.equal(state.homeActivityFollowEnd, false);
  scroller.setLayout(610, 333);
  resize();
  assert.equal(scroller.scrollLeft, 177);
  scroller.fire('scroll');

  // Dragging back to the right edge resumes following the newest column.
  scroller.fire('pointerup', { pointerId: 1 });
  scroller.setLayout(700, 700);
  scroller.scrollLeft = 0;
  scroller.setLayout(610, 333);
  scroller.fire('scroll');
  assert.equal(scroller.scrollLeft, 177, 'same-frame layout clamps restore the historical browsing position');
  assert.equal(state.homeActivityScrollLeft, 177);
  assert.equal(state.homeActivityFollowEnd, false);
  scroller.fire('pointerdown', { button: 0, pointerType: 'mouse', clientX: 200, pointerId: 2, preventDefault() {} });
  scroller.fire('pointermove', { clientX: 100, pointerId: 2, preventDefault() {} });
  assert.equal(scroller.scrollLeft, 277);
  scroller.fire('scroll');
  assert.equal(state.homeActivityFollowEnd, true);

  // ...and the next layout change keeps the newest edge visible.
  scroller.setLayout(610, 223);
  resize();
  assert.equal(scroller.scrollLeft, 387);
  assert.equal(state.homeActivityFollowEnd, true);

  // A stats rebuild creates a fresh scroller; it lands on the newest edge from state.
  const rebuilt = createScroller();
  rebuilt.setLayout(610, 333);
  sandbox.setupHomeActivityScroller(rebuilt);
  assert.equal(rebuilt.scrollLeft, 277);

  const roundTrip = () => {
    rebuilt.setLayout(700, 700);
    rebuilt.scrollLeft = 0;
    rebuilt.setLayout(610, 333);
    rebuilt.fire('scroll');
  };
  const saved = state.homeActivityScrollLeft;
  rebuilt.fire('pointerdown', { button: 0, pointerType: 'mouse', clientX: 200, pointerId: 3, preventDefault() {} });
  rebuilt.fire('pointermove', { clientX: 200, preventDefault() {} });
  rebuilt.fire('pointerup', { pointerId: 3 });
  for (const [name, event] of [
    ['wheel', { deltaX: 0, deltaY: 120 }],
    ['wheel', { deltaX: 0, deltaY: 0 }],
    ['keydown', { target: rebuilt, key: 'ArrowDown' }],
    ['touchstart', { touches: [{ clientX: 100, clientY: 100 }] }],
    ['touchend', {}]
  ]) {
    rebuilt.fire(name, event);
    roundTrip();
    assert.equal(rebuilt.scrollLeft, 277, `${name} without horizontal intent preserves the newest edge`);
    assert.equal(state.homeActivityFollowEnd, true);
    assert.equal(state.homeActivityScrollLeft, saved);
  }

  // Outward input at the latest edge has no movement to save. Its delayed
  // layout event must not authorize a jump to the oldest column.
  for (const [name, event] of [
    ['wheel', { deltaX: 50, deltaY: 0 }],
    ['wheel', { deltaX: 0, deltaY: 50, shiftKey: true }],
    ['keydown', { target: rebuilt, key: 'ArrowRight' }],
    ['keydown', { target: rebuilt, key: 'End' }]
  ]) {
    assert.equal(rebuilt.fire(name, event), true);
    roundTrip();
    assert.equal(rebuilt.scrollLeft, 277, `${name} at the edge preserves the latest column`);
    assert.equal(state.homeActivityFollowEnd, true);
    assert.equal(state.homeActivityScrollLeft, saved);
  }

  for (const [name, event, expected] of [
    ['wheel', { deltaX: -90, deltaY: 0 }, 187],
    ['wheel', { deltaX: 0, deltaY: -90, shiftKey: true }, 187],
    ['wheel', { deltaX: -2, deltaY: 0, deltaMode: 1 }, 245],
    ['wheel', { deltaX: -1, deltaY: 0, deltaMode: 2 }, 0],
    ['keydown', { target: rebuilt, key: 'ArrowLeft' }, 237],
    ['keydown', { target: rebuilt, key: 'Home' }, 0]
  ]) {
    state.homeActivityFollowEnd = true;
    sandbox.applyHomeActivityScroll(rebuilt);
    assert.equal(rebuilt.fire(name, event), true);
    assert.equal(rebuilt.scrollLeft, expected, `${name} moves the real scroller during input`);
    assert.equal(state.homeActivityScrollLeft, expected, `${name} saves browsing before async scroll delivery`);
    assert.equal(state.homeActivityFollowEnd, false);
    roundTrip();
    assert.equal(rebuilt.scrollLeft, expected, `${name} history survives a same-task clamp`);
  }
  rebuilt.fire('keydown', { target: rebuilt, key: 'End' });
  assert.equal(rebuilt.scrollLeft, 277);
  assert.equal(state.homeActivityFollowEnd, true);

  for (const event of [
    { deltaX: 10, deltaY: 120 },
    { deltaX: -90, deltaY: 0, ctrlKey: true },
    { deltaX: -90, deltaY: 0, metaKey: true },
    { deltaX: NaN, deltaY: 0 }
  ]) {
    assert.equal(rebuilt.fire('wheel', event), false, 'vertical and zoom gestures retain their default action');
    roundTrip();
    assert.equal(rebuilt.scrollLeft, 277);
  }

  // Touch remains native, including inertia after pointer cancellation.
  rebuilt.fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
  rebuilt.fire('touchmove', { touches: [{ clientX: 160, clientY: 102 }] });
  rebuilt.scrollLeft = 140;
  rebuilt.fire('scroll');
  assert.equal(state.homeActivityScrollLeft, 140);
  assert.equal(state.homeActivityFollowEnd, false);
  rebuilt.fire('pointercancel', { pointerId: 4 });
  rebuilt.fire('touchend');
  rebuilt.scrollLeft = 120;
  rebuilt.fire('scroll');
  assert.equal(state.homeActivityScrollLeft, 120, 'native touch inertia survives pointer cancellation');
  rebuilt.fire('scrollend');
  roundTrip();
  assert.equal(rebuilt.scrollLeft, 120);

  // Chromium's compositor can move the physical offset before touchmove delivery.
  // Compare with the last recorded position, including a reversal before the finger
  // crosses its starting point, rather than treating the already moved offset as zero.
  state.homeActivityFollowEnd = true;
  sandbox.applyHomeActivityScroll(rebuilt);
  rebuilt.fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
  for (const [x, left] of [[120, 257], [160, 217], [130, 247]]) {
    rebuilt.scrollLeft = left;
    if (x === 130) rebuilt.fire('scroll'); // a compositor reversal may arrive before touchmove
    rebuilt.fire('touchmove', { touches: [{ clientX: x, clientY: 102 }] });
    rebuilt.fire('scroll');
    assert.equal(rebuilt.scrollLeft, left, 'successive native touch movement does not snap back');
    assert.equal(state.homeActivityScrollLeft, left, 'each touch step, including reversal, records its actual position');
  }
  rebuilt.fire('touchend');
  rebuilt.fire('scrollend');
  roundTrip();
  assert.equal(rebuilt.scrollLeft, 247);

  // A resize during native touch must not replace the historical position with a clamp.
  rebuilt.fire('touchstart', { touches: [{ clientX: 100, clientY: 100 }] });
  rebuilt.fire('touchmove', { touches: [{ clientX: 160, clientY: 102 }] });
  rebuilt.setLayout(610, 560);
  rebuilt.scrollLeft = 50;
  rebuilt.fire('scroll');
  assert.equal(state.homeActivityScrollLeft, 247);
  rebuilt.setLayout(610, 333);
  resize();
  assert.equal(rebuilt.scrollLeft, 247);
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

test('renderHomeTrendsModule preserves long-range Activity and peak', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function renderHomeTrendsModule\(\) \{([\s\S]*?)\n\}\n\nfunction renderHome/);
  assert.ok(match, 'renderHomeTrendsModule exists');
  assert.match(match[1], /patchDailyToday\(/);
  assert.match(match[1], /rollingYearHeatmap\(/);
  assert.match(match[1], /clampDaily\(points, 45\)/);
  assert.match(match[1], /longRangePeakDayTokens\(/);
  assert.doesNotMatch(match[1], /activityStatsForPeriod\(/);
});

test('Home peak uses the freshest maximum across retained and live daily data', () => {
  assert.equal(longRangePeakDayTokens({
    historySummary: { peakDayTokens: 999 },
    daily: [{ tokens: 100 }, { tokens: 200 }]
  }), 999);
  assert.equal(longRangePeakDayTokens({
    historySummary: { peakDayTokens: 100 },
    daily: [{ tokens: 200 }]
  }), 200);
  assert.equal(longRangePeakDayTokens({
    historySummary: {},
    daily: [{ tokens: 100 }, { tokens: 200 }]
  }), 200);
});

test('Trends preserves its long-range chart while selecting range stats', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/function renderTrends\(\) \{([\s\S]*?)\n\}\n\nfunction viewLabelById/);
  assert.ok(match, 'renderTrends exists');
  assert.match(match[1], /selectPreviewSeries\(preview, fixed\?\.status === 'ready' \? 'allTime' : state\.period\)/);
  assert.match(match[1], /activityStatsForPeriod\(/);
});

test('Activity keeps long-term day and streak stats while range-shaping time and peak', () => {
  const fixedSnapshot = {
    status: 'ready',
    summary: { activeDays: 4, currentStreak: 4, activeTimeMs: 3600000, peakDayTokens: 80 }
  };
  assert.deepEqual(activityStatsForPeriod({
    period: 'last7',
    fixedSnapshot,
    historySummary: { activeDays: 119, currentStreak: 87, activeTimeMs: 999, peakDayTokens: 999 }
  }), {
    activeDays: 119,
    currentStreak: 87,
    activeTimeMs: 3600000,
    peakDayTokens: 80
  });
});

test('native DAY and MONTH activity time and peak follow their calendar range', () => {
  const daily = [
    { date: '2026-07-31', tokens: 90, activeTimeMs: 9000 },
    { date: '2026-08-11', tokens: 40, activeTimeMs: 4000 },
    { date: '2026-08-12', tokens: 70, activeTimeMs: 7000 }
  ];
  const historySummary = { activeDays: 120, currentStreak: 8, activeTimeMs: 20000, peakDayTokens: 90 };
  assert.deepEqual(activityStatsForPeriod({
    period: 'today', daily, historySummary, todayKey: '2026-08-12'
  }), { activeDays: 120, currentStreak: 8, activeTimeMs: 7000, peakDayTokens: 70 });
  assert.deepEqual(activityStatsForPeriod({
    period: 'month', daily, historySummary, todayKey: '2026-08-12'
  }), { activeDays: 120, currentStreak: 8, activeTimeMs: 11000, peakDayTokens: 70 });
});

test('loadHomeHistory wires the bounded retry through a timer, not a render', () => {
  const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const match = rendererSource.match(/async function loadHomeHistory\(\) \{([\s\S]*?)\n\}/);
  assert.ok(match, 'loadHomeHistory exists');
  const body = match[1];
  assert.match(body, /shouldRetryHomeHistory\(/, 'retry decision is delegated to the guarded predicate');
  assert.match(body, /setTimeout\(/, 'the retry is timer-driven so it cannot re-enter on every render');
  assert.match(body, /homeHistoryRetries \+= 1/, 'the retry counter advances toward the cap');
  assert.match(body, /homeHistoryRetrySignature !== requestSignature[\s\S]*?homeHistoryRetries = 0/, 'a new signature receives a fresh retry budget');
  assert.match(body, /homeHistoryLoadedSignature === requestSignature/, 'stale display history cannot suppress a retry');
});

test('historyPreviewKey is empty for no days and changes as the daily tail moves', () => {
  assert.equal(historyPreviewKey(null), '');
  assert.equal(historyPreviewKey(emptyHistory), '');
  const key = historyPreviewKey(historyWithDays);
  assert.notEqual(key, '');
  assert.equal(historyPreviewKey(historyWithDays), key); // stable for the same data
  assert.notEqual(historyPreviewKey({ daily: [{ date: '2026-06-02', tokens: 99 }] }), key);
});

test('homeHistorySignature prefers the revision and falls back to the whole preview', () => {
  assert.equal(homeHistorySignature({ historyRevision: 'abc123', historyPreview: historyWithDays }), 'abc123');
  // An older hub that predates revisions falls back to the full preview, mirroring
  // main's statsHistoryRevision, so any field change moves the signature.
  assert.equal(
    homeHistorySignature({ historyPreview: historyWithDays }),
    JSON.stringify(historyWithDays)
  );
  assert.equal(homeHistorySignature(null), '');
  assert.equal(homeHistorySignature({ historyRevision: '   ' , historyPreview: emptyHistory }), '');
});

test('homeHistorySignature (revision-less) moves on a non-tail change the tail key would miss', () => {
  // The daily tail (length:lastDate:lastTokens) is identical across these, but an
  // earlier day's cost/tokens and a monthly total differ — a backfill of an older
  // day. Home must still invalidate, which the tail key could not detect.
  const base = { daily: [{ date: '2026-06-01', tokens: 0, cost: 0 }, { date: '2026-06-02', tokens: 10, cost: 1 }], monthly: [{ month: '2026-06', tokens: 10 }], summary: {} };
  const backfilled = { daily: [{ date: '2026-06-01', tokens: 500, cost: 5 }, { date: '2026-06-02', tokens: 10, cost: 1 }], monthly: [{ month: '2026-06', tokens: 510 }], summary: {} };
  assert.equal(historyPreviewKey(base), historyPreviewKey(backfilled)); // tail key is blind to it
  assert.notEqual(
    homeHistorySignature({ historyPreview: base }),
    homeHistorySignature({ historyPreview: backfilled })
  );
});

test('shouldFetchHomeHistory fetches on the first request', () => {
  assert.equal(shouldFetchHomeHistory({ requested: false, stats: null }), true);
});

test('shouldFetchHomeHistory refetches when an empty result raced the collector', () => {
  // Requested once during the race (no stats yet → lastSignature ''), but stats now
  // show history exists — fetch again instead of sticking on the empty result.
  assert.equal(shouldFetchHomeHistory({
    requested: true, stats: { historyRevision: 'rev-1' }, lastSignature: ''
  }), true);
});

test('shouldFetchHomeHistory does not refetch against the history it already tried', () => {
  // A failed/empty full-history fetch must not loop: loadHomeHistory's finally always
  // re-renders Home, so refetching the same history state would spin the IPC path.
  assert.equal(shouldFetchHomeHistory({
    requested: true, stats: { historyRevision: 'rev-1' }, lastSignature: 'rev-1'
  }), false);
});

test('shouldFetchHomeHistory refetches once the collector produces a newer history (#177)', () => {
  // Home used to freeze the first non-empty snapshot for the whole renderer session, so
  // a snapshot taken before midnight kept rendering yesterday at its startup value until
  // the app was restarted. Holding data must not block a refetch any more.
  assert.equal(shouldFetchHomeHistory({
    requested: true, stats: { historyRevision: 'rev-2' }, lastSignature: 'rev-1'
  }), true);
  // Same for a revision-less hub, via the preview tail fallback.
  assert.equal(shouldFetchHomeHistory({
    requested: true,
    stats: { historyPreview: { daily: [{ date: '2026-06-02', tokens: 42 }] } },
    lastSignature: historyPreviewKey(historyWithDays)
  }), true);
});

test('shouldRetryHomeHistory retries a failed first load when the preview has days', () => {
  // Account has history but no current activity, so its revision never moves; a
  // transient first-load failure must still recover without waiting for a real change.
  assert.equal(shouldRetryHomeHistory({ loadedDays: false, previewHasDays: true, retries: 0, maxRetries: 3 }), true);
  assert.equal(shouldRetryHomeHistory({ loadedDays: false, previewHasDays: true, retries: 2, maxRetries: 3 }), true);
});

test('shouldRetryHomeHistory stops at the cap and after a success', () => {
  assert.equal(shouldRetryHomeHistory({ loadedDays: false, previewHasDays: true, retries: 3, maxRetries: 3 }), false);
  assert.equal(shouldRetryHomeHistory({ loadedDays: true, previewHasDays: true, retries: 0, maxRetries: 3 }), false);
});

test('shouldRetryHomeHistory never retries a genuinely zero-usage account (#39)', () => {
  // No preview days means there is nothing to load, so retrying would just poll — and
  // could reintroduce the render→fetch loop. Suppress it regardless of the counter.
  assert.equal(shouldRetryHomeHistory({ loadedDays: false, previewHasDays: false, retries: 0, maxRetries: 3 }), false);
});

test('homeHistoryFetchOutcome does not mistake stale display history for a successful request', () => {
  // The rejected request produced no value. Passing the old snapshot here proves
  // that it cannot make this attempt look loaded merely because it still has days.
  assert.deepEqual(homeHistoryFetchOutcome({
    resolved: false,
    history: historyWithDays,
    previewHasDays: true
  }), { loadedDays: false, accepted: false });
});

test('homeHistoryFetchOutcome preserves stale history across a raced empty result', () => {
  assert.deepEqual(homeHistoryFetchOutcome({
    resolved: true,
    history: emptyHistory,
    previewHasDays: true
  }), { loadedDays: false, accepted: false });
  assert.deepEqual(homeHistoryFetchOutcome({
    resolved: true,
    history: historyWithDays,
    previewHasDays: true
  }), { loadedDays: true, accepted: true });
});

test('homeHistoryFetchOutcome accepts an empty result for a zero-usage account', () => {
  assert.deepEqual(homeHistoryFetchOutcome({
    resolved: true,
    history: emptyHistory,
    previewHasDays: false
  }), { loadedDays: false, accepted: true });
});

test('shouldFetchHomeHistory never polls a zero-usage account', () => {
  // Requested once, still nothing to identify a history by — don't poll on every render.
  assert.equal(shouldFetchHomeHistory({ requested: true, stats: { historyPreview: emptyHistory } }), false);
  assert.equal(shouldFetchHomeHistory({ requested: true, stats: null }), false);
});

test('Home carries credits windows through as money, not a percentage', () => {
  const [row] = homeLimitAccounts([{
    key: 'thirdparty:0',
    providerId: 'thirdparty',
    name: 'production',
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Balance',
      remaining: 25,
      currency: 'USD',
      used: 75,
      limit: 100,
      usedPercent: 75,
      remainingPercent: 25
    }]
  }]);

  const [window] = row.windows;
  assert.equal(window.metric, 'credits');
  assert.equal(window.remaining, 25);
  assert.equal(window.currency, 'USD');
});

test('Home no longer synthesizes a balance window for DeepSeek', () => {
  const [row] = homeLimitAccounts([{
    key: 'deepseek',
    providerId: 'deepseek',
    name: 'DeepSeek',
    windows: [{
      kind: 'billing',
      metric: 'credits',
      label: 'Balance',
      remaining: 4,
      currency: 'CNY'
    }],
    balance: { amount: 4, currency: 'CNY', monthSpend: 0 }
  }]);

  assert.equal(row.windows.length, 1);
  assert.equal(row.windows[0].kind, 'billing');
  assert.equal(row.windows[0].metric, 'credits');
  assert.equal(row.windows[0].remaining, 4);
});

test('Home shows WorkBuddy credits through the shared credits contract', () => {
  const [row] = homeLimitAccounts([{
    key: 'workbuddy',
    providerId: 'workbuddy',
    name: 'WorkBuddy',
    windows: [{
      kind: 'billing',
      label: 'Credits',
      metric: 'credits',
      currency: 'CREDITS',
      remaining: 1069.59,
      limit: 1650,
      used: 580.41,
      usedPercent: 35.176,
      remainingPercent: 64.824
    }],
    balance: { amount: 1069.59, currency: 'CREDITS' }
  }]);

  assert.equal(row.windows.length, 1);
  assert.deepEqual(row.windows[0], {
    kind: 'billing',
    metric: 'credits',
    label: 'Credits',
    remainingPercent: 64.824,
    remaining: 1069.59,
    currency: 'CREDITS',
    resetsAt: undefined,
    resetDescription: '',
    value: '',
    planStatus: '',
    showMeter: true,
    detail: ''
  });
});

test('Home bars a MiMo lane by lane, so all readings stay on their own bar', () => {
  // Home is handed one entry per wire row, so each lane's readings keep a bar.
  const rows = homeLimitAccounts([
    {
      key: 'mimo:console',
      providerId: 'mimo',
      name: 'Console',
      windows: [
        { kind: 'billing', label: 'Token Plan', usedPercent: 20, remainingPercent: 80 },
        { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 9.95, currency: 'CNY' }
      ],
      balance: { amount: 9.95, currency: 'CNY', monthSpend: 0 }
    },
    {
      key: 'mimo:membership',
      providerId: 'mimo',
      name: 'Desktop Membership',
      windows: [{ kind: 'weekly', usedPercent: 22, remainingPercent: 78 }]
    }
  ]);

  assert.deepEqual(rows.map((row) => row.windows.map((window) => [window.label, window.metric])), [
    [['weekly', '']],
    [['Token Plan', ''], ['Balance', 'credits']]
  ]);
  assert.deepEqual(rows.map((row) => [row.key, row.windows.map((window) => window.remainingPercent)]), [
    ['mimo:membership', [78]], ['mimo:console', [80, 100]]
  ]);
  assert.equal(rows[1].windows[1].remaining, 9.95);
});

test('Home shows a MiMo token plan and balance side by side', () => {
  const [row] = homeLimitAccounts([{
    key: 'mimo',
    providerId: 'mimo',
    name: 'MiMo',
    windows: [
      { kind: 'billing', label: 'Token Plan', usedPercent: 22, remainingPercent: 78 },
      { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 12.5, currency: 'CNY' }
    ],
    balance: { amount: 12.5, currency: 'CNY', monthSpend: 0 }
  }]);

  assert.equal(row.windows.length, 2);
  assert.equal(row.windows[0].label, 'Token Plan');
  assert.equal(row.windows[0].remainingPercent, 78);
  assert.equal(row.windows[1].metric, 'credits');
  assert.equal(row.windows[1].remaining, 12.5);
});

test('Home sorts a nearly drained balance ahead of a healthy percentage quota', () => {
  const rows = homeLimitAccounts([
    {
      key: 'claude',
      providerId: 'claude',
      name: 'Claude',
      windows: [{ kind: 'session', usedPercent: 8, remainingPercent: 92 }]
    },
    {
      key: 'deepseek',
      providerId: 'deepseek',
      name: 'DeepSeek',
      windows: [{ kind: 'billing', metric: 'credits', label: 'Balance', remaining: 1, currency: 'CNY' }],
      balance: { amount: 1, currency: 'CNY', monthSpend: 99 }
    }
  ]);

  // 1 / (1 + 99) = 1% remaining, so DeepSeek must sort first.
  assert.equal(rows[0].key, 'deepseek');
  assert.equal(rows[1].key, 'claude');
});

test('Home drops the rows unchecked on a provider\'s usage-item list, MiMo\'s synthesized plan included', () => {
  const usageItems = require('../../src/shared/limits/usageItems');
  const hidden = {
    claude: [usageItems.limitWindowKey({ kind: 'weekly', label: 'Weekly' })],
    mimo: [usageItems.limitWindowKey({ kind: 'billing', label: 'Token Plan' })]
  };
  const rows = homeLimitAccountsForProviders({
    providers: [
      { provider: 'claude', windows: [
        { kind: 'session', label: 'Session', remainingPercent: 80 },
        { kind: 'weekly', label: 'Weekly', remainingPercent: 10 }
      ] },
      { provider: 'mimo', balance: { amount: 3, currency: 'USD', planUsed: 20, planLimit: 100 }, windows: [
        { kind: 'billing', metric: 'credits', label: 'Balance', remaining: 3, currency: 'USD' }
      ] }
    ],
    providerOptions: [{ id: 'claude', label: 'Claude' }, { id: 'mimo', label: 'MiMo' }],
    enabledProviderIds: ['claude', 'mimo'],
    limit: 5,
    isWindowHidden: (providerId, window) => usageItems.isLimitWindowHidden(hidden, providerId, window)
  });
  const byProvider = Object.fromEntries(rows.map((row) => [row.providerId, row.windows.map((window) => window.label)]));
  assert.deepEqual(byProvider.claude, ['Session']);
  assert.deepEqual(byProvider.mimo, ['Balance']);
});
