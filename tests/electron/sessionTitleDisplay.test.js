'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { withoutSessionTitles, withoutSessionTitleStats } = require('../../src/electron/sessionTitleDisplay');
const { createStatsPresentationCache } = require('../../src/electron/statsPublisher');
const modelAliases = require('../../src/electron/modelAliasPresentation');
const { classifySettingsChange, usageConfigFromSettings } = require('../../src/electron/runtimeConfig');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');

const AT = '2026-10-02T08:00:00.000Z';
function session() {
  return { client: 'codex', sessionId: 's', title: 'Private title', totalTokens: 42,
    costUsd: 0.1, lastUsedAt: AT, models: { 'gpt-5': 42 }, contextTokens: 20,
    contextWindow: 100, turnEnded: true, sessionKind: 'background-review' };
}

test('hiding titles copies display paths and leaves stored sessions and other metadata intact', () => {
  const row = Object.freeze({ ...session(), preview: 'Private preview' });
  const period = Object.freeze({ sessions: Object.freeze({ s: row }) });
  const limits = Object.freeze({ providers: [] });
  const stats = Object.freeze({ periods: { today: period, allTime: period }, limits,
    nativeSessions: { today: { s: { ...row, topicTitle: 'Private topic' } } },
    devices: [{ today: period, month: period }] });
  const hidden = withoutSessionTitleStats(stats);
  assert.doesNotMatch(JSON.stringify(hidden), /Private/);
  assert.equal(row.title, 'Private title');
  assert.equal(hidden.periods.today.sessions.s.totalTokens, 42);
  assert.equal(hidden.periods.today.sessions.s.contextTokens, 20);
  assert.equal(hidden.periods.today.sessions.s.turnEnded, true);
  assert.equal(hidden.periods.today.sessions.s.sessionKind, 'background-review');
  assert.strictEqual(hidden.limits, limits);
  assert.strictEqual(withoutSessionTitleStats(hidden), hidden);
  assert.strictEqual(withoutSessionTitles(hidden.periods.today.sessions), hidden.periods.today.sessions);
});

test('main presentation caches restore titles from the same snapshot when re-enabled', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const context = {
    settings: {}, ...modelAliases, withoutSessionTitles, withoutSessionTitleStats,
    presentationCache: createStatsPresentationCache(), allTimeSessionsCache: createStatsPresentationCache(),
    snapshotLocalDevices: new WeakMap(), syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: (value) => value, completeLocalSyncStats: (value) => value
  };
  const presentationStart = source.indexOf('function electronPresentationStats(');
  const presentationEnd = source.indexOf('\nconst allTimeSessionsCache', presentationStart);
  const allTimeStart = source.indexOf('function rendererAllTimeSessions(');
  const allTimeEnd = source.indexOf('\nlet codexPresentationPendingSince', allTimeStart);
  vm.runInNewContext(`${source.slice(presentationStart, presentationEnd)}\n${source.slice(allTimeStart, allTimeEnd)}`, context);
  const row = Object.freeze(session());
  const stats = { periods: { today: { sessions: { s: row } }, allTime: { sessions: { s: row } } } };
  for (const enabled of [undefined, false, true]) {
    context.settings = { sessionTitlesEnabled: enabled };
    const shown = context.electronPresentationStats(stats);
    assert.equal(shown.periods.today.sessions.s.title, enabled === false ? undefined : 'Private title');
    assert.equal(context.rendererAllTimeSessions(stats).s.title, enabled === false ? undefined : 'Private title');
    assert.strictEqual(context.electronPresentationStats(stats), shown, 'each display policy reuses its projection');
    assert.equal(row.title, 'Private title', 'the same collected snapshot retains its title');
  }
});

test('saving the title preference immediately republishes Today and Home data from main', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const projectionStart = source.indexOf('function electronPresentationStats(');
  const projectionEnd = source.indexOf('\nconst allTimeSessionsCache', projectionStart);
  const refreshStart = source.indexOf('function refreshLimitStatsPresentation(');
  const refreshEnd = source.indexOf('\nfunction sendMimoAccountsPush(', refreshStart);
  const updateStart = source.indexOf('    pushSettingsToRenderer();\n    if (settings.sessionTitlesEnabled');
  const updateEnd = source.indexOf('    return settingsForRenderer();', updateStart);
  assert.ok(projectionStart >= 0 && projectionEnd > projectionStart);
  assert.ok(refreshStart >= 0 && refreshEnd > refreshStart);
  assert.ok(updateStart >= 0 && updateEnd > updateStart);
  const events = [];
  const noop = () => {};
  let adopted;
  const original = { periods: { today: { sessions: { 'codex:s': session() } }, month: { sessions: {} } } };
  const context = {
    settings: { sessionTitlesEnabled: false }, previousSettingsState: { sessionTitlesEnabled: true },
    latestStats: original, mode: 'local', ...modelAliases, withoutSessionTitleStats,
    presentationCache: createStatsPresentationCache(), syncProvenanceActive: () => false,
    projectLimitStatsForDisplay: value => value,
    migrateCodexAdditionalLimits: noop, scheduleMacWidgetSnapshot: noop, captureMacWidgetProducerOwner: noop,
    repaintEdgeDockCells: noop, updateTrayDisplay: noop,
    rendererSnapshots: { stamp: (_raw, value) => value }, rendererStats: value => value,
    pushSettingsToRenderer() { events.push('settings'); },
    mainWindow: { isDestroyed: () => false, webContents: { send(_channel, payload) {
      events.push('stats'); adopted = payload.data.stats;
    } } }
  };
  vm.runInNewContext(`${source.slice(projectionStart, projectionEnd)}\n${source.slice(refreshStart, refreshEnd)}\nfunction saveDisplayPreference() {${source.slice(updateStart, updateEnd)}}`, context);
  for (const enabled of [false, true]) {
    context.previousSettingsState = { sessionTitlesEnabled: !enabled };
    context.settings = { sessionTitlesEnabled: enabled };
    context.saveDisplayPreference();
    assert.equal(adopted.periods.today.sessions['codex:s'].title, enabled ? 'Private title' : undefined,
      'Today and Home receive the restored title without another collection tick');
    assert.deepEqual(events.splice(0), ['settings', 'stats']);
    assert.equal(original.periods.today.sessions['codex:s'].title, 'Private title');
  }
});

test('changing title display does not reconfigure usage collection', () => {
  const enabled = { clients: 'codex', sessionTitlesEnabled: true };
  const hidden = { ...enabled, sessionTitlesEnabled: false };
  assert.deepEqual(usageConfigFromSettings(hidden), usageConfigFromSettings(enabled));
  const change = classifySettingsChange(enabled, hidden);
  assert.equal(change.usageStructural, false);
  assert.equal(change.modeStructural, false);
  assert.equal(change.sinkStructural, false);
  assert.equal(change.limitsReconfigure, false);
  assert.deepEqual(change.limitScopes, []);
});

test('titles continue to reach archive capture while hidden', () => {
  const captured = [];
  const transform = createUsageTransform({
    getSettings: () => ({ sessionTitlesEnabled: false, projectsEnabled: false }),
    store: { capture(value) { captured.push(value); return { archive: { version: 1, sessions: {} } }; } }
  });
  const summary = { updatedAt: AT, today: { sessions: { 'codex:s': session() } } };
  const collected = transform.transform(summary);
  assert.equal(captured[0].today.sessions['codex:s'].title, 'Private title');
  assert.equal(collected.today.sessions['codex:s'].title, 'Private title');
  assert.equal(withoutSessionTitleStats(collected).today.sessions['codex:s'].title, undefined);
  assert.equal(captured[0].today.sessions['codex:s'].title, 'Private title');
});

test('a stats response started before hiding titles adopts the current display preference', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  let resolveStats;
  let rendered = 0;
  const state = { settings: {}, stats: null };
  const noop = () => {};
  const context = {
    state, window: { TokenMonitorSessionTitleDisplay: { withoutSessionTitleStats },
      tokenMonitor: { getStats: () => new Promise(resolve => { resolveStats = resolve; }) } },
    allTimeSessions: { invalidate: noop, attach: value => value },
    observeLiveTokenRate: noop, observeDisplayLiveTokenRates: noop, applyCodexActiveAccountFromStats: noop,
    fixedPeriodRangesApi: { isDerived: () => false }, warmFixedPeriodHistory: async () => {},
    statsRenderScheduler: { request: () => { rendered += 1; } }, maybeUpdateBarsIcon: noop, console
  };
  const displayStart = source.indexOf('function sessionStatsForDisplay(');
  const displayEnd = source.indexOf('\nfunction setRendererSettings(', displayStart);
  const refreshStart = source.indexOf('async function refreshStats(');
  const refreshEnd = source.indexOf('\nasync function refreshStatusViewManually(', refreshStart);
  vm.runInNewContext(`${source.slice(displayStart, displayEnd)}\n${source.slice(refreshStart, refreshEnd)}`, context);
  const pending = context.refreshStats();
  state.settings.sessionTitlesEnabled = false;
  const original = { periods: { today: { sessions: { s: session() } } } };
  resolveStats(original);
  await pending;
  assert.equal(state.stats.periods.today.sessions.s.title, undefined);
  assert.equal(state.stats.periods.today.sessions.s.totalTokens, 42);
  assert.equal(original.periods.today.sessions.s.title, 'Private title');
  assert.equal(rendered, 1);
});
