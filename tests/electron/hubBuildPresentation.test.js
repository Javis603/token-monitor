'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { presentation, targetKey } = require('../../src/electron/renderer/hubBuildPresentation');

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
