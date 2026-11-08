'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const preferences = require('../../src/electron/renderer/homeModulePreferences');
const overview = require('../../src/electron/renderer/homeOverview');
const i18n = require('../../src/electron/renderer/i18n');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function source(name, next) {
  const start = app.indexOf(`function ${name}(`);
  assert.ok(start >= 0, `${name} exists`);
  const end = app.indexOf(`function ${next}(`, start);
  assert.ok(end > start, `${next} follows ${name}`);
  return app.slice(start, end);
}

class Element {
  constructor() {
    this.children = [];
    this.events = {};
    this.attributes = {};
    this.dataset = {};
    this.classList = { add() {}, toggle() {} };
  }
  append(...children) { this.children.push(...children); }
  appendChild(child) { this.append(child); }
  addEventListener(name, fn) { this.events[name] = fn; }
  setAttribute(name, value) { this.attributes[name] = value; }
}

test('Home counts retain old defaults, normalize bounds, and merge partial updates independently', () => {
  assert.deepEqual(preferences.normalizeHomeModuleCounts(), { tool: 5, model: 5, session: 5, device: 4 });
  const counts = preferences.normalizeHomeModuleCounts({ tool: '8.9', model: -2, session: 999, device: 'bad', unknown: 10 });
  assert.deepEqual(counts, { tool: 8, model: 1, session: 50, device: 4 });
  assert.deepEqual(preferences.normalizeHomeModuleCounts({ device: 12 }, counts), { ...counts, device: 12 });
  for (const value of [null, [], '', true, { tool: null, model: Infinity, session: {}, device: '' }]) {
    assert.deepEqual(preferences.normalizeHomeModuleCounts(value), preferences.normalizeHomeModuleCounts());
  }
});

test('main registers defaults, normalizes saved counts and preserves other counts on IPC updates', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const assignments = [...main.matchAll(/^\s*homeModuleCounts: (.+),$/gm)].map(match => match[1]);
  assert.equal(assignments.length, 2, 'default settings and settings:update both register counts');
  const context = { ...preferences, settings: { homeModuleCounts: { tool: 10, model: 8, session: 7, device: 6 } }, patch: { homeModuleCounts: { tool: 15 } } };
  assert.deepEqual(vm.runInNewContext(assignments[0], context), preferences.normalizeHomeModuleCounts());
  context.merged = { homeModuleCounts: JSON.parse(JSON.stringify(vm.runInNewContext(assignments[1], context))) };
  const load = main.match(/^\s*(merged\.homeModuleCounts = .+;)$/m);
  assert.ok(load, 'loadSettings normalizes persisted counts');
  vm.runInNewContext(load[1], context);
  assert.deepEqual(context.merged.homeModuleCounts, { tool: 15, model: 8, session: 7, device: 6 });
  context.patch = {};
  assert.deepEqual(vm.runInNewContext(assignments[1], context), context.settings.homeModuleCounts);
});

test('Tools, Models and Devices render more than their old hardcoded caps with unchanged shares', () => {
  const rows = Array.from({ length: 15 }, (_, i) => ({ key: `row-${i}`, name: `Row ${i}`, value: 100 - i }));
  const period = { totalTokens: 2000 };
  const state = { settings: { homeModuleCounts: { tool: 9, model: 8, device: 7 } }, period: 'today' };
  const devices = rows.map(row => ({ deviceId: row.key, displayName: row.name, periods: { today: { totalTokens: row.value } } }));
  const context = {
    state, document: { createElement: () => new Element() }, homeModulePreferencesApi: preferences,
    homeOverviewApi: overview, homeModuleShell: () => ({ module: new Element(), body: context.body = new Element() }),
    t: key => key, modelRowsForPeriod: () => rows, homeToolSourceRows: () => rows,
    fixedPeriodDevices: () => devices, applyHomeListMark() {}, iconKindFor() {},
    formatCompact: String, formatPercent: String, deviceAccent: '#fff', deviceStaleColor: '#888'
  };
  for (const [name, next, count] of [
    ['renderHomeToolModule', 'homeSessionAgo', 9],
    ['renderHomeModelModule', 'homeToolSourceRows', 8],
    ['renderHomeDeviceModule', 'dailyWithHeatIntensity', 7]
  ]) {
    vm.runInNewContext(`${source(name, next)}; ${name}(period);`, { ...context, period, homeModuleShell: () => ({ module: new Element(), body: context.body = new Element() }) });
    assert.equal(context.body.children.length, count);
    if (count !== 7) assert.equal(context.body.children[0].children[3].textContent, '5', 'share uses the full period total');
  }
});

test('each Home count control saves only its own count and refreshes immediately', async () => {
  for (const id of ['tool', 'model', 'session', 'device']) {
    const state = { settings: { homeModuleCounts: { tool: 10, model: 8, session: 7, device: 6 } } };
    let patch;
    let refreshed = false;
    const wrap = vm.runInNewContext(`${source('renderHomeModuleCountSettings', 'renderHomeSettingsList')}; renderHomeModuleCountSettings(id);`, {
      id, state, document: { createElement: () => new Element() }, homeModulePreferencesApi: preferences,
      t: key => i18n.translate('en', key),
      saveSettings: async value => { patch = value; }, renderHomeIfVisible: () => { refreshed = true; }
    });
    const input = wrap.children[0].children[1];
    assert.equal(input.value, String(state.settings.homeModuleCounts[id]));
    assert.equal(input.min, '1');
    assert.equal(input.max, '50');
    input.value = '75';
    await input.events.change();
    assert.equal(input.value, '50');
    assert.equal(JSON.stringify(patch), JSON.stringify({ homeModuleCounts: { [id]: 50 } }));
    assert.equal(refreshed, true);
    if (id === 'session') assert.equal(input.attributes['aria-describedby'], wrap.children[1].id);
  }
});

test('failed Home count saves restore persisted controls without rejecting the change handler', async () => {
  const saveStart = app.indexOf('async function saveSettings(');
  const saveEnd = app.indexOf('// The resolved settings of a write', saveStart);
  const saveSource = app.slice(saveStart, saveEnd);
  for (const id of ['tool', 'model', 'session', 'device']) for (const code of ['EACCES', 'EIO']) {
    const persisted = { homeModuleCounts: { tool: 10, model: 8, session: 7, device: 6 } };
    const state = { settings: structuredClone(persisted) };
    const error = Object.assign(new Error('Settings write failed'), { code });
    const logged = [];
    let recoveredRenders = 0;
    let successRefreshes = 0;
    let control;
    const context = {
      id, state, document: { createElement: () => new Element() }, homeModulePreferencesApi: preferences,
      t: key => i18n.translate('en', key), appearancePreview: {}, pendingSettingsPatches: new Set(), syncContentForm: null,
      window: { tokenMonitor: {
        updateSettings: async () => { throw error; },
        getSettings: async () => structuredClone(persisted)
      } },
      setSyncContentEditError() {}, applyEffectiveCurrencyRates() {}, restartTimer() {}, maybeUpdateBarsIcon() {},
      preserveSettingsPanelScroll: callback => callback(),
      syncSettingsForm: () => { control = context.renderHomeModuleCountSettings(id); },
      isSettingsSurfaceVisible: () => true, render: () => { recoveredRenders += 1; },
      applyPersistedSettings: () => assert.fail('failed writes must not apply a successful result'),
      renderHomeIfVisible: () => { successRefreshes += 1; },
      console: { error: (...args) => logged.push(args) }
    };
    vm.runInNewContext(`${saveSource}\n${source('renderHomeModuleCountSettings', 'renderHomeSettingsList')}`, context);
    control = context.renderHomeModuleCountSettings(id);
    const input = control.children[0].children[1];
    input.value = '25';
    await assert.doesNotReject(input.events.change(), `${id}: ${code}`);
    assert.deepEqual(state.settings, persisted);
    assert.equal(control.children[0].children[1].value, String(persisted.homeModuleCounts[id]));
    assert.equal(context.pendingSettingsPatches.size, 0);
    assert.equal(recoveredRenders, 1);
    assert.equal(successRefreshes, 0);
    assert.equal(logged.length, 1, 'saveSettings retains its error reporting');
    assert.equal(logged[0][1], error);
  }
});

test('every Home settings panel stays beside its module when reordered', () => {
  const definitions = app.slice(app.indexOf('const HOME_MODULE_SUBGROUPS ='), app.indexOf('function expandedPreferenceSubgroups('));
  const order = ['device', 'session', 'model', 'tool', 'limits', 'trends'];
  const rows = order.map(id => ({ dataset: { homeModule: id } }));
  const panels = Object.fromEntries(['homeDeviceSettingsContainer', 'homeSessionSettingsContainer', 'homeModelSettingsContainer',
    'homeToolSettingsContainer', 'homeLimitProviderContainer', 'homeActivitySettingsContainer'].map(id => [id, { id }]));
  const list = new Element();
  vm.runInNewContext(`${definitions}\n${source('applyPreferenceOrder', 'createPreferenceOrderHandle')}\napplyPreferenceOrder('homeModule', order);`, {
    order, preferenceRows: () => rows, preferenceListForKind: () => list, preferenceItemAttribute: () => 'homeModule',
    document: { getElementById: id => panels[id] }
  });
  assert.equal(list.children.length, 12);
  order.forEach((id, index) => {
    assert.equal(list.children[index * 2].dataset.homeModule, id);
    assert.equal(list.children[index * 2 + 1], Object.values(panels)[index]);
  });
});

test('Home sessions respect a smaller count while retaining an active session beyond it', () => {
  const presentation = require('../../src/electron/renderer/edgeDock/presentation');
  const now = Date.now();
  const sessions = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`codex:s${i}`, {
    client: 'codex', sessionId: `s${i}`, totalTokens: 100, title: `Session ${i}`, turnEnded: true,
    lastUsedAt: new Date(now - i * 1000).toISOString(),
    ...(i === 9 ? { liveActivity: { state: 'waiting', source: 'test', observedAt: new Date(now).toISOString(), expiresAt: new Date(now + 60000).toISOString() } } : {})
  }]));
  const state = { stats: { periods: { today: { sessions } } }, settings: { homeModuleCounts: { session: 2 } } };
  const context = {
    state, document: { createElement: () => new Element(), createTextNode: text => ({ textContent: text }) },
    els: {}, sessionTooltipShouldHoldRender: () => false, homeModulePreferencesApi: preferences,
    window: { TokenMonitorEdgeDockPresentation: presentation, TokenMonitorSessionLive: { sessionStateMarkup: () => '' } },
    sessionPresentationOptions: () => ({}), homeModuleShell: () => ({ module: new Element(), body: context.body = new Element() }),
    applyHomeListMark() {}, iconKindFor() {}, clientColors: {}, stableColor() {}, fallbackModelColors: [], bindHoverMarquee() {},
    formatCompact: String, homeSessionAgo: () => '', t: key => key, limitWindowsView: {},
    sessionRowsApi: require('../../src/electron/renderer/sessionRows')
  };
  vm.runInNewContext(`${source('renderHomeSessionModule', 'renderHomeDeviceModule')}; renderHomeSessionModule();`, context);
  assert.equal(context.body.children.length, 3);
  assert.ok(context.body.children.some(row => row.dataset.key.includes('s9')), 'waiting session survives outside the recent count');
});

test('all supported locales translate the Home count controls and active-session explanation', () => {
  for (const { value: locale } of i18n.LANGUAGE_OPTIONS.filter(option => option.value !== 'auto')) {
    for (const key of ['settings.home.itemCount', 'settings.home.configureModule', 'settings.home.sessionCountNote']) {
      assert.notEqual(i18n.translate(locale, key, { name: 'Models' }), key);
    }
  }
});
