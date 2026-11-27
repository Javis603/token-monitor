'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function extractFunction(name) {
  const start = app.indexOf(`function ${name}(`);
  assert.notEqual(start, -1, `missing function ${name}`);
  const end = app.indexOf('\n}', start) + 2;
  return app.slice(start, end);
}

const sessionToolClientsSource = extractFunction('sessionToolClients');
const resolveSessionToolFilterSource = extractFunction('resolveSessionToolFilter');
const sessionPeriodTotalsSource = extractFunction('sessionPeriodTotals');

function createHelpers(initialState = {}) {
  const state = { sessionToolFilter: '', sessionPage: 0, ...initialState };
  const api = Function(
    'state',
    `${sessionToolClientsSource}\n${resolveSessionToolFilterSource}\n${sessionPeriodTotalsSource}\nreturn { state, sessionToolClients, resolveSessionToolFilter, sessionPeriodTotals };`
  )(state);
  return api;
}

const multiToolRows = [
  { key: 'session:claude:c1', kind: 'session', client: 'claude', value: 1000, cost: 0.2 },
  {
    key: 'session-group:codex:g1',
    kind: 'summary',
    client: 'codex',
    value: 900,
    cost: 0.18,
    groupRows: [
      { key: 'session:codex:x1', kind: 'session', client: 'codex', value: 500, cost: 0.1, unpricedTokens: 40 },
      { key: 'session:claude:c2', kind: 'session', client: 'claude', value: 400, cost: 0.08 }
    ]
  }
];

const multiToolPeriod = {
  totalTokens: 1900,
  costUsd: 0.38,
  unpricedTokens: 40,
  clients: { claude: 1400, codex: 500 },
  clientCosts: { claude: 0.28, codex: 0.1 },
  clientUnpricedTokens: { codex: 40 }
};

test('sessionPeriodTotals returns full period totals when no tool filter is active', () => {
  const { sessionPeriodTotals } = createHelpers();
  assert.deepEqual(sessionPeriodTotals(multiToolPeriod, multiToolRows, ''), {
    totalTokens: 1900,
    costUsd: 0.38,
    unpricedTokens: 40
  });
});

test('sessionPeriodTotals scopes tokens, cost, and unpriced tokens to the selected tool', () => {
  const { sessionPeriodTotals } = createHelpers();
  assert.deepEqual(sessionPeriodTotals(multiToolPeriod, multiToolRows, 'codex'), {
    totalTokens: 500,
    costUsd: 0.1,
    unpricedTokens: 40
  });
  assert.deepEqual(sessionPeriodTotals(multiToolPeriod, multiToolRows, 'claude'), {
    totalTokens: 1400,
    costUsd: 0.28,
    unpricedTokens: 0
  });
});

test('sessionPeriodTotals falls back to matching session members when period client aggregates are absent', () => {
  const { sessionPeriodTotals } = createHelpers();
  const rowsOnlyPeriod = { totalTokens: 1900, costUsd: 0.38 };
  assert.deepEqual(sessionPeriodTotals(rowsOnlyPeriod, multiToolRows, 'codex'), {
    totalTokens: 500,
    costUsd: 0.1,
    unpricedTokens: 40
  });
  assert.deepEqual(sessionPeriodTotals(rowsOnlyPeriod, multiToolRows, 'claude'), {
    totalTokens: 1400,
    costUsd: 0.28,
    unpricedTokens: 0
  });
});

test('resolveSessionToolFilter clears stale or single-tool selections', () => {
  const { state, resolveSessionToolFilter } = createHelpers({ sessionToolFilter: 'codex', sessionPage: 3 });
  assert.equal(resolveSessionToolFilter(multiToolRows), 'codex');
  assert.equal(state.sessionPage, 3);

  const singleToolRows = [{ key: 'session:claude:c1', kind: 'session', client: 'claude', value: 1000, cost: 0.2 }];
  assert.equal(resolveSessionToolFilter(singleToolRows), '');
  assert.equal(state.sessionToolFilter, '');
  assert.equal(state.sessionPage, 0);
});

test('renderAppContent updates headline tokens and cost when filtering sessions by tool', () => {
  const start = app.indexOf('function renderAppContent(');
  const end = app.indexOf('\nfunction setStatus(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);

  const classList = () => ({
    classes: new Set(),
    add(...names) { for (const name of names) this.classes.add(name); },
    remove(...names) { for (const name of names) this.classes.delete(name); },
    toggle(name, enabled) { if (enabled === undefined) { if (this.classes.has(name)) this.classes.delete(name); else this.classes.add(name); } else if (enabled) this.classes.add(name); else this.classes.delete(name); }
  });
  const node = () => ({ classList: classList(), textContent: '' });

  const todayPeriod = {
    totalTokens: 1500,
    costUsd: 0.3,
    unpricedTokens: 25,
    clients: { claude: 1000, codex: 500 },
    clientCosts: { claude: 0.2, codex: 0.1 },
    clientUnpricedTokens: { codex: 25 },
    sessions: {
      'claude:c1': { client: 'claude', sessionId: 'c1', totalTokens: 1000, costUsd: 0.2 },
      'codex:x1': { client: 'codex', sessionId: 'x1', totalTokens: 500, costUsd: 0.1 }
    }
  };
  const claudeOnlyPeriod = {
    totalTokens: 800,
    costUsd: 0.16,
    clients: { claude: 800 },
    clientCosts: { claude: 0.16 },
    sessions: {
      'claude:c2': { client: 'claude', sessionId: 'c2', totalTokens: 800, costUsd: 0.16 }
    }
  };

  const state = {
    breakdown: 'session',
    period: 'today',
    openSession: null,
    sessionToolFilter: '',
    sessionPage: 0,
    currentTotal: 0,
    suppressInitialNumberAnimation: true,
    stats: { periods: { today: todayPeriod, claudeOnly: claudeOnlyPeriod } },
    settings: { tokenNumberAnimation: 'off' },
    floatingBubble: { collapsed: false }
  };

  const els = {
    shell: node(),
    totalTokens: node(),
    homePanel: node(),
    breakdown: node(),
    limitsPanel: node(),
    serviceStatusPanel: node(),
    trendsPanel: node(),
    sessionDetail: node(),
    sessionDetailHead: node(),
    sessionPagerHost: node(),
    sessionToolFilter: node(),
    sessionSortToggle: node(),
    sessionSearchToggle: node(),
    sessionSearchHost: node(),
    toolDetailFooter: node(),
    projectBreakdownFooter: node(),
    fixedPeriodMessage: node(),
    viewBackRow: node()
  };

  const costCalls = [];
  const compactCalls = [];
  const renderedRows = [];
  const noop = () => {};

  const deps = {
    state,
    els,
    visibleStatsSurface: () => 'main',
    statsRenderScheduler: { request: noop },
    ensureBreakdownVisible: noop,
    loadReasonixSessionList: noop,
    syncSessionSearchChrome: noop,
    pluginMainPages: null,
    stopHomeSessionRepaint: noop,
    stopSessionStatusRepaint: noop,
    stopServiceStatusTicker: noop,
    hideHomeActivityTooltip: noop,
    hideHomeTrendTooltip: noop,
    cancelNumberAnimation: noop,
    renderViewSwitcher: noop,
    signalContentReady: noop,
    allTimeSessions: { ensure: noop },
    syncLiveTokenRateFooterState: noop,
    renderSessionUsageArchiveStatus: noop,
    fixedPeriodRangesApi: { isDerived: () => false },
    needsPagedSessions: () => false,
    warmSyncedFixedPeriod: noop,
    rendererDom: { clear: noop },
    periodContentAvailability: () => ({ fixedUnavailable: false, detailUnavailable: false }),
    formatNumber: value => Number(value).toLocaleString('en-US'),
    updateTotalCompact: value => compactCalls.push(value),
    setTotalCost: (cost, unpriced) => costCalls.push({ cost, unpriced: unpriced || 0 }),
    tokenNumberAnimationApi: { normalize: () => 'off' },
    animateTotalNumber: (_el, _from, to) => { els.totalTokens.textContent = Number(to).toLocaleString('en-US'); },
    headlineNumberIsAnimatingTo: () => false,
    pulseLiveDot: noop,
    renderTokenRate: noop,
    setRefreshButtonState: noop,
    hideTrendTooltip: noop,
    ensureServiceStatusTicker: noop,
    renderHome: noop,
    renderLimits: noop,
    maybeFetchCodexResetForecast: noop,
    renderTrends: noop,
    renderServiceStatus: noop,
    sessionRowsForPeriod: period => Object.entries(period.sessions || {}).map(([key, s]) => ({
      key: `session:${key}`,
      kind: 'session',
      client: s.client,
      value: s.totalTokens,
      cost: s.costUsd
    })),
    rowsForPeriod: period => Object.entries(period.sessions || {}).map(([key, s]) => ({
      key: `session:${key}`,
      kind: 'session',
      client: s.client,
      value: s.totalTokens,
      cost: s.costUsd
    })),
    projectRowsApi: { projectBreakdownIncomplete: () => false },
    sessionBreakdownIncomplete: () => false,
    renderRows: rows => {
      const visible = state.breakdown === 'session' && state.sessionToolFilter
        ? rows.filter(row => row.client === state.sessionToolFilter)
        : rows;
      renderedRows.push(visible);
    },
    scheduleSessionStatusRepaint: noop,
    renderFloatingBubbleContent: noop
  };

  const renderAppContent = Function(
    ...Object.keys(deps),
    `let numberAnimValue = 0; let numberAnimHandle = null;\n${sessionToolClientsSource}\n${resolveSessionToolFilterSource}\n${sessionPeriodTotalsSource}\n${app.slice(start, end)}\nreturn renderAppContent;`
  )(...Object.values(deps));

  renderAppContent();
  assert.equal(els.totalTokens.textContent, '1,500');
  assert.equal(state.currentTotal, 1500);
  assert.deepEqual(compactCalls.at(-1), 1500);
  assert.deepEqual(costCalls.at(-1), { cost: 0.3, unpriced: 25 });
  assert.equal(renderedRows.at(-1).length, 2);

  state.sessionToolFilter = 'codex';
  renderAppContent();
  assert.equal(els.totalTokens.textContent, '500');
  assert.equal(state.currentTotal, 500);
  assert.deepEqual(compactCalls.at(-1), 500);
  assert.deepEqual(costCalls.at(-1), { cost: 0.1, unpriced: 25 });
  assert.deepEqual(renderedRows.at(-1).map(row => row.client), ['codex']);

  state.sessionToolFilter = 'claude';
  renderAppContent();
  assert.equal(els.totalTokens.textContent, '1,000');
  assert.equal(state.currentTotal, 1000);
  assert.deepEqual(compactCalls.at(-1), 1000);
  assert.deepEqual(costCalls.at(-1), { cost: 0.2, unpriced: 0 });
  assert.deepEqual(renderedRows.at(-1).map(row => row.client), ['claude']);

  // Other views must keep showing all-tools totals even if a session tool filter was previously chosen.
  state.breakdown = 'home';
  renderAppContent();
  assert.equal(els.totalTokens.textContent, '1,500');
  assert.deepEqual(costCalls.at(-1), { cost: 0.3, unpriced: 25 });

  // Returning to Sessions and switching to a single-tool period resets the stale filter and shows full period totals.
  state.breakdown = 'session';
  state.period = 'claudeOnly';
  renderAppContent();
  assert.equal(state.sessionToolFilter, '');
  assert.equal(els.totalTokens.textContent, '800');
  assert.deepEqual(costCalls.at(-1), { cost: 0.16, unpriced: 0 });
});
