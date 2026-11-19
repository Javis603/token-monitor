'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { showPluginNotification } = require('../../src/electron/plugins/notification');

test('unsupported notifications reject without constructing a native object', async () => {
  class Notification { static isSupported() { return false; } constructor() { assert.fail('must not construct'); } }
  await assert.rejects(showPluginNotification(Notification, {}), /not supported/);
});
for (const outcome of ['throw', 'timeout']) test(`native ${outcome} rejects and releases listeners`, async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  let instance;
  class Notification extends EventEmitter {
    static isSupported() { return true; }
    constructor() { super(); instance = this; }
    show() { if (outcome === 'throw') throw new Error('native error'); }
  }
  const result = showPluginNotification(Notification, {});
  const rejected = assert.rejects(result, outcome === 'throw' ? /native error/ : /not confirmed/);
  if (outcome === 'timeout') t.mock.timers.tick(5000);
  await rejected;
  assert.equal(instance.listenerCount('show'), 0);
  assert.equal(instance.listenerCount('failed'), 0);
});
