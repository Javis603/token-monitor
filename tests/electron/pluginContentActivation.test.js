'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { normalizeInitialSetup, contentKey } = require('../../src/electron/plugins/initialSetup');
const TARGET = 'main.home.content';
const REF = 'trusted-fixture/content';

async function setup(t, { competitor = false } = {}) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-content-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.cpSync(path.resolve(__dirname, '../fixtures/trusted-plugin'), source, { recursive: true });
  const file = path.join(source, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file));
  manifest.views.find(view => view.id === 'content').targets = [TARGET];
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

test('enabling selects replacements without another action; off/on preserves the chosen provider', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.install();
  assert.equal(f.settings.pluginContentSelections, undefined, 'install-only must not select content');
  let list = await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(list.contentSelections[TARGET], REF);
  assert.equal(f.dialogs.length, 0);
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  assert.equal(f.runtime.payload('page').views[REF], undefined, 'disabled content cannot mount');
  assert.ok(f.runtime.payload('page').views['other-fixture/content'], 'the chosen provider stays active');
  list = await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(list.contentSelections[TARGET], 'other-fixture/content');
  await f.runtime.manager.reload();
  assert.equal(f.invoke('plugins:list').contentSelections[TARGET], 'other-fixture/content');
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

for (const response of [0, 1, 2]) test(`an author suggestion of native content confirms displacement, response=${response}`, async t => {
  const { f, file, manifest } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  manifest.defaults = { content: { [TARGET]: null } };
  fs.writeFileSync(file, JSON.stringify(manifest));
  const preview = await f.invoke('plugins:import', 'directory'), before = structuredClone(f.settings);
  f.respond(response);
  const install = f.invoke('plugins:install', preview.token, { trustInstall: true });
  if (response === 0) {
    await assert.rejects(install, /cancelled/);
    assert.deepEqual(f.settings, before);
    assert.equal(fs.existsSync(path.join(f.dir, 'plugins', 'trusted-fixture')), false);
  } else {
    await install;
    assert.equal(f.settings.pluginContentSelections[TARGET], response === 1 ? undefined : 'other-fixture/content');
    assert.equal(f.runtime.manager.active('trusted-fixture'), true);
    assert.equal(f.runtime.manager.active('other-fixture'), true);
  }
  assert.equal(f.dialogs.length, 1);
});

test('a trusted update defaults only unconfigured new targets and preserves native and other-plugin choices', async t => {
  const { f, file, manifest } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.invoke('plugins:selectContent', 'main.model.content', null);
  manifest.views = manifest.views.filter(view => view.id !== 'content');
  fs.writeFileSync(file, JSON.stringify(manifest));
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  manifest.version = '2.0.0'; manifest.views.push({ id: 'content', mode: 'replace', targets: [TARGET, 'main.model.content', 'main.session.content'] });
  fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.settings.pluginContentSelections['main.model.content'], undefined);
  assert.equal(f.settings.pluginContentSelections['main.session.content'], REF);
  assert.equal(f.dialogs.length, 0);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.settings.pluginContentSelections['main.model.content'], undefined);
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
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.dialogs.length, dialogCount);
});

test('updates replace a removed selected view but retain an explicit built-in content choice', async t => {
  const { f, file, manifest } = await setup(t);
  let preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  manifest.views.find(view => view.id === 'content').id = 'alternative'; manifest.version = '2.0.0';
  fs.writeFileSync(file, JSON.stringify(manifest)); preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'trusted-fixture/alternative');
  f.invoke('plugins:selectContent', TARGET, null);
  manifest.version = '3.0.0'; fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.equal(f.dialogs.length, 0);
});

test('restoring native content keeps the plugin enabled and survives off/on and a runtime restart', async t => {
  const { f, file } = await setup(t);
  await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.invoke('plugins:selectContent', TARGET, null);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.ok(f.runtime.payload('page').views['trusted-fixture/panel']);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  const saved = JSON.parse(JSON.stringify(f.settings));
  saved.pluginInitialSetup = normalizeInitialSetup(saved.pluginInitialSetup);
  await f.runtime.dispose();
  const restarted = await runtimeFixture(t, { sourceDirectory: path.dirname(file), initialSettings: saved,
    beforeStart(dir) { fs.cpSync(f.dir, dir, { recursive: true }); } });
  await restarted.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await restarted.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(restarted.settings.pluginContentSelections[TARGET], undefined);
  assert.equal(restarted.runtime.manager.active('trusted-fixture'), true);
});

test('first enable can keep another plugins content while activating the remaining features', async t => {
  const { f } = await setup(t, { competitor: true }); await f.install();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.respond(2);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.ok(f.runtime.payload('page').views['trusted-fixture/panel']);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.dialogs.length, 1);
});

test('trust-and-install can keep existing content and remember that decision', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const preview = await f.invoke('plugins:import', 'directory'); f.respond(2);
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.ok(f.settings.pluginInitialSetup['trusted-fixture'].applied.includes(contentKey(TARGET)));
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.dialogs.length, 1);
});

test('a new plugins defaults respect a native choice already made for that target', async t => {
  const { f } = await setup(t, { competitor: true }); await f.install();
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.invoke('plugins:selectContent', TARGET, null);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.ok(f.settings.pluginInitialSetup['trusted-fixture'].applied.includes(contentKey(TARGET)));
  assert.equal(f.dialogs.length, 0);
});

for (const keepPlacements of [false, true]) test(`reinstall retains the native decision only when keeping placements=${keepPlacements}`, async t => {
  const { f } = await setup(t); await f.install();
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  f.invoke('plugins:selectContent', TARGET, null);
  await f.invoke('plugins:uninstall', 'trusted-fixture', { keepPlacements });
  assert.equal(Object.hasOwn(f.settings.pluginInitialSetup, 'trusted-fixture'), keepPlacements);
  const preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], keepPlacements ? undefined : REF);
});

test('recording a native choice also initializes targets of an already active plugin', async t => {
  const { f } = await setup(t); await f.install();
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  delete f.settings.pluginInitialSetup;
  f.invoke('plugins:selectContent', TARGET, null);
  assert.ok(f.settings.pluginInitialSetup['trusted-fixture'].applied.includes(contentKey(TARGET)));
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: false });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
});

test('initial setup normalizes persisted decisions including an own constructor id', () => {
  const normalized = normalizeInitialSetup(JSON.parse('{"constructor":{"values":{"content:main.home.content":null,"background":false,"bad":42},"applied":["content:main.home.content","content:main.home.content","bad"]},"bad id":{}}'));
  assert.deepEqual(normalized, { constructor: { values: { 'content:main.home.content': null, background: false }, applied: ['content:main.home.content'] } });
  for (const invalid of [null, [], 'wrong', false]) assert.deepEqual(normalizeInitialSetup(invalid), {});
});
