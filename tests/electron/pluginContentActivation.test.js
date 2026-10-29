'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { Element } = require('../helpers/notchPanel');
const { createHost } = require('../../src/electron/renderer/pluginUi');
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
  const preview = await f.invoke('plugins:import', 'directory');
  f.cancel();
  await assert.rejects(f.invoke('plugins:install', preview.token, { trustInstall: true }), /cancelled/);
  assert.deepEqual(f.settings, before);
  assert.equal(fs.existsSync(path.join(f.dir, 'plugins', 'trusted-fixture')), false);
  f.accept();
  await f.invoke('plugins:install', preview.token, { trustInstall: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.equal(f.runtime.manager.active('other-fixture'), true);
});

for (const cancelAt of ['conflict', 'displaced-draft', 'package', 'expired-preview']) test(`update cancellation at ${cancelAt} preserves both original drafts before cleanup`, async t => {
  const { f, file, manifest } = await setup(t, { competitor: true });
  manifest.views = manifest.views.filter(view => view.id !== 'content');
  fs.writeFileSync(file, JSON.stringify(manifest));
  const first = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', first.token, { trustInstall: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const document = { createElement: tag => new Element(tag, document) };
  document.head = document.createElement('head');
  let lifecycle, disposals = 0;
  const host = createHost({ document, window: {}, bridge: { onLifecycle(fn) { lifecycle = fn; } },
    importModule: async () => ({ mount(container) {
      const input = document.createElement('input'); container.append(input);
      return { hasUnsavedChanges: () => Boolean(input.value), dispose() { disposals++; input.remove(); } };
    } }) });
  t.after(() => host.dispose());
  const container = document.createElement('div');
  await host.mount(container, { pluginId: 'trusted-fixture', revision: 'one', ref: 'trusted-fixture/panel', id: 'panel', entry: 'tm-plugin://trusted-fixture/one/ui.mjs' }, { surface: 'page' });
  const original = container.children[0]; original.value = 'UNSAVED UPDATE DRAFT';
  const otherContainer = document.createElement('div');
  await host.mount(otherContainer, { pluginId: 'other-fixture', revision: 'one', ref: 'other-fixture/content', id: 'content', entry: 'tm-plugin://other-fixture/one/ui.mjs' }, { target: TARGET });
  const otherInput = otherContainer.children[0]; otherInput.value = 'UNSAVED OTHER DRAFT';
  const actions = [];
  f.lifecycle(f.main, request => { actions.push(request.action); return lifecycle(request); }, ['trusted-fixture', 'other-fixture']);
  f.send(f.main, 'home');
  const child = f.children[0]; assert.ok(child);
  manifest.version = '2.0.0'; manifest.views.push({ id: 'content', mode: 'replace', targets: [TARGET] });
  fs.writeFileSync(file, JSON.stringify(manifest));
  const preview = await f.invoke('plugins:import', 'directory'), before = structuredClone(f.settings);
  // Decisions follow each dialog's purpose, independent of its presentation order.
  const show = f.dialogs.push.bind(f.dialogs);
  f.dialogs.push = options => {
    const kind = options.type === 'question' ? 'conflict' : options.message.startsWith('The content you are replacing') ? 'displaced-draft' : 'package';
    if (cancelAt === 'expired-preview' && kind === 'package') f.invoke('plugins:cancelInstall', preview.token);
    f.respond(kind === cancelAt ? 0 : 1); return show(options);
  };
  await assert.rejects(f.invoke('plugins:install', preview.token, { trustUpdate: true, initialSetup: { [contentKey(TARGET)]: REF } }), cancelAt === 'expired-preview' ? /preview expired/ : /cancelled/);
  assert.equal(disposals, 0);
  assert.equal(container.children[0], original);
  assert.equal(original.value, 'UNSAVED UPDATE DRAFT');
  assert.equal(otherContainer.children[0], otherInput); assert.equal(otherInput.value, 'UNSAVED OTHER DRAFT');
  assert.equal(child.exited, undefined, 'cancellation must not pause the original backend');
  assert.equal(actions.includes('release'), false);
  assert.deepEqual(f.settings, before);
  assert.equal(f.invoke('plugins:list').plugins.find(plugin => plugin.id === 'trusted-fixture').version, '1.0.0');
  assert.equal(f.runtime.manager.active('trusted-fixture'), true);
  assert.equal(f.runtime.manager.active('other-fixture'), true);
  if (cancelAt === 'conflict') {
    f.dialogs.push = show;
    await f.invoke('plugins:install', preview.token, { trustUpdate: true, initialSetup: { [contentKey(TARGET)]: REF } });
    assert.equal(f.invoke('plugins:list').plugins.find(plugin => plugin.id === 'trusted-fixture').version, '2.0.0');
    assert.equal(f.settings.pluginContentSelections[TARGET], REF);
    assert.equal(disposals, 1, 'only the updated plugin UI is released');
    assert.equal(otherContainer.children[0], otherInput);
  }
});

for (const operation of ['enable', 'install', 'native', 'provider']) test(`cancelling the draft warning preserves the selected content during ${operation}`, async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  if (operation !== 'install') await f.install();
  if (operation === 'provider') {
    f.respond(2);
    await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  }
  const requests = [];
  f.lifecycle(f.main, value => { requests.push(value); return { loaded: true, unsaved: true }; }, ['other-fixture']);
  const before = structuredClone(f.settings);
  f.respond(...(operation === 'enable' || operation === 'install' ? [1, 0] : [0]));
  const preview = operation === 'install' ? await f.invoke('plugins:import', 'directory') : null;
  const change = () => operation === 'enable' ? f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true })
    : operation === 'install' ? f.invoke('plugins:install', preview.token, { trustInstall: true })
      : f.invoke('plugins:selectContent', TARGET, operation === 'native' ? null : REF);
  await assert.rejects(async () => change(), /cancelled/);
  assert.deepEqual(f.settings, before);
  assert.deepEqual(requests.map(item => item.action), ['inspect']);
  assert.deepEqual(requests[0].content, [{ target: TARGET, ref: 'other-fixture/content' }]);
  assert.equal(f.main.webContents.reloads, 0);
  if (operation === 'install') {
    f.respond(1, 1);
    await change();
    assert.equal(f.settings.pluginContentSelections[TARGET], REF);
  }
});

test('source switching checks real renderer drafts only in the departing ref and target', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  const document = { createElement: tag => new Element(tag, document) };
  document.head = document.createElement('head');
  let inspect, disposed = 0;
  const host = createHost({ document, window: {}, bridge: { onLifecycle(fn) { inspect = fn; } },
    importModule: async () => ({ mount(container) {
      const input = document.createElement('input'); container.append(input);
      return { hasUnsavedChanges: () => Boolean(input.value), dispose() { disposed++; } };
    } }) });
  t.after(() => host.dispose());
  f.lifecycle(f.main, request => inspect(request), ['other-fixture']);
  const mount = async (ref, target) => {
    const container = document.createElement('div');
    await host.mount(container, { pluginId: 'other-fixture', revision: 'one', ref, id: ref.split('/')[1], entry: 'tm-plugin://other/one/ui.mjs' }, { target });
    return container.children[0];
  };
  const home = await mount('other-fixture/content', TARGET);
  const model = await mount('other-fixture/content', 'main.model.content');
  const page = await mount('other-fixture/panel');
  home.value = 'home draft'; model.value = 'model draft'; page.value = 'page draft';
  f.cancel();
  await assert.rejects(f.invoke('plugins:selectContent', TARGET, null), /cancelled/);
  assert.equal(home.value, 'home draft'); assert.equal(disposed, 0);
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.match(f.dialogs.at(-1).message, /unsaved work/);
  assert.equal(f.dialogs.at(-1).defaultId, 0);
  home.value = '';
  await f.invoke('plugins:selectContent', TARGET, null);
  assert.equal(f.dialogs.length, 1, 'other targets and independent pages must not warn');
  assert.equal(model.value, 'model draft'); assert.equal(page.value, 'page draft');
  assert.equal(disposed, 0, 'inspection must not release the whole plugin');
  assert.equal(f.runtime.manager.active('other-fixture'), true);
});

test('a failed draft inspection blocks the source change without reloading the renderer', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.lifecycle(f.main, () => { throw Error('author inspection failed'); }, ['other-fixture']);
  await assert.rejects(f.invoke('plugins:selectContent', TARGET, null), /Could not check/);
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.main.webContents.reloads, 0);
  assert.equal(f.dialogs.length, 0);
});

test('keeping the existing provider or selecting it again does not inspect or discard its draft', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  await f.install();
  let inspections = 0;
  f.lifecycle(f.main, () => { inspections++; return { loaded: true, unsaved: true }; }, ['other-fixture']);
  f.respond(2);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  await f.invoke('plugins:selectContent', TARGET, 'other-fixture/content');
  assert.equal(inspections, 0);
  assert.equal(f.settings.pluginContentSelections[TARGET], 'other-fixture/content');
  assert.equal(f.dialogs.length, 1);
});

test('awaiting a draft inspection does not overwrite a concurrent choice for a different target', async t => {
  const { f } = await setup(t, { competitor: true });
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  let respond;
  const started = new Promise(resolve => {
    f.lifecycle(f.main, () => new Promise(finish => { respond = finish; resolve(); }), ['other-fixture']);
  });
  const home = f.invoke('plugins:selectContent', TARGET, null);
  await started;
  f.settings.pluginContentSelections['main.model.content'] = 'another/model';
  respond({ loaded: true, unsaved: false });
  await home;
  assert.equal(f.settings.pluginContentSelections['main.model.content'], 'another/model');
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
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
  await f.invoke('plugins:selectContent', 'main.model.content', null);
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

test('a trusted update can replace a removed target at the 128-selection limit', async t => {
  const { f, file, manifest } = await setup(t);
  const first = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', first.token, { trustInstall: true });
  for (let i = 0; i < 127; i++) f.settings.pluginContentSelections[`main.extra${i}.content`] = 'other/view';
  manifest.version = '2.0.0';
  manifest.views.find(view => view.id === 'content').targets = ['main.session.content'];
  fs.writeFileSync(file, JSON.stringify(manifest));
  const update = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', update.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.equal(f.settings.pluginContentSelections['main.session.content'], REF);
  assert.equal(Object.keys(f.settings.pluginContentSelections).length, 128);
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
  await f.invoke('plugins:selectContent', TARGET, null);
  manifest.version = '3.0.0'; fs.writeFileSync(file, JSON.stringify(manifest));
  preview = await f.invoke('plugins:import', 'directory');
  await f.invoke('plugins:install', preview.token, { trustUpdate: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.equal(f.dialogs.length, 0);
});

test('restoring native content keeps the plugin enabled and survives off/on and a runtime restart', async t => {
  const { f, file } = await setup(t);
  await f.install(); await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  await f.invoke('plugins:selectContent', TARGET, null);
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
  await f.invoke('plugins:selectContent', TARGET, null);
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  assert.equal(f.settings.pluginContentSelections[TARGET], undefined);
  assert.ok(f.settings.pluginInitialSetup['trusted-fixture'].applied.includes(contentKey(TARGET)));
  assert.equal(f.dialogs.length, 0);
});

for (const keepPlacements of [false, true]) test(`reinstall retains the native decision only when keeping placements=${keepPlacements}`, async t => {
  const { f } = await setup(t); await f.install();
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  await f.invoke('plugins:selectContent', TARGET, null);
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
  await f.invoke('plugins:selectContent', TARGET, null);
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
