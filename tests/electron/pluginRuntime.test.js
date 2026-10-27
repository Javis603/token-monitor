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
  f.lifecycle(f.main, () => ({ loaded: true, unsaved: true }));
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

test('Notch mirror and custom bitmap demand follow only the effective layout and preserve other owners', async t => {
  const f = await runtimeFixture(t, { surfaceContext: () => ({ visible: false, summaryVisible: true }) });
  await f.install();
  const file = path.join(f.dir, 'plugins/trusted-fixture/manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.views = [{ id: 'bitmap', surfaces: ['tray'] }, { id: 'custom', surfaces: ['tray'] }];
  fs.writeFileSync(file, JSON.stringify(manifest)); await f.runtime.manager.reload();
  const layout = ref => ({ items: [{ id: 'p', type: 'plugin', ref }] });
  const mirror = 'trusted-fixture/bitmap', custom = 'trusted-fixture/custom';
  Object.assign(f.settings, { showTrayIcon: true, trayContent: 'custom', trayCustomLayout: layout(mirror), notchSummaryMode: 'tray', notchCustomLayout: layout(custom) });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.ok(f.runtime.payload('notch').views[mirror]); assert.equal(f.runtime.payload('notch').views[custom], undefined);
  f.send(f.notch, 'notch', [mirror]); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.settings.notchSummaryMode = 'custom'; f.runtime.settingsChanged(); await tick();
  assert.ok(f.runtime.payload('notch').views[custom]); assert.equal(f.runtime.payload('notch').views[mirror], undefined);
  f.send(f.notch, 'notch', [custom]); f.send(f.main, 'tray', [mirror]); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.settings.notchSummaryEnabled = false; f.runtime.settingsChanged(); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
  f.send(f.main, 'tray', []); await tick(); assert.equal(f.runtime.manager.backendCount(), 0);
  f.settings.notchSummaryEnabled = true; f.settings.notchSummaryMode = 'tray'; f.settings.trayContent = 'tokens'; f.runtime.settingsChanged();
  assert.equal(f.runtime.payload('notch').views[mirror], undefined);
});

for (const keepPlacements of [false,true]) test(`uninstall compact placements keep=${keepPlacements} survive management restart consistently`, async t => {
  const f=await runtimeFixture(t);await f.install();await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  const ref='trusted-fixture/panel',other='other/panel';
  const layout={items:[{id:'own',type:'plugin',ref},{id:'native',type:'icon',style:'appIcon',icon:'app'},{id:'other',type:'plugin',ref:other}]};
  Object.assign(f.settings,{floatingBubbleCustomLayout:structuredClone(layout),notchCustomLayout:structuredClone(layout),notchPageOrder:['plugin:'+ref,'home','plugin:'+other]});
  await f.invoke('plugins:uninstall','trusted-fixture',{keepPlacements,keepData:true});
  for(const key of ['floatingBubbleCustomLayout','notchCustomLayout']) assert.deepEqual(f.settings[key].items.map(item=>item.id),keepPlacements?['own','native','other']:['native','other']);
  assert.deepEqual(f.settings.notchPageOrder,keepPlacements?['plugin:'+ref,'home','plugin:'+other]:['home','plugin:'+other]);
  await f.runtime.manager.reload();await f.install();
  assert.equal(f.invoke('plugins:list').plugins[0].enabled,false);assert.equal(f.runtime.manager.backendCount(),0);
});


test('unchanged trust survives off/on and restart; changed bytes require fresh consent metadata', async t => {
  const f = await runtimeFixture(t); await f.install();
  assert.equal(f.invoke('plugins:list').plugins[0].trusted, false);
  await f.invoke('plugins:setEnabled', { id:'trusted-fixture', enabled:true });
  const revision = f.settings.pluginStates['trusted-fixture'].trustedRevision;
  f.lifecycle(f.main, () => ({ loaded:true, unsaved:false }));
  await f.invoke('plugins:setEnabled', { id:'trusted-fixture', enabled:false });
  assert.equal(f.invoke('plugins:list').plugins[0].trusted, true);
  await f.invoke('plugins:setEnabled', { id:'trusted-fixture', enabled:true });
  await f.runtime.manager.reload();
  assert.equal(f.invoke('plugins:list').plugins[0].trusted, true);
  assert.equal(f.settings.pluginStates['trusted-fixture'].trustedRevision, revision);
  assert.equal(f.dialogs.length, 0); assert.equal(f.main.webContents.reloads, 0);
  fs.appendFileSync(path.join(f.dir,'plugins/trusted-fixture/ui.mjs'),'\n// new code'); await f.runtime.manager.reload();
  assert.equal(f.invoke('plugins:list').plugins[0].trusted, false);
});
test('cooperative disable reaches only loaded hosts and stops backend without reloading', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  const calls = [];
  f.lifecycle(f.main, request => { calls.push(['main',request.action]); return {loaded:true,unsaved:false}; });
  f.lifecycle(f.notch, request => { calls.push(['notch',request.action]); return {loaded:false}; });
  f.send(f.main,'home'); await tick(); assert.equal(f.runtime.manager.backendCount(),1);
  await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:false}); await tick();
  assert.equal(f.runtime.manager.backendCount(),0); assert.equal(f.dialogs.length,0);
  assert.ok(calls.some(([host,action])=>host==='main'&&action==='release'));
  assert.ok(!calls.some(([host,action])=>host==='notch'&&action==='release'));
  assert.equal(f.main.webContents.reloads+f.notch.webContents.reloads,0);
});
test('failed cleanup stays disabled; cancel recovery preserves other hosts and re-enable asks again', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  f.lifecycle(f.notch, request => { if(request.action==='release')throw Error('dispose failed');return {loaded:true}; });
  f.cancel(); await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:false});
  assert.equal(f.runtime.manager.active('trusted-fixture'),false); assert.equal(f.dialogs.length,1);
  assert.equal(f.notch.webContents.reloads,0);
  await assert.rejects(f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true}),/cancelled/);
  f.accept(); await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.equal(f.notch.webContents.reloads,1); assert.equal(f.main.webContents.reloads,0);
});
test('master pause checks drafts before mutation and disposes after persistence; resume reuses trust', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  const actions=[]; f.lifecycle(f.main, request=>{actions.push(request.action);return {loaded:true,unsaved:true};});
  f.cancel(); await assert.rejects(f.runtime.beforeSettingsChange(f.event(f.main),{pluginsEnabled:false}),/cancelled/);
  assert.equal(f.settings.pluginsEnabled,true); assert.ok(!actions.includes('release'));
  f.accept(); const finish=await f.runtime.beforeSettingsChange(f.event(f.main),{pluginsEnabled:false});
  f.settings.pluginsEnabled=false;f.runtime.settingsChanged();await finish();assert.ok(actions.includes('release'));
  const resume=await f.runtime.beforeSettingsChange(f.event(f.main),{pluginsEnabled:true});
  f.settings.pluginsEnabled=true;f.runtime.settingsChanged();await resume();
  assert.equal(f.runtime.manager.active('trusted-fixture'),true);assert.equal(f.main.webContents.reloads,0);
});


test('an unrelated silent host cannot block enable, disable, or re-enable', async t => {
  const f = await runtimeFixture(t); await f.install();
  f.events.get('plugins:lifecycleHost')(f.event(f.notch), true);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.lifecycle(f.main, () => ({ loaded: true, unsaved: false }));
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.equal(f.notch.webContents.sent.filter(message => message.channel === 'plugins:lifecycle').length, 0);
  assert.equal(f.dialogs.length, 0); assert.equal(f.notch.webContents.reloads, 0);
  const actions = f.main.webContents.sent.filter(message => message.channel === 'plugins:lifecycle').map(message => message.value.action);
  assert.deepEqual(actions, ['inspect', 'release', 'resume']);
});
test('ownership of another plugin does not join lifecycle operations; navigation clears ownership', async t => {
  const f = await runtimeFixture(t); await f.install();
  const folder = path.join(f.dir, 'plugins', 'other-fixture');
  fs.cpSync(path.join(f.dir, 'plugins', 'trusted-fixture'), folder, { recursive: true });
  const file = path.join(folder, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
  manifest.id = 'other-fixture'; fs.writeFileSync(file, JSON.stringify(manifest)); await f.runtime.manager.reload();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.events.get('plugins:lifecycleHost')(f.event(f.notch), true);
  f.events.get('plugins:uiLoading')?.(f.event(f.notch), 'other-fixture');
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.equal(f.notch.webContents.sent.filter(message => message.channel === 'plugins:lifecycle').length, 0);
  f.notch.webContents.emit('did-start-navigation', {}, '', false, true);
  f.events.get('plugins:lifecycleHost')(f.event(f.notch), true);
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: false });
  assert.equal(f.dialogs.length, 0);
});


test('same-document navigation retains lifecycle ownership and draft checks', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.lifecycle(f.main, () => ({ loaded: true, unsaved: true }));
  f.main.webContents.emit('did-start-navigation', {}, 'file:///index.html#author', true, true);
  f.cancel(); await assert.rejects(f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false }), /cancelled/);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
});
test('failed relevant resume offers explicit recovery and cancellation preserves disabled state', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.lifecycle(f.main, request => { if (request.action === 'resume') throw Error('resume failed'); return { loaded: true }; });
  f.events.get('plugins:lifecycleHost')(f.event(f.notch), true);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  f.cancel(); await assert.rejects(f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true }), /cancelled/);
  assert.equal(f.runtime.manager.active('trusted-fixture'), false); assert.equal(f.main.webContents.reloads, 0);
  f.accept(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true }); await new Promise(resolve => setTimeout(resolve, 20));
  assert.equal(f.main.webContents.reloads, 1); assert.equal(f.notch.webContents.reloads, 0);
});
test('master pause and resume send only each hosts loaded plugin ids', async t => {
  const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  const folder = path.join(f.dir, 'plugins', 'other-fixture'); fs.cpSync(path.join(f.dir, 'plugins', 'trusted-fixture'), folder, { recursive: true });
  const file = path.join(folder, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file)); manifest.id = 'other-fixture'; fs.writeFileSync(file, JSON.stringify(manifest)); await f.runtime.manager.reload();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const calls = []; f.lifecycle(f.main, request => { calls.push(request); return { loaded: true }; });
  const finish = await f.runtime.beforeSettingsChange(f.event(f.main), { pluginsEnabled: false });
  f.settings.pluginsEnabled = false; f.runtime.settingsChanged(); await finish();
  const resume = await f.runtime.beforeSettingsChange(f.event(f.main), { pluginsEnabled: true });
  f.settings.pluginsEnabled = true; f.runtime.settingsChanged(); await resume();
  assert.deepEqual(calls.map(request => request.ids), [['trusted-fixture'], ['trusted-fixture'], ['trusted-fixture']]);
});

for (const [name, inPlace, mainFrame, retained] of [['hash', true, true, true], ['subframe', false, false, true], ['full', false, true, false]]) {
  test(`${name} navigation preserves only same-document subscriber demand and data`, async t => {
    const f = await runtimeFixture(t); await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
    f.runtime.publishStats({ periods: { today: { totalTokens: 1, costUsd: 1 } } });
    const subscription = await f.invoke('plugins:subscribe', 'trusted-fixture', { resource: 'usage', period: 'today' });
    await tick(); await tick();
    const messages = () => f.main.webContents.sent.filter(item => item.channel === 'plugins:data' && item.value.subscription === subscription);
    assert.equal(messages().length, 1);
    f.send(f.main, 'home'); await tick(); assert.equal(f.runtime.manager.backendCount(), 1);
    f.main.webContents.emit('did-start-navigation', {}, 'file:///index.html#author', inPlace, mainFrame); await tick();
    // No replacement demand or subscription IPC: the document still has the same refs.
    f.runtime.publishStats({ periods: { today: { totalTokens: 2, costUsd: 1 } } });
    await new Promise(resolve => setTimeout(resolve, 300));
    assert.equal(f.runtime.manager.backendCount(), retained ? 1 : 0);
    assert.equal(messages().length > 1, retained);
    assert.equal(await f.invoke('plugins:unsubscribe', subscription), retained);
  });
}
