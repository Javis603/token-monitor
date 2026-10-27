'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const tick = () => new Promise(setImmediate);
test('bubble-only bitmap demand stops on native hide; system Tray demand survives it', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', {id:'trusted-fixture',enabled:true});
  const layout = {items:[{id:'plugin',type:'plugin',ref:'trusted-fixture/panel'}]};
  Object.assign(f.settings,{showTrayIcon:false,floatingBubbleContent:'custom',floatingBubbleCustomLayout:layout});
  f.send(f.main,'tray'); await tick(); assert.equal(f.runtime.manager.backendCount(),1);
  f.main.visible=false; f.runtime.refreshWindowVisibility(f.main); await tick(); assert.equal(f.runtime.manager.backendCount(),0);
  f.send(f.main,'tray'); await tick(); assert.equal(f.runtime.manager.backendCount(),0);
  Object.assign(f.settings,{showTrayIcon:true,trayContent:'custom',trayCustomLayout:layout});
  f.runtime.settingsChanged(); await tick(); assert.equal(f.runtime.manager.backendCount(),1);
  f.settings.showTrayIcon=false; f.runtime.settingsChanged(); await tick(); assert.equal(f.runtime.manager.backendCount(),0);
});
test('collapsed Notch custom bitmap supports a Tray-only view and releases hidden demand', async t => {
  let visible=true;
  const f=await runtimeFixture(t,{surfaceContext:()=>({visible:false,summaryVisible:visible})}); await f.install();
  const file=path.join(f.dir,'plugins/trusted-fixture/manifest.json'), manifest=JSON.parse(fs.readFileSync(file));
  manifest.views=[{id:'bitmap',surfaces:['tray']}]; fs.writeFileSync(file,JSON.stringify(manifest)); await f.runtime.manager.reload();
  Object.assign(f.settings,{notchSummaryMode:'custom',notchCustomLayout:{items:[{id:'plugin',type:'plugin',ref:'trusted-fixture/bitmap'}]}});
  await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  assert.ok(f.runtime.payload('notch').views['trusted-fixture/bitmap']);
  f.send(f.notch,'notch',['trusted-fixture/bitmap']); await tick(); assert.equal(f.runtime.manager.backendCount(),1);
  visible=false; f.runtime.refreshSurfaces(); await tick(); assert.equal(f.runtime.manager.backendCount(),0);
  visible=true; f.runtime.refreshSurfaces(); await tick(); assert.equal(f.runtime.manager.backendCount(),1);
  f.settings.notchSummaryMode='sessions'; f.runtime.settingsChanged(); await tick(); assert.equal(f.runtime.manager.backendCount(),0);
  assert.equal(f.runtime.payload('notch').views['trusted-fixture/bitmap'],undefined);
});
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
  f.settings.trayContent = 'custom'; f.settings.trayCustomLayout = { items: [{ id: 'plugin', type: 'plugin', ref: 'trusted-fixture/panel' }] };
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
test('Tray menu enumeration is idle; callbacks are declared, demand-driven and revoked when disabled', async t => {
  const f = await runtimeFixture(t); await f.install();
  assert.deepEqual(f.runtime.trayMenu(), []);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.runtime.trayMenu()[0].id, 'ping'); assert.equal(f.children.length, 0);
  assert.deepEqual(await f.runtime.trayAction('trusted-fixture', 'ping'), { id: 'ping' });
  await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  await assert.rejects(async () => f.runtime.trayAction('trusted-fixture', 'unknown'));
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.deepEqual(f.runtime.trayMenu(), []);
  await assert.rejects(async () => f.runtime.trayAction('trusted-fixture', 'ping'));
});
test('content ordering validates declared additive refs, persists and reaches descriptors without starting code', async t => {
  const f = await runtimeFixture(t); await f.install();
  const manifestPath = path.join(f.dir, 'plugins/trusted-fixture/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath));
  manifest.views.push(...['a','b'].map(id => ({ id, targets: ['main.model.content'] })));
  fs.writeFileSync(manifestPath, JSON.stringify(manifest)); await f.runtime.manager.reload();
  const refs = ['trusted-fixture/b', 'trusted-fixture/a'];
  const list = f.invoke('plugins:orderContent', 'main.model.content', refs);
  assert.deepEqual(list.contentOrder['main.model.content'], refs);
  assert.equal(list.plugins[0].views.find(view => view.id === 'b').contentOrder['main.model.content'], 0);
  assert.equal(f.children.length, 0);
  assert.throws(() => f.invoke('plugins:orderContent', 'main.model.content', ['other/a']));
  assert.throws(() => f.invoke('plugins:orderContent', 'main.model.content', [refs[0],refs[0]]));
  assert.throws(() => f.invoke('plugins:orderContent', 'main.limits.content', ['trusted-fixture/content']));
});

test('removing placements does not create an absent content-order setting', () => {
  const { removePluginPlacements } = require('../../src/electron/plugins/placementSettings');
  assert.equal(Object.hasOwn(removePluginPlacements({}, 'fixture'), 'pluginContentOrder'), false);
});
