'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { panelFixture } = require('../helpers/notchPanel');
const { buildNotchData, notchSummaryMode } = require('../../src/electron/notch/data');
const { notchPanelItems, notchWeek } = require('../../src/electron/notch/panel');
const { createNotchHistory } = require('../../src/electron/notch/history');
const { breakdownRows, panelContentHeight } = require('../../src/electron/renderer/notch/panel');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
const { providerKey } = require('../../src/electron/renderer/limits/resetMotion');
const { createLiveTokenRateGroupTracker } = require('../../src/electron/renderer/tokenRatePresentation');

function payload(tokens = 100) {
  return { cells: [{ id: 'stat:today', available: true, totalTokens: tokens, costUsd: 2, clients: [], models: [] },
    { id: 'stat:sessions', sessions: [] }], panel: { week: { available: true, days: [
      { date: '2026-10-17', tokens: 30, costUsd: 1, clients: [{ client: 'codex', tokens: 30 }] },
      { date: '2026-10-18', tokens, costUsd: 2 }
    ], todayClients: [{ client: 'codex', tokens }] } } };
}

test('missing or invalid modes default to sessions without converting the old follow-tray flag', () => {
  assert.equal(notchSummaryMode({}), 'sessions');
  assert.equal(notchSummaryMode({ notchSummaryMode: 'unknown' }), 'sessions');
  assert.equal(notchSummaryMode({ notchFollowTray: true }), 'sessions');
  assert.equal(notchSummaryMode({ notchFollowTray: false }), 'sessions');
  assert.equal(notchSummaryMode({ notchFollowTray: false, notchSummaryMode: 'auto' }), 'auto');
  assert.equal(notchSummaryMode({ notchFollowTray: true, notchSummaryMode: 'sessions' }), 'sessions');
  for (const mode of ['auto', 'sessions', 'tray', 'custom']) assert.equal(notchSummaryMode({ notchSummaryMode: mode }), mode);
});

test('Notch renderer forwards the TPS formatter through live, retained-idle and unavailable states', t => {
  const f = panelFixture(t, {}, { viaRenderer: true }), data = payload();
  const tracker = createLiveTokenRateGroupTracker({ now: Date.now });
  const period = { timedTokens: 100, timedOutputTokens: 50, timedDurationMs: 1000 };
  const entries = () => [{ id: 'device', period }];
  tracker.reset(entries());
  const renderRate = mode => {
    data.cells = buildEdgeDockCells({}, { items: [{ type: 'stat', metric: 'liveRate' }],
      liveRate: tracker.getSample(), tokenRateMode: mode });
    f.panel.render(data);
    return f.find('notch-rate');
  };
  assert.ok(renderRate().classList.contains('is-idle'));
  assert.equal(f.find('notch-rate-value').textContent, '—');
  period.timedTokens += 200; period.timedOutputTokens += 100; period.timedDurationMs += 2000;
  tracker.observe(entries());
  assert.equal(renderRate().classList.contains('is-idle'), false);
  assert.equal(f.find('notch-rate-value').textContent, '50');
  t.mock.timers.tick(8001);
  assert.equal(renderRate().classList.contains('is-idle'), true, 'idle retains the last useful reading');
  assert.equal(f.find('notch-rate-value').textContent, '50');
  assert.match(f.find('notch-rate').title, /Idle/);
  renderRate('burn');
  assert.equal(f.find('notch-rate-value').textContent, '6.0K');
  assert.equal(f.find('notch-rate-unit').textContent, 'TPM');
  t.mock.timers.tick(172000);
  assert.equal(tracker.getSample(), null);
  assert.ok(renderRate().classList.contains('is-idle'));
  assert.equal(f.find('notch-rate-value').textContent, '—');
  period.timedTokens += 200; period.timedDurationMs += 2000;
  tracker.observe(entries()); renderRate();
  assert.equal(f.find('notch-rate-value').textContent, '0', 'a measured zero output speed is a valid reading');
  data.cells[0].rate = 0.05; f.panel.render(data);
  assert.equal(f.find('notch-rate-value').textContent, '<0.1', 'small rates use the shared rate formatter');
});

test('sessions-only summary stays quiet without live work and never falls back to quotas or usage', () => {
  const nowMs = Date.now(), settings = { notchSummaryMode: 'sessions', notchWarnColors: true };
  const stats = { periods: { today: { totalTokens: 123456 } } };
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0 };
  const live = { id: 'stat:sessions', metric: 'sessions', sessions: [{ client: 'codex',
    lastUsedAt: new Date(nowMs).toISOString(), totalTokens: 5 }] };
  const data = buildNotchData(stats, [live, quota], settings, { nowMs });
  assert.equal(data.summary.items.at(-1).running, 1);
  assert.equal(data.panel.week.days.at(-1).tokens, 123456, 'the open panel remains populated');
  assert.equal(buildNotchData(stats, [live, quota], settings, { nowMs: nowMs + 3600000 }).summary, null);
  assert.equal(buildNotchData(stats, [quota], settings, { nowMs }).summary, null);
  assert.equal(buildNotchData(stats, [], settings, { nowMs }).summary, null);
  const waiting = { ...live, sessions: [{ client: 'claude', turnEnded: true,
    liveActivity: { state: 'waiting', observedAt: new Date(nowMs).toISOString() } }] };
  assert.equal(buildNotchData(stats, [waiting, quota], settings, { nowMs }).summary.items.at(-1).waiting, 1);
  assert.equal(buildNotchData(stats, [live], { ...settings, notchSummaryEnabled: false }, { nowMs }).summary, null);
});

test('automatic summary prioritizes running and waiting sessions over exhausted quotas', () => {
  const nowMs = Date.now(), stats = { periods: { today: { totalTokens: 100 } } };
  const live = { id: 'stat:sessions', metric: 'sessions', sessions: [{ client: 'codex', lastUsedAt: new Date(nowMs).toISOString(), totalTokens: 5 }] };
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0 };
  for (const notchWarnColors of [false, true]) {
    const summary = buildNotchData(stats, [live, quota], { notchSummaryMode: 'auto', notchWarnColors }, { nowMs }).summary;
    assert.equal(summary.automatic, 'activity');
    assert.equal(summary.items.at(-1).running, 1);
  }
  const waiting = { ...live, sessions: [{ client: 'codex', turnEnded: true,
    liveActivity: { state: 'waiting', observedAt: new Date(nowMs).toISOString() } }] };
  assert.equal(buildNotchData(stats, [waiting, quota], { notchSummaryMode: 'auto' }, { nowMs }).summary.items.at(-1).waiting, 1);
  assert.equal(buildNotchData(stats, [live, quota], { notchSummaryMode: 'auto' }, { nowMs: nowMs + 3600000 }).summary.automatic, 'alert');
  assert.equal(buildNotchData(stats, [live], { notchSummaryMode: 'auto' }, { nowMs }).summary.automatic, 'activity');
  assert.equal(buildNotchData(stats, [live], { notchSummaryMode: 'auto' }, { nowMs: nowMs + 3600000 }).summary.items[1].measure.value, 100);
  assert.equal(buildNotchData(stats, [quota], { notchSummaryMode: 'auto', limitsEnabled: false }).summary.automatic, undefined);
});

test('automatic quota summary colours are opt-in and independent of the side dock', () => {
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0 };
  for (const settings of [{}, { notchWarnColors: false }, { edgeDockWarnColors: true }]) {
    const summary = buildNotchData({}, [quota], { ...settings, notchSummaryMode: 'auto' }).summary;
    assert.equal(summary.automatic, 'alert');
    assert.equal(summary.items[1].text, '0%');
    assert.equal(summary.items[1].tone, undefined);
  }
  const coloured = buildNotchData({}, [quota], { notchSummaryMode: 'auto', notchWarnColors: true, edgeDockWarnColors: false }).summary;
  assert.equal(coloured.items[1].tone, 'alert');
  assert.equal(coloured.items[1].text, '0%');
  const used = buildNotchData({}, [quota], { notchSummaryMode: 'auto', notchWarnColors: true, showLimitUsed: true }).summary;
  assert.equal(used.items[1].text, '100%');
  assert.equal(used.items[1].unit, 'used');
});

test('fixed panel readouts do not inherit legacy usage cards or pinned quota windows', () => {
  const items = notchPanelItems({}, { notchItems: [{ type: 'stat', metric: 'allTime' }, { type: 'limit', provider: 'codex', hiddenAccounts: ['hidden'], windowKey: 'weekly' }] });
  assert.deepEqual(items.map(item => item.type === 'stat' ? item.metric : item.provider), ['codex', 'today', 'month', 'sessions', 'liveRate']);
  assert.deepEqual(items[0].hiddenAccounts, ['hidden']);
  assert.equal(items[0].windowKey, '');
  assert.equal(notchPanelItems({}, { notchItems: [] }).filter(item => item.type === 'limit').length, 0);
});

test('week uses local calendar dates and History attribution while today follows the live period', () => {
  const now = new Date(2026, 9, 18, 12), stats = { periods: { today: { totalTokens: 10, costUsd: 1, clients: { codex: 10 } } } };
  const history = { daily: [{ date: '2026-10-17', tokens: 30, cost: 2, perClient: { claude: { tokens: 30 } } }], complete: true };
  const week = notchWeek(stats, now, history);
  assert.equal(week.days.length, 7);
  assert.equal(week.days[0].tokens, 0);
  assert.deepEqual(week.days.at(-2).clients, [{ client: 'claude', tokens: 30 }]);
  assert.equal(week.days.at(-1).tokens, 10);
  assert.equal(notchWeek(stats, now, null).days[0].tokens, null, 'unavailable history is not a zero');
});

test('history reads cache a revision and reject late results after a backend switch or disable/re-enable', async () => {
  const pending = [], changes = [];
  const cache = createNotchHistory({ load: () => new Promise(resolve => pending.push(resolve)), changed: () => changes.push(true) });
  const stats = { historyRevision: 'same' };
  cache.read(stats, { generation: 1 }); await Promise.resolve();
  cache.read(stats, { generation: 2 }); await Promise.resolve();
  pending[0]({ daily: [{ date: 'old' }] }); await new Promise(setImmediate);
  assert.equal(changes.length, 0);
  pending[1]({ daily: [{ date: 'new' }] }); await new Promise(setImmediate);
  assert.equal(cache.read(stats, { generation: 2 }).daily[0].date, 'new');
  assert.equal(pending.length, 2);
  cache.read(stats, { generation: 3 }); await Promise.resolve();
  cache.read(stats, { enabled: false });
  cache.read(stats, { generation: 3 }); await Promise.resolve();
  pending[2]({ daily: [{ date: 'withdrawn' }] }); await new Promise(setImmediate);
  assert.equal(cache.read(stats, { generation: 3 }), null);
  pending[3]({ daily: [] }); await new Promise(setImmediate);
  assert.deepEqual(cache.read(stats, { generation: 3 }).daily, []);
});

test('tabs expose one active panel and support arrows, Home and End without focusing hidden controls', t => {
  const f = panelFixture(t); f.panel.render(payload());
  f.find('notch-tabs').fire('keydown', { key: 'End', preventDefault() {} });
  assert.equal(f.panel.view.page, 'breakdown');
  assert.equal(f.document.activeElement.attributes['aria-selected'], 'true');
  assert.equal(f.all('notch-page').filter(node => !node.inert).length, 1);
  assert.equal(f.all('notch-tab').filter(node => node.tabIndex === 0).length, 1);
  f.find('notch-tabs').fire('keydown', { key: 'Home', preventDefault() {} });
  assert.equal(f.panel.view.page, 'home');
});

test('tabs reuse the app menu icons and breakdown uses the model icon', t => {
  const f = panelFixture(t); f.panel.render(payload());
  assert.deepEqual(f.all('notch-tab').map(button => button.children[0].className),
    ['home', 'limits', 'session', 'model'].map(icon => `view-switcher-icon view-icon-${icon}`));
});

test('session context retains shared eligibility, tooltips and small meters without row fills or prices', t => {
  const f = panelFixture(t), data = payload();
  const now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const row = (id, extra = {}) => ({ key: `codex:${id}`, client: 'codex', sessionId: id, title: id,
    totalTokens: 1234567, costUsd: 2, startedAt: ago(20), lastUsedAt: ago(1), contextTokens: 74000, contextWindow: 200000, ...extra });
  data.cells[1].sessions = [row('running', { liveActivity: { state: 'running', observedAt: ago(0) },
    promptCache: { observedAt: ago(1), ttlSeconds: 1800 } }),
  row('waiting', { liveActivity: { state: 'waiting', observedAt: ago(0) }, waitingForInput: true, contextTokens: 190000, unpricedTokens: 40 }),
  row('ended', { turnEnded: true }),
  row('cached', { client: 'claude', lastUsedAt: ago(20), promptCache: { observedAt: ago(10), ttlSeconds: 1800 } }),
  row('idle', { lastUsedAt: ago(40), promptCache: { observedAt: ago(40), ttlSeconds: 1800 } })];
  f.panel.render(data);
  assert.equal(f.find('notch-now-value').querySelector('.notch-session-context-value').textContent, '37%');
  assert.equal(f.find('notch-orb'), null);
  assert.equal(f.find('notch-now-tokens').textContent, '1234567', 'the current session keeps its exact total');
  f.panel.selectPage('sessions');
  const page = f.find('notch-page-sessions'), active = page.querySelectorAll('.notch-active');
  assert.equal(active.length, 2);
  assert.deepEqual(active.map(node => node.querySelector('.notch-session-context-fill').style['--bar-scale']), ['0.95', '0.37']);
  assert.equal(active[0].querySelector('.notch-session-context').dataset.tone, 'low');
  assert.equal(page.querySelector('.notch-active-context-fill'), null);
  assert.equal(page.querySelector('.notch-active-cost'), null, 'both priced and partially priced sessions omit cost');
  const runningContext = active[1].querySelector('.notch-session-context');
  assert.deepEqual(runningContext.tooltipEntries.map(entry => entry.full), ['74K / 200K', 'Cache ~29m left']);
  const recent = page.querySelectorAll('.notch-recent');
  assert.equal(recent[0].querySelector('.notch-session-context-value').textContent, '37%', 'a freshly ended turn retains context');
  assert.equal(recent[1].querySelector('.notch-session-cache').textContent, 'Cache 20m');
  assert.equal(recent[1].querySelector('.notch-session-cache').tooltipEntries[0].full, '74K / 200K',
    'a cache badge still names the context size, as the Home list and Edge Dock do');
  assert.equal(recent[2].querySelector('.notch-session-context'), null, 'idle sessions do not revive stale context');
  assert.equal(recent[2].querySelector('.notch-session-cache'), null, 'expired cache stays absent');
  f.settings.sessionContextMetric = 'remaining'; f.state.appearanceKey = 'remaining'; f.panel.render(data);
  const remaining = page.querySelectorAll('.notch-active')[1];
  assert.equal(remaining.querySelector('.notch-session-context-fill').style['--bar-scale'], '0.63');
  assert.equal(remaining.querySelector('.notch-session-context').attributes['aria-valuenow'], '63');
});

test('cache expiry refreshes within the same minute without a new stats push', t => {
  const f = panelFixture(t), data = payload(), now = Date.now();
  data.cells[1].sessions = [{ key: 'claude:cache', client: 'claude', sessionId: 'cache', title: 'cached session', totalTokens: 10,
    lastUsedAt: new Date(now - 1200000).toISOString(), promptCache: { observedAt: new Date(now - 1799000).toISOString(), ttlSeconds: 1800 } }];
  f.panel.render(data); f.panel.selectPage('sessions');
  const page = f.find('notch-page-sessions');
  assert.equal(page.querySelector('.notch-session-cache').textContent, 'Cache 1m');
  t.mock.timers.tick(2000); f.panel.render(data);
  assert.equal(page.querySelector('.notch-session-cache'), null);
});

test('recent sessions retain all quiet rows and preserve scroll and focus across live updates', t => {
  const f = panelFixture(t), data = payload();
  data.cells[1].sessions = Array.from({ length: 8 }, (_, index) => ({ key: `codex:${index}`, client: 'codex',
    sessionId: String(index), title: `Session ${index + 1}`, totalTokens: index + 1, lastUsedAt: '2026-10-17T10:00:00Z' }));
  f.panel.render(data); f.panel.selectPage('sessions');
  const page = f.find('notch-page-sessions');
  assert.equal(page.querySelectorAll('.notch-recent').length, 8);
  const list = page.querySelector('.notch-recent-list');
  list.scrollTop = 96; list.focus();
  data.cells[1].sessions[0].totalTokens += 1; f.panel.render(data);
  assert.equal(page.querySelector('.notch-recent-list').scrollTop, 96);
  assert.equal(f.document.activeElement.dataset.focusKey, 'recent:list');
  assert.deepEqual(page.querySelectorAll('.notch-recent-tokens').slice(-2).map(node => node.textContent), ['7', '8']);
  data.cells[1].sessions = data.cells[1].sessions.slice(0, 1); f.panel.render(data);
  assert.equal(page.querySelectorAll('.notch-recent').length, 1);
});

test('week footer omits redundant labels while qualifying partial history and accessible values', t => {
  const f = panelFixture(t), data = payload();
  f.panel.render(data);
  const summary = f.find('notch-week-foot');
  assert.equal(summary.children.length, 2);
  assert.equal(summary.querySelectorAll('.notch-summary-label').length, 0);
  assert.equal(f.find('notch-week-tokens').textContent, '130');
  assert.equal(f.find('notch-week-tokens').attributes['aria-label'], 'Total usage: 130');
  assert.equal(f.find('notch-week-cost-value').attributes['aria-label'], 'Total cost: $3');
  data.panel.week.days[0].tokens = null; f.panel.render(data);
  assert.deepEqual(f.find('notch-week-foot').querySelectorAll('.notch-summary-label').map(node => node.textContent), ['Recorded']);
  assert.equal(f.find('notch-week-tokens').attributes['aria-label'], 'Recorded: 100');
  assert.equal(f.find('notch-week-cost-value').attributes['aria-label'], 'Recorded cost: $3');
  data.panel.week.days[0].unpricedTokens = 10; f.panel.render(data);
  assert.equal(f.find('notch-week-cost-value').textContent, '—');
});

test('quiet sessions use concise age metadata and explicit empty-state copy', t => {
  const f = panelFixture(t), data = payload();
  data.cells[1].sessions = [{ key: 'codex:old', client: 'codex', sessionId: 'old', title: 'Previous task',
    models: { 'model-a': 1 }, totalTokens: 1, lastUsedAt: new Date(Date.now() - 660000).toISOString() }];
  f.panel.render(data);
  assert.match(f.find('notch-now-meta').textContent, /^Codex · model-a · /);
  assert.doesNotMatch(f.find('notch-now-meta').textContent, /Last active/);
  assert.equal(f.find('notch-now-caption'), null);
  assert.match(f.find('notch-now-tokens').attributes['aria-label'], /last session.*1/i);
  f.panel.selectPage('sessions');
  assert.match(f.find('notch-sessions-empty').textContent, /^No active sessionsLast active: /);
});

test('session titles use shared hover reading and hand it across live updates', t => {
  const f = panelFixture(t), data = payload();
  data.cells[1].sessions = [{ key: 'codex:long', client: 'codex', sessionId: 'long', title: 'A long session title',
    totalTokens: 1, lastUsedAt: new Date(Date.now()).toISOString() }];
  f.panel.render(data);
  const previous = f.find('notch-now-title');
  assert.ok(f.overflowText.bound.includes(previous));
  assert.equal(previous.title, undefined, 'normal hover uses the app reader instead of a native title popup');
  data.cells[1].sessions[0].totalTokens += 1; f.panel.render(data);
  assert.equal(f.find('notch-now-title').dataset.overflowKey, previous.dataset.overflowKey);
  assert.equal(f.overflowText.preserved.at(-1).previous.contains(previous), true);
  const current = f.find('notch-now-title'); f.panel.suspend();
  assert.ok(f.overflowText.stopped.includes(current));
});

test('scrubbing freezes the historical reading and returning applies the latest push immediately', t => {
  const f = panelFixture(t); f.panel.render(payload());
  f.all('notch-day')[0].fire('pointerenter');
  assert.equal(f.find('notch-big').textContent, '30');
  f.panel.render(payload(200));
  assert.equal(f.find('notch-big').textContent, '30');
  f.find('notch-bars').fire('pointerleave');
  assert.equal(f.find('notch-big').textContent, '200');
  assert.equal(f.panel.view.scrub, null);
});

test('number rolls retarget from semantic values and release effects on collapse', t => {
  const f = panelFixture(t); f.panel.render(payload());
  f.panel.render(payload(200)); f.panel.render(payload(150));
  assert.deepEqual(f.rolls.map(roll => [roll.from, roll.to]), [['100', '200'], ['200', '150']]);
  assert.deepEqual(f.rolls[1].glyphs, ['in-flight']);
  assert.equal(f.rolls[1].increasing, false);
  f.panel.suspend();
  assert.equal(f.find('notch-big').rolling, false);
});

test('repeated pushes do not replay the bar entrance and reduced motion skips digit effects', t => {
  const f = panelFixture(t, { reduceMotion: true }); f.panel.render(payload(), { opening: true });
  f.panel.render(payload(150));
  assert.equal(f.panel.node.classList.contains('is-entering'), false);
  assert.equal(f.rolls.length, 0);
});

test('breakdown retains unattributed usage and other rows reconcile to the total', t => {
  const f = panelFixture(t), data = payload();
  data.cells[0].clients = [{ client: 'codex', tokens: 60 }, { client: 'unattributed', unattributed: true, tokens: 40 }];
  f.panel.render(data); f.panel.selectPage('breakdown');
  assert.match(f.find('notch-rank').textContent, /Unclassified/);
  assert.deepEqual(f.all('notch-rank-share').map(node => node.textContent), ['60%', '40%']);
  const grouped = breakdownRows(Array.from({ length: 9 }, (_, index) => ({ key: String(index), tokens: 10 })));
  assert.equal(grouped.length, 4); assert.equal(grouped.at(-1).tokens, 60);
});

test('breakdown rounds visible shares to integers while preserving exact spectrum proportions', t => {
  const f = panelFixture(t), data = payload(1000);
  data.cells[0].clients = [{ client: 'codex', tokens: 899 }, { client: 'claude', tokens: 82 }, { client: 'cursor', tokens: 19 }];
  data.cells[0].models = [{ model: 'model-a', tokens: 921 }, { model: 'model-b', tokens: 78 }, { model: 'model-c', tokens: 1 }];
  f.panel.render(data); f.panel.selectPage('breakdown');
  assert.equal(f.find('notch-breakdown-caption'), null);
  assert.deepEqual(f.all('notch-rank-share').map(node => node.textContent), ['90%', '8%', '2%', '92%', '8%', '0%']);
  assert.deepEqual(f.all('notch-spectrum').map(node => node.children.map(segment => segment.style.flex)),
    [['899', '82', '19'], ['921', '78', '1']]);
});

test('breakdown shows tools and models together and switches both to the same period', t => {
  const f = panelFixture(t), data = payload();
  data.cells[0].clients = [{ client: 'codex', tokens: 60 }, { client: 'claude', tokens: 40 }];
  data.cells[0].models = [{ model: 'gpt-6.1', tokens: 50 }, { model: 'claude-opus-5.5', tokens: 50 }];
  data.cells.push({ id: 'stat:month', available: true, totalTokens: 400, costUsd: 8,
    clients: [{ client: 'cursor', tokens: 400 }], models: [{ model: 'gemini', tokens: 400 }] });
  f.panel.render(data); f.panel.selectPage('breakdown');
  assert.equal(f.all('notch-breakdown-column').length, 2);
  assert.match(f.find('notch-breakdown-tool').textContent, /Codex/);
  assert.match(f.find('notch-breakdown-model').textContent, /gpt-6.1/);
  assert.equal(f.find('notch-breakdown-by'), null);
  const head = f.find('notch-breakdown-head');
  assert.equal(head.children[0], f.find('notch-breakdown-total'));
  assert.equal(head.children[1], f.find('notch-breakdown-period'));
  assert.equal(f.find('notch-breakdown-total').children.at(-1), f.find('notch-breakdown-cost'));
  assert.deepEqual(f.all('notch-rank-share').map(node => node.textContent), ['60%', '40%', '50%', '50%']);
  const month = f.find('notch-breakdown-period').children.filter(node => node.tagName === 'BUTTON')[1];
  month.focus(); month.fire('click', { detail: 0 });
  assert.equal(f.find('notch-breakdown-tokens').textContent, '400');
  assert.equal(f.find('notch-breakdown-cost').textContent, '$8');
  assert.match(f.find('notch-breakdown-tool').textContent, /Cursor/);
  assert.match(f.find('notch-breakdown-model').textContent, /gemini/);
  assert.deepEqual(f.all('notch-rank-share').map(node => node.textContent), ['100%', '100%']);
  assert.equal(f.document.activeElement.attributes['aria-pressed'], 'true', 'period switching preserves keyboard focus');
});

test('pointer and keyboard inspection only highlight the matching column spectrum', t => {
  const f = panelFixture(t), data = payload();
  data.cells[0].clients = [{ client: 'codex', tokens: 60 }, { client: 'claude', tokens: 40 }];
  data.cells[0].models = [{ model: 'gpt-6.1', tokens: 100 }];
  f.panel.render(data); f.panel.selectPage('breakdown');
  const [tools, models] = f.all('notch-breakdown-column');
  const toolRow = tools.querySelector('.notch-rank-row'), modelRow = models.querySelector('.notch-rank-row');
  toolRow.fire('pointerenter');
  assert.equal(tools.querySelector('.notch-spectrum').classList.contains('is-hovering'), true);
  assert.equal(models.querySelector('.notch-spectrum').classList.contains('is-hovering'), false);
  toolRow.fire('pointerleave'); modelRow.focus();
  assert.equal(tools.querySelector('.notch-spectrum').classList.contains('is-hovering'), false);
  assert.equal(models.querySelector('.notch-spectrum').children[0].classList.contains('is-highlighted'), true);
  data.cells[0].models[0].tokens = 90;
  f.panel.render(data);
  assert.equal(f.document.activeElement.dataset.focusKey, modelRow.dataset.focusKey, 'updates restore the inspected model');
  assert.equal(f.find('notch-breakdown-model').querySelector('.notch-rank-share').textContent, '90%', 'shares use the period total, including unclassified usage');
});

test('both breakdown columns fold overflow into Other without losing usage', t => {
  const f = panelFixture(t), data = payload();
  const counts = [40, 25, 15, 10, 8, 2];
  data.cells[0].clients = counts.map((tokens, index) => ({ client: `tool-${index}`, tokens }));
  data.cells[0].models = counts.map((tokens, index) => ({ model: `model-${index}`, tokens }));
  f.panel.render(data); f.panel.selectPage('breakdown');
  for (const column of f.all('notch-breakdown-column')) {
    const rows = column.querySelectorAll('.notch-rank-row');
    assert.equal(rows.length, 4);
    assert.match(rows.at(-1).textContent, /Other/);
    assert.equal(rows.reduce((sum, row) => sum + Number(row.querySelector('.notch-rank-tokens').textContent), 0), 100);
    assert.deepEqual(column.querySelectorAll('.notch-rank-share').map(node => node.textContent), ['40%', '25%', '15%', '20%']);
  }
});

test('unknown and zero usage remain distinct in both breakdown columns', t => {
  const f = panelFixture(t);
  f.panel.render({ cells: [] }); f.panel.selectPage('breakdown');
  assert.equal(f.find('notch-breakdown-tokens').textContent, '—');
  assert.ok(f.all('notch-breakdown-column').every(column => /Unavailable/.test(column.textContent)));
  const data = payload(0); data.cells[0].costUsd = 0;
  f.panel.render(data);
  assert.equal(f.find('notch-breakdown-tokens').textContent, '0');
  assert.ok(f.all('notch-breakdown-column').every(column => /No usage yet/.test(column.textContent)));
});

test('limits retain the shared current account beyond the detail cap and expose every quota page', t => {
  const f = panelFixture(t);
  const records = Array.from({ length: 55 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: `key:${index}`, accountEmail: `${index}@example.test`,
    windows: [{ kind: 'session', remainingPercent: 60 }, { kind: 'weekly', remainingPercent: 70 }, { kind: 'daily', remainingPercent: 80 }] }));
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: [{ type: 'limit', provider: 'codex' }] });
  cells[0].headlineAccount = providerKey(records.at(-1));
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.match(f.find('notch-limit-account').textContent, /54@example.test/);
  assert.equal(f.all('notch-limit-window').length, 2);
  f.find('notch-window-page').fire('click', { detail: 0 });
  assert.equal(f.all('notch-limit-window').length, 1);
  assert.equal(f.find('notch-limit-number').textContent, '80');
});

test('money quotas and unlimited readings keep their values without fabricated percentages', t => {
  const f = panelFixture(t), record = { provider: 'cline', status: 'ok', windows: [
    { kind: 'billing', metric: 'credits', remaining: 12, currency: 'USD', showMeter: false },
    { kind: 'session', detail: 'unlimited', showMeter: false }
  ] };
  const cells = buildEdgeDockCells({ limits: { providers: [record] } }, { items: [{ type: 'limit', provider: 'cline' }] });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.match(f.find('notch-limit-money').textContent, /12/);
  assert.equal(f.find('notch-limit-detail').textContent, 'Unlimited');
  assert.equal(f.all('notch-limit-percent').length, 0);
});

test('Home and Limits quota colours follow only the Notch opt-in and clear when switched off', t => {
  const f = panelFixture(t, { edgeDockWarnColors: true }), data = payload();
  const providers = ['codex', 'claude', 'cursor'].map((provider, index) => ({ provider, status: 'ok',
    windows: [{ kind: 'weekly', remainingPercent: [0, 20, 80][index] }] }));
  data.cells.push(...buildEdgeDockCells({ limits: { providers } }, { items: providers.map(record => ({ type: 'limit', provider: record.provider })) }));
  for (const enabled of [false, true, false]) {
    f.settings.notchWarnColors = enabled; f.state.appearanceKey = `warn:${enabled}`;
    f.panel.selectPage('home'); f.panel.render(data);
    const tones = enabled ? ['critical', 'low', undefined] : [undefined, undefined, undefined];
    assert.deepEqual(f.all('notch-fuel-value').map(node => node.dataset.tone), tones);
    f.panel.selectPage('limits');
    assert.deepEqual(f.all('notch-limit-window').map(node => node.dataset.tone), tones);
    assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['0', '20', '80']);
  }
});

test('home quota groups fill the available width and resize without losing the remainder link', t => {
  const f = panelFixture(t), data = payload();
  data.cells.push(...Array.from({ length: 8 }, (_, index) => ({ kind: 'provider', id: `limit:provider-${index}`, provider: `provider-${index}`,
    accounts: [{ record: { provider: `provider-${index}`, status: 'ok', windows: [{ kind: 'session', remainingPercent: 75 }] } }] })));
  f.panel.render(data);
  const row = f.find('notch-fuel');
  let width = 300;
  Object.defineProperties(row, {
    clientWidth: { get: () => width },
    scrollWidth: { get: () => row.children.reduce((sum, child) => sum + (child.classList.contains('notch-fuel-item') ? 70 : 20), 0)
      + Math.max(0, row.children.length - 1) * 12 }
  });
  f.resize();
  assert.equal(f.all('notch-fuel-item').length, 3, 'the freed caption space can hold a third complete group');
  assert.equal(f.find('notch-fuel-more').textContent, '+5');
  assert.equal(f.find('notch-fuel-caption'), null);
  assert.equal(row.attributes['aria-label'], 'limits left');
  width = 170; f.resize();
  assert.equal(f.all('notch-fuel-item').length, 1);
  assert.equal(f.find('notch-fuel-more').textContent, '+7');
  width = 700; f.resize();
  assert.equal(f.all('notch-fuel-item').length, 8, 'widening restores groups that were previously hidden');
  assert.equal(f.find('notch-fuel-more'), null);
  width = 300; f.resize();
  f.find('notch-fuel-more').fire('click', { detail: 0 });
  assert.equal(f.panel.view.page, 'limits');
});

test('panel height scales once', () => {
  assert.equal(panelContentHeight({ attached: true, zoom: 1.5 }), 300);
  assert.equal(panelContentHeight({ attached: false, zoom: 1.5 }), 351);
});

test('partial pricing does not present the known subtotal as a complete cost', t => {
  const f = panelFixture(t), data = payload();
  data.cells[0].unpricedTokens = 40;
  f.panel.render(data);
  assert.equal(f.find('notch-cost').textContent, '—');
  assert.match(f.find('notch-cost').title, /40/);
  f.panel.selectPage('breakdown');
  assert.equal(f.find('notch-breakdown-cost').textContent, '—');
});

test('a provider without a headline never falls back to an account hidden from the panel', t => {
  const f = panelFixture(t);
  const hidden = { provider: 'codex', status: 'ok', accountKey: 'hidden', planLabel: 'HiddenPlan', windows: [{ kind: 'weekly', remainingPercent: 3 }] };
  const visible = { provider: 'codex', status: 'error', accountKey: 'visible', windows: [] };
  const cells = buildEdgeDockCells({ limits: { providers: [hidden, visible] } },
    { includeUnavailableAccounts: true, items: [{ type: 'limit', provider: 'codex', hiddenAccounts: ['hidden'] }] });
  assert.equal(cells[0].headlineAccount, '');
  f.panel.render({ ...payload(), cells });
  assert.doesNotMatch(f.find('notch-fuel').textContent, /3%/, 'Home does not read the hidden account');
  f.panel.selectPage('limits');
  assert.equal(f.find('notch-chip'), null, 'the hidden plan is not shown');
  assert.equal(f.find('notch-limit-number'), null);
});

test('the TPS reading updates in place so keyboard focus survives live samples', t => {
  const f = panelFixture(t), data = payload();
  const rate = value => ({ id: 'stat:liveRate', kind: 'stat', metric: 'liveRate', rate: value, rateMode: 'speed', idle: false });
  f.panel.render({ ...data, cells: [...data.cells, rate(40)] });
  const button = f.find('notch-rate');
  f.panel.render({ ...data, cells: [...data.cells, rate(55)] });
  assert.equal(f.find('notch-rate'), button, 'the focused button is the same node');
  assert.match(button.querySelector('.notch-rate-value').textContent, /55/);
});

test('grouped activity is drawn with the active member tool, not the parent', () => {
  const nowMs = Date.now(), stats = { periods: { today: { totalTokens: 1 } } };
  const old = new Date(nowMs - 3600000).toISOString(), now = new Date(nowMs).toISOString();
  const group = { client: 'claude', sessionGroup: true, groupRows: [{ client: 'claude', lastUsedAt: old }, { client: 'codex', lastUsedAt: now }] };
  const cells = [{ id: 'stat:sessions', metric: 'sessions', sessions: [group] }];
  const summary = buildNotchData(stats, cells, { notchSummaryMode: 'sessions' }, { nowMs }).summary;
  assert.deepEqual(summary.items.filter(item => item.type === 'icon').map(item => item.provider), ['codex']);
});

test('history keeps the previous week across revisions, throttles reloads and needs every device for zeros', async () => {
  const pending = [], changes = [];
  let clock = 0;
  const timers = [];
  const cache = createNotchHistory({ load: () => new Promise(resolve => pending.push(resolve)), changed: () => changes.push(true),
    minIntervalMs: () => 60000, now: () => clock, setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const at = revision => ({ historyRevision: revision });
  cache.read(at('a'), { generation: 1 }); await Promise.resolve();
  pending[0]({ daily: [{ date: 'first' }], fixedPeriods: { historyTransportAvailable: true }, devicesComplete: false });
  await new Promise(setImmediate);
  assert.equal(cache.read(at('a'), { generation: 1 }).complete, false, 'a device without History keeps absent days unknown');
  clock = 1000;
  assert.equal(cache.read(at('b'), { generation: 1 }).daily[0].date, 'first', 'a new revision keeps the shown week');
  assert.equal(pending.length, 1, 'reloads wait for the throttle');
  assert.equal(timers.at(-1).ms, 59000);
  clock = 61000;
  assert.equal(cache.read(at('b'), { generation: 1 }).daily[0].date, 'first');
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1]({ daily: [{ date: 'second' }], fixedPeriods: { historyTransportAvailable: true }, devicesComplete: true });
  await new Promise(setImmediate);
  const fresh = cache.read(at('b'), { generation: 1 });
  assert.equal(fresh.daily[0].date, 'second');
  assert.equal(fresh.complete, true);
  assert.equal(cache.read(at('b'), { generation: 2 }), null, 'a backend switch drops the answer');
});
