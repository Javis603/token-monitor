'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { normalizeManifest } = require('../../src/shared/plugins/manifest');
const { initialPlacements, initializePlacementPatch } = require('../../src/electron/plugins/placementSettings');
async function setup(t, id = 'trusted-fixture') {
  const sourceDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-initial-'));
  t.after(() => fs.rmSync(sourceDirectory, { recursive:true, force:true }));
  fs.cpSync(path.resolve(__dirname, '../fixtures/trusted-plugin'), sourceDirectory, {recursive:true});
  const file = path.join(sourceDirectory,'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.id = id;
  manifest.views.find(view=>view.id==='panel').defaultSurfaces=['page','notch'];
  fs.writeFileSync(file,JSON.stringify(manifest));
  const f = await runtimeFixture(t,{sourceDirectory});
  Object.assign(f.settings,{pluginMainPages:[],notchPluginPages:[],homeModuleOrder:'native',topNotchEnabled:false,edgeDockEnabled:false});
  return {f,manifest,file};
}
test('manifest defaults are optional supported locations, never settings or undeclared surfaces',()=>{
 const manifest={tmApi:1,id:'test-plugin',version:'1.0.0',name:'Test',ui:'ui.mjs',files:['ui.mjs'],views:[{id:'panel',surfaces:['page']}]};
 assert.equal(normalizeManifest(manifest).ok,true);
 for (const value of [['notch'],['page','page'],'page',['settings']]) assert.equal(normalizeManifest({...manifest,views:[{...manifest.views[0],defaultSurfaces:value}]}).ok,false);
 assert.throws(()=>initialPlacements(normalizeManifest(manifest).manifest,[{ref:'other/view',surface:'page'}]),/invalid/);
});
test('install-and-enable applies author defaults without enabling surface masters; user removal survives toggles/update/reinstall',async t=>{
 const {f,manifest,file}=await setup(t);
 let preview=await f.invoke('plugins:import','directory');
 assert.deepEqual(preview.views.find(v=>v.ref==='trusted-fixture/panel').defaultSurfaces,['page','notch']);
 await f.invoke('plugins:install',preview.token,{trustInstall:true});
 assert.deepEqual(f.settings.pluginMainPages,['trusted-fixture/panel']); assert.deepEqual(f.settings.notchPluginPages,['trusted-fixture/panel']);
 assert.equal(f.settings.topNotchEnabled,false); assert.equal(f.settings.edgeDockEnabled,false);
 await f.invoke('plugins:place',{ref:'trusted-fixture/panel',surface:'page',placed:false});
 await f.invoke('plugins:place',{ref:'trusted-fixture/panel',surface:'notch',placed:false});
 await f.invoke('plugins:setEnabled',{id:manifest.id,enabled:false}); await f.invoke('plugins:setEnabled',{id:manifest.id,enabled:true});
 manifest.version='9.0.0'; fs.writeFileSync(file,JSON.stringify(manifest)); preview=await f.invoke('plugins:import','directory');
 await f.invoke('plugins:install',preview.token,{trustUpdate:true});
 await f.invoke('plugins:uninstall',manifest.id,{keepPlacements:true});
 preview=await f.invoke('plugins:import','directory'); assert.equal(preview.placementsRetained,true);
 await f.invoke('plugins:install',preview.token,{trustInstall:true});
 assert.deepEqual(f.settings.pluginMainPages,[]); assert.deepEqual(f.settings.notchPluginPages,[]);
 await f.invoke('plugins:uninstall',manifest.id,{keepPlacements:false});
 preview=await f.invoke('plugins:import','directory'); await f.invoke('plugins:install',preview.token,{trustInstall:true});
 assert.deepEqual(f.settings.pluginMainPages,['trusted-fixture/panel']);
});
test('install-only saves explicit empty or custom selections for first enable, without starting work',async t=>{
 for(const placements of [[],[{ref:'trusted-fixture/panel',surface:'notch'}]]) {
  const {f}=await setup(t); const preview=await f.invoke('plugins:import','directory');
  await f.invoke('plugins:install',preview.token,{placements});
  assert.equal(f.runtime.manager.backendCount(),0); assert.deepEqual(f.settings.notchPluginPages,[]);
  await f.runtime.manager.reload();
  await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
  assert.deepEqual(f.settings.pluginMainPages,[]);assert.deepEqual(f.settings.notchPluginPages,placements.length?['trusted-fixture/panel']:[]);
 }
});
test('full locations never evict other content and stale pending refs are not restored',()=>{
 const pages=Array.from({length:32},(_,i)=>`other/page-${i}`);
 const settings={pluginMainPages:pages,pluginPlacementDefaults:{demo:{applied:false,placements:[{ref:'demo/panel',surface:'page'},{ref:'demo/removed',surface:'notch'}]}}};
 const patch=initializePlacementPatch(settings,'demo',{},[{id:'panel',surfaces:['page']}]);
 assert.equal(patch.pluginMainPages,undefined); assert.equal(patch.notchPluginPages,undefined); assert.equal(patch.pluginPlacementDefaults.demo.applied,true);assert.equal(pages.length,32);
});

test('manual placement before first enable overrides pending author defaults',async t=>{
 const {f}=await setup(t);const preview=await f.invoke('plugins:import','directory');
 await f.invoke('plugins:install',preview.token);
 await f.invoke('plugins:place',{ref:'trusted-fixture/panel',surface:'page',placed:true});
 await f.invoke('plugins:place',{ref:'trusted-fixture/panel',surface:'page',placed:false});
 await f.invoke('plugins:setEnabled',{id:'trusted-fixture',enabled:true});
 assert.deepEqual(f.settings.pluginMainPages,[]);assert.deepEqual(f.settings.notchPluginPages,[]);
});

for (const trustInstall of [true, false]) test(`constructor ID has real initial placement records, install enabled=${trustInstall}`, async t => {
  const { f } = await setup(t, 'constructor');
  const preview = await f.invoke('plugins:import', 'directory');
  assert.equal(preview.placementsRetained, false, 'an inherited constructor is not a retained choice');
  await f.invoke('plugins:install', preview.token, { trustInstall });
  assert.equal(Object.hasOwn(f.settings.pluginPlacementDefaults, 'constructor'), true);
  assert.equal(f.settings.pluginPlacementDefaults.constructor.applied, trustInstall);
  if (!trustInstall) {
    assert.deepEqual(f.settings.pluginMainPages, []);
    await f.runtime.manager.reload();
    await f.invoke('plugins:setEnabled', { id: 'constructor', enabled: true });
  }
  assert.equal(f.runtime.manager.active('constructor'), true);
  assert.deepEqual(f.settings.pluginMainPages, ['constructor/panel']);
  assert.deepEqual(f.settings.notchPluginPages, ['constructor/panel']);
  await f.invoke('plugins:place', { ref: 'constructor/panel', surface: 'page', placed: false });
  await f.invoke('plugins:place', { ref: 'constructor/panel', surface: 'notch', placed: false });
  await f.invoke('plugins:uninstall', 'constructor', { keepPlacements: true });
  const retained = await f.invoke('plugins:import', 'directory');
  assert.equal(retained.placementsRetained, true);
  await f.invoke('plugins:install', retained.token, { trustInstall: true });
  assert.deepEqual(f.settings.pluginMainPages, []);
  assert.deepEqual(f.settings.notchPluginPages, []);
  await f.invoke('plugins:uninstall', 'constructor', { keepPlacements: false });
  const fresh = await f.invoke('plugins:import', 'directory');
  assert.equal(fresh.placementsRetained, false);
  await f.invoke('plugins:install', fresh.token, { trustInstall: true });
  assert.deepEqual(f.settings.pluginMainPages, ['constructor/panel']);
});
test('inherited constructor is ignored by initialization and legacy manual placement', async t => {
  assert.deepEqual(initializePlacementPatch({ pluginPlacementDefaults: {} }, 'constructor'), {});
  const { f } = await setup(t, 'constructor');
  const preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token);
  delete f.settings.pluginPlacementDefaults.constructor;
  await f.invoke('plugins:place', { ref: 'constructor/panel', surface: 'page', placed: true });
  assert.equal(Object.hasOwn(f.settings.pluginPlacementDefaults, 'constructor'), false);
});
