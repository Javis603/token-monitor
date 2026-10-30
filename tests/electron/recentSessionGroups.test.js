'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const presentation = require('../../src/electron/renderer/edgeDock/presentation');
const sessionLive = require('../../src/shared/sessionLive');
const { sessionRowsForPeriod, groupSessionRows } = require('../../src/electron/renderer/sessionRows');

function session(client, sessionId, extra = {}) {
  return { client, sessionId, title: sessionId, totalTokens: 100, costUsd: 1,
    models: { shared: 100 }, lastUsedAt: new Date(Date.now() - 1000).toISOString(), ...extra };
}
function fixture() {
  const parent = session('codex', 'same', { turnEnded: true, lastUsedAt: new Date(Date.now() - 3_600_000).toISOString(),
    contextTokens: 10, contextWindow: 100 });
  const child = session('claude', 'same', { parentClient: 'codex', parentSessionId: 'same',
    models: { shared: 60, other: 40 }, unpricedTokens: 30, contextTokens: 80, contextWindow: 100 });
  const nested = session('codex', 'nested', { parentClient: 'claude', parentSessionId: 'same' });
  return { periods: { month: { sessions: { 'codex:same': parent, 'claude:same': child, 'codex:nested': nested } },
    today: { sessions: { 'claude:same': child } } } };
}

test('cross-client families group before caps and running filters and sum each accounting identity once', () => {
  const stats = fixture();
  const original = JSON.stringify(stats);
  for (const options of [{}, { includeRunningBeyondCap: true }, { runningOnly: true }]) {
    const rows = presentation.recentSessionRows(stats, 1, options);
    assert.equal(rows.length, 1);
    const group = rows[0];
    assert.equal(group.key, 'session-group:subagents:codex:same');
    assert.equal(group.client, 'codex');
    assert.equal(group.totalTokens, 300);
    assert.equal(group.costUsd, 3);
    assert.equal(group.unpricedTokens, 30);
    assert.deepEqual(group.models, { shared: 260, other: 40 });
    assert.equal(group.groupRows[0].key, 'codex:same');
    assert.equal(new Set(group.groupRows.map(row => row.key)).size, 3);
    assert.equal(presentation.runningSessionSummary(rows).count, 1, 'visible family counts once');
    assert.equal(presentation.sessionActivityState(group), 'running', 'idle parent retains active child');
    assert.equal(group.context, null);
    assert.equal(group.promptCache, null);
  }
  assert.equal(JSON.stringify(stats), original, 'presentation never inserts synthetic accounting records');
});

test('group activity and expiry re-read every member instead of the idle parent or latest group timestamp', () => {
  const stats = fixture();
  delete stats.periods.month.sessions['codex:nested'];
  const child = stats.periods.month.sessions['claude:same'];
  const now = Date.now();
  child.lastUsedAt = new Date(now - sessionLive.RUNNING_WINDOW_MS + 1000).toISOString();
  const [group] = presentation.recentSessionRows(stats);
  const expiry = Date.parse(child.lastUsedAt) + sessionLive.RUNNING_WINDOW_MS + 1;
  assert.equal(presentation.nextRunningExpiryAt([group], now), expiry);
  assert.equal(presentation.runningSessionSummary([group], expiry).count, 0);
  assert.equal(presentation.sessionActivityState(group, expiry), 'idle');
  group.groupRows[1].liveActivity = { state: 'waiting', source: 'test', observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 5000).toISOString() };
  assert.equal(presentation.waitingSessionSummary([group], now).count, 1);
  assert.equal(presentation.nextRunningExpiryAt([group], expiry), now + sessionLive.LIVE_ACTIVITY_TTL_MS);
});

test('running tool marks follow live members and their leases rather than the family parent', () => {
  const stats = fixture();
  delete stats.periods.month.sessions['codex:nested'];
  const [group] = presentation.recentSessionRows(stats);
  const now = Date.now();
  assert.deepEqual(presentation.runningSessionSummary([group], now).clients, ['claude']);
  group.groupRows[0].liveActivity = { state: 'running', source: 'test', observedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + 1000).toISOString() };
  assert.deepEqual(presentation.runningSessionSummary([group], now).clients, ['codex', 'claude']);
  assert.deepEqual(presentation.runningSessionSummary([group], now + sessionLive.LIVE_ACTIVITY_TTL_MS).clients, ['claude']);
  assert.equal(presentation.runningSessionSummary([group], now).count, 1);
});

test('accounting and native session builders use full client/id for parent links and reject true self links', () => {
  const parent = session('codex', 'same');
  const child = session('claude', 'same', { parentClient: 'codex', parentSessionId: 'same' });
  const self = session('codex', 'self', { parentSessionId: 'self' });
  for (const native of [false, true]) {
    const sessions = { 'codex:same': parent, 'claude:same': child, 'codex:self': self };
    const rows = sessionRowsForPeriod(native ? {} : { sessions }, native ? { nativeSessions: sessions } : {});
    assert.equal(rows.find(row => row.key === 'session:claude:same').parentKey, 'session:codex:same');
    assert.equal(rows.find(row => row.key === 'session:codex:self').parentKey, undefined);
    assert.equal(rows.find(row => row.key === 'session:codex:self').subagent, undefined);
    const grouped = groupSessionRows(rows);
    assert.equal(grouped.find(row => row.subagentGroup).value, 200);
    assert.equal(grouped.length, 2);
  }
});

test('native zero-token idle parent can anchor a linked active child without extra accounting records', () => {
  const child = session('claude', 'child', { parentClient: 'codex', parentSessionId: 'parent' });
  const stats = { periods: { month: { sessions: { 'claude:child': child } } }, nativeSessions: { today: {
    'codex:parent': session('codex', 'parent', { totalTokens: 0, costUsd: 0, models: {}, turnEnded: true })
  } } };
  const [group] = presentation.recentSessionRows(stats, 1, { runningOnly: true });
  assert.equal(group.key, 'session-group:subagents:codex:parent');
  assert.equal(group.totalTokens, 100);
  assert.equal(group.groupRows.length, 2);
  assert.equal(group.groupRows[0].key, 'codex:parent');
  assert.equal(group.groupRows[0].totalTokens, 0);
});

test('global reviews stay excluded and Grok bots keep their global group outside ordinary parent families', () => {
  const stats = fixture();
  stats.periods.month.sessions['codex:review'] = session('codex', 'review', {
    parentSessionId: 'same', sessionKind: 'background-review' });
  stats.periods.month.sessions['cursor:bot1'] = session('cursor', 'bot1', {
    parentClient: 'codex', parentSessionId: 'same', models: { 'grok-bot-automation': 100 }, turnEnded: false });
  stats.periods.month.sessions['cursor:bot2'] = session('cursor', 'bot2', {
    parentClient: 'codex', parentSessionId: 'same', models: { 'grok-bot-automation': 100 } });
  const rows = presentation.recentSessionRows(stats, 1, { includeRunningBeyondCap: true });
  assert.equal(rows.length, 2);
  const bot = rows.find(row => row.sessionGroup === 'cursor-grok-bot');
  assert.equal(bot.totalTokens, 200);
  assert.deepEqual(bot.models, { 'grok-bot-automation': 200 });
  assert.equal(rows.find(row => row.subagentGroup).totalTokens, 300);
  assert.equal(presentation.runningSessionSummary(rows).count, 2);
  assert.equal(presentation.sessionMembers(rows).some(row => row.sessionId === 'review'), false);
});

class Node {
  constructor(tag, className = '', text = '') {
    this.tagName = tag; this.className = className; this.textContent = text;
    this.children = []; this.dataset = {}; this.attributes = {}; this.handlers = {};
    this.isConnected = true;
    this.classList = { add() {}, toggle() {} };
    this.style = { setProperty() {} };
  }
  append(...nodes) { this.children.push(...nodes); }
  replaceChildren(...nodes) { this.children = nodes; }
  setAttribute(name, value) { this.attributes[name] = value; }
  addEventListener(name, callback) { this.handlers[name] = callback; }
  get childElementCount() { return this.children.length; }
}

const fs = require('node:fs');
const path = require('node:path');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const dock = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/edgeDock/dock.js'), 'utf8');
const rowApi = require('../../src/electron/renderer/sessionRows');

function translate(key, params) {
  if (key === 'sessions.subagentCount') return `${params.count} subagents`;
  if (key === 'session.cacheEstimate') return `Cache ${params.minutes}m`;
  return key;
}

function incumbentOptions(stats) {
  const { CLIENT_LABELS } = require('../../src/shared/clientCatalog');
  const { clientColors } = require('../../src/electron/renderer/usageCharts');
  const { translate: localize } = require('../../src/electron/renderer/i18n');
  const source = app.slice(app.indexOf('function sessionPresentationOptions()'), app.indexOf('function rawSessionRowsForPeriod('));
  return Function('clientLabels', 'clientColors', 'modelColor', 'stableColor', 'fallbackModelColors', 't',
    'state', 'formatCompact', 'effectiveCompactTokenUnits', 'currentLocale', `${source}; return sessionPresentationOptions();`)(
    CLIENT_LABELS, clientColors, () => '', () => '', [], (key, params) => localize('zh-TW', key, params),
    { stats, period: 'month' }, String, () => '', () => 'zh-TW'
  );
}

function renderStatusGroup(group, metric = 'used') {
  const document = { createElement: tag => new Node(tag), createTextNode: text => new Node('text', '', text) };
  const state = { settings: { sessionContextMetric: metric } };
  const shellSource = app.slice(app.indexOf('function homeModuleShell('), app.indexOf('function homeLimitRows('));
  const contextSource = app.slice(app.indexOf('function homeSessionContext('), app.indexOf('function stopHomeSessionRepaint('));
  const homeSource = app.slice(app.indexOf('function renderHomeSessionModule('), app.indexOf('function renderHomeDeviceModule()'));
  const tooltip = { setDetailTooltip() {} };
  const home = Function('document', 'window', 'state', 'els', 'pluginContent', 'sessionTooltipShouldHoldRender',
    'renderBreakdownChange', 'VIEW_ICON_CLASSES', 't', 'applyHomeListMark', 'iconKindFor', 'clientColors', 'stableColor', 'fallbackModelColors',
    'bindHoverMarquee', 'formatCompact', 'homeSessionAgo', 'sessionRowsApi', 'limitWindowsView',
    `${shellSource}; ${contextSource}; ${homeSource}; return renderHomeSessionModule;`)(
    document, { TokenMonitorEdgeDockPresentation: presentation, TokenMonitorSessionLive: sessionLive },
    state, { homePanel: { children: [], querySelector: () => null } }, null, () => false,
    () => {}, {}, translate, () => {}, () => '', {}, () => '', [], () => {}, String, () => '', rowApi, tooltip
  )([group]);
  const dockContext = dock.slice(dock.indexOf('function contextNode('), dock.indexOf('// Last activity seen'));
  const dockSource = dock.slice(dock.indexOf('const expandedSessionGroups ='), dock.indexOf('function providerCard('));
  const card = Function('document', 'presentation', 'sessionKey', 'el', 't', 'stateMark', 'overflowText',
    'clientLabel', 'sessionRowsApi', 'relativeAgo', 'limitWindowsView', 'sessionLive', 'appearance',
    'formatBreakdownTokens', 'state', 'surface', 'renderBubble', 'markNode',
    `${dockContext}; ${dockSource}; return sessionsContainer;`)(
    document, presentation, row => row.key, (tag, cls, text) => new Node(tag, cls, text), translate,
    () => new Node('span'), { bind() {} }, value => value, rowApi, () => '', tooltip, sessionLive,
    () => ({ sessionContextMetric: metric }), String, { payload: { cell: { id: 'sessions' } } },
    'bubble', () => {}, () => new Node('span')
  )([group]);
  return { home: home.children[1].children[0], dock: card.children.at(-1).children[0].children[0] };
}

test('Home and Dock retain the latest main gauge and cache snapshot without aggregating child readings', () => {
  const now = Date.now();
  const stats = fixture();
  const parent = stats.periods.month.sessions['codex:same'];
  Object.assign(parent, { lastUsedAt: new Date(now - 1000).toISOString(), contextTokens: 30, contextWindow: 100,
    promptCache: { observedAt: new Date(now - 60_000).toISOString(), ttlSeconds: 1800 } });
  const child = stats.periods.month.sessions['claude:same'];
  child.promptCache = { observedAt: new Date(now).toISOString(), ttlSeconds: 300 };
  const original = JSON.stringify(stats);
  const [group] = presentation.recentSessionRows(stats);
  assert.equal(group.context.percentUsed, 30);
  assert.equal(group.contextTokens, 30);
  assert.equal(group.contextWindow, 100);
  assert.deepEqual(group.promptCache, parent.promptCache);
  for (const [metric, percent] of [['used', '30%'], ['remaining', '70%']]) {
    const rendered = renderStatusGroup(group, metric);
    for (const [surface, row] of Object.entries(rendered)) {
      const meta = row.children.find(node => node.className === `${surface === 'home' ? 'home' : 'edge-dock'}-session-meta`);
      const gauge = meta.children.find(node => node.className.endsWith('-session-context'));
      assert.ok(gauge, `${surface} group keeps the main gauge`);
      assert.equal(gauge.children.at(-1).textContent, percent);
      assert.equal(meta.children.some(node => node.className.endsWith('-session-cache')), false);
    }
  }
  // Child writes do not extend the main's context freshness or revive a
  // legacy Codex countdown through the child's supported Claude estimate.
  group.groupRows[0].lastUsedAt = new Date(now - sessionLive.RUNNING_WINDOW_MS - 1).toISOString();
  assert.equal(presentation.sessionActivityState(group), 'running');
  assert.equal(sessionLive.sessionPromptCacheForRow(group.groupRows[0]), null);
  for (const [surface, row] of Object.entries(renderStatusGroup(group))) {
    const meta = row.children.find(node => node.className === `${surface === 'home' ? 'home' : 'edge-dock'}-session-meta`);
    assert.equal(meta.children.some(node => node.className.endsWith('-session-context')), false);
    const badge = meta.children.find(node => node.className.endsWith('-session-cache'));
    assert.equal(badge, undefined, `${surface} hides the legacy Codex cache and does not borrow the child's`);
  }
  assert.equal(JSON.stringify(stats), original);
});

test('a newer main continuation replaces status snapshots instead of retaining an older gauge or child cache', () => {
  const stats = fixture();
  stats.periods.month.sessions['codex:same'].t3ThreadId = 'main-app';
  const newer = session('claude', 'continuation', { t3ThreadId: 'main-app',
    lastUsedAt: new Date().toISOString(), contextTokens: 55, contextWindow: 100,
    promptCache: { observedAt: new Date().toISOString(), ttlSeconds: 300 } });
  stats.periods.month.sessions['claude:continuation'] = newer;
  const [group] = presentation.recentSessionRows(stats);
  assert.equal(group.groupRows[0].key, 'claude:continuation');
  assert.equal(group.context.percentUsed, 55);
  assert.deepEqual(group.promptCache, newer.promptCache);
  assert.equal(group.subagentCount, 2);
  assert.equal(group.totalTokens, 400);
});

test('recent groups resolve to Sessions detail with incumbent tool names, colors and localized counts', () => {
  const stats = fixture();
  const opts = incumbentOptions(stats);
  const [family] = presentation.recentSessionRows(stats, Infinity, opts);
  const details = () => {
    const options = incumbentOptions(stats);
    return groupSessionRows(sessionRowsForPeriod(stats.periods.month, options), options);
  };
  const familyDetail = details().find(row => row.key === family.key);
  const child = familyDetail.groupRows.find(row => row.client === 'claude');
  assert.equal(child.clientLabel, opts.clientLabels.claude);
  assert.equal(child.color, opts.clientColors.claude);
  assert.equal(familyDetail.groupDetail, opts.subagents.countLabel(2));
  const parent = stats.periods.month.sessions['codex:same'];
  parent.tokenDataUnavailable = true;
  parent.totalTokens = 0;
  parent.costUsd = 0;
  parent.models = {};
  stats.nativeSessions = { month: { 'codex:same': parent } };
  delete stats.periods.month.sessions['codex:same'];
  const [nativeFamily] = presentation.recentSessionRows(stats, Infinity, incumbentOptions(stats));
  const nativeDetail = details().find(row => row.key === nativeFamily.key);
  assert.equal(nativeDetail.groupRows[0].clientLabel, opts.clientLabels.codex);
  assert.equal(nativeDetail.groupRows[0].color, opts.clientColors.codex);
  stats.periods.month.sessions = { ...stats.periods.month.sessions };
  stats.periods.month.sessions['cursor:bot1'] = session('cursor', 'bot1', { models: { 'grok-bot-automation': 100 } });
  stats.periods.month.sessions['cursor:bot2'] = session('cursor', 'bot2', { models: { 'grok-bot-automation': 100 } });
  const bot = presentation.recentSessionRows(stats, Infinity, incumbentOptions(stats)).find(row => row.sessionGroup === 'cursor-grok-bot');
  const botDetail = details().find(row => row.key === bot.key);
  assert.equal(botDetail.detail, opts.grokBot.countLabel(2));
  assert.notEqual(botDetail.detail, '2 activity records');
});

test('Home keeps family membership below the title and routes mouse and keyboard activation to the Sessions list', () => {
  const stats = fixture();
  const opts = incumbentOptions(stats);
  const group = presentation.recentSessionRows(stats, Infinity, opts)[0];
  const shellSource = app.slice(app.indexOf('function homeModuleShell('), app.indexOf('function homeLimitRows('));
  const source = app.slice(app.indexOf('function renderHomeSessionModule('), app.indexOf('function renderHomeDeviceModule()'));
  for (const keyboard of [false, true]) for (const periodMode of ['month', 'last30']) {
    const state = { stats, period: 'today', breakdown: 'home', openSession: null, settings: { periodMonthMode: periodMode } };
    const routes = [];
    const readingTargets = [];
    const renderHomeSessionModule = Function('document', 'window', 'state', 'els', 'pluginContent', 'sessionTooltipShouldHoldRender',
      'renderBreakdownChange', 'VIEW_ICON_CLASSES', 't', 'applyHomeListMark', 'iconKindFor', 'clientColors', 'stableColor', 'fallbackModelColors',
      'bindHoverMarquee', 'formatCompact', 'homeSessionAgo', 'sessionRowsApi', 'limitWindowsView', 'homeSessionContext',
      'sessionPresentationOptions', 'homeModulePreferencesApi', `${shellSource}; ${source}; return renderHomeSessionModule;`)(
      { createElement: tag => new Node(tag), createTextNode: text => new Node('text', '', text) },
      { TokenMonitorEdgeDockPresentation: presentation, TokenMonitorSessionLive: sessionLive },
      state, { homePanel: { children: [], querySelector: () => null } }, null, () => false,
      (view, options) => { routes.push([view, options]); state.breakdown = view; }, {}, translate,
      () => {}, () => '', {}, () => '', [], node => readingTargets.push(node), String, () => 'just now',
      rowApi, { setDetailTooltip() {} }, () => assert.fail('group context must be absent'), () => opts, require('../../src/electron/renderer/homeModulePreferences')
    );
    const module = renderHomeSessionModule();
    const row = module.children[1].children[0];
    const title = row.children.find(node => node.className === 'home-list-name');
    const meta = row.children.find(node => node.className === 'home-session-meta');
    assert.equal(readingTargets[0], title, 'the whole title retains incumbent overflow reading');
    assert.equal(title.textContent, group.title);
    assert.equal(title.children.length, 0, 'membership never consumes title width');
    const description = meta.children[0];
    const countIndex = description.children.findIndex(node => node.className === 'home-session-member-count');
    const modelIndex = description.children.findIndex(node => node.className === 'session-model-metadata'
      && node.children[0]?.textContent === rowApi.sessionModelLabel(group));
    assert.ok(modelIndex >= 0 && countIndex > modelIndex, 'models precede membership like Sessions');
    assert.equal(description.children[countIndex].textContent, '2 subagents');
    assert.equal(description.children.at(-1).textContent, ' · just now');
    assert.equal(row.attributes.role, undefined, 'rows do not create nested navigation buttons');
    assert.equal(row.handlers.click, undefined);
    assert.equal(row.dataset.key, group.key);
    let prevented = false;
    module.handlers[keyboard ? 'keydown' : 'click']({
      target: keyboard ? module : { closest: () => null }, key: 'Enter',
      preventDefault() { prevented = true; }
    });
    assert.equal(prevented, keyboard);
    assert.deepEqual(routes, [['session', { fromHome: true }]]);
    assert.equal(state.breakdown, 'session');
    assert.equal(state.period, 'today', 'Home navigation preserves the selected period');
    assert.equal(state.openSession, null, 'activation opens the list rather than a group detail');
  }
});

test('Dock family expansion keeps real member rows and requests the existing native bubble size handshake', () => {
  const group = presentation.recentSessionRows(fixture())[0];
  const source = dock.slice(dock.indexOf('const expandedSessionGroups ='), dock.indexOf('function providerCard('));
  const payload = { cell: { id: 'sessions' } };
  const resized = [];
  const build = Function('document', 'presentation', 'sessionKey', 'el', 't', 'stateMark', 'overflowText',
    'clientLabel', 'sessionRowsApi', 'relativeAgo', 'limitWindowsView', 'contextNode', 'sessionLive',
    'formatBreakdownTokens', 'state', 'surface', 'renderBubble', 'markNode', 'appearance', `${source}; return sessionsContainer;`)(
    { createTextNode: text => new Node('text', '', text), createElement: tag => new Node(tag) }, presentation, row => row.key,
    (tag, className, text) => new Node(tag, className, text), translate, () => new Node('span'), { bind() {} },
    value => value, rowApi, () => '', { setDetailTooltip() {} }, () => null, sessionLive, String,
    { payload }, 'bubble', value => resized.push(value), () => new Node('span'), () => ({})
  );
  const list = build([group]);
  const family = list.children.at(-1).children[0];
  const summary = family.children[0];
  assert.equal(family.tagName, 'details');
  assert.equal(summary.tagName, 'summary');
  assert.equal(summary.attributes.role, 'button');
  assert.equal(summary.attributes['aria-expanded'], 'false');
  const titleLine = summary.children[0];
  const description = summary.children[2].children[0];
  assert.equal(titleLine.children.some(node => node.className === 'edge-dock-session-disclosure'), false,
    'group titles retain the ordinary session row layout without an extra arrow column');
  assert.equal(titleLine.children.some(node => node.className === 'edge-dock-session-member-count'), false);
  assert.equal(description.className, 'edge-dock-session-description');
  const countIndex = description.children.findIndex(node => node.className === 'edge-dock-session-member-count');
  const modelIndex = description.children.findIndex(node => node.className === 'session-model-metadata'
    && node.children[0]?.textContent === rowApi.sessionModelLabel(group));
  assert.ok(modelIndex >= 0 && countIndex > modelIndex, 'models precede membership like Sessions');
  assert.equal(description.children[countIndex].textContent, '2 subagents');
  assert.equal(family.children[1].children.at(-1).children.length, 3, 'members retain individual navigable expansion rows');
  family.open = true;
  family.handlers.toggle();
  assert.deepEqual(resized, [payload]);
  assert.equal(summary.attributes['aria-expanded'], 'true');
  assert.equal(build([group]).children.at(-1).children[0].open, true, 'expansion survives a repaint');
  family.isConnected = false;
  family.open = false;
  family.handlers.toggle();
  assert.equal(resized.length, 1, 'detached old nodes cannot collapse fresh state');
});

test('native activity overlay retains archived accounting tokens, costs and models when a family resumes', () => {
  const parent = session('codex', 'parent', { archived: true, totalTokens: 900, costUsd: 9, models: { prior: 900 } });
  const stats = { periods: { month: { sessions: { 'codex:parent': parent,
    'claude:child': session('claude', 'child', { parentClient: 'codex', parentSessionId: 'parent' }) } } },
    nativeSessions: { today: { 'codex:parent': session('codex', 'parent', { totalTokens: 0, costUsd: 0, models: {} }) } } };
  const [group] = presentation.recentSessionRows(stats);
  assert.equal(group.totalTokens, 1000);
  assert.equal(group.costUsd, 10);
  assert.deepEqual(group.models, { prior: 900, shared: 100 });
  assert.equal(presentation.runningSessionSummary([group]).count, 1);
});

test('provider cards retain complete cross-client families under the parent provider before applying their cap', () => {
  const stats = fixture();
  const quota = { provider: 'codex', status: 'ok', windows: [{ name: 'Session', usedPercent: 10 }] };
  const providerStats = { ...stats, limits: { providers: [quota] } };
  const cards = presentation.buildEdgeDockCells(providerStats, { items: [{ type: 'limit', provider: 'codex' }] });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].sessions.length, 1);
  assert.equal(cards[0].sessions[0].groupRows.length, 3);
  assert.equal(cards[0].sessions[0].totalTokens, 300);
});

test('resumed archived child preserves its accounting parent unless native metadata supplies a newer link', () => {
  const stats = fixture();
  delete stats.periods.month.sessions['codex:nested'];
  delete stats.periods.today;
  const child = stats.periods.month.sessions['claude:same'];
  child.archived = true;
  stats.nativeSessions = { today: { 'claude:same': session('claude', 'same', { totalTokens: 0, costUsd: 0, models: {} }) } };
  const [family] = presentation.recentSessionRows(stats);
  assert.equal(family.subagentGroup, true);
  assert.equal(family.totalTokens, 200);
  assert.equal(family.costUsd, 2);
  assert.deepEqual(presentation.runningSessionSummary([family]).clients, ['claude']);
  stats.nativeSessions.today['claude:same'].parentSessionId = 'new-parent';
  const rows = presentation.recentSessionRows(stats);
  assert.equal(rows.length, 2);
  assert.equal(rows.find(row => row.client === 'claude').parentSessionId, 'new-parent');
});

test('Home session navigation uses the incumbent module action without a second heading or row action', () => {
  const source = app.slice(app.indexOf('function homeModuleShell('), app.indexOf('function homeLimitRows('));
  const routes = [];
  const shell = Function('document', 'els', 'pluginContent', 'renderBreakdownChange', 'VIEW_ICON_CLASSES', `${source}; return homeModuleShell;`)(
    { createElement: tag => new Node(tag) }, { homePanel: { children: [] } }, null, (...args) => routes.push(args), {}
  );
  const { module } = shell('session', 'Sessions', 'session');
  const head = module.children[0];
  assert.equal(module.attributes.role, 'button');
  assert.equal(module.tabIndex, 0);
  assert.equal(head.attributes.role, undefined);
  assert.equal(head.tabIndex, undefined);
  module.handlers.keydown({ target: module, key: ' ', preventDefault() {} });
  assert.deepEqual(routes, [['session', { fromHome: true }]]);
  module.handlers.keydown({ target: new Node('div'), key: 'Enter', preventDefault() {} });
  assert.equal(routes.length, 1, 'unrelated nested keyboard events do not trigger navigation');
  assert.equal(shell('model', 'Models', 'model').module.attributes.role, 'button');
});

test('Dock projects once per update for Sessions and multiple provider cards and recomputes activity on the next update', () => {
  const vm = require('node:vm');
  const filename = path.join(__dirname, '../../src/electron/renderer/edgeDock/presentation.js');
  const load = require('node:module').createRequire(filename);
  let projections = 0;
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module,
    require(id) {
      const api = load(id);
      if (id !== '../sessionRows') return api;
      return { ...api,
        sessionRowsForPeriod() { assert.fail('Dock must not build session detail DTOs'); },
        groupSessionRows(...args) { projections += 1; return api.groupSessionRows(...args); }
      };
    }
  });
  const stats = fixture();
  const config = { items: [{ type: 'stat', metric: 'sessions', runningOnly: true },
    { type: 'limit', provider: 'codex' }, { type: 'limit', provider: 'claude' }] };
  const cells = module.exports.buildEdgeDockCells(stats, config);
  assert.equal(projections, 1);
  assert.equal(cells[0].sessions[0], cells[1].sessions[0], 'cards share the complete family projection');
  assert.equal(cells[0].sessions[0].summary, undefined, 'detail DTOs stay out of the Dock IPC payload');
  stats.periods = { month: { sessions: Object.fromEntries(Object.entries(stats.periods.month.sessions)
    .map(([key, row]) => [key, { ...row, turnEnded: true }])) } };
  const next = module.exports.buildEdgeDockCells(stats, config);
  assert.equal(projections, 2, 'even the same stats object is projected again on a new update');
  assert.equal(next[0].sessions.length, 0, 'running-only selection observes changed member activity');
});

test('Dock retains child activity flare history and scopes expansion pruning to each card', () => {
  const group = presentation.recentSessionRows(fixture())[0];
  const activity = dock.slice(dock.indexOf('const lastActivityBySession ='), dock.indexOf('function sessionsNode('));
  const activityApi = Function('presentation', 'sessionKey', 'el', 't', 'SESSION_STATE_GLYPHS', `${activity}; return { stateMark, pruneActivity };`)(
    presentation, row => row.key, (tag, cls) => {
      const node = new Node(tag, cls);
      node.classList.add = value => { node.className += ` ${value}`; };
      return node;
    }, translate, ''
  );
  const child = group.groupRows.find(row => row.client === 'claude');
  assert.doesNotMatch(activityApi.stateMark(child, child.key, 'running').className, /pulse/);
  activityApi.pruneActivity([group]);
  const updated = { ...child, lastUsedAt: new Date(Date.parse(child.lastUsedAt) + 1).toISOString() };
  assert.match(activityApi.stateMark(updated, child.key, 'running').className, /pulse/);

  const expansion = dock.slice(dock.indexOf('const expandedSessionGroups ='), dock.indexOf('function sessionsContainer('));
  const state = { payload: { cell: { id: 'sessions' } } };
  const api = Function('state', 'sessionKey', `${expansion}; return { expandedSessionGroups, sessionGroupExpansionKey, pruneSessionGroupExpansion };`)(state, row => row.key);
  const sessionsKey = api.sessionGroupExpansionKey(group.key);
  api.expandedSessionGroups.add(sessionsKey);
  state.payload.cell.id = 'limit:codex';
  const providerKey = api.sessionGroupExpansionKey(group.key);
  api.expandedSessionGroups.add(providerKey);
  api.pruneSessionGroupExpansion([]);
  assert.equal(api.expandedSessionGroups.has(providerKey), false, 'provider-only cards retire absent groups');
  api.expandedSessionGroups.add(providerKey);
  const providerSessions = dock.slice(dock.indexOf('function sessionsNode('), dock.indexOf('const expandedSessionGroups ='));
  const sessionsNode = Function('pruneActivity', 'pruneSessionGroupExpansion', 'sessionsContainer', 't', `${providerSessions}; return sessionsNode;`)(
    () => {}, api.pruneSessionGroupExpansion, () => assert.fail('empty provider lists render no container'), translate
  );
  assert.equal(sessionsNode([]), null);
  assert.equal(api.expandedSessionGroups.has(providerKey), false, 'empty provider cards prune before returning');
  assert.equal(api.expandedSessionGroups.has(sessionsKey), true, 'another card keeps its own expansion');
  state.payload.cell.id = 'sessions';
  api.pruneSessionGroupExpansion([group]);
  assert.equal(api.expandedSessionGroups.has(sessionsKey), true);
  api.pruneSessionGroupExpansion([]);
  assert.equal(api.expandedSessionGroups.size, 0);
});

const NATIVE_MAIN = '01a128e7-84b0-7443-9d1d-af0368c81583';
const NATIVE_CHILD = '01a1296b-e500-7b51-82c8-169dec45b59c';
function continuations() {
  const rows = [
    session('codex', 'rollout-1', { nativeSessionId: NATIVE_MAIN, turnEnded: true, lastUsedAt: '2026-01-01T00:00:00Z' }),
    session('codex', 'rollout-2', { nativeSessionId: NATIVE_MAIN, title: 'Current main', liveActivity: { state: 'running', source: 'test', observedAt: new Date().toISOString() } }),
    session('codex', 'child-1', { nativeSessionId: NATIVE_CHILD, parentSessionId: 'rollout-1', turnEnded: true }),
    session('codex', 'child-2', { nativeSessionId: NATIVE_CHILD, parentSessionId: 'rollout-2', turnEnded: true }),
    session('claude', 'review', { parentClient: 'codex', parentSessionId: 'rollout-1', turnEnded: true })
  ];
  return { periods: { today: { sessions: Object.fromEntries(rows.map(row => [`${row.client}:${row.sessionId}`, row])) } } };
}
test('all surfaces collapse verified continuations, count logical subagents and preserve every accounting member and main role', () => {
  const stats = continuations(); const original = JSON.stringify(stats);
  const sessions = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(sessions.length, 1);
  const group = sessions[0];
  assert.equal(group.value, 500);
  assert.equal(group.cost, 5);
  assert.equal(group.subagentCount, 2, 'two child rollouts count as one delegated conversation');
  assert.equal(group.name, 'Current main');
  assert.equal(group.running, true);
  assert.equal(group.groupRows.length, 5);
  assert.equal(group.groupRows.filter(row => row.groupRole === 'main').length, 2);
  assert.equal(group.key, `session-group:subagents:codex:${NATIVE_MAIN}`);
  const [recent] = presentation.recentSessionRows(stats, 1, { runningOnly: true });
  assert.equal(recent.key, group.key);
  assert.equal(recent.totalTokens, 500);
  assert.equal(recent.subagentCount, 2);
  assert.equal(new Set(recent.groupRows.map(row => row.key)).size, 5);
  assert.equal(recent.groupRows.filter(row => row.groupRole === 'main').length, 2);
  assert.equal(JSON.stringify(stats), original);
});
test('continuation-only families never claim subagents; unknown identities and identical titles remain separate', () => {
  const stats = continuations(); delete stats.periods.today.sessions['codex:child-1']; delete stats.periods.today.sessions['codex:child-2']; delete stats.periods.today.sessions['claude:review'];
  const [group] = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(group.subagentCount, 0); assert.equal(group.subagentCountLabel, '');
  assert.equal(group.groupRows.every(row => row.groupRole === 'main'), true);
  delete stats.periods.today.sessions['codex:rollout-2'].nativeSessionId;
  assert.equal(groupSessionRows(sessionRowsForPeriod(stats.periods.today)).length, 2);
});
test('links to any visible continuation work with missing earliest records; native relationship conflicts and cycles stay bounded', () => {
  const stats = continuations(); delete stats.periods.today.sessions['codex:rollout-1'];
  // The old parent is genuinely absent; its orphans remain separate.
  const rows = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), 400);
  const family = rows.find(row => row.subagentGroup);
  assert.equal(family.subagentCount, 1);
  assert.equal(family.groupRows.length, 2, 'an unverifiable orphan link does not override a visible relationship');
  const cycle = { sessions: { 'codex:a': session('codex', 'a', { parentSessionId: 'b' }), 'codex:b': session('codex', 'b', { parentSessionId: 'a' }) } };
  assert.equal(groupSessionRows(sessionRowsForPeriod(cycle)).reduce((sum, row) => sum + row.value, 0), 200);
});

test('contradictory native alias parent links keep each record with its proven parent without losing usage', () => {
  const stats = continuations();
  stats.periods.today.sessions['codex:other-parent'] = session('codex', 'other-parent');
  stats.periods.today.sessions['codex:child-2'].parentSessionId = 'other-parent';
  const rows = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(rows.length, 2);
  assert.equal(rows.reduce((sum, row) => sum + row.value, 0), 600);
  assert.equal(new Set(rows.flatMap(row => row.groupRows || [row]).map(row => row.key)).size, 6);
});

test('group title and supporting detail both follow the latest main continuation', () => {
  const stats = continuations();
  const old = stats.periods.today.sessions['codex:rollout-1'];
  const latest = stats.periods.today.sessions['codex:rollout-2'];
  old.title = '';
  let [group] = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(group.name, 'Current main');
  assert.equal(group.detail, '', 'a titled latest row uses its activity line instead of the old ID');
  old.title = 'Old main'; latest.title = '';
  [group] = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  const display = group.groupRows.find(row => row.key === 'session:codex:rollout-2');
  assert.equal(group.activity, undefined);
  assert.equal(group.detail, display.detail, 'an untitled latest row keeps its own ID');
});

test('a link between continuations of the same native conversation does not hide delegated children', () => {
  const stats = continuations();
  stats.periods.today.sessions['codex:rollout-2'].parentSessionId = 'rollout-1';
  const [group] = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  assert.equal(group.value, 500);
  assert.equal(group.groupRows.length, 5);
  assert.equal(group.subagentCount, 2);
  assert.equal(group.groupRows.filter(row => row.groupRole === 'main').length, 2);
});

test('T3 app families span main and child provider switches without increasing logical child counts', () => {
  const stats = continuations();
  for (const row of Object.values(stats.periods.today.sessions)) row.t3ThreadId = row.parentSessionId ? 'child-app' : 'main-app';
  // The existing Claude review is a separate delegated task.
  stats.periods.today.sessions['claude:review'].t3ThreadId = 'review-app';
  stats.periods.today.sessions['claude:main-claude'] = session('claude', 'main-claude', { t3ThreadId: 'main-app', turnEnded: true });
  stats.periods.today.sessions['claude:child-claude'] = session('claude', 'child-claude', {
    t3ThreadId: 'child-app', parentClient: 'codex', parentSessionId: 'rollout-1', turnEnded: true
  });
  stats.periods.today.sessions['codex:human-fork'] = session('codex', 'human-fork', { t3ThreadId: 'human-fork' });
  const rows = groupSessionRows(sessionRowsForPeriod(stats.periods.today));
  const family = rows.find(row => row.subagentGroup);
  assert.equal(rows.length, 2);
  assert.equal(family.key, 'session-group:subagents:t3:main-app');
  assert.equal(family.value, 700); assert.equal(family.cost, 7);
  assert.equal(family.subagentCount, 2);
  assert.equal(family.groupRows.filter(row => row.groupRole === 'main').length, 3);
  assert.equal(new Set(family.groupRows.map(row => row.key)).size, 7);
  const dock = presentation.recentSessionRows(stats, 10).find(row => row.subagentGroup);
  assert.equal(dock.key, family.key);
  assert.equal(dock.totalTokens, 700);
  assert.equal(dock.subagentCount, 2);
  assert.equal(dock.groupRows.filter(row => row.groupRole === 'main').length, 3);
});


test('family activity switches from running to waiting to idle as individual member leases expire', t => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const idle = { turnEnded: true, lastUsedAt: new Date(now - 3_600_000).toISOString() };
  const parent = session('codex', 'parent', { ...idle, liveActivity: {
    state: 'waiting', source: 'test', observedAt: new Date(now - 1000).toISOString()
  } });
  const child = session('claude', 'child', { ...idle, parentSessionId: 'parent', parentClient: 'codex', liveActivity: {
    state: 'running', source: 'test', observedAt: new Date(now - 2000).toISOString()
  } });
  const stats = { periods: { today: { sessions: { 'codex:parent': parent, 'claude:child': child } } } };
  const [group] = presentation.recentSessionRows(stats);
  const runningExpiry = now - 2000 + sessionLive.LIVE_ACTIVITY_TTL_MS;
  const waitingExpiry = now - 1000 + sessionLive.LIVE_ACTIVITY_TTL_MS;
  assert.equal(presentation.sessionActivityState(group, now), 'running');
  assert.equal(presentation.waitingSessionSummary([group], now).count, 0);
  assert.equal(presentation.nextRunningExpiryAt([group], now), runningExpiry);
  assert.equal(presentation.sessionActivityState(group, runningExpiry), 'waiting');
  assert.equal(presentation.runningSessionSummary([group], runningExpiry).count, 0);
  assert.equal(presentation.waitingSessionSummary([group], runningExpiry).count, 1);
  assert.equal(presentation.nextRunningExpiryAt([group], runningExpiry), waitingExpiry);
  assert.equal(presentation.sessionActivityState(group, waitingExpiry), 'idle');
  assert.equal(presentation.nextRunningExpiryAt([group], waitingExpiry), 0);
});

test('zero recent cap retains complete running and waiting families while excluding quiet groups', t => {
  const now = Date.parse('2026-10-11T12:00:00Z');
  t.mock.method(Date, 'now', () => now);
  const rows = [];
  for (const state of ['running', 'waiting', 'idle']) {
    const idle = { turnEnded: true, lastUsedAt: new Date(now - 3_600_000).toISOString() };
    rows.push(session('codex', state, idle));
    rows.push(session('claude', `${state}-child`, { ...idle, parentSessionId: state, parentClient: 'codex',
      liveActivity: { state, source: 'test', observedAt: new Date(now).toISOString() } }));
  }
  const stats = { periods: { today: { sessions: Object.fromEntries(rows.map(row => [`${row.client}:${row.sessionId}`, row])) } } };
  for (const options of [{}, { includeRunningBeyondCap: true }]) {
    const groups = presentation.recentSessionRows(stats, 0, options);
    assert.deepEqual(groups.map(group => presentation.sessionActivityState(group)).sort(), ['running', 'waiting']);
    assert.ok(groups.every(group => group.groupRows.length === 2 && group.totalTokens === 200));
    assert.equal(presentation.sessionMembers(groups).length, 4);
  }
  const running = presentation.recentSessionRows(stats, 0, { runningOnly: true });
  assert.equal(running.length, 1);
  assert.equal(running[0].groupRows.length, 2);
  assert.equal(presentation.sessionActivityState(running[0]), 'running');
});
