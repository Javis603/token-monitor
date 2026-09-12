'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const {
  TASKBAR_WIDGET_FALLBACK_HEIGHT,
  TASKBAR_WIDGET_PERIODS,
  TASKBAR_WIDGET_WIDTH,
  canUseTaskbarWidget,
  nextTaskbarWidgetPeriod,
  normalizeTaskbarWidgetPeriod,
  taskbarWidgetBounds,
  taskbarWidgetPagePath,
  taskbarWidgetPeriodLabelKey,
  taskbarWidgetPeriodTokens
} = require('../../src/electron/taskbarWidget');

const indexPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'index.html');
const appPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js');
const i18nPath = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'i18n.js');
const mainPath = path.join(__dirname, '..', '..', 'src', 'electron', 'main.js');
const widgetDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');

test('taskbar widget is available only on win32 with the setting on and tray mode off', () => {
  assert.equal(canUseTaskbarWidget({ taskbarWidgetEnabled: true, trayMode: false }, 'win32'), true);
  assert.equal(canUseTaskbarWidget({ taskbarWidgetEnabled: false, trayMode: false }, 'win32'), false);
  assert.equal(canUseTaskbarWidget({ taskbarWidgetEnabled: true, trayMode: true }, 'win32'), false);
  assert.equal(canUseTaskbarWidget({ taskbarWidgetEnabled: true, trayMode: false }, 'darwin'), false);
  assert.equal(canUseTaskbarWidget({}, 'win32'), false);
});

test('taskbarWidgetBounds sits on the bottom taskbar strip, left-aligned', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1032 } };
  assert.deepEqual(taskbarWidgetBounds(display), { x: 0, y: 1032, width: TASKBAR_WIDGET_WIDTH, height: 48 });
});

test('taskbarWidgetBounds falls back to the bottom-left corner when the taskbar is autohidden', () => {
  const display = { bounds: { x: 0, y: 0, width: 1920, height: 1080 }, workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
  assert.deepEqual(taskbarWidgetBounds(display), {
    x: 0,
    y: 1080 - TASKBAR_WIDGET_FALLBACK_HEIGHT,
    width: TASKBAR_WIDGET_WIDTH,
    height: TASKBAR_WIDGET_FALLBACK_HEIGHT
  });
});

test('taskbarWidgetBounds handles displays offset from the origin', () => {
  const display = { bounds: { x: 1920, y: 0, width: 2560, height: 1440 }, workArea: { x: 1920, y: 0, width: 2560, height: 1392 } };
  assert.deepEqual(taskbarWidgetBounds(display), { x: 1920, y: 1392, width: TASKBAR_WIDGET_WIDTH, height: 48 });
});

test('taskbar widget renderer is a CSP-safe file page fed by the preload bridge', () => {
  const html = fs.readFileSync(path.join(widgetDir, 'taskbarWidget.html'), 'utf8');
  const css = fs.readFileSync(path.join(widgetDir, 'taskbarWidget.css'), 'utf8');
  const js = fs.readFileSync(path.join(widgetDir, 'taskbarWidget.js'), 'utf8');
  assert.equal(taskbarWidgetPagePath().endsWith(path.join('renderer', 'taskbarWidget.html')), true);
  // External assets only — the app injects CSP 'script-src self' on HTTP
  // responses, which data: URLs inherit, so inline scripts/styles would be blocked.
  assert.match(html, /<link rel="stylesheet" href="taskbarWidget\.css" \/>/);
  assert.match(html, /<script src="i18n\.js"><\/script>/);
  assert.match(html, /<script src="taskbarWidgetPeriod\.js"><\/script>/);
  assert.match(html, /<script src="taskbarWidget\.js"><\/script>/);
  assert.doesNotMatch(html, /<style>/);
  assert.match(html, /id="period"/);
  // The widget must stay hint-free on hover: no title means no native tooltip.
  assert.doesNotMatch(html, /data-i18n-title/);
  assert.match(css, /prefers-color-scheme: dark/);
  // Windows hit-tests layered windows per-pixel, so fully transparent pixels
  // pass clicks through to the taskbar; the near-invisible row background
  // keeps the whole module clickable.
  assert.match(css, /background: rgba\(0, 0, 0, 0\.01\)/);
  assert.match(js, /window\.tokenMonitor/);
  assert.match(js, /getStats\(\)\.then\(render\)/);
  assert.match(js, /onStatsPush\(render\)/);
  assert.match(js, /formatNumber/);
  assert.match(js, /toLocaleString\('en-US'\)/);
  assert.match(js, /addEventListener\('pointerup'/);
  assert.match(js, /updateSettings\(\{ taskbarWidgetPeriod: period \}\)/);
  assert.doesNotMatch(js, /suffix: 'K'|s: 'K'|formatCompact/);
  assert.doesNotMatch(js, /require\(['"]electron['"]\)/);
});

test('taskbar widget formats totals as full numbers without K/M/B', () => {
  const js = fs.readFileSync(path.join(widgetDir, 'taskbarWidget.js'), 'utf8');
  const start = js.indexOf('function formatNumber(');
  const end = js.indexOf('function resolveLocale(', start);
  assert.notEqual(start, -1);
  assert.notEqual(end, -1);
  const formatNumber = Function(`return (${js.slice(start, end).trim()})`)();
  assert.equal(formatNumber(999), '999');
  assert.equal(formatNumber(29_000_000), '29,000,000');
  assert.equal(formatNumber(2_000_000_000), '2,000,000,000');
  assert.doesNotMatch(formatNumber(2_000_000_000), /[KMB]/);
});

test('taskbar widget click cycles today, this month, and all time', () => {
  assert.deepEqual(TASKBAR_WIDGET_PERIODS, ['today', 'month', 'allTime']);
  assert.equal(normalizeTaskbarWidgetPeriod('today'), 'today');
  assert.equal(normalizeTaskbarWidgetPeriod('month'), 'month');
  assert.equal(normalizeTaskbarWidgetPeriod('allTime'), 'allTime');
  assert.equal(normalizeTaskbarWidgetPeriod('yesterday'), 'allTime');
  assert.equal(normalizeTaskbarWidgetPeriod(undefined, 'today'), 'today');
  assert.equal(nextTaskbarWidgetPeriod('today'), 'month');
  assert.equal(nextTaskbarWidgetPeriod('month'), 'allTime');
  assert.equal(nextTaskbarWidgetPeriod('allTime'), 'today');
  assert.equal(taskbarWidgetPeriodLabelKey('today'), 'trayComposer.period.today');
  assert.equal(taskbarWidgetPeriodLabelKey('month'), 'trayComposer.period.month');
  assert.equal(taskbarWidgetPeriodLabelKey('allTime'), 'trayComposer.period.allTime');
  const stats = {
    periods: {
      today: { totalTokens: 10 },
      month: { totalTokens: 200 },
      allTime: { totalTokens: 3000 }
    }
  };
  assert.equal(taskbarWidgetPeriodTokens(stats, 'today'), 10);
  assert.equal(taskbarWidgetPeriodTokens(stats, 'month'), 200);
  assert.equal(taskbarWidgetPeriodTokens(stats, 'allTime'), 3000);
});

test('taskbar widget renderer cycles on pointerup (delivered even when the press is not)', async () => {
  const source = fs.readFileSync(path.join(widgetDir, 'taskbarWidget.js'), 'utf8');
  const listeners = new Map();
  const elements = new Map([
    ['widget', {
      addEventListener(type, handler) {
        listeners.set(type, handler);
      }
    }],
    ['total', { textContent: '' }],
    ['period', { textContent: '' }]
  ]);
  const updates = [];
  const stats = {
    periods: {
      today: { totalTokens: 10 },
      month: { totalTokens: 200 },
      allTime: { totalTokens: 3000 }
    }
  };
  const api = {
    getSettings: () => Promise.resolve({ language: 'en', taskbarWidgetPeriod: 'today' }),
    onSettingsPush: () => () => {},
    getStats: () => Promise.resolve(stats),
    onStatsPush: () => () => {},
    updateSettings: (patch) => {
      updates.push(patch);
      return Promise.resolve(patch);
    }
  };
  const periodApi = {
    normalizeTaskbarWidgetPeriod,
    nextTaskbarWidgetPeriod,
    taskbarWidgetPeriodLabelKey,
    taskbarWidgetPeriodTokens
  };
  const labels = {
    'trayComposer.period.today': 'Today',
    'trayComposer.period.month': 'This month',
    'trayComposer.period.allTime': 'All time'
  };
  const context = {
    window: {
      tokenMonitor: api,
      TokenMonitorTaskbarWidgetPeriod: periodApi,
      TokenMonitorI18n: {
        resolveLocale: () => 'en',
        translate: (_locale, key) => labels[key] || key,
        applyTranslations: () => {}
      }
    },
    document: { getElementById: (id) => elements.get(id) },
    navigator: { language: 'en-US' },
    console,
    Promise
  };

  vm.runInNewContext(source, context, { filename: 'taskbarWidget.js' });
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(elements.get('period').textContent, 'Today');
  assert.equal(elements.get('total').textContent, '10 tokens');

  listeners.get('pointerup')({ button: 0 });
  assert.equal(elements.get('period').textContent, 'This month');
  assert.equal(elements.get('total').textContent, '200 tokens');
  assert.deepEqual(updates.map((patch) => patch.taskbarWidgetPeriod), ['month']);

  listeners.get('pointerup')({ button: 2 });
  assert.equal(elements.get('period').textContent, 'This month');
  assert.equal(updates.length, 1);

  listeners.get('pointerup')({ button: 0 });
  assert.equal(elements.get('period').textContent, 'All time');
  assert.equal(elements.get('total').textContent, '3,000 tokens');
  assert.deepEqual(updates.map((patch) => patch.taskbarWidgetPeriod), ['month', 'allTime']);
});

test('taskbar widget settings UI is wired in the renderer and translated in every locale', () => {
  const html = fs.readFileSync(indexPath, 'utf8');
  const app = fs.readFileSync(appPath, 'utf8');
  const i18n = fs.readFileSync(i18nPath, 'utf8');
  assert.ok(html.indexOf('id="taskbarWidgetInput"') > -1);
  assert.ok(html.indexOf('id="taskbarWidgetFeature"') > -1);
  assert.match(html, /data-i18n="settings\.display\.taskbarWidget"/);
  assert.match(html, /data-i18n="settings\.display\.taskbarWidgetNote"/);
  // The row starts hidden and is revealed only on Windows (mirrors the WSL row).
  assert.match(html, /presence-feature hidden" id="taskbarWidgetFeature"/);
  assert.match(app, /taskbarWidgetFeature\.classList\.toggle\('hidden', state\.appInfo\?\.platform !== 'win32'\)/);
  assert.match(app, /saveSettings\(\{ taskbarWidgetEnabled: els\.taskbarWidgetInput\.checked \}\)/);
  for (const key of [
    'settings.display.taskbarWidget',
    'settings.display.taskbarWidgetNote',
    'settings.display.taskbarWidgetClickHint'
  ]) {
    assert.match(i18n, new RegExp(`'${key}':`));
  }
});

test('main process wires the taskbar widget to settings, live stats, and clickable period cycling', () => {
  const main = fs.readFileSync(mainPath, 'utf8');
  assert.match(main, /taskbarWidgetEnabled: parseBoolean\(patch\.taskbarWidgetEnabled/);
  assert.match(main, /taskbarWidgetPeriod: normalizeTaskbarWidgetPeriod\(patch\.taskbarWidgetPeriod/);
  assert.match(main, /taskbarWidgetPeriod: 'allTime'/);
  assert.match(main, /merged\.taskbarWidgetPeriod = normalizeTaskbarWidgetPeriod\(merged\.taskbarWidgetPeriod\)/);
  assert.match(main, /syncTaskbarWidget\(\)/);
  assert.match(main, /taskbarWidgetWindow\.webContents\.send\('stats:push'/);
  assert.match(main, /taskbarWidgetWindow\.webContents\.send\('settings:push'/);
  assert.match(main, /win\.setIgnoreMouseEvents\(false\)/);
  assert.doesNotMatch(main, /win\.setIgnoreMouseEvents\(true, \{ forward: true \}\)/);
  assert.match(main, /win\.loadFile\(loadTarget\)/);
  assert.match(main, /screen\.on\('display-metrics-changed'/);
});

test('isEffectiveTopmost treats only visible real-size windows above the overlay as buried', () => {
  const { isEffectiveTopmost } = require('../../src/electron/taskbarWidgetWin32');
  const widget = 0x100n;
  const helper1x1 = 0x101n;   // ThumbnailDeviceHelperWnd-style 1x1 window
  const taskbar = 0x102n;     // Shell_TrayWnd
  const rect = (w, h) => {
    const buf = Buffer.alloc(16);
    buf.writeInt32LE(0, 0); buf.writeInt32LE(0, 4);
    buf.writeInt32LE(w, 8); buf.writeInt32LE(h, 12);
    return buf;
  };
  const api = {
    GetWindow: (hwnd, cmd) => {
      assert.equal(cmd, 3); // GW_HWNDPREV
      if (hwnd === widget) return helper1x1;
      if (hwnd === helper1x1) return taskbar;
      return 0n;
    },
    GetWindowRect: (hwnd, buf) => {
      if (hwnd === helper1x1) rect(1, 1).copy(buf);
      else if (hwnd === taskbar) rect(1707, 48).copy(buf);
      else return false;
      return true;
    },
    IsWindowVisible: (hwnd) => hwnd !== 0n
  };
  assert.equal(isEffectiveTopmost(api, widget), false, 'a visible real-size window above means buried');

  api.IsWindowVisible = () => false;
  assert.equal(isEffectiveTopmost(api, widget), true, 'invisible windows above are ignored');

  api.IsWindowVisible = (hwnd) => hwnd !== 0n;
  api.GetWindowRect = (hwnd, buf) => {
    rect(1, 1).copy(buf);
    return true;
  };
  assert.equal(isEffectiveTopmost(api, widget), true, '1x1 helper windows above are ignored');

  // Degenerate helper then a real window: still buried.
  api.GetWindow = (hwnd) => {
    if (hwnd === widget) return helper1x1;
    if (hwnd === helper1x1) return taskbar;
    return 0n;
  };
  api.GetWindowRect = (hwnd, buf) => {
    if (hwnd === helper1x1) rect(1, 1).copy(buf);
    else rect(1707, 48).copy(buf);
    return true;
  };
  assert.equal(isEffectiveTopmost(api, widget), false);
});

test('main process re-asserts the taskbar widget topmost only when it is buried and hides during fullscreen', () => {
  const main = fs.readFileSync(mainPath, 'utf8');
  assert.match(main, /isTaskbarWidgetTopmost\(taskbarWidgetWindow\)/);
  assert.match(main, /raiseTaskbarWidgetWindowSafe\(taskbarWidgetWindow\)/);
  assert.match(main, /if \(!isTaskbarWidgetTopmost\(taskbarWidgetWindow\)\)/);
  assert.match(main, /isForegroundFullscreen\(primaryDisplay, taskbarWidgetWindow\)/);
  assert.match(main, /taskbarWidgetWindow\.hide\(\)/);
  assert.match(main, /taskbarWidgetWindow\.show\(\)/);
});
