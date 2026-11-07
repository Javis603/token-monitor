'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { pluginLimitSettingsStatus } = require('../../src/electron/renderer/limits/providerPresentation');
const { translate } = require('../../src/electron/renderer/i18n');
test('missing reading is unknown, while an explicit setup failure is not configured', () => {
  assert.equal(pluginLimitSettingsStatus({}, null).key, 'plugins.limits.awaitingData');
  assert.equal(pluginLimitSettingsStatus({}, { status: 'notConfigured' }).key, 'settings.limits.status.notSetUp');
});
test('only modules with host login show reconnect; read failures do not assert lost configuration', () => {
  assert.equal(pluginLimitSettingsStatus({ credentials: { fields: [] } }, { status: 'unauthorized' }).key, 'plugins.credentials.invalid');
  assert.equal(pluginLimitSettingsStatus({}, { status: 'unauthorized' }).key, 'settings.limits.status.error');
  assert.equal(pluginLimitSettingsStatus({}, { status: 'error' }).key, 'plugins.limits.readFailed');
  assert.equal(pluginLimitSettingsStatus({}, { status: 'unavailable' }).label, 'Unavailable');
  assert.equal(pluginLimitSettingsStatus({}, { status: 'rateLimited' }).label, 'Limited');
});
test('healthy and unchecked rows omit duplicate or irrelevant right-side state', () => {
  assert.equal(pluginLimitSettingsStatus({}, { status: 'ok' }), null);
  assert.equal(pluginLimitSettingsStatus({}, { status: 'notConfigured' }, false), null);
  assert.equal(pluginLimitSettingsStatus({}, { status: 'disabled' }), null);
});
test('new status copy is localized in all supported languages', () => {
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ja', 'ko', 'pt-BR']) {
    for (const key of ['plugins.limits.awaitingData', 'plugins.limits.readFailed']) assert.notEqual(translate(locale, key), key);
  }
});
