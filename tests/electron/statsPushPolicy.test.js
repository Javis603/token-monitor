'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { rendererNeedsStatsWhileHidden } = require('../../src/electron/statsPushPolicy');
const { isGeneratedTrayIconMode } = require('../../src/shared/trayText');

const GENERATED_MODES = [
  'bars',
  'barsSession',
  'barsWeekly',
  'barsAllSessions',
  'limitsAllSessions',
  'liveTokenRate',
  'custom'
];

test('text and plain icon tray modes do not need stats while the window is hidden', () => {
  for (const trayContent of ['tokens', 'cost', 'both', 'tokensMonth', 'costMonth', 'bothMonth', 'tokensAll', 'costAll', 'bothAll', 'icon']) {
    assert.equal(rendererNeedsStatsWhileHidden({ trayContent, showTrayIcon: true }), false, trayContent);
  }
});

test('renderer-composed tray artwork still receives stats while hidden', () => {
  for (const trayContent of GENERATED_MODES) {
    assert.equal(isGeneratedTrayIconMode(trayContent), true, `${trayContent} is a generated mode`);
    assert.equal(rendererNeedsStatsWhileHidden({ trayContent, showTrayIcon: true }), true, trayContent);
  }
});

test('a hidden tray does not demand renderer artwork', () => {
  assert.equal(rendererNeedsStatsWhileHidden({ trayContent: 'bars', showTrayIcon: false }), false);
});

test('a collapsed floating bubble keeps renderer stats even with plain tray text', () => {
  assert.equal(rendererNeedsStatsWhileHidden({
    trayContent: 'tokens',
    showTrayIcon: true,
    floatingBubbleEnabled: true,
    floatingBubbleCollapsed: true
  }), true);
  assert.equal(rendererNeedsStatsWhileHidden({
    trayContent: 'tokens',
    showTrayIcon: true,
    floatingBubbleEnabled: true,
    floatingBubbleCollapsed: false
  }), false);
});
