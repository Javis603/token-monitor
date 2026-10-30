'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { panelFixture } = require('../helpers/notchPanel');
const { buildNotchData, notchSummaryMode } = require('../../src/electron/notch/data');
const { notchPanelItems, notchWeek } = require('../../src/electron/notch/panel');
const { createNotchHistory } = require('../../src/electron/notch/history');
const { breakdownRows, panelContentHeight } = require('../../src/electron/renderer/notch/panel');
const { buildEdgeDockCells } = require('../../src/electron/renderer/edgeDock/presentation');
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
  assert.match(f.find('notch-rate').attributes['aria-label'], /Idle/);
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
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0, severityPercent: 0 };
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
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0, severityPercent: 0 };
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
  const quota = { kind: 'provider', provider: 'devin', status: 'ok', remainingPercent: 0, severityPercent: 0 };
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

test('automatic alerts rank providers and display the tightest projected quota rather than the headline', () => {
  const stats = { periods: { today: { totalTokens: 100 } }, limits: { providers: [
    { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 80 }, { kind: 'weekly', remainingPercent: 5 }] },
    { provider: 'codex', status: 'ok', windows: [{ kind: 'session', remainingPercent: 7 }, { kind: 'weekly', remainingPercent: 50 }] }
  ] } };
  const cells = buildEdgeDockCells(stats, { items: [{ type: 'limit', provider: 'claude' }, { type: 'limit', provider: 'codex' }] });
  assert.deepEqual(cells.map(cell => [cell.provider, cell.remainingPercent, cell.severityPercent]), [['claude', 80, 5], ['codex', 7, 7]]);
  for (const showLimitUsed of [false, true]) {
    const summary = buildNotchData(stats, cells, { notchSummaryMode: 'auto', showLimitUsed }).summary;
    assert.equal(summary.automatic, 'alert');
    assert.equal(summary.items[0].provider, 'claude');
    assert.equal(summary.items[1].text, showLimitUsed ? '95%' : '5%');
    assert.equal(summary.items[1].measure.value, showLimitUsed ? 95 : 5);
    assert.equal(summary.items[1].unit, showLimitUsed ? 'used' : 'left');
    const secondaryOnly = buildNotchData(stats, [cells[0]], { notchSummaryMode: 'auto', showLimitUsed }).summary;
    assert.equal(secondaryOnly.automatic, 'alert', 'a critical secondary pool cannot fall back to daily usage');
    assert.equal(secondaryOnly.items[1].text, showLimitUsed ? '95%' : '5%');
  }
  assert.equal(cells[0].remainingPercent, 80, 'alert projection does not rewrite the shared headline');
});

test('automatic alerts keep unknown severity unknown and ignore stale or failed readings', () => {
  const stats = { periods: { today: { totalTokens: 100 } } };
  const cell = { kind: 'provider', provider: 'claude', status: 'ok', remainingPercent: 0 };
  for (const severityPercent of [null, undefined, NaN, Infinity]) {
    const summary = buildNotchData(stats, [{ ...cell, severityPercent }], { notchSummaryMode: 'auto' }).summary;
    assert.equal(summary.automatic, undefined);
    assert.equal(summary.items.at(-1).measure.value, 100);
  }
  for (const status of ['stale', 'error']) {
    assert.equal(buildNotchData(stats, [{ ...cell, status, severityPercent: 0 }], { notchSummaryMode: 'auto' }).summary.automatic, undefined);
  }
  assert.equal(buildNotchData(stats, [{ ...cell, severityPercent: 0 }], { notchSummaryMode: 'auto' }).summary.items.at(-1).text, '0%');
});

test('automatic alerts respect the shared headline account and hidden-account selection', () => {
  const stats = { periods: { today: { totalTokens: 100 } }, limits: { providers: [
    { provider: 'claude', accountKey: 'hidden', status: 'ok', windows: [{ kind: 'session', remainingPercent: 80 }, { kind: 'weekly', remainingPercent: 1 }] },
    { provider: 'claude', accountKey: 'visible', status: 'ok', windows: [{ kind: 'session', remainingPercent: 90 }, { kind: 'weekly', remainingPercent: 50 }] }
  ] } };
  for (const hide of [false, true]) {
    const cells = buildEdgeDockCells(stats, { items: [{ type: 'limit', provider: 'claude', hiddenAccounts: hide ? ['hidden'] : [] }] });
    assert.equal(cells[0].severityPercent, hide ? 50 : 1);
    const summary = buildNotchData(stats, cells, { notchSummaryMode: 'auto' }).summary;
    assert.equal(summary.automatic, hide ? undefined : 'alert');
    if (!hide) assert.equal(summary.items.at(-1).text, '1%');
    assert.equal(buildNotchData(stats, cells, { notchSummaryMode: 'auto', limitsEnabled: false }).summary.automatic, undefined);
  }
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

// A fixed local midday, so the week's local dates do not depend on when the suite runs.
const DAY = new Date(2026, 9, 19, 12);

test('history picks the local week by date even when a remote source is already a day ahead', async () => {
  const pending = [];
  const cache = createNotchHistory({ load: () => new Promise(resolve => pending.push(resolve)), changed: () => {} });
  cache.read({}, { generation: 1, now: DAY }); await Promise.resolve();
  // Seven rows ending tomorrow (a remote device past midnight): position would
  // drop the local week's first day.
  const days = ['2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20']
    .map(date => ({ date, tokens: 100, cost: 1 }));
  pending[0]({ daily: days, fixedPeriods: { historyTransportAvailable: true } }); await new Promise(setImmediate);
  const week = cache.read({}, { generation: 1, now: DAY }).daily;
  assert.deepEqual(week.map(day => day.date), ['2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16', '2026-10-17', '2026-10-18', '2026-10-19']);
  assert.equal(week.reduce((sum, day) => sum + day.tokens, 0), 700);
});

test('history reads cache a revision and reject late results after a backend switch or disable/re-enable', async () => {
  const pending = [], changes = [];
  const cache = createNotchHistory({ load: () => new Promise(resolve => pending.push(resolve)), changed: () => changes.push(true) });
  const stats = { historyRevision: 'same' };
  cache.read(stats, { generation: 1, now: DAY }); await Promise.resolve();
  cache.read(stats, { generation: 2, now: DAY }); await Promise.resolve();
  pending[0]({ daily: [{ date: '2026-10-13' }] }); await new Promise(setImmediate);
  assert.equal(changes.length, 0);
  pending[1]({ daily: [{ date: '2026-10-19' }] }); await new Promise(setImmediate);
  assert.equal(cache.read(stats, { generation: 2, now: DAY }).daily[0].date, '2026-10-19');
  assert.equal(pending.length, 2);
  cache.read(stats, { generation: 3, now: DAY }); await Promise.resolve();
  cache.read(stats, { enabled: false });
  cache.read(stats, { generation: 3, now: DAY }); await Promise.resolve();
  pending[2]({ daily: [{ date: '2026-10-14' }] }); await new Promise(setImmediate);
  assert.equal(cache.read(stats, { generation: 3, now: DAY }), null);
  pending[3]({ daily: [] }); await new Promise(setImmediate);
  assert.deepEqual(cache.read(stats, { generation: 3, now: DAY }).daily, []);
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

const pluginPageFixture = (t, refs) => {
  const states = Object.fromEntries(refs.map((ref, index) => [ref, { title: `Plugin ${index + 1}`, icon: 'cpu' }]));
  const pluginHost = { state: (_surface, ref) => states[ref], mount() {}, refreshDemand() {} };
  const pluginViews = require('../../src/electron/renderer/pluginViews');
  const f = panelFixture(t, {}, { pluginHost, pluginViews });
  const data = payload();
  data.panel.pluginPages = refs;
  data.panel.pluginCatalog = states;
  f.panel.render(data);
  const [leadRail, trailRail] = f.all('notch-tab-rail');
  const [leadTrack, trailTrack] = f.all('notch-tabs');
  const [leadPill, trailPill] = f.all('notch-tab-pill');
  const visibleIn = track => track.querySelectorAll('.notch-tab').filter(button => !button.hidden).map(button => button.dataset.page);
  return { f, data, leadRail, trailRail, leadTrack, trailTrack, leadPill, trailPill, visibleIn };
};

test('legal plugin refs keep unique tab and panel ARIA identities', t => {
  const refs = ['ab-c/d', 'ab/c-d'];
  const { normalizeManifest } = require('../../src/shared/plugins/manifest');
  for (const ref of refs) {
    const [id, view] = ref.split('/');
    const result = normalizeManifest({ tmApi: 1, id, name: id, version: '1.0.0', ui: 'ui.js', files: ['ui.js'], views: [{ id: view, surfaces: ['notch'] }] });
    assert.equal(result.ok, true, result.errors.join(', '));
  }
  const { f, leadRail, trailRail, leadTrack } = pluginPageFixture(t, refs);
  const tabs = f.all('notch-tab'), panels = f.all('notch-page');
  assert.equal(new Set(tabs.map(node => node.id)).size, tabs.length);
  assert.equal(new Set(panels.map(node => node.id)).size, panels.length);
  for (const tab of tabs) {
    const panel = panels.find(node => node.id === tab.attributes['aria-controls']);
    assert.equal(panel.dataset.page, tab.dataset.page);
    assert.equal(panel.attributes['aria-labelledby'], tab.id);
    if (!tab.dataset.page.startsWith('plugin:')) {
      assert.equal(tab.id, `notch-tab-${tab.dataset.page}`);
      assert.equal(panel.id, `notch-page-${tab.dataset.page}`);
    }
  }
  leadRail.clientWidth = 147; trailRail.clientWidth = 112;
  f.resize();
  const pluginTabs = tabs.filter(node => node.dataset.page.startsWith('plugin:'));
  assert.deepEqual(leadTrack.attributes['aria-owns'].split(' '), pluginTabs.map(node => node.id));
  for (const tab of pluginTabs) {
    tab.fire('click', { detail: 0 });
    assert.equal(f.panel.view.page, tab.dataset.page);
  }
  leadTrack.fire('keydown', { key: 'ArrowLeft', preventDefault() {} });
  assert.equal(f.panel.view.page, `plugin:${refs[0]}`);
  leadTrack.fire('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(f.panel.view.page, `plugin:${refs[1]}`);
});

test('an unmeasured rail shows every page in the leading track with no step buttons', t => {
  const { f, leadTrack, trailTrack, visibleIn } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c']);
  assert.deepEqual(visibleIn(leadTrack), ['home', 'limits', 'sessions', 'breakdown', 'plugin:demo/a', 'plugin:demo/b', 'plugin:demo/c']);
  assert.deepEqual(visibleIn(trailTrack), []);
  assert.equal(f.all('notch-tab-step').filter(step => !step.hidden).length, 0, 'no visible step buttons');
});

test('overflow pages continue in the trailing track bridged by aria-owns', t => {
  const { f, leadRail, trailRail, leadTrack, trailTrack, leadPill, trailPill, visibleIn } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c']);
  leadRail.clientWidth = 183; trailRail.clientWidth = 112; // L=5, T=3
  f.resize();
  assert.deepEqual(visibleIn(leadTrack), ['home', 'limits', 'sessions', 'breakdown', 'plugin:demo/a']);
  assert.deepEqual(visibleIn(trailTrack), ['plugin:demo/b', 'plugin:demo/c']);
  assert.equal(f.all('notch-tab-step').filter(step => !step.hidden).length, 0, 'both lanes fit, so no pager');
  assert.equal(leadTrack.attributes['aria-owns'], 'notch-tab-plugin%3Ademo%2Fb notch-tab-plugin%3Ademo%2Fc');
  // Selecting a trailing page activates its local indicator across the camera.
  f.panel.selectPage('plugin:demo/c');
  assert.equal(leadPill.classList.contains('is-off'), true);
  assert.equal(trailPill.classList.contains('is-off'), false);
  assert.equal(trailPill.style.transform, 'translateX(36px)');
  // Back to a leading page: position the hidden local indicator before fading it in.
  f.panel.selectPage('home');
  assert.equal(leadPill.classList.contains('is-off'), false);
  assert.equal(leadPill.style.transform, 'translateX(0px)');
  assert.equal(trailPill.classList.contains('is-off'), true);
});

test('the trailing track paints only while it holds pages', t => {
  const { f, data, leadRail, trailRail, trailTrack } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c']);
  leadRail.clientWidth = 183; trailRail.clientWidth = 112; // L=5, T=3
  data.panel.pluginPages = []; f.panel.render(data); f.resize();
  assert.equal(trailTrack.hidden, true, 'built-in pages alone leave no fill beside the camera');
  data.panel.pluginPages = ['demo/a', 'demo/b', 'demo/c']; f.panel.render(data); f.resize();
  assert.equal(trailTrack.hidden, false);
  data.panel.pluginPages = []; f.panel.render(data); f.resize();
  assert.equal(trailTrack.hidden, true);
});

test('mixed saved order controls runtime tabs and keyboard order without selecting hidden pages', t => {
  const { f, data, leadTrack, trailTrack, visibleIn } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c']);
  data.panel.builtinPages = ['home', 'limits'];
  data.panel.pageOrder = ['plugin:demo/c', 'limits', 'plugin:demo/a', 'home'];
  f.panel.render(data);
  assert.deepEqual([...visibleIn(leadTrack), ...visibleIn(trailTrack)], ['plugin:demo/c', 'limits', 'plugin:demo/a', 'home', 'plugin:demo/b']);
  f.panel.selectPage('home');
  leadTrack.fire('keydown', { key: 'ArrowRight', preventDefault() {} });
  assert.equal(f.panel.view.page, 'plugin:demo/b');
  f.panel.selectPage('plugin:demo/c');
  data.panel.pageOrder = ['limits', 'plugin:demo/c', 'home']; f.panel.render(data);
  assert.equal(f.panel.view.page, 'plugin:demo/c', 'ordering preserves the selected page');
  data.panel.pluginPages = ['demo/a', 'demo/b']; f.panel.render(data);
  assert.equal(f.panel.view.page, 'limits', 'removal falls back to the first remaining ordered page');
});

test('a full trailing lane becomes a pager that keeps its window across pushes', t => {
  const { f, data, leadRail, trailRail, leadTrack, trailTrack, visibleIn } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c', 'demo/d', 'demo/e', 'demo/f']);
  leadRail.clientWidth = 183; trailRail.clientWidth = 112; // L=5, T=3 -> trail pager k=2
  f.resize();
  const back = f.find('is-back'), forward = f.find('is-forward');
  assert.equal(trailTrack.contains(back), true, 'the trailing track is the pager');
  assert.equal(back.disabled, true);
  assert.equal(forward.disabled, false);
  assert.deepEqual(visibleIn(leadTrack), ['home', 'limits', 'sessions', 'breakdown', 'plugin:demo/a']);
  assert.deepEqual(visibleIn(trailTrack), ['plugin:demo/b', 'plugin:demo/c']);
  // A step shifts the window one slot without changing selection or focus.
  forward.fire('click', { detail: 0 });
  assert.deepEqual(visibleIn(trailTrack), ['plugin:demo/c', 'plugin:demo/d']);
  assert.equal(f.panel.view.page, 'home');
  assert.equal(back.disabled, false);
  // A normal data push keeps the window where the user left it.
  f.panel.render(data);
  assert.deepEqual(visibleIn(trailTrack), ['plugin:demo/c', 'plugin:demo/d']);
  // End reaches the last page: the window follows and the button takes focus.
  leadTrack.fire('keydown', { key: 'End', preventDefault() {} });
  assert.equal(f.panel.view.page, 'plugin:demo/f');
  assert.deepEqual(visibleIn(trailTrack), ['plugin:demo/e', 'plugin:demo/f']);
  const last = f.all('notch-tab').find(button => button.dataset.page === 'plugin:demo/f');
  assert.equal(f.document.activeElement, last);
  assert.equal(f.all('notch-tab').filter(button => button.tabIndex === 0).length, 1);
  assert.equal(forward.disabled, true);
});

test('a trailing lane too thin for a pager moves the pager into the leading track', t => {
  const { f, leadRail, trailRail, leadTrack, trailTrack, visibleIn } = pluginPageFixture(t, ['demo/a', 'demo/b', 'demo/c']);
  leadRail.clientWidth = 183; trailRail.clientWidth = 40; // L=5, T=1 -> lead pager k=4
  f.resize();
  const back = f.find('is-back'), forward = f.find('is-forward');
  assert.equal(leadTrack.contains(back), true, 'the leading track is the pager');
  assert.deepEqual(visibleIn(leadTrack), ['home', 'limits', 'sessions', 'breakdown']);
  assert.deepEqual(visibleIn(trailTrack), []);
  forward.fire('click', { detail: 0 });
  assert.deepEqual(visibleIn(leadTrack), ['limits', 'sessions', 'breakdown', 'plugin:demo/a']);
  assert.equal(back.disabled, false);
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
  // Running leads; the waiting session follows.
  assert.deepEqual(active.map(node => node.querySelector('.notch-session-context-fill').style['--bar-scale']), ['0.37', '0.95']);
  assert.equal(active[1].querySelector('.notch-session-context').dataset.tone, 'low');
  assert.equal(page.querySelector('.notch-active-context-fill'), null);
  assert.equal(page.querySelector('.notch-active-cost'), null, 'both priced and partially priced sessions omit cost');
  const runningContext = active[0].querySelector('.notch-session-context');
  assert.deepEqual(runningContext.tooltipEntries.map(entry => entry.full), ['74K / 200K', 'Cache ~29m left']);
  const recent = page.querySelectorAll('.notch-recent');
  assert.equal(recent[0].querySelector('.notch-session-context-value').textContent, '37%', 'a freshly ended turn retains context');
  assert.equal(recent[1].querySelector('.notch-session-cache').textContent, 'Cache 20m');
  assert.equal(recent[1].querySelector('.notch-session-cache').tooltipEntries[0].full, '74K / 200K',
    'a cache badge still names the context size, as the Home list and Edge Dock do');
  assert.equal(recent[2].querySelector('.notch-session-context'), null, 'idle sessions do not revive stale context');
  assert.equal(recent[2].querySelector('.notch-session-cache'), null, 'expired cache stays absent');
  f.settings.sessionContextMetric = 'remaining'; f.state.appearanceKey = 'remaining'; f.panel.render(data);
  const remaining = page.querySelectorAll('.notch-active')[0];
  assert.equal(remaining.querySelector('.notch-session-context-fill').style['--bar-scale'], '0.63');
  assert.equal(remaining.querySelector('.notch-session-context').attributes['aria-valuenow'], '63');
});

for (const client of ['codex', 'claude']) test(`${client} Notch Home, active and recent rows share persistent main-session effort without tooltips`, t => {
  const f = panelFixture(t), data = payload();
  const now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const row = (id, extra) => ({ key: `${client}:${id}`, client, sessionId: id, title: id,
    totalTokens: 100, models: { 'gpt-test': 100 }, startedAt: ago(20), lastUsedAt: ago(1), ...extra });
  const main = row('running', { reasoningEffort: 'high', liveActivity: { state: 'running', observedAt: ago(0) } });
  data.cells[1].sessions = [
    { ...main, models: { 'gpt-test': 100, child: 100 }, groupRows: [main, row('child', { reasoningEffort: 'low' })] },
    row('waiting', { reasoningEffort: 'xhigh', liveActivity: { state: 'waiting', observedAt: ago(0) } }),
    row('idle', { reasoningEffort: 'medium', lastUsedAt: ago(60), turnEnded: true }),
    row('archived', { reasoningEffort: 'high', archived: true, lastUsedAt: ago(120) }),
    row('unknown', { reasoningEffort: null, lastUsedAt: ago(60) })
  ];
  f.panel.render(data);
  const home = f.find('notch-now-meta');
  assert.ok(home.textContent.includes(`${client === 'codex' ? 'Codex' : 'Claude Code'} · 2 models · high`));
  assert.equal(home.querySelector('.session-models').tooltipEntries.length, 2, 'model breakdown retains its tooltip');
  f.panel.selectPage('sessions');
  const page = f.find('notch-page-sessions');
  const active = page.querySelectorAll('.notch-active');
  assert.deepEqual(active.map(node => node.querySelector('.session-reasoning-effort').textContent), ['high', 'xhigh']);
  const recent = page.querySelectorAll('.notch-recent');
  assert.deepEqual(recent.map(node => node.querySelector('.session-reasoning-effort')?.textContent), ['medium', 'high', undefined]);
  assert.equal(recent[0].querySelector('.notch-session-context'), null);
  assert.equal(recent[2].querySelector('.notch-recent-meta').textContent.includes(' ·  · '), false);
  for (const setting of [...home.querySelectorAll('.session-reasoning-effort'), ...page.querySelectorAll('.session-reasoning-effort')]) {
    assert.equal(setting.tooltipEntries, undefined);
    assert.equal(setting.getAttribute('tabindex'), undefined);
    assert.ok(setting.getAttribute('aria-label'));
  }
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

test('week footer marks a missing day and explains it with a centered shared info tooltip', t => {
  const f = panelFixture(t), data = payload();
  f.panel.render(data);
  const summary = f.find('notch-week-foot');
  assert.equal(summary.children.length, 2);
  assert.equal(summary.querySelectorAll('.notch-summary-label').length, 0);
  assert.equal(f.find('notch-week-tokens').textContent, '130');
  assert.equal(f.find('notch-week-tokens').attributes['aria-label'], 'Total usage: 130');
  assert.equal(f.find('notch-week-cost-value').attributes['aria-label'], 'Total cost: $3');
  assert.equal(f.find('notch-week-tokens').tooltipEntries, undefined);
  assert.equal(f.find('notch-week-info'), null);
  data.panel.week.days[0].tokens = null; f.panel.render(data);
  // A day without data keeps its baseline mark; nothing relabels the total.
  assert.equal(f.find('notch-week-bars').querySelectorAll('.is-unknown').length, 1);
  assert.equal(f.find('notch-week-foot').querySelectorAll('.notch-summary-label').length, 0);
  assert.equal(f.find('notch-week-tokens').textContent, '100');
  assert.equal(f.find('notch-week-tokens').tooltipEntries, undefined);
  assert.equal(f.find('notch-week-tokens').attributes['aria-label'], 'Total usage: 100');
  const info = f.find('notch-week-info');
  const trigger = info.querySelector('.limit-detail-tooltip-trigger');
  const tooltip = info.querySelector('.limit-detail-tooltip');
  assert.equal(trigger.textContent, 'i');
  assert.equal(trigger.tabIndex, 0);
  assert.equal(trigger.dataset.focusKey, 'week:history-info');
  assert.match(trigger.attributes['aria-label'], /^Some devices/);
  assert.equal(tooltip.classList.contains('is-centered'), true);
  assert.equal(tooltip.attributes.popover, 'manual');
  assert.equal(tooltip.querySelector('.limit-detail-tooltip-full').textContent,
    'Some devices have not reported their history, so earlier days may be incomplete.');
  assert.equal(tooltip.style['position-anchor'], info.style['anchor-name']);
  assert.equal(f.find('notch-week-cost-value').attributes['aria-label'], 'Total cost: $3');
  data.panel.week.days[0].unpricedTokens = 10; f.panel.render(data);
  assert.equal(f.find('notch-week-cost-value').textContent, '$3');
  assert.match(f.find('notch-week-cost-value').querySelector('.usage-cost-info').tooltipEntries[0].full, /10/);
});

test('a partial device response keeps its total and info icon until history is complete', t => {
  const f = panelFixture(t), data = payload();
  // Every day has a figure, but History came back from only some devices.
  data.panel.week.complete = false; f.panel.render(data);
  assert.equal(f.find('notch-week-foot').querySelectorAll('.notch-summary-label').length, 0);
  assert.equal(f.find('notch-week-info').querySelector('.limit-detail-tooltip').classList.contains('is-centered'), true);
  assert.equal(f.find('notch-week-tokens').attributes['aria-label'], 'Total usage: 130');
  data.panel.week.complete = true; f.panel.render(data);
  assert.equal(f.find('notch-week-info'), null);
  const { notchWeek } = require('../../src/electron/notch/panel');
  assert.equal(notchWeek({}, new Date(2026, 9, 19, 12), { daily: [], complete: false }).complete, false);
  assert.equal(notchWeek({}, new Date(2026, 9, 19, 12), { daily: [], complete: true }).complete, true);
});

test('active sessions retain the shared projection order across running and waiting states', t => {
  const f = panelFixture(t), data = payload();
  const now = Date.now(), ago = minutes => new Date(now - minutes * 60000).toISOString();
  const row = (id, state, minutes) => ({ key: `codex:${id}`, client: 'codex', sessionId: id, title: id, totalTokens: 1,
    lastUsedAt: ago(minutes), liveActivity: { state, observedAt: ago(0) }, ...(state === 'waiting' ? { waitingForInput: true } : {}) });
  data.cells[1].sessions = [row('waiting-a', 'waiting', 1), row('waiting-b', 'waiting', 2), row('running-c', 'running', 3)];
  f.panel.render(data); f.panel.selectPage('sessions');
  const titles = f.find('notch-page-sessions').querySelectorAll('.notch-active').map(node => node.querySelector('.notch-active-title').textContent);
  assert.deepEqual(titles, ['waiting-a', 'waiting-b', 'running-c']);
  assert.equal(f.find('notch-more'), null);
});

test('active sessions remain reachable and retain independent scroll and focus across live updates', t => {
  const f = panelFixture(t), data = payload(), now = Date.now();
  const active = Array.from({ length: 6 }, (_, index) => ({ key: `codex:active-${index}`, client: 'codex',
    sessionId: `active-${index}`, title: `Active ${index + 1}`, totalTokens: index + 1,
    lastUsedAt: new Date(now).toISOString(), liveActivity: { state: 'running', observedAt: new Date(now).toISOString() } }));
  const quiet = Array.from({ length: 5 }, (_, index) => ({ key: `codex:quiet-${index}`, client: 'codex',
    sessionId: `quiet-${index}`, title: `Quiet ${index + 1}`, totalTokens: index + 1, lastUsedAt: '2026-10-17T10:00:00Z' }));
  data.cells[1].sessions = [...active, ...quiet];
  f.panel.render(data); f.panel.selectPage('sessions');
  const page = f.find('notch-page-sessions');
  const list = page.querySelector('.notch-active-list');
  assert.equal(list.querySelectorAll('.notch-active').length, 6);
  assert.equal(list.attributes.role, 'list');
  assert.equal(list.attributes['aria-label'], 'Active');
  assert.equal(list.tabIndex, 0);
  assert.equal(list.querySelectorAll('.notch-active').at(-1).attributes.role, 'listitem');
  list.scrollTop = 150; list.focus();
  page.querySelector('.notch-recent-list').scrollTop = 75;
  active[0].totalTokens += 1; f.panel.render(data);
  assert.equal(page.querySelector('.notch-active-list').scrollTop, 150);
  assert.equal(page.querySelector('.notch-recent-list').scrollTop, 75);
  assert.equal(f.document.activeElement.dataset.focusKey, 'active:list');
  assert.equal(page.querySelectorAll('.notch-active-title').at(-1).textContent, 'Active 6');
  f.panel.selectPage('home');
  for (let reopen = 0; reopen < 2; reopen++) {
    f.panel.suspend();
    f.panel.render(data, { opening: true });
  }
  f.panel.selectPage('sessions');
  assert.equal(page.querySelector('.notch-active-list').scrollTop, 150, 'reopening retains the hidden active list position');
  assert.equal(page.querySelector('.notch-recent-list').scrollTop, 75, 'reopening retains the hidden recent list position');
  data.cells[1].sessions = quiet; f.panel.render(data);
  assert.equal(page.querySelector('.notch-active-list'), null);
  assert.ok(page.querySelector('.notch-sessions-empty'));
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
  f.find('notch-week-bars').fire('pointerleave');
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

test('limits give every account its own column with the Limits view plan and Home window order', t => {
  const f = panelFixture(t);
  const records = [
    { provider: 'codex', status: 'ok', accountKey: 'key:a', accountEmail: 'a@example.test', accountLabel: 'Pro',
      windows: [{ kind: 'weekly', remainingPercent: 70 }, { kind: 'monthly', remainingPercent: 90 }, { kind: 'session', remainingPercent: 60 }] },
    { provider: 'codex', status: 'ok', accountKey: 'key:b', accountEmail: 'b@example.test', accountLabel: 'Plus',
      windows: [{ kind: 'session', remainingPercent: 100 }] }
  ];
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: [{ type: 'limit', provider: 'codex' }] });
  cells[0].accounts[0].active = false; cells[0].accounts[1].active = true;
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.equal(f.all('notch-limit').length, 2);
  // The plan lives in accountLabel, which the panel used to miss.
  assert.deepEqual(f.all('notch-chip').map(node => node.textContent), ['Pro', 'Plus']);
  assert.deepEqual(f.all('notch-limit-account').map(node => node.textContent), ['a@example.test', 'b@example.test']);
  assert.equal(f.all('notch-limit-active').length, 1);
  assert.ok(f.all('notch-limit')[1].contains(f.find('notch-limit-active')));
  // Session before weekly, as Home's limits card orders them; monthly is next,
  // in the same column drawn tighter rather than on a page of its own.
  assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['60', '70', '90', '100']);
  assert.deepEqual(f.all('notch-limit-windows').map(node => node.dataset.count), ['3', '1']);
  assert.equal(f.all('notch-window-page').length, 0);
  // Three slots fill one page exactly, so there is nothing to page through.
  assert.equal(f.all('notch-pager').length, 0);
});

test('a grant measured against an allowance reads as a percentage while a bare balance keeps its money', t => {
  const f = panelFixture(t);
  const { normalizeLimitWindow } = require('../../src/shared/limits/core');
  const records = [
    { provider: 'commandcode', status: 'ok', windows: [normalizeLimitWindow({ kind: 'billing', metric: 'credits', label: 'Monthly',
      remaining: 4.79, limit: 10, used: 5.21, currency: 'USD' })] },
    { provider: 'deepseek', status: 'ok', windows: [normalizeLimitWindow({ kind: 'billing', metric: 'credits', label: 'Balance',
      remaining: 6.86, currency: 'CNY', showMeter: false })] }
  ];
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: records.map(record => ({ type: 'limit', provider: record.provider })) });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['48']);
  assert.equal(f.all('notch-limit-value')[0].attributes['aria-label'], '$4.79 / $10.00');
  assert.equal(f.all('notch-limit-money').length, 1);
  assert.match(f.find('notch-limit-money').textContent, /6\.86/);
});

test('only a column with more than four windows pages them, three at a time beside the page button', t => {
  const f = panelFixture(t);
  const record = { provider: 'codex', status: 'ok', windows: [10, 20, 30, 40, 50].map(remainingPercent => ({ kind: 'weekly', remainingPercent })) };
  const cells = buildEdgeDockCells({ limits: { providers: [record] } }, { items: [{ type: 'limit', provider: 'codex' }] });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['10', '20', '30']);
  assert.equal(f.find('notch-limit-windows').dataset.count, '4');
  assert.equal(f.find('notch-window-page').textContent, '1 / 2');
  f.find('notch-window-page').fire('click', { detail: 0 });
  assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['40', '50']);
});

test('a plan stays beside the name and drops below only when the name would be cut', t => {
  const f = panelFixture(t);
  const records = ['commandcode', 'deepseek'].map(provider => ({ provider, status: 'ok', planLabel: 'Go', windows: [{ kind: 'weekly', remainingPercent: 50 }] }));
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: records.map(record => ({ type: 'limit', provider: record.provider })) });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  const [short, long] = f.all('notch-limit');
  assert.ok(f.all('notch-limit-head').every(head => head.children.some(node => node.classList.contains('notch-chip'))));
  for (const [column, scrollWidth] of [[short, 80], [long, 140]]) {
    const name = column.querySelector('.notch-limit-name');
    name.clientWidth = 100; name.scrollWidth = scrollWidth;
  }
  f.resize();
  assert.ok(short.querySelector('.notch-limit-head').children.some(node => node.classList.contains('notch-chip')));
  assert.ok(long.querySelector('.notch-limit-sub').children.some(node => node.classList.contains('notch-chip')));
  // Room again (a wider panel) brings it back up.
  long.querySelector('.notch-limit-name').scrollWidth = 90;
  f.resize();
  assert.ok(long.querySelector('.notch-limit-head').children.some(node => node.classList.contains('notch-chip')));
});

test('limit columns past one page scroll a page per wheel gesture and keep their page across pushes', t => {
  const f = panelFixture(t);
  const records = Array.from({ length: 4 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: `key:${index}`,
    accountEmail: `${index}@example.test`, windows: [{ kind: 'weekly', remainingPercent: 50 + index }] }));
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: [{ type: 'limit', provider: 'codex' }] });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  const strip = f.find('notch-limits');
  assert.ok(strip.classList.contains('is-paged') && strip.classList.contains('has-after'));
  // Two fillers square off the last page so it can snap flush like the first.
  assert.equal(f.all('notch-limit-filler').length, 2);
  assert.equal(f.find('notch-pager').children.length, 2);
  let prevented = 0;
  const wheel = deltaY => strip.fire('wheel', { deltaX: 0, deltaY, preventDefault: () => { prevented += 1; } });
  wheel(30); wheel(30);
  assert.equal(prevented, 2);
  assert.equal(strip.scrollLeft, 120);
  assert.equal(f.find('notch-pager').children[1].classList.contains('is-selected'), true);
  assert.equal(strip.classList.contains('has-after'), false);
  // A later push rebuilds the strip on the same page.
  records[0].windows[0].remainingPercent = 10;
  f.panel.render({ ...payload(), cells: buildEdgeDockCells({ limits: { providers: records } }, { items: [{ type: 'limit', provider: 'codex' }] }) });
  assert.notEqual(f.find('notch-limits'), strip);
  assert.equal(f.find('notch-limits').scrollLeft, 120);
  // Horizontal swipes stay native; a new vertical gesture steps back.
  f.find('notch-limits').fire('wheel', { deltaX: 40, deltaY: 2, preventDefault: () => { prevented += 1; } });
  assert.equal(prevented, 2);
  t.mock.timers.tick(200);
  f.find('notch-limits').fire('wheel', { deltaX: 0, deltaY: -30, preventDefault() {} });
  assert.equal(f.find('notch-limits').scrollLeft, 0);
});


test('the first limits wheel gesture works after a quick close and reopen', t => {
  const f = panelFixture(t);
  const providers = Array.from({ length: 4 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: String(index),
    windows: [{ kind: 'weekly', remainingPercent: 50 }] }));
  const data = { ...payload(), cells: buildEdgeDockCells({ limits: { providers } }, { items: [{ type: 'limit', provider: 'codex' }] }) };
  f.panel.render(data); f.panel.selectPage('limits');
  const wheel = deltaY => f.find('notch-limits').fire('wheel', { deltaX: 0, deltaY, preventDefault() {} });
  wheel(30);
  assert.equal(f.panel.view.limitPage, 1);
  f.panel.suspend();
  t.mock.timers.tick(250);
  f.panel.render(data, { opening: true });
  wheel(-30);
  assert.equal(f.panel.view.limitPage, 0);
});

function swipe(f, id, phase, amount, complete = false, hit = 'page') {
  if (phase === 'began') f.document.elementFromPoint = () => f.find(hit === 'strip' ? 'notch-limits' : 'notch-band');
  f.scroll({ id, phase, amount, complete, x: 0, y: 0 });
}

function assertPageMotionCleared(f) {
  for (const page of f.all('notch-page')) {
    assert.deepEqual([page.style.opacity, page.style.transform, page.style.filter], ['', '', '']);
  }
}

test('native pages slide with a fixed gap and settle without momentum', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  const pill = f.find('notch-tab-pill');
  let layoutReads = 0;
  Object.defineProperty(pill, 'offsetWidth', { get() { layoutReads++; return 36; } });
  f.panel.render(payload(150));
  assert.equal(layoutReads, 0, 'ordinary pushes do not force the tab highlight layout');
  swipe(f, 1, 'began', 0);
  swipe(f, 1, 'changed', 0.4);
  assert.equal(Number(f.find('notch-page-home').style.opacity), 1);
  assert.equal(Number(f.find('notch-page-limits').style.opacity), 1);
  const pageX = page => Number(f.find(`notch-page-${page}`).style.transform.match(/translateX\(([-\d.]+)px\)/)[1]);
  assert.equal(pageX('home'), -256);
  assert.equal(pageX('limits') - pageX('home') - 600, 40, 'neighboring pages retain their content gap');
  assert.equal(f.find('notch-page-home').style.filter, 'none');
  swipe(f, 1, 'changed', 0);
  assert.equal(pageX('home'), 0);
  assert.equal(pageX('limits'), 640, 'returning to zero keeps the neighbor outside the viewport');
  swipe(f, 1, 'changed', 0.4);
  f.panel.render(payload(200));
  assert.equal(pageX('limits'), 384, 'a live data push preserves swipe progress');
  swipe(f, 1, 'ended', 0.4);
  swipe(f, 1, 'none', 1, true);
  assert.equal(f.panel.view.page, 'limits');
  assert.equal(pill.style.transition, '', 'completion restores the normal tab transition');
  assertPageMotionCleared(f);
});

test('swipes prepare only the target and refresh hidden data when selected', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  swipe(f, 1, 'began', 0.2);
  assert.ok(f.find('notch-page-limits').children.length > 0);
  assert.equal(f.find('notch-page-sessions').children.length, 0);
  assert.equal(f.find('notch-page-breakdown').children.length, 0);
  swipe(f, 1, 'ended', 0.2);
  swipe(f, 1, 'none', 1, true);
  const homeText = f.find('notch-page-home').textContent;
  f.panel.render(payload(300));
  assert.equal(f.find('notch-page-home').textContent, homeText);
  f.panel.selectPage('home');
  assert.equal(f.find('notch-big').textContent, '300');
  f.panel.selectPage('sessions');
  assert.equal(f.find('notch-page-breakdown').children.length, 0);
});

test('a native cancellation returns to the origin and clears the preview', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  swipe(f, 1, 'began', 0.1);
  swipe(f, 1, 'cancelled', 0.2);
  swipe(f, 1, 'none', 0, true);
  assert.equal(f.panel.view.page, 'home');
  assert.equal(f.find('notch-pages').classList.contains('is-handoff'), false);
  assertPageMotionCleared(f);
});

test('reduced motion settles pages and accounts when fingers lift', t => {
  const f = panelFixture(t, { reduceMotion: true });
  const providers = Array.from({ length: 4 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: String(index),
    windows: [{ kind: 'weekly', remainingPercent: 50 }] }));
  f.panel.render({ ...payload(), cells: buildEdgeDockCells({ limits: { providers } }, { items: [{ type: 'limit', provider: 'codex' }] }) });
  swipe(f, 1, 'began', 0.3);
  swipe(f, 1, 'ended', 0.3);
  assert.equal(f.panel.view.page, 'limits');
  assertPageMotionCleared(f);
  swipe(f, 1, 'none', 0.7);
  assertPageMotionCleared(f);
  swipe(f, 1, 'none', 1, true);
  swipe(f, 2, 'began', 0.4, false, 'strip');
  swipe(f, 2, 'ended', 0.4, false, 'strip');
  assert.equal(f.panel.view.limitPage, 1);
  assert.equal(f.find('notch-limits').scrollLeft, 120);
  swipe(f, 2, 'none', 0.7);
  assert.equal(f.find('notch-limits').scrollLeft, 120);
  swipe(f, 2, 'none', 1, true);
  swipe(f, 3, 'began', -0.4, false, 'strip');
  swipe(f, 3, 'cancelled', -0.4, false, 'strip');
  assert.equal(f.panel.view.limitPage, 1);
  assert.equal(f.find('notch-pages').classList.contains('is-handoff'), false);
  assertPageMotionCleared(f);
});

test('a new finger gesture interrupts the old animation at its decided page', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  swipe(f, 1, 'began', 0.1);
  swipe(f, 1, 'ended', 0.3);
  swipe(f, 2, 'began', 0.1);
  assert.equal(f.panel.view.page, 'limits');
  swipe(f, 2, 'ended', 0.3);
  swipe(f, 2, 'none', 1, true);
  assert.equal(f.panel.view.page, 'sessions');
});

test('main-page endpoints stay visible and a reverse swipe remains available', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  swipe(f, 1, 'began', -0.5);
  assert.equal(Number(f.find('notch-page-home').style.opacity), 1);
  assert.equal(Number(f.find('notch-page-breakdown').style.opacity), 0);
  assert.equal(f.find('notch-page-limits').children.length, 0);
  swipe(f, 1, 'ended', -0.5);
  swipe(f, 1, 'none', -1, true);
  assert.equal(f.panel.view.page, 'home');
  swipe(f, 2, 'began', 0.5);
  swipe(f, 2, 'ended', 0.5);
  swipe(f, 2, 'none', 1, true);
  assert.equal(f.panel.view.page, 'limits');
  f.panel.selectPage('breakdown');
  swipe(f, 3, 'began', 0.5);
  assert.equal(Number(f.find('notch-page-breakdown').style.opacity), 1);
  assert.equal(Number(f.find('notch-page-home').style.opacity), 0);
  swipe(f, 3, 'ended', 0.5);
  swipe(f, 3, 'none', 1, true);
  assert.equal(f.panel.view.page, 'breakdown');
  swipe(f, 4, 'began', -0.5);
  swipe(f, 4, 'ended', -0.5);
  swipe(f, 4, 'none', -1, true);
  assert.equal(f.panel.view.page, 'sessions');
});

test('account paging has priority, then the next gesture leaves its edge', t => {
  const f = panelFixture(t);
  const providers = Array.from({ length: 4 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: String(index),
    windows: [{ kind: 'weekly', remainingPercent: 50 }] }));
  f.panel.render({ ...payload(), cells: buildEdgeDockCells({ limits: { providers } }, { items: [{ type: 'limit', provider: 'codex' }] }) });
  f.panel.selectPage('limits');
  const strip = f.find('notch-limits');
  swipe(f, 1, 'began', 0.4, false, 'strip');
  assert.equal(strip.scrollLeft, 48);
  swipe(f, 1, 'ended', 0.4, false, 'strip');
  swipe(f, 2, 'began', 0.2, false, 'strip');
  assert.equal(strip.scrollLeft, 120);
  assert.equal(f.panel.view.page, 'limits');
  swipe(f, 2, 'ended', 0.2, false, 'strip');
  swipe(f, 2, 'none', 1, true, 'strip');
  assert.equal(f.panel.view.page, 'sessions');
});

test('one gesture can reverse between account and main pages without retaining either preview', t => {
  const f = panelFixture(t);
  const providers = Array.from({ length: 4 }, (_, index) => ({ provider: 'codex', status: 'ok', accountKey: String(index),
    windows: [{ kind: 'weekly', remainingPercent: 50 }] }));
  f.panel.render({ ...payload(), cells: buildEdgeDockCells({ limits: { providers } }, { items: [{ type: 'limit', provider: 'codex' }] }) });
  f.panel.selectPage('limits');
  const strip = f.find('notch-limits');
  const tabPosition = f.find('notch-tab-pill').style.transform;
  f.document.elementFromPoint = () => strip.children[0];
  f.scroll({ id: 1, phase: 'began', amount: -0.4, x: 0, y: 0 });
  assert.equal(Number(f.find('notch-page-home').style.opacity), 1);
  swipe(f, 1, 'changed', 0.2);
  assert.equal(Number(f.find('notch-page-home').style.opacity), 0);
  assert.equal(Number(f.find('notch-page-limits').style.opacity), 1);
  assert.equal(f.find('notch-tab-pill').style.transform, tabPosition);
  assert.equal(strip.scrollLeft, 24);
  swipe(f, 1, 'changed', -0.3);
  assert.equal(strip.scrollLeft, 0, 'returning to main pages restores the account origin');
  swipe(f, 1, 'cancelled', -0.3);
  swipe(f, 1, 'none', 0, true);
  assert.equal(f.panel.view.page, 'limits');
  assert.equal(f.panel.view.limitPage, 0);
  strip.scrollTo({ left: 120 });
  swipe(f, 2, 'began', 0.4, false, 'strip');
  swipe(f, 2, 'changed', -0.2);
  assert.equal(Number(f.find('notch-page-sessions').style.opacity), 0);
  assert.equal(strip.scrollLeft, 96);
  swipe(f, 2, 'changed', 0.3);
  assert.equal(strip.scrollLeft, 120);
  swipe(f, 2, 'ended', 0.3);
  swipe(f, 2, 'none', 1, true);
  assert.equal(f.panel.view.page, 'sessions');
  assert.equal(f.panel.view.limitPage, 1);
});

test('tab changes and collapse ignore remaining native animation frames', t => {
  const f = panelFixture(t);
  f.panel.render(payload());
  swipe(f, 1, 'began', 0.5);
  f.panel.selectPage('breakdown');
  assertPageMotionCleared(f);
  swipe(f, 1, 'none', 1, true);
  assert.equal(f.panel.view.page, 'breakdown');
  swipe(f, 2, 'began', -0.5);
  f.panel.suspend();
  swipe(f, 2, 'ended', -0.5);
  swipe(f, 2, 'none', -1, true);
  f.panel.render(payload());
  assert.equal(f.panel.view.page, 'breakdown');
  assertPageMotionCleared(f);
  swipe(f, 3, 'began', -0.5);
  f.pageHide();
  assert.equal(f.scrollSubscribed, false);
  assertPageMotionCleared(f);
});

test('limit boundaries use the Limits view wording, so an expiring grant never reads as a reset', t => {
  const f = panelFixture(t);
  const now = Date.now(), hours = h => new Date(now + h * 3600000).toISOString();
  const record = { provider: 'kiro', status: 'ok', windows: [
    { kind: 'session', remainingPercent: 60, resetsAt: hours(3) },
    { kind: 'monthly', remainingPercent: 40, resetsAt: hours(48), boundaryKind: 'expiry' },
    { kind: 'weekly', remainingPercent: 20, resetsAt: hours(5), boundaryKind: 'mixed' }
  ] };
  const cells = buildEdgeDockCells({ limits: { providers: [record] } }, { items: [{ type: 'limit', provider: 'kiro' }] });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  assert.deepEqual(f.all('notch-limit-reset').map(node => node.textContent), ['Reset 3h 0m', 'Changes in 5h 0m', 'Expires 2d 0h']);
});

test('the week chart keeps its layout rules off the collapsed summary bars', () => {
  const css = require('node:fs').readFileSync(require('node:path').join(__dirname, '../../src/electron/renderer/notch/notch.css'), 'utf8');
  for (const [, selector, body] of css.matchAll(/([^{}]+)\{([^}]*)\}/g)) {
    if (!/\.notch-bars\b/.test(selector)) continue;
    assert.doesNotMatch(body, /grid|height/, `${selector.trim()} must not size the summary bars`);
  }
});

test('windows hidden on the Limits page stay hidden on Limits and Home', t => {
  const { limitUsageItemId } = require('../../src/shared/limits/usageItems');
  const f = panelFixture(t, { limitProviderHiddenItems: { claude: [limitUsageItemId({ kind: 'weekly' }, 'claude')] } }), data = payload();
  const record = { provider: 'claude', status: 'ok', windows: [{ kind: 'session', remainingPercent: 60 }, { kind: 'weekly', remainingPercent: 10 }] };
  data.cells.push(...buildEdgeDockCells({ limits: { providers: [record] } }, { items: [{ type: 'limit', provider: 'claude' }] }));
  f.panel.render(data);
  assert.deepEqual(f.all('notch-fuel-value').map(node => node.textContent), ['60%']);
  f.panel.selectPage('limits');
  assert.deepEqual(f.all('notch-limit-number').map(node => node.textContent), ['60']);
});

test('a cached offline reading says Stale with the Limits view wording and dims its figures', t => {
  const f = panelFixture(t);
  const at = new Date(Date.now() - 55 * 60000).toISOString();
  const records = [
    { provider: 'claude', status: 'ok', stale: true, updatedAt: at, windows: [{ kind: 'session', remainingPercent: 60 }] },
    ...['a', 'b'].map(id => ({ provider: 'codex', status: 'ok', stale: id === 'b', updatedAt: at, accountKey: `key:${id}`,
      accountEmail: `${id}@example.test`, windows: [{ kind: 'weekly', remainingPercent: 50 }] }))
  ];
  const cells = buildEdgeDockCells({ limits: { providers: records } }, { items: [{ type: 'limit', provider: 'claude' }, { type: 'limit', provider: 'codex' }] });
  f.panel.render({ ...payload(), cells }); f.panel.selectPage('limits');
  const [claude, codexA, codexB] = f.all('notch-limit');
  assert.equal(claude.querySelector('.notch-limit-updated').textContent, 'Stale · 55m ago');
  assert.equal(claude.dataset.tone, 'stale');
  assert.equal(codexA.dataset.tone, undefined);
  assert.equal(codexA.querySelector('.notch-limit-stale'), null);
  assert.equal(codexB.querySelector('.notch-limit-stale').textContent, 'Stale');
  assert.equal(codexB.querySelector('.notch-limit-stale').attributes['aria-label'], 'Stale · 55m ago');
  f.state.locale = 'zh-TW'; f.state.appearanceKey = 'zh'; f.panel.render({ ...payload(), cells });
  assert.equal(f.all('notch-limit')[2].querySelector('.notch-limit-stale').textContent, 'Stale', 'matches the Limits view on every locale');
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

test('partial pricing retains the shared known subtotal and info disclosure on Home, week and Breakdown', t => {
  const f = panelFixture(t, {}, { viaRenderer: true }), data = payload();
  data.cells[0].costUsd = 12;
  data.cells[0].unpricedTokens = 40;
  data.panel.week.days[0].unpricedTokens = 10;
  f.panel.render(data);
  const check = (name, cost, tokens) => {
    const node = f.find(name), info = node.querySelector('.usage-cost-info');
    assert.equal(node.textContent, cost);
    assert.equal(info.tooltipEntries[0].full, `${tokens} tokens excluded from the cost estimate`);
    assert.deepEqual(info.tooltipOptions, { centered: true });
  };
  check('notch-cost', '$12', 40);
  check('notch-week-cost-value', '$13', 50);
  const bars = f.find('notch-week-bars');
  bars.children[0].fire('pointerenter');
  check('notch-cost', '$1', 10);
  bars.fire('pointerleave');
  check('notch-cost', '$12', 40);
  data.panel.week.days[0].unpricedTokens = 0; f.panel.render(data);
  f.find('notch-week-bars').children[0].fire('pointerenter');
  assert.equal(f.find('notch-cost').textContent, '$1');
  assert.equal(f.find('notch-cost').querySelector('.usage-cost-info'), null);
  f.find('notch-week-bars').fire('pointerleave');
  check('notch-cost', '$12', 40);
  f.panel.selectPage('breakdown');
  check('notch-breakdown-cost', '$12', 40);
  data.cells.push({ id: 'stat:month', available: true, totalTokens: 500, costUsd: 20, unpricedTokens: 80, clients: [], models: [] });
  f.find('notch-breakdown-period').querySelectorAll('button')[1].fire('click', { detail: 0 });
  check('notch-breakdown-cost', '$20', 80);
});

test('cost readouts distinguish all-unpriced, priced zero, and fully priced usage without stale info', t => {
  const f = panelFixture(t), data = payload();
  data.cells[0].costUsd = 0;
  data.cells[0].unpricedTokens = 40;
  data.panel.week.days[0].costUsd = 0;
  f.panel.render(data);
  assert.equal(f.find('notch-cost').textContent, '—');
  assert.equal(f.find('notch-week-cost-value').textContent, '—');
  assert.ok(f.find('notch-cost').querySelector('.usage-cost-info'));
  f.panel.selectPage('breakdown');
  assert.equal(f.find('notch-breakdown-cost').textContent, '—');
  assert.ok(f.find('notch-breakdown-cost').querySelector('.usage-cost-info'));
  data.cells[0].unpricedTokens = 0;
  f.panel.render(data);
  assert.equal(f.find('notch-breakdown-cost').textContent, '$0');
  assert.equal(f.find('notch-breakdown-cost').querySelector('.usage-cost-info'), null);
  f.panel.selectPage('home');
  assert.equal(f.find('notch-cost').textContent, '$0');
  assert.equal(f.find('notch-cost').querySelector('.usage-cost-info'), null);
  assert.equal(f.find('notch-week-cost-value'), null);
  data.cells[0].costUsd = 12;
  f.panel.render(data);
  assert.equal(f.find('notch-cost').textContent, '$12');
  assert.equal(f.find('notch-cost').querySelector('.usage-cost-info'), null);
  assert.equal(f.find('notch-week-cost-value').textContent, '$12');
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
  cache.read(at('a'), { generation: 1, now: DAY }); await Promise.resolve();
  pending[0]({ daily: [{ date: '2026-10-15' }], fixedPeriods: { historyTransportAvailable: true }, devicesComplete: false });
  await new Promise(setImmediate);
  assert.equal(cache.read(at('a'), { generation: 1, now: DAY }).complete, false, 'a device without History keeps absent days unknown');
  clock = 1000;
  assert.equal(cache.read(at('b'), { generation: 1, now: DAY }).daily[0].date, '2026-10-15', 'a new revision keeps the shown week');
  assert.equal(pending.length, 1, 'reloads wait for the throttle');
  assert.equal(timers.at(-1).ms, 59000);
  clock = 61000;
  assert.equal(cache.read(at('b'), { generation: 1, now: DAY }).daily[0].date, '2026-10-15');
  await Promise.resolve();
  assert.equal(pending.length, 2);
  pending[1]({ daily: [{ date: '2026-10-16' }], fixedPeriods: { historyTransportAvailable: true }, devicesComplete: true });
  await new Promise(setImmediate);
  const fresh = cache.read(at('b'), { generation: 1, now: DAY });
  assert.equal(fresh.daily[0].date, '2026-10-16');
  assert.equal(fresh.complete, true);
  assert.equal(cache.read(at('b'), { generation: 2, now: DAY }), null, 'a backend switch drops the answer');
});

test('Notch can hide built-ins, switch to the first selected page, and hide all pages', t => {
  const f = panelFixture(t);
  const data = payload();
  data.panel.builtinPages = ['limits', 'breakdown'];
  f.panel.render(data);
  assert.equal(f.panel.view.page, 'limits');
  assert.equal(f.all('notch-tab').filter(button => !button.hidden).length, 2);
  f.panel.selectPage('home');
  assert.equal(f.panel.view.page, 'limits', 'hidden pages cannot be selected');
  data.panel.builtinPages = ['breakdown']; f.panel.render(data);
  assert.equal(f.panel.view.page, 'breakdown');
  data.panel.builtinPages = []; f.panel.render(data);
  assert.equal(f.panel.view.page, '');
  assert.equal(f.all('notch-page').filter(page => page.classList.contains('is-selected')).length, 0);
  data.panel.builtinPages = ['home']; f.panel.render(data);
  assert.equal(f.panel.view.page, 'home');
});


test('native swipes follow mixed selected order and release cancelled plugin previews', t => {
  let mounts = 0, releases = 0;
  const pluginHost = { state: () => ({ title: 'Plugin' }), mount() { mounts++; }, refreshDemand() { releases++; } };
  const f = panelFixture(t, {}, { pluginHost });
  const data = payload();
  data.panel.builtinPages = ['home', 'breakdown'];
  data.panel.pluginPages = ['demo/chart'];
  data.panel.pageOrder = ['home', 'plugin:demo/chart', 'breakdown'];
  f.panel.render(data);
  swipe(f, 1, 'began', 0.4);
  assert.ok(mounts > 0);
  swipe(f, 1, 'cancelled', 0.4);
  swipe(f, 1, 'none', 0, true);
  assert.equal(f.panel.view.page, 'home');
  assert.equal(f.all('notch-page-plugin')[0].children.length, 0);
  assert.ok(releases > 0);
  swipe(f, 2, 'began', 0.4);
  swipe(f, 2, 'ended', 0.4);
  swipe(f, 2, 'none', 1, true);
  assert.equal(f.panel.view.page, 'plugin:demo/chart');
  swipe(f, 3, 'began', 0.4);
  data.panel.pluginPages = [];
  f.panel.render(data);
  swipe(f, 3, 'none', 1, true);
  assert.equal(f.panel.view.page, 'home', 'removing a page cancels the old gesture');
});

test('cached native page selection refreshes plugin demand after updating page activity', t => {
  const active = [];
  let f;
  const pluginHost = { refreshDemand() { if (f) active.push(f.all('notch-page').filter(node => !node.inert).map(node => node.dataset.page)); } };
  f = panelFixture(t, {}, { pluginHost }); f.panel.render(payload());
  f.panel.selectPage('limits'); f.panel.selectPage('home');
  const before = active.length;
  f.panel.selectPage('limits');
  assert.ok(active.length > before, 'cached content must still publish its activity change');
  assert.deepEqual(active.at(-1), ['limits']);
});

test('plugin navigation artwork arrives from metadata before page mount and refreshes', t => {
  const pluginViews = require('../../src/electron/renderer/pluginViews');
  let mounts = 0;
  const f = panelFixture(t, {}, { pluginViews, pluginHost: { state: () => null, mount() { mounts++; }, refreshDemand() {} } });
  const data = payload(); data.panel.pluginPages = ['demo/panel'];
  data.panel.pluginCatalog = { 'demo/panel': { title: 'Demo', icon: 'cpu', identityIcon: 'data:image/png;base64,fixture' } };
  f.panel.render(data);
  const icon = f.all('notch-tab-plugin-icon')[0];
  assert.equal(icon.querySelector('img')?.src, data.panel.pluginCatalog['demo/panel'].identityIcon);
  assert.equal(mounts, 0);
  data.panel.pluginCatalog['demo/panel'].identityIcon = '';
  f.panel.render(data);
  assert.equal(icon.querySelector('img'), null);
  assert.ok(icon.querySelector('svg'));
});

test('plugin tools use the top status lane without a second title row and unmount on exit', t => {
  const mounts = [], unmounted = [];
  const f = panelFixture(t, {}, { pluginHost: {
    state: () => ({ title: 'Author page' }),
    mount(...args) { mounts.push(args); },
    unmount(container) { unmounted.push(container); },
    refreshDemand() {}
  } });
  const data = payload(); data.panel.pluginPages = ['demo/panel'];
  f.panel.render(data); f.panel.selectPage('plugin:demo/panel');
  const mount = mounts.find(args => args[1] === 'demo/panel');
  assert.ok(mount);
  assert.equal(mount[2], 'notch');
  const slot = mount[3].headerActions;
  assert.equal(slot.className, 'notch-plugin-header-actions');
  assert.equal(slot.parentNode, f.find('notch-band-trailing'));
  assert.equal(slot.parentNode.querySelector('.notch-status'), f.find('notch-status'));
  assert.equal(slot.hidden, false);
  assert.equal(f.find('notch-page-plugin').children.length, 1, 'full page body, no duplicate heading');
  assert.notEqual(slot.parentNode, mount[0]);
  f.panel.render(data);
  assert.equal(mounts.length, 1, 'ordinary pushes retain tools and focus');
  f.panel.selectPage('home');
  assert.equal(slot.parentNode, null);
  assert.deepEqual(unmounted, [mount[0]]);
  assert.equal(f.all('notch-page-plugin')[0].children.length, 0);
  f.panel.selectPage('plugin:demo/panel');
  const next = mounts.at(-1)[3].headerActions;
  assert.notEqual(next, slot);
  f.panel.suspend();
  assert.equal(next.parentNode, null);
  f.panel.render(data, { opening: true });
  assert.equal(mounts.at(-1)[3].headerActions.hidden, false);
  data.panel.pluginPages = [];
  f.panel.render(data);
  assert.equal(f.all('notch-plugin-header-actions').length, 0);
  assert.equal(f.panel.view.page, 'home');
});

test('swipe previews keep plugin header tools hidden until the page is selected', t => {
  const mounts = [];
  const f = panelFixture(t, {}, { pluginHost: {
    state: () => ({ title: 'Preview' }), mount(...args) { mounts.push(args); }, refreshDemand() {}
  } });
  const data = payload(); data.panel.builtinPages = ['home']; data.panel.pluginPages = ['demo/panel'];
  f.panel.render(data);
  swipe(f, 1, 'began', 0.4);
  assert.equal(mounts.length, 1);
  assert.equal(mounts[0][3].headerActions.hidden, true);
  f.scroll({ id: 1, phase: 'cancelled', amount: 0, complete: true });
  assert.equal(mounts[0][3].headerActions.parentNode, null);
  f.panel.selectPage('plugin:demo/panel');
  assert.equal(mounts.at(-1)[3].headerActions.hidden, false);
});
