'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { applyTranslations, translate, LANGUAGE_OPTIONS } = require('../../src/electron/renderer/i18n');
const app = fs.readFileSync(require.resolve('../../src/electron/renderer/app'), 'utf8');
const main = fs.readFileSync(require.resolve('../../src/electron/main'), 'utf8');

function appFunction(name, context) {
  const source = app.match(new RegExp(`^function ${name}\\([^]*?^}`, 'm'))?.[0];
  assert.ok(source, name);
  return vm.runInNewContext(`${source}; ${name}`, context);
}

test('recent dated sessions precede invalid dates before the 2000-session reader limit', () => {
  const undated = Array.from({ length: 2000 }, (_, i) => ({ client: 'codex', sessionId: `missing-${i}`,
    lastUsedAt: i % 2 ? 'invalid' : undefined, title: 'undated' }));
  const dated = ['2026-10-04', '2026-10-06', '2026-10-05'].map(lastUsedAt => ({
    client: 'antigravity', sessionId: lastUsedAt, lastUsedAt, title: 'dated' }));
  const state = { stats: { periods: { allTime: { sessions: Object.fromEntries([...undated, ...dated].map(s => [s.sessionId, s])) } } } };
  const sessions = appFunction('taskSpeedSessions', { state })();
  assert.deepEqual(Array.from(sessions.slice(0, 3), s => s.sessionId), ['2026-10-06', '2026-10-05', '2026-10-04']);
  assert.ok(sessions.slice(0, 2000).some(s => s.sessionId === '2026-10-06'));
  assert.deepEqual(Array.from(sessions.slice(3), s => s.sessionId), undated.map(s => s.sessionId));
});

function classList(initial = []) {
  const values = new Set(initial);
  return { add: value => values.add(value), toggle(value, enabled) { if (enabled) values.add(value); else values.delete(value); },
    contains: value => values.has(value) };
}

test('entering Task speeds clears Home/session shell state and tooltip, and restores the back row', () => {
  for (const previous of ['home-mode', 'session-mode']) {
    const state = { stats: {}, breakdown: 'speed', homeReturnVisible: true };
    const els = Object.fromEntries(['shell', 'taskSpeedPanel', 'toolDetailFooter', 'viewBackRow', 'homePanel', 'breakdown',
      'serviceStatusPanel', 'trendsPanel', 'limitsPanel', 'sessionDetail', 'sessionDetailHead', 'fixedPeriodMessage',
      'sessionPagerHost'].map(key => [key, { classList: classList() }]));
    els.shell.classList.add(previous);
    els.viewBackRow.classList.add('hidden');
    let tooltipVisible = true;
    const noop = () => {};
    appFunction('render', { state, els, isLinux: true, visibleStatsSurface: () => 'main', allTimeSessions: { ensure: noop },
      stopHomeSessionRepaint: noop, stopSessionStatusRepaint: noop, syncLiveTokenRateFooterState: noop,
      renderSessionUsageArchiveStatus: noop, ensureBreakdownVisible: noop, renderViewSwitcher: noop, renderTaskSpeed: noop,
      signalContentReady: noop, hideHomeActivityTooltip: () => { tooltipVisible = false; } })();
    assert.equal(els.shell.classList.contains(previous), false);
    assert.equal(els.viewBackRow.classList.contains('hidden'), false);
    assert.equal(tooltipVisible, false);
  }
});

test('Linux resize grips use translated titles and follow language changes', () => {
  const handles = [];
  const document = { documentElement: { lang: 'en' }, body: { append: handle => handles.push(handle) },
    createElement: () => ({ dataset: {}, addEventListener() {} }) };
  vm.runInNewContext(app.slice(app.indexOf('// Transparent frameless windows')), {
    document, window: { addEventListener() {} }, isLinux: true, t: key => translate('en', key)
  });
  assert.equal(handles.length, 8);
  for (const handle of handles) assert.equal(handle.title, translate('en', 'window.resizeHandle'));
  const root = { querySelectorAll: selector => selector === '[data-i18n-title]' ? handles : [] };
  for (const { value } of LANGUAGE_OPTIONS.filter(entry => entry.value !== 'auto')) {
    applyTranslations(root, value);
    assert.notEqual(translate(value, 'window.resizeHandle'), 'window.resizeHandle');
    for (const handle of handles) assert.equal(handle.title, translate(value, 'window.resizeHandle'));
  }
});

test('non-Linux renderers have no custom resize grips or task-rate background requests', () => {
  let handles = 0;
  vm.runInNewContext(app.slice(app.indexOf('// Transparent frameless windows')), {
    isLinux: false, t: key => key, window: { addEventListener() {} },
    document: { documentElement: { lang: 'en' }, body: { append: () => { handles++; } },
      createElement: () => ({ dataset: {}, addEventListener() {} }) }
  });
  assert.equal(handles, 0);
  assert.equal(appFunction('taskTokenRateDisplaysNeeded', {
    isLinux: false, displayLiveTokenRateItems: () => [{ rateMode: 'task' }]
  })(), false);
});

test('task-history and custom-resize IPC stay Linux-only on both sides of the bridge', () => {
  const preload = fs.readFileSync(require.resolve('../../src/electron/preload'), 'utf8');
  const channels = ['taskSpeed:get', 'window:resizeStart', 'window:resizeMove', 'window:resizeEnd'];
  for (const platform of ['linux', 'darwin', 'win32']) {
    let exposed;
    vm.runInNewContext(preload, { process: { platform }, require: () => ({ ipcRenderer: {},
      contextBridge: { exposeInMainWorld: (_key, api) => { exposed = api; } } }) });
    for (const key of ['getTaskSpeedStats', 'startWindowResize', 'moveWindowResize', 'endWindowResize']) {
      assert.equal(typeof exposed[key] === 'function', platform === 'linux', `${platform}: ${key}`);
    }
    const registered = [];
    const context = { process: { platform }, ipcMain: {
      handle: channel => registered.push(channel), on: channel => registered.push(channel)
    } };
    // Execute the actual registration blocks, without starting Electron or invoking handlers.
    const taskBlock = main.match(/(?: {2}if \(process\.platform === 'linux'\) \{\n)? +ipcMain\.handle\('taskSpeed:get'[^]*?(?= {2}ipcMain\.handle\('session:getDetail')/)[0];
    const resizeBlock = main.match(/(?: {2}if \(process\.platform === 'linux'\) \{\n)? +let windowResize = null;[^]*?(?= {2}ipcMain\.on\('window:minimize')/)[0];
    vm.runInNewContext(taskBlock, context);
    vm.runInNewContext(resizeBlock, context);
    assert.deepEqual(registered.filter(channel => channels.includes(channel)), platform === 'linux' ? channels : []);
  }
});

test('task-history IPC normalizes session fields and bounds IDs before the reader', () => {
  let handler;
  let forwarded;
  const block = main.match(/(?: {2}if \(process\.platform === 'linux'\) \{\n)? +ipcMain\.handle\('taskSpeed:get'[^]*?(?= {2}ipcMain\.handle\('session:getDetail')/)[0];
  vm.runInNewContext(block, { process: { platform: 'linux' },
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    readTaskSpeedStats: args => { forwarded = args; }
  });
  const sessions = [null, 7, { client: 123, sessionId: 42 },
    { client: 'codex', sessionId: 'a'.repeat(300), title: 'b'.repeat(300) },
    { client: 'antigravity', sessionId: 'ordinary-id', title: 'ordinary-title' }];
  handler({}, { sessions });
  assert.deepEqual(JSON.parse(JSON.stringify(forwarded.sessions)), [
    { client: '', sessionId: '', title: '' },
    { client: '', sessionId: '', title: '' },
    { client: '123', sessionId: '42', title: '' },
    { client: 'codex', sessionId: 'a'.repeat(200), title: 'b'.repeat(180) },
    { client: 'antigravity', sessionId: 'ordinary-id', title: 'ordinary-title' }
  ]);
  for (const args of [undefined, {}, { sessions: null }]) {
    handler({}, args);
    assert.equal(forwarded.sessions.length, 0);
  }
  handler({}, { sessions: Array(2001).fill(sessions[4]) });
  assert.equal(forwarded.sessions.length, 2000);
});

test('only Linux offers the Task speeds view in settings and navigation', () => {
  for (const platform of ['linux', 'darwin', 'win32']) {
    const context = { process: { platform }, isLinux: platform === 'linux', baseBreakdownOrder: ['tool', 'device', 'model', 'project', 'session'] };
    for (const [source, name] of [[main, 'DEFAULT_VIEW_LIST'], [app, 'VIEW_DISPLAY_OPTIONS']]) {
      const declaration = source.match(new RegExp(`const ${name} = [^]*?;`))[0];
      const views = vm.runInNewContext(`${declaration}; ${name}`, context);
      assert.equal(views.some(view => view.id === 'speed'), platform === 'linux', `${platform}: ${name}`);
    }
    const available = appFunction('availableBreakdownIds', { ...context, state: { settings: {} }, limitViewAvailable: () => false })();
    assert.equal(available.includes('speed'), platform === 'linux', `${platform}: available views`);
  }
});

test('the composer keeps existing rate choices and adds task rate only when Linux enables it', () => {
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/trayComposer'), 'utf8');
  const editor = source.match(/^ {4}function liveTokenRateEditor\([^]*?^ {4}}/m)[0];
  for (const taskSpeedEnabled of [true, false]) {
    const choices = vm.runInNewContext(`${editor}; liveTokenRateEditor({ rateMode: 'speed', rateScope: 'all' })`, {
      taskSpeedEnabled, l: (_key, fallback) => fallback, picker: (_label, values) => values
    });
    assert.deepEqual(Array.from(choices[0], choice => choice.value), taskSpeedEnabled ? ['speed', 'task', 'burn'] : ['speed', 'burn']);
  }
});

test('startup rejects the Linux task view on other platforms while keeping existing views', () => {
  const boot = fs.readFileSync(require.resolve('../../src/electron/renderer/floatingBubbleBoot'), 'utf8');
  for (const platform of ['Linux x86_64', 'Macintosh', 'Windows NT']) {
    for (const breakdown of ['speed', 'session']) {
      const window = { navigator: { userAgent: platform }, location: { search: `?breakdown=${breakdown}&period=allTime` } };
      vm.runInNewContext(boot, { window, document: {}, URLSearchParams });
      assert.equal(window.__TOKEN_MONITOR_INITIAL_VIEW_STATE__.breakdown,
        breakdown !== 'speed' || platform.startsWith('Linux') ? breakdown : undefined);
    }
  }
});
