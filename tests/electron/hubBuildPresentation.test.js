'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { presentation, targetKey } = require('../../src/electron/renderer/hubBuildPresentation');
const i18n = require('../../src/electron/renderer/i18n');

const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const renderSource = app.slice(app.indexOf('function renderHubBuildStatus('), app.indexOf('function renderHubAddresses('));

function renderer({ status = 'current', runtime = 'cloudflare-worker', hubMode = 'client', locale = 'en' } = {}) {
  const context = vm.createContext({
    state: { settings: { hubMode }, hubBuildStatus: { status, runtime } },
    els: { syncPanelBuild: {}, hubBuildStatus: {} },
    hubBuildPresentationApi: { presentation },
    t: (key, params) => i18n.translate(locale, key, params)
  });
  vm.runInContext(renderSource, context);
  context.renderHubBuildStatus();
  return context;
}

test('Hub build presentation uses restrained semantic tones', () => {
  assert.deepEqual(presentation({ status: 'current', runtime: 'cloudflare-worker' }), {
    key: 'settings.sync.hubBuild.current',
    targetKey: 'settings.sync.hubBuild.targetWorker',
    tone: 'ok'
  });
  assert.equal(presentation({ status: 'updateAvailable', runtime: 'node-hub' }).tone, 'warning');
  assert.deepEqual(presentation({ status: 'legacy', runtime: 'cloudflare-worker' }), {
    key: 'settings.sync.hubBuild.updateAvailable',
    targetKey: 'settings.sync.hubBuild.targetWorker',
    tone: 'warning'
  });
  assert.equal(presentation({ status: 'remoteNewer', runtime: 'node-hub' }).tone, '');
  assert.equal(presentation({ status: 'unavailable', runtime: '' }), null);
});

test('Hub build presentation labels Worker, Node, and unknown Hub runtimes', () => {
  assert.equal(targetKey('cloudflare-worker'), 'settings.sync.hubBuild.targetWorker');
  assert.equal(targetKey('node-hub'), 'settings.sync.hubBuild.targetNode');
  assert.equal(targetKey('custom'), 'settings.sync.hubBuild.targetHub');
});

test('matching Hub builds show only the confirmed backend in every locale', () => {
  for (const locale of ['en', 'zh-TW', 'zh-CN', 'ko', 'ja']) {
    for (const [runtime, label] of [['cloudflare-worker', 'Cloudflare Worker'], ['node-hub', 'Node Hub']]) {
      const { els } = renderer({ runtime, locale });
      assert.equal(els.syncPanelBuild.hidden, false);
      assert.equal(els.syncPanelBuild.textContent, label);
      assert.equal(els.hubBuildStatus.hidden, true);
      assert.equal(els.hubBuildStatus.textContent, '');
    }
    assert.equal(Object.hasOwn(i18n.MESSAGES[locale], 'settings.sync.panel.buildCurrent'), false);
  }
});

test('backend labels coexist with the existing version notices', () => {
  for (const status of ['updateAvailable', 'legacy', 'remoteNewer', 'unknown']) {
    const { els } = renderer({ status });
    assert.equal(els.syncPanelBuild.hidden, false);
    assert.equal(els.syncPanelBuild.textContent, 'Cloudflare Worker');
    assert.equal(els.hubBuildStatus.hidden, false);
    assert.equal(els.hubBuildStatus.textContent, i18n.translate('en', presentation({ status }).key, { target: 'Cloudflare Worker' }));
    if (status === 'updateAvailable' || status === 'legacy') assert.match(els.hubBuildStatus.className, /warning/);
  }
});

test('unconfirmed runtimes and unavailable probes do not guess a backend label', () => {
  for (const result of [
    { status: 'current', runtime: 'custom' },
    { status: 'unknown', runtime: '' },
    { status: 'unavailable', runtime: 'cloudflare-worker' },
    { status: 'notConfigured', runtime: 'node-hub' },
    { status: '', runtime: 'cloudflare-worker' }
  ]) {
    const { els } = renderer(result);
    assert.equal(els.syncPanelBuild.hidden, true);
    assert.equal(els.syncPanelBuild.textContent, '');
  }
  for (const hubMode of ['host', 'local', 'icloud']) {
    const { els } = renderer({ hubMode });
    assert.equal(els.syncPanelBuild.hidden, true);
    assert.equal(els.hubBuildStatus.hidden, true);
  }
});
