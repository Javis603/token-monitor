'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const tick = () => new Promise(setImmediate);
for (const surface of ['home', 'page', 'settings']) test(`native ${surface} hide, late IPC, minimize and restore bound effective backend demand`, async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.runtime.manager.backendCount(), 0);
  f.send(f.main, surface); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.main.visible = false; f.runtime.refreshWindowVisibility(f.main); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  f.send(f.main, surface); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  f.main.visible = true; f.main.minimized = true; f.runtime.refreshWindowVisibility(f.main); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  f.main.minimized = false; f.runtime.refreshWindowVisibility(f.main); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  if (surface !== 'settings') {
    f.settings.homeModuleOrder = ''; f.settings.pluginMainPages = []; f.runtime.settingsChanged(); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  }
});
test('one backend is shared across native surfaces; final hide stops it', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.send(f.main, 'home'); f.send(f.notch, 'notch'); await tick(); assert.equal(f.children.length, 1);
  f.main.visible = false; f.runtime.refreshWindowVisibility(f.main); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.notch.visible = false; f.runtime.refreshSurfaces(); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  f.send(f.main, 'tray'); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.main.webContents.emit('destroyed'); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
});
test('no overlapping backend processes across rapid stop/start; removed demand cancels queued start', async t => {
  const f = await runtimeFixture(t, { delayedExit: true }); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.send(f.main, 'home'); await tick(); f.send(f.main, 'home', []); f.send(f.main, 'home'); await tick();
  assert.equal(f.children.length, 1); f.send(f.main, 'home', []); f.children[0].kill(); await tick(); assert.equal(f.children.length, 1);
  f.send(f.main, 'home'); await tick(); assert.equal(f.children.length, 2);
});
test('safe mode enumerates packages without loading UI or starting backend', async t => {
  const f = await runtimeFixture(t, { safeMode: true }); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.send(f.main, 'home'); await tick(); assert.equal(f.children.length, 0);
  assert.deepEqual(f.runtime.payload('home').views, {}); assert.equal(f.invoke('plugins:list').safeMode, true);
});
test('trust is revision-specific and missing installs remain manageable after reload', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  fs.appendFileSync(path.join(f.dir, 'plugins/trusted-fixture/ui.mjs'), '\n// changed');
  await f.runtime.manager.reload(); assert.equal(f.invoke('plugins:list').plugins[0].status, 'needsApproval');
  assert.deepEqual(f.runtime.payload('page').views, {});
  fs.rmSync(path.join(f.dir, 'plugins/trusted-fixture'), { recursive: true }); await f.runtime.manager.reload();
  assert.equal(f.invoke('plugins:list').plugins[0].status, 'missing');
  await f.invoke('plugins:uninstall', 'trusted-fixture'); assert.equal(f.invoke('plugins:list').plugins.length, 0);
});
test('replacement selection requires an active declared replacement; cancelling code changes preserves execution', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  const selected = f.invoke('plugins:selectContent', 'main.limits.content', 'trusted-fixture/content');
  assert.equal(selected.contentSelections['main.limits.content'], 'trusted-fixture/content');
  assert.throws(() => f.invoke('plugins:selectContent', 'main.limits.content', 'trusted-fixture/panel'));
  f.cancel(); await assert.rejects(f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false }), /cancelled/);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
});
test('formal data source changes refresh results; disabled calls reject and host settings use public projection', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  for (const value of [5, 9]) {
    f.runtime.publishStats({ periods: { today: { totalTokens: value, costUsd: 1 } } });
    const result = await f.invoke('plugins:host', 'trusted-fixture', 'data.query', { resource: 'usage', period: 'today' });
    assert.equal(result.rows[0].totalTokens, value);
  }
  assert.deepEqual(await f.invoke('plugins:host', 'trusted-fixture', 'app.settings'), { public: true });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await assert.rejects(f.invoke('plugins:host', 'trusted-fixture', 'data.query', {}), /disabled/);
});
test('descriptor subscription receives first content selection without foreground demand', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  const first = f.handlers.get('plugins:views')(f.event(f.notch), { surface: 'notch' });
  assert.ok(first.views['trusted-fixture/content']); assert.equal(f.children.length, 0);
  f.notch.webContents.sent.length = 0;
  f.invoke('plugins:selectContent', 'notch.home.content', 'trusted-fixture/content');
  assert.ok(f.notch.webContents.sent.some(item => item.channel === 'plugins:views' && item.value.surface === 'notch'));
  assert.equal(f.children.length, 0);
});
test('returning demand during cancelled activation starts the replacement backend', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.send(f.main, 'home'); f.send(f.main, 'home', []); f.send(f.main, 'home');
  await tick(); await tick();
  assert.equal(f.children.length, 2); assert.equal(f.runtime.manager.backendCount(), 1);
  assert.equal(await f.invoke('plugins:call', 'trusted-fixture', 'echo', 'ready'), 'ready');
});
