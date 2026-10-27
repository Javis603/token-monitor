'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');

function harness() {
  const settings = {}, stats = {};
  let value = '10', draws = 0;
  const calls = [];
  const window = { ResizeObserver: class { observe() {} }, addEventListener() {} };
  const document = { createElement: () => ({ dataset: {}, append() {}, replaceChildren() {} }) };
  vm.runInNewContext(fs.readFileSync(path.join(renderer, 'displaySettingsPreview.js'), 'utf8'), { window });
  const preview = window.TokenMonitorDisplaySettingsPreview.create({ window, document, settings: () => settings, stats: () => stats,
    bitmap: () => { draws++; return { text: value }; }, t: key => key,
    bridge: { getDisplayPreview: (...args) => { calls.push(args); return new Promise(() => {}); } } });
  const stage = () => ({ dataset: {}, append(node) { this.firstElementChild = node; } });
  return { preview, settings, calls, stage, setValue(next) { value = next; }, draws: () => draws };
}

test('existing composer refresh updates bitmap previews even when stats identity is unchanged', () => {
  const h = harness();
  for (const surface of ['tray', 'floatingBubble']) {
    const stage = h.stage();
    h.setValue('10'); h.preview.show(surface, stage, 'open');
    assert.equal(stage.firstElementChild.textContent, '10');
    h.setValue('20'); h.preview.show(surface, stage, 'open', { force: true });
    assert.equal(stage.firstElementChild.textContent, '20');
  }
  let refreshed = 0;
  const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
  const source = app.slice(app.indexOf('function refreshTrayComposers()'), app.indexOf('function loadImage('));
  const refresh = vm.runInNewContext(`${source}; refreshTrayComposers`, {
    state: { settings: {}, appInfo: {} }, els: {}, trayComposers: {}, createTrayComposer() {}, syncCustomTrayClockTimer() {},
    window: { TokenMonitorTrayComposer: { syncTrayComposerSurfaces() {} } },
    displaySettings: { refreshLivePreview() { refreshed++; } }
  });
  refresh(); assert.equal(refreshed, 1);
});

test('display preference changes invalidate sample preview cache', () => {
  const h = harness(), stage = h.stage();
  h.preview.show('notch', stage, 'open');
  for (const [key, value] of Object.entries({ interfaceFontFamily: 'Georgia, serif', displayFontFamily: 'Menlo, monospace', currencyRatesEffective: { TWD: 40 }, showCompactTotalTokens: true, sessionContextMetric: 'remaining', tokenNumberAnimation: 'count', showCodexAdditionalLimits: true, limitProviderHiddenItems: { codex: ['weekly'] } })) {
    const before = h.calls.length;
    h.settings[key] = value;
    h.preview.show('notch', stage, 'open');
    assert.equal(h.calls.length, before + 1, key);
  }
  const before = h.calls.length;
  h.settings.secret = 'never-project'; h.preview.show('notch', stage, 'open');
  assert.equal(h.calls.length, before);
});
