'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { parseMacWidgetDeepLink } = require('../../src/electron/macWidgetDeepLink');

test('maps every Widget page to the matching application area', () => {
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor-widget-dev://overview', 'token-monitor-widget-dev'), { page: 'overview', view: 'home', settings: false });
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor-widget-dev://quota', 'token-monitor-widget-dev'), { page: 'quota', view: 'limits', settings: false });
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor-widget-dev://models', 'token-monitor-widget-dev'), { page: 'models', view: 'model', settings: false });
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor-widget-dev://activity', 'token-monitor-widget-dev'), { page: 'activity', view: 'trends', settings: false });
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor-widget-dev://trend', 'token-monitor-widget-dev'), { page: 'trend', view: 'trends', settings: false });
});

test('keeps legacy widget links and rejects other schemes or unknown pages', () => {
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor://widget', 'token-monitor'), { page: 'overview', view: 'home', settings: false });
  assert.deepEqual(parseMacWidgetDeepLink('token-monitor://widget-settings', 'token-monitor'), { page: 'overview', view: 'home', settings: true });
  assert.equal(parseMacWidgetDeepLink('token-monitor://unknown', 'token-monitor'), null);
  assert.equal(parseMacWidgetDeepLink('token-monitor://overview', 'token-monitor-widget-dev'), null);
});

// A widget click arrives as open-url and is answered by openMainWindowFromWidget.
// That handler used to bail when the window had been destroyed — which is the
// normal state after closing it with the tray icon off, since macOS keeps the
// app running — while still having consumed the event, leaving every later
// widget click dead for the rest of the session.
test('a widget click rebuilds the window instead of dropping the event', () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');
  const start = main.indexOf('function openMainWindowFromWidget()');
  assert.notEqual(start, -1, 'openMainWindowFromWidget should exist');
  const body = main.slice(start, main.indexOf('\nfunction ', start + 1));

  assert.match(body, /if \(!mainWindow \|\| mainWindow\.isDestroyed\(\)\) createWindow\(\);/);
  assert.doesNotMatch(body, /if \(!app\.isReady\(\) \|\| !mainWindow \|\| mainWindow\.isDestroyed\(\)\) return;/);
  // Matches focusExistingWindow: an accessory app has to switch policy before
  // it can take focus, and a collapsed bubble would hide the view we just sent.
  assert.match(body, /applyMacActivationPolicy\(\{ mainWindowVisible: true \}\)/);
  assert.match(body, /if \(floatingBubbleState\.collapsed\) expandFloatingBubble\(\);/);
});
