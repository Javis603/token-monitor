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
