'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const fs = require('node:fs');
const path = require('node:path');
const { limitsSource, periodSource } = require('../../src/electron/plugins/appSources');

test('plugin quota projection skips unknown readings and strips identity', () => {
  const rows = limitsSource({ limits: { providers: [
    { provider: 'codex', accountKey: 'secret', email: 'private@example.com', windows: [{ remainingPercent: null }, { remainingPercent: 42, kind: 'weekly' }] },
    { provider: 'claude', windows: [{ remainingPercent: '', kind: 'weekly' }] }
  ] } });
  assert.deepEqual(rows, [{ provider: 'codex', window: 'weekly', kind: 'weekly', remainingPercent: 42, usedPercent: 58, resetsAt: null }]);
  assert.equal(periodSource(null), null);
  assert.deepEqual(periodSource({ totalTokens: 123, costUsd: 4.5, unpricedTokens: 10, sessions: [{ title: 'private' }] }), { tokens: 123, cost: 4.5, unpricedTokens: 10 });
});

test('Token Pulse starts with a baseline and keeps its tray drawing inside the viewport', async () => {
  let tick;
  let sample = { burn: 0, idle: true };
  const notifications = [];
  const values = new Map();
  const tm = { subscribe() {}, read: id => id === 'tm.rate' ? sample : 42,
    publish: (id, value) => values.set(id, value), onTick: fn => { tick = fn; },
    storage: { get: async () => null }, notify: async note => notifications.push(note) };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../../docs/plugins/examples/token-pulse/main.js'), 'utf8'), { tm });
  await tick({ mode: 'visible', now: 1000 });
  sample = { burn: 100_000, idle: true };
  await tick({ mode: 'visible', now: 3000 });
  assert.equal(values.get('tpm'), 0, 'initial collector total is a baseline');
  sample = { burn: 3000, idle: false };
  await tick({ mode: 'visible', now: 5000 });
  assert.equal(values.get('tpm'), 3000);
  sample = { burn: 300_000, idle: false };
  for (const now of [10_000, 12_000, 14_000]) await tick({ mode: 'visible', now });
  assert.equal(notifications.length, 0, 'three fast ticks must not mean a minute');
  await tick({ mode: 'background', now: 70_000 });
  assert.equal(notifications.length, 1);
  await tick({ mode: 'background', now: 100_000 });
  assert.equal(notifications.length, 1, 'notification cooldown also applies in the background');
  for (const op of values.get('mini')) {
    assert.ok(op.x >= 0 && op.x + op.w <= 30, JSON.stringify(op));
    assert.ok(op.y >= 0 && op.y + op.h <= 22, JSON.stringify(op));
  }
});
