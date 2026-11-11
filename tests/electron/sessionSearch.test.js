'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { filterSessionRows } = require('../../src/electron/renderer/sessionRows');

const rows = [
  {
    key: 'session:codex:review',
    name: 'Review PR 1449',
    title: 'Codex session 019e76fc-aaaa-bbbb-cccc-111111111111',
    detail: '019e76fc-aaaa-bbbb-cccc-111111111111',
    client: 'codex',
    clientLabel: 'Codex',
    modelLabel: 'gpt-6.1-sol',
    subtitle: '09:33 · 100 calls'
  },
  {
    key: 'session-group:codex:daily',
    name: '每日課程與待辦提醒',
    client: 'codex',
    clientLabel: 'Codex',
    modelLabel: 'deepseek-v4.1-flash',
    subtitle: '07:38 · 213 calls',
    groupRows: [
      { name: '每日課程與待辦提醒', detail: 'main-id' },
      { name: '子代理檢查排程', detail: 'child-id', clientLabel: 'Codex' }
    ]
  }
];

test('session search matches titles, tools, models and ids without case sensitivity', () => {
  assert.strictEqual(filterSessionRows(rows, ''), rows);
  assert.deepEqual(filterSessionRows(rows, 'review').map((row) => row.key), ['session:codex:review']);
  assert.deepEqual(filterSessionRows(rows, 'REVIEW 1449').map((row) => row.key), ['session:codex:review']);
  assert.deepEqual(filterSessionRows(rows, '019e76fc').map((row) => row.key), ['session:codex:review']);
  assert.deepEqual(filterSessionRows(rows, 'deepseek').map((row) => row.key), ['session-group:codex:daily']);
});

test('session search reaches folded subagent titles and returns no matches cleanly', () => {
  assert.deepEqual(filterSessionRows(rows, '子代理').map((row) => row.key), ['session-group:codex:daily']);
  assert.deepEqual(filterSessionRows(rows, 'child-id').map((row) => row.key), ['session-group:codex:daily']);
  assert.deepEqual(filterSessionRows(rows, 'does-not-exist'), []);
  assert.deepEqual(filterSessionRows(null, 'review'), []);
});

test('the search affordance is scoped to the session list and closing it clears the query', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function sessionSearchQuery(');
  const end = app.indexOf('function sessionSearchEmptyNode(', start);
  const node = () => {
    const classes = new Set();
    return {
      classes,
      attributes: {},
      value: '',
      classList: { toggle(name, enabled) { if (enabled) classes.add(name); else classes.delete(name); } },
      setAttribute(name, value) { this.attributes[name] = value; }
    };
  };
  const els = {
    sessionSearchToggle: node(),
    sessionSearchHost: node(),
    sessionSearchInput: node(),
    sessionSearchClear: node(),
    sessionSearchStatus: { textContent: '' },
    breakdown: { scrollTop: 180 }
  };
  const state = { breakdown: 'session', openSession: null, sessionSearchOpen: false,
    sessionSearchQuery: '', sessionPage: 3, rowSignature: 'rows' };
  const api = Function('state', 'els', 't',
    `let sessionSearchComposing = false;\n${app.slice(start, end)}\nreturn { syncSessionSearchChrome, setSessionSearchOpen };`)(state, els, (key) => key);

  api.syncSessionSearchChrome();
  assert.equal(els.sessionSearchToggle.classes.has('hidden'), false);
  assert.equal(els.sessionSearchHost.classes.has('hidden'), false);
  assert.equal(els.sessionSearchHost.classes.has('is-open'), false);
  assert.equal(els.sessionSearchHost.inert, true);
  assert.equal(els.sessionSearchHost.attributes['aria-hidden'], 'true');

  state.sessionSearchOpen = true;
  state.sessionSearchQuery = 'review';
  api.syncSessionSearchChrome();
  assert.equal(els.sessionSearchHost.classes.has('hidden'), false);
  assert.equal(els.sessionSearchHost.classes.has('is-open'), true);
  assert.equal(els.sessionSearchHost.inert, false);
  assert.equal(els.sessionSearchHost.attributes['aria-hidden'], 'false');
  assert.equal(els.sessionSearchToggle.attributes['aria-expanded'], 'true');
  assert.equal(els.sessionSearchInput.value, 'review');
  assert.equal(els.sessionSearchClear.classes.has('hidden'), false);

  state.openSession = { kind: 'session' };
  api.syncSessionSearchChrome();
  assert.equal(els.sessionSearchToggle.classes.has('hidden'), true);
  assert.equal(els.sessionSearchHost.classes.has('hidden'), true);
  assert.equal(els.sessionSearchHost.classes.has('is-open'), false);
  assert.equal(els.sessionSearchHost.inert, true);

  state.openSession = null;
  state.sessionSearchOpen = true;
  api.setSessionSearchOpen(false);
  assert.equal(state.sessionSearchQuery, '');
  assert.equal(els.sessionSearchInput.value, '');
  assert.equal(state.sessionPage, 0);
  assert.equal(state.rowSignature, '');
  assert.equal(els.breakdown.scrollTop, 0);
  assert.equal(els.sessionSearchHost.classes.has('hidden'), false);
  assert.equal(els.sessionSearchHost.classes.has('is-open'), false);
  assert.equal(els.sessionSearchHost.inert, true);

  els.breakdown.scrollTop = 240;
  state.sessionPage = 2;
  api.setSessionSearchOpen(true);
  assert.equal(els.breakdown.scrollTop, 0);
  assert.equal(state.sessionPage, 0);
});

test('background renders preserve IME composition until the completed query is committed', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function sessionSearchQuery(');
  const end = app.indexOf('function sessionSearchEmptyNode(', start);
  const handlersStart = app.indexOf('let sessionSearchComposing = false;');
  const handlersEnd = app.indexOf("els.sessionSearchClear?.addEventListener('click'", handlersStart);
  const handlers = {};
  const input = {
    value: '',
    addEventListener: (type, handler) => { handlers[type] = handler; }
  };
  const state = { breakdown: 'session', stats: {}, period: 'today',
    sessionSearchOpen: true, sessionSearchQuery: '' };
  let renders = 0;
  const sync = Function('state', 'els', 't', 'render',
    `${app.slice(start, end)}\n${app.slice(handlersStart, handlersEnd)}\nreturn syncSessionSearchChrome;`)(
    state, { sessionSearchInput: input, breakdown: { scrollTop: 0 } }, key => key, () => { renders++; }
  );

  handlers.compositionstart();
  input.value = '中文';
  handlers.input({ isComposing: true });
  sync();
  assert.equal(input.value, '中文');
  assert.equal(state.sessionSearchQuery, '');
  assert.equal(renders, 0);

  handlers.compositionend();
  assert.equal(state.sessionSearchQuery, '中文');
  assert.equal(renders, 1);
  handlers.input({ isComposing: false });
  assert.equal(renders, 1);
  sync();
  assert.equal(input.value, '中文');
});

test('typing after a session-status repaint uses the refreshed projection cache', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function scheduleSessionStatusRepaint(');
  const end = app.indexOf('\n}', start) + 2;
  const updateStart = app.indexOf('function updateSessionSearchQuery(');
  const updateEnd = app.indexOf('\n}', updateStart) + 2;
  const stats = {};
  const staleRows = [{ key: 'session:1', running: true, context: { percentLeft: 50 } }];
  const freshRows = [{ key: 'session:1', running: false }];
  const state = { stats, period: 'today', breakdown: 'session', sessionSearchQuery: '',
    sessionRowsCache: { stats, period: 'today', rows: staleRows } };
  let timer;
  const rendered = [];
  const dependencies = {
    state, Date, els: { breakdown: { scrollTop: 120 } },
    window: { TokenMonitorSessionLive: {
      nextSessionStatusChangeAt: () => timer ? 0 : Date.now() + 1000
    } },
    stopSessionStatusRepaint: () => {},
    visibleStatsSurface: () => 'main',
    setTimeout: callback => { timer = callback; return 1; },
    sessionRowsForPeriod: () => freshRows,
    renderRows: rows => rendered.push(rows),
    syncSessionSearchChrome: () => {},
    sessionRowsApi: { sessionBreakdownIncomplete: () => false },
    overflowText: { batch: callback => callback() },
    render: () => { assert.fail('the fresh cache should avoid a full render'); }
  };
  const api = Function(...Object.keys(dependencies),
    `let sessionStatusRepaintTimer;\n${app.slice(start, end)}\n${app.slice(updateStart, updateEnd)}
    return { scheduleSessionStatusRepaint, updateSessionSearchQuery };`)(...Object.values(dependencies));

  api.scheduleSessionStatusRepaint({});
  timer();
  assert.equal(rendered[0], freshRows);
  api.updateSessionSearchQuery('review');
  assert.equal(rendered[1], freshRows);
  assert.equal(rendered[1][0].running, false);
  assert.equal(rendered[1][0].context, undefined);
  assert.equal(dependencies.els.breakdown.scrollTop, 0);
});

test('typing filters the cached session rows instead of rebuilding the projection', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function updateSessionSearchQuery(');
  const end = app.indexOf('\n}', start) + 2;
  const stats = {};
  const rows = [{ key: 'session:1' }];
  const state = {
    breakdown: 'session', stats, period: 'today', sessionSearchQuery: '',
    sessionPage: 2, rowSignature: 'previous', sessionRowsCache: { stats, period: 'today', rows }
  };
  const els = { breakdown: { scrollTop: 240 } };
  const calls = [];
  const update = Function('state', 'els', 'sessionRowsApi', 'syncSessionSearchChrome', 'renderRows', 'render', 'overflowText',
    `${app.slice(start, end)}\nreturn updateSessionSearchQuery;`)(
    state, els,
    { sessionBreakdownIncomplete: () => false },
    () => calls.push('sync'),
    (nextRows, options) => calls.push(['rows', nextRows, options]),
    () => calls.push('render'),
    { batch: callback => callback() }
  );

  update('review');
  assert.deepEqual(calls, ['sync', ['rows', rows, { incompleteHint: '', fromSearch: true, reuseToolFilter: true }]]);
  assert.equal(state.sessionSearchQuery, 'review');
  assert.equal(state.sessionPage, 0);
  assert.equal(state.rowSignature, 'previous');
  assert.equal(els.breakdown.scrollTop, 0);
});

test('typing without a valid projection forwards search intent through the full render', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const updateStart = app.indexOf('function updateSessionSearchQuery(');
  const updateEnd = app.indexOf('\n}', updateStart) + 2;
  const renderStart = app.indexOf('\nfunction render(');
  const renderEnd = app.indexOf('\nfunction renderAppContent(', renderStart);
  const state = { breakdown: 'session', stats: {}, period: 'today', sessionSearchQuery: '',
    sessionPage: 2, sessionRowsCache: { stats: {}, period: 'today', rows: [] } };
  const els = { breakdown: { scrollTop: 180 } };
  const calls = [];
  const update = Function('state', 'els', 'renderAppContent', 'pluginViewHost', 'pluginContent',
    `${app.slice(updateStart, updateEnd)}\n${app.slice(renderStart, renderEnd)}\nreturn updateSessionSearchQuery;`)(
    state, els, options => calls.push(options), null, null
  );
  update('review');
  assert.deepEqual(calls, [{ fromSearch: true }]);
  assert.equal(state.sessionPage, 0);
  assert.equal(els.breakdown.scrollTop, 0);
});

test('the search field expands and collapses with reduced-motion support', () => {
  const css = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/styles.css'), 'utf8');
  const hostStart = css.indexOf('.session-search-host {');
  const hostCss = css.slice(hostStart, css.indexOf('\n.session-search {', hostStart));
  const openStart = css.indexOf('.session-search-host.is-open {');
  const openCss = css.slice(openStart, css.indexOf('\n.session-search {', openStart));

  assert.match(hostCss, /height: 0;/);
  assert.match(hostCss, /margin-block: -4px;/);
  assert.match(hostCss, /transition:[\s\S]*?height 200ms cubic-bezier\(0\.22, 1, 0\.36, 1\),/);
  assert.match(openCss, /height: 30px;/);
  assert.match(openCss, /margin-block: -8px 4px;/);
  assert.match(openCss, /pointer-events: auto;/);
  assert.match(css, /:root\[data-reduce-motion="on"\] \.session-search-host \{ transition: none; \}/);
  assert.match(css,
    /@media \(prefers-reduced-motion: reduce\) \{\s*:root:not\(\[data-reduce-motion="off"\]\) \.session-search-host \{ transition: none; \}/);
});

test('search renders reuse matching rows without layout motion or rebuilding tool filters', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('function renderRows(');
  const end = app.indexOf('\n}', start) + 2;
  const policy = require('../../src/electron/renderer/breakdownRenderPolicy');
  const state = { breakdown: 'session', sessionSearchQuery: '', sessionToolFilter: '', sessionPage: 0 };
  const calls = { capture: 0, animate: 0, tools: 0, replace: 0, update: 0 };
  const breakdown = {
    children: [],
    replaceChildren(...children) { this.children = children; calls.replace++; },
    append(child) { this.children.push(child); }
  };
  const noop = () => {};
  const batch = { active: false, calls: 0 };
  let tooltipHold = false;
  const statuses = [];
  const dependencies = {
    state, els: { breakdown }, ...policy,
    sessionTooltipShouldHoldRender: () => tooltipHold,
    sessionSearchQuery: () => state.sessionSearchQuery,
    sessionRowsApi: { filterSessionRows },
    sessionToolClients: row => [row.client, ...(row.groupRows || []).map(member => member.client)],
    renderSessionToolFilter: data => { calls.tools++; return data; },
    renderSessionPager: noop,
    setSessionSearchStatus: (query, count) => statuses.push({ query, count }),
    currentCurrency: () => 'USD',
    currentLocale: () => 'en',
    t: key => key,
    rowRenderFingerprints: new WeakMap(),
    captureBreakdownMotion: () => { calls.capture++; return new Map(); },
    animateBreakdownFrom: () => { calls.animate++; },
    cancelRowNumberAnimation: noop,
    rowTemplate: data => ({
      dataset: { key: data.key },
      classList: { contains: () => false },
      querySelector: () => null
    }),
    updateRow: () => {
      calls.update++;
      assert.equal(batch.active, true);
    },
    renderToolDetailFooter: noop,
    renderProjectBreakdownFooter: noop,
    sessionSearchEmptyNode: query => ({
      query, dataset: {}, classList: { contains: () => false }, querySelector: () => null
    }),
    overflowText: { batch: callback => {
      batch.active = true;
      batch.calls++;
      try { return callback(); } finally { batch.active = false; }
    } }
  };
  const renderRows = Function(...Object.keys(dependencies),
    `${app.slice(start, end)}\nreturn renderRows;`)(...Object.values(dependencies));
  const data = [
    { key: 'review', name: 'Review PR', client: 'codex', value: 100 },
    { key: 'release', name: 'Release notes', client: 'claude', value: 50 },
    { key: 'group', name: 'Review group', client: 'claude', value: 25, groupRows: [{ client: 'codex' }] }
  ];

  renderRows(data);
  assert.equal(calls.capture, 1);
  assert.equal(calls.animate, 1);
  assert.equal(calls.tools, 1);
  assert.equal(batch.calls, 1);
  const retained = breakdown.children[0];

  tooltipHold = true;
  state.sessionSearchQuery = 'review';
  state.sessionToolFilter = 'codex';
  renderRows(data);
  assert.equal(breakdown.children.length, 3);
  assert.equal(statuses.at(-1).query, '');

  renderRows(data, { fromSearch: true, reuseToolFilter: true });
  assert.deepEqual(breakdown.children.map(row => row.dataset.key), ['review', 'group']);
  assert.deepEqual(statuses.at(-1), { query: 'review', count: 2 });
  assert.equal(breakdown.children[0], retained);
  assert.equal(calls.capture, 1);
  assert.equal(calls.animate, 1);
  assert.equal(calls.tools, 1);
  assert.equal(batch.calls, 2);

  const replacements = calls.replace;
  const updates = calls.update;
  state.sessionSearchQuery = 'REVIEW';
  renderRows(data, { fromSearch: true, reuseToolFilter: true });
  assert.equal(calls.replace, replacements);
  assert.equal(calls.update, updates);

  state.sessionSearchQuery = 'not found';
  renderRows(data, { fromSearch: true, reuseToolFilter: true });
  assert.equal(breakdown.children.length, 1);
  assert.equal(breakdown.children[0].query, 'not found');
  state.sessionSearchQuery = '';
  state.sessionToolFilter = '';
  renderRows(data, { fromSearch: true, reuseToolFilter: true });
  assert.equal(breakdown.children.length, 3);
  assert.equal(calls.capture, 1);
  assert.equal(calls.animate, 1);
  assert.equal(calls.tools, 1);
  assert.equal(batch.calls, 4);

  renderRows(data, { fromSearch: true });
  assert.equal(calls.tools, 2);
  assert.equal(calls.capture, 1);
  assert.equal(calls.animate, 1);
});
