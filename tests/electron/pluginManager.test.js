'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const tick = () => new Promise(setImmediate);
test('backend action starts on demand and stops after last call without placements', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(await f.invoke('plugins:call', 'trusted-fixture', 'echo', 7), 7); await tick();
  assert.equal(f.children.length, 1); assert.equal(f.runtime.manager.backendCount(), 0);
});
test('backend exit remains failed until an explicit restart; disable revokes executable assets', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true }); f.send(f.main, 'home'); await tick();
  f.children[0].emit('exit', 9); f.runtime.manager.settingsChanged(); await tick(); assert.equal(f.children.length, 1);
  assert.equal(f.invoke('plugins:list').plugins[0].runtime.state, 'error');
  f.invoke('plugins:restart', { id: 'trusted-fixture' }); await tick(); assert.equal(f.children.length, 2);
  const view = f.runtime.payload('home').views['trusted-fixture/panel'];
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.equal(f.runtime.manager.asset('trusted-fixture', view.revision, 'ui.mjs'), null);
});
test('plugin data listeners cannot break another subscriber', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true }); f.send(f.main, 'home'); await tick();
  let value; f.runtime.manager.onData(() => { throw Error('bad listener'); }); f.runtime.manager.onData((_id, data) => { value = data; });
  f.children[0].emit('message', { type: 'data', value: { count: 3 } }); assert.deepEqual(value, { count: 3 });
});
test('package removed between discovery and demand stays a plugin error without throwing into host', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  require('node:fs').rmSync(require('node:path').join(f.dir, 'plugins/trusted-fixture/backend.cjs'));
  assert.doesNotThrow(() => f.send(f.main, 'home')); await tick();
  assert.equal(f.children.length, 0); assert.equal(f.invoke('plugins:list').plugins[0].runtime.state, 'error');
});
