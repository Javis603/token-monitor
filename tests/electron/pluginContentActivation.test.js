'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const TARGET = 'main.home.content';
const REF = 'trusted-fixture/content';

async function setup(t, { competitor = false, alternatives = false } = {}) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-content-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, '../fixtures/trusted-plugin'), source, { recursive: true });
  const file = path.join(source, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.views.find(view => view.id === 'content').targets = [TARGET];
  if (alternatives) manifest.views.push({ id: 'alternative', title: 'Alternative', mode: 'replace', targets: [TARGET] });
  fs.writeFileSync(file, JSON.stringify(manifest));
  const f = await runtimeFixture(t, { sourceDirectory: source, beforeStart(dir) {
    if (!competitor) return;
    const folder = path.join(dir, 'plugins', 'other-fixture');
    fs.cpSync(source, folder, { recursive: true });
    const other = structuredClone(manifest); other.id = 'other-fixture'; other.name = 'Other plugin';
    other.views.push({ id: 'independent', mode: 'replace', targets: ['main.model.content'] });
    fs.writeFileSync(path.join(folder, 'manifest.json'), JSON.stringify(other));
  } });
  return { f, file, manifest };
}

test('enabling selects replacements without another action; off/on restores the saved choice', async t => {
  const { f } = await setup(t, { alternatives: true });
  await f.install();
  assert.equal(f.settings.pluginContentSelections, undefined, 'install-only must not select content');
  let list = await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(list.contentSelections[TARGET], REF);
  assert.equal(f.dialogs.length, 0);
  f.invoke('plugins:selectContent', TARGET, 'trusted-fixture/alternative');
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.deepEqual(f.runtime.payload('page').views, {}, 'disabled content cannot mount');
  list = await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(list.contentSelections[TARGET], 'trusted-fixture/alternative');
  await f.runtime.manager.reload();
  assert.equal(f.invoke('plugins:list').contentSelections[TARGET], 'trusted-fixture/alternative');
});

test('a conflicting enable can be cancelled; accepting switches only the shared target', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.install();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  const before = structuredClone(f.settings);
  f.cancel();
  await assert.rejects(f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true }), /cancelled/);
  assert.deepEqual(f.settings, before);
  assert.match(f.dialogs[0].message, /Other plugin/);
  f.accept();
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  assert.equal(f.settings.pluginContentSelections['main.model.content'], 'other-fixture/independent');
  assert.equal(f.runtime.manager.active('other-fixture'), true);
  assert.ok(f.runtime.payload('page').views['other-fixture/panel']);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF, 'do not silently fall back to the displaced plugin');
  assert.equal(f.runtime.payload('page').views[REF], undefined);
});

test('disabled competitors do not require confirmation', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.install();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  assert.equal(f.dialogs.length, 0);
});

test('trust-and-install selects content; cancelled conflicts leave no installed package', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const before = structuredClone(f.settings);
  let preview = await f.invoke('plugins:import', 'directory');
  f.cancel();
  await assert.rejects(f.invoke('plugins:install', preview.token, { trustInstall: true }), /cancelled/);
  assert.deepEqual(f.settings, before);
  assert.equal(fs.existsSync(path.join(f.dir, 'plugins', 'trusted-fixture')), false);
  f.accept(); preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.equal(f.runtime.manager.active('other-fixture'), true);
});

test('a trusted update selects new targets and preserves the previous version on cancellation', async t => {
  const { f, file, manifest } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  manifest.views = manifest.views.filter(view => view.id !== 'content');
  fs.writeFileSync(file, JSON.stringify(manifest));
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  manifest.version = '2.0.0'; manifest.views.push({ id: 'content', mode: 'replace', targets: [TARGET] });
  fs.writeFileSync(file, JSON.stringify(manifest));
  const before = structuredClone(f.settings);
  preview = await f.invoke('plugins:import', 'directory'); f.cancel();
  await assert.rejects(f.invoke('plugins:install', preview.token, { trustUpdate: true }), /cancelled/);
  assert.deepEqual(f.settings, before);
  assert.equal(f.invoke('plugins:list').plugins.find(plugin => plugin.id === 'trusted-fixture').version, '1.0.0');
  f.accept(); preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  assert.equal(f.invoke('plugins:list').plugins.find(plugin => plugin.id === 'trusted-fixture').version, '2.0.0');
});

test('append-only plugins leave replacement choices unchanged', async t => {
  const { f, file, manifest } = await setup(t);
  manifest.views.find(view => view.id === 'content').mode = 'append';
  fs.writeFileSync(file, JSON.stringify(manifest)); await f.install();
  f.settings.pluginContentSelections = { 'main.model.content': 'other/model' };
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.deepEqual(f.settings.pluginContentSelections, { 'main.model.content': 'other/model' });
  assert.equal(f.dialogs.length, 0);
});

test('updating an enabled plugin does not reclaim content selected from another plugin', async t => {
  const { f, file, manifest } = await setup(t, { competitor: true });
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const dialogCount = f.dialogs.length;
  manifest.version = '2.0.0'; fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.dialogs.length, dialogCount);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
});

test('updates replace a removed selected view but retain an explicit built-in content choice', async t => {
  const { f, file, manifest } = await setup(t, { alternatives: true });
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  f.invoke('plugins:selectContent', TARGET, 'trusted-fixture/alternative');
  manifest.views = manifest.views.filter(view => view.id !== 'alternative'); manifest.version = '2.0.0';
  fs.writeFileSync(file, JSON.stringify(manifest)); preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  f.invoke('plugins:selectContent', TARGET, null);
  manifest.version = '3.0.0'; fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.equal(f.dialogs.length, 0);
});
