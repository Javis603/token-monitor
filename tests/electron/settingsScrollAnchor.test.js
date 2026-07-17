'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function scrollAnchorHarness({ reducedMotion = false, settingsSections = {} } = {}) {
  const start = app.indexOf('const SETTINGS_SCROLL_ANCHOR_MS');
  const end = app.indexOf('\nfunction setupSettingsSections', start);
  assert.ok(start >= 0 && end > start, 'settings scroll anchor helpers should be present');

  let nextFrame = 1;
  const frames = new Map();
  const cancelled = [];
  const panel = {
    scrollTop: 0,
    classList: { contains: () => false },
    getBoundingClientRect: () => ({ top: 20 })
  };
  const context = {
    SETTINGS_SECTION_IDS: ['general', 'main', 'window', 'appearance'],
    state: { settingsSections },
    els: { settingsPanel: panel },
    prefersReducedMotion: () => reducedMotion,
    performance: { now: () => 0 },
    requestAnimationFrame(callback) {
      const id = nextFrame++;
      frames.set(id, callback);
      return id;
    },
    cancelAnimationFrame(id) {
      cancelled.push(id);
      frames.delete(id);
    }
  };
  vm.runInNewContext(
    `${app.slice(start, end)}\nglobalThis.scrollAnchorApi = { anchorSettingsScroll, cancelSettingsScrollAnchor, cancelSettingsScrollAnchorOnKeydown, shouldAnchorSettingsScroll };`,
    context
  );
  return { api: context.scrollAnchorApi, cancelled, frames, panel };
}

function anchor(top = 100) {
  return { isConnected: true, getBoundingClientRect: () => ({ top }) };
}

test('settings scroll anchoring only runs when an expanded section above will collapse', () => {
  const { api } = scrollAnchorHarness({
    settingsSections: { general: true, main: false, window: false, appearance: false }
  });
  assert.equal(api.shouldAnchorSettingsScroll('window', true), true);
  assert.equal(api.shouldAnchorSettingsScroll('general', true), false);
  assert.equal(api.shouldAnchorSettingsScroll('window', false), false);
});

test('a new settings scroll anchor cancels the previous animation frame', () => {
  const { api, cancelled, frames } = scrollAnchorHarness();
  api.anchorSettingsScroll(anchor(), () => {});
  assert.deepEqual([...frames.keys()], [1]);

  api.anchorSettingsScroll(anchor(120), () => {});
  assert.deepEqual(cancelled, [1]);
  assert.deepEqual([...frames.keys()], [2]);
});

test('reduced motion performs one scroll correction without scheduling a loop', () => {
  const { api, frames, panel } = scrollAnchorHarness({ reducedMotion: true });
  let top = 100;
  const anchorEl = { isConnected: true, getBoundingClientRect: () => ({ top }) };
  api.anchorSettingsScroll(anchorEl, () => { top = 70; });

  const frame = frames.get(1);
  frames.delete(1);
  frame();

  assert.equal(panel.scrollTop, -30);
  assert.equal(frames.size, 0);
});

test('manual interaction can cancel an active settings scroll anchor', () => {
  const { api, cancelled, frames } = scrollAnchorHarness();
  api.anchorSettingsScroll(anchor(), () => {});
  api.cancelSettingsScrollAnchor();

  assert.deepEqual(cancelled, [1]);
  assert.equal(frames.size, 0);
});

test('keyboard scroll and focus-navigation keys cancel an active settings scroll anchor', () => {
  for (const key of ['ArrowUp', 'ArrowDown', 'PageUp', 'PageDown', 'Home', 'End', ' ', 'Tab']) {
    const { api, cancelled, frames } = scrollAnchorHarness();
    api.anchorSettingsScroll(anchor(), () => {});
    api.cancelSettingsScrollAnchorOnKeydown({ key });
    assert.deepEqual(cancelled, [1], `${key} should cancel the active frame`);
    assert.equal(frames.size, 0);
  }

  const { api, cancelled, frames } = scrollAnchorHarness();
  api.anchorSettingsScroll(anchor(), () => {});
  api.cancelSettingsScrollAnchorOnKeydown({ key: 'a' });
  assert.deepEqual(cancelled, []);
  assert.deepEqual([...frames.keys()], [1]);
  assert.match(app, /settingsPanel\?\.addEventListener\('keydown', cancelSettingsScrollAnchorOnKeydown\)/);
});
