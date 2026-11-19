'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { Element } = require('../helpers/notchPanel');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const { createHost } = require('../../src/electron/renderer/pluginUi');
const { createPluginViewHost } = require('../../src/electron/renderer/pluginViews');
const tick = () => new Promise(setImmediate);
async function fixture(t, operation) {
  const source = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-transaction-source-'));
  t.after(() => fs.rmSync(source, { recursive: true, force: true }));
  fs.cpSync(path.resolve('tests/fixtures/trusted-plugin'), source, { recursive: true });
  const version = value => {
    const file = path.join(source, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
    manifest.version = value; fs.writeFileSync(file, JSON.stringify(manifest));
  };
  const f = await runtimeFixture(t, { sourceDirectory: source, beforeStart(dir) {
    const target = path.join(dir, 'plugins/other-fixture'); fs.cpSync(source, target, { recursive: true });
    const file = path.join(target, 'manifest.json'), manifest = JSON.parse(fs.readFileSync(file));
    manifest.id = 'other-fixture'; fs.writeFileSync(file, JSON.stringify(manifest));
  } });
  if (operation !== 'install') await f.install();
  if (operation === 'rollback') { version('2.0.0'); await f.install(); }
  await f.invoke('plugins:setEnabled', { id: 'other-fixture', enabled: true });
  f.settings.homeModuleOrder = 'plugin:other-fixture/panel'; f.dialogs.length = 0;
  let checks = 0, mounts = 0;
  f.lifecycle(f.main, ({ content }) => {
    // This draft belongs to a page, not to B's replacement outlets.
    if (content) return { loaded: true, unsaved: false };
    checks++; return { loaded: true, unsaved: true };
  }, ['other-fixture']);
  const document = { visibilityState: 'visible', addEventListener() {}, removeEventListener() {} };
  document.createElement = tag => {
    const node = new Element(tag, document); node.isConnected = true; node.getClientRects = () => [{}]; node.style.removeProperty = () => {}; return node;
  };
  document.head = document.createElement('head'); const node = document.createElement('div');
  const window = { tokenMonitorTrustedPlugins: {}, requestAnimationFrame: () => 1, cancelAnimationFrame() {}, TokenMonitorPluginUi: {
    createHost: options => createHost({ ...options, importModule: async () => ({ mount(container) {
      mounts++; const input = document.createElement('input'); input.value = ''; container.append(input);
      return { dispose() { input.remove(); }, hasUnsavedChanges: () => Boolean(input.value) };
    } }) })
  } };
  const host = createPluginViewHost({ document, window }); t.after(() => host.dispose());
  const send = f.main.webContents.send;
  f.main.webContents.send = (channel, payload) => { send(channel, payload); if (channel === 'plugins:views') host.update(payload); };
  f.send(f.main, 'home', ['other-fixture/panel']); host.mount(node, 'other-fixture/panel', 'home'); await tick(); await tick();
  const original = node.children[0], child = f.children[0]; original.value = 'UNSAVED B DRAFT';
  child.emit('message', { type: 'data', value: { counter: 17 } });
  if (operation === 'update') version('2.0.0');
  async function verify() {
    await tick(); await tick();
    assert.equal(mounts, 1); assert.equal(node.children[0], original); assert.equal(original.value, 'UNSAVED B DRAFT');
    assert.equal(checks, 0); assert.equal(f.dialogs.length, 0);
    assert.equal(f.runtime.manager.active('other-fixture'), true);
    assert.equal(f.children.length, 1); assert.ok(!child.exited);
    assert.deepEqual(f.runtime.payload('home').views['other-fixture/panel'].data, { counter: 17 });
  }
  return { f, source, verify };
}
for (const operation of ['install', 'update', 'uninstall', 'rollback']) {
  test(`${operation} A preserves B draft, instance, backend and data through runtime IPC`, async t => {
    const { f, verify } = await fixture(t, operation);
    if (operation === 'uninstall') await f.invoke('plugins:uninstall', 'trusted-fixture', { keepData: true, keepPlacements: true });
    else if (operation === 'rollback') await f.invoke('plugins:rollback', 'trusted-fixture');
    else await f.install();
    await verify();
  });
  for (const phase of ['prepared', 'old-moved', 'new-moved', 'registry-written', 'settings-written', 'reloaded']) {
    test(`${operation} A rollback after ${phase} leaves B running and mounted`, async t => {
      const { f, source, verify } = await fixture(t, operation);
      const before = f.runtime.manager.list().plugins.find(p => p.id === 'trusted-fixture')?.revision;
      const managed = createManagedPlugins({ root: path.join(f.dir, 'plugin-manager'), userDir: path.join(f.dir, 'plugins'),
        dataDir: path.join(f.dir, 'plugin-data'), settingsDir: path.join(f.dir, 'plugin-settings'), manager: f.runtime.manager,
        getSettings: () => f.settings, saveSettings: patch => Object.assign(f.settings, patch),
        fault: point => { if (point === phase) throw Error('injected transaction failure'); } });
      managed.recover(); t.after(() => managed.dispose());
      await assert.rejects(async () => {
        if (operation === 'uninstall') return managed.uninstall('trusted-fixture');
        if (operation === 'rollback') return managed.rollback('trusted-fixture');
        return managed.install(managed.previewDirectory(source).token);
      }, /injected transaction failure/);
      await verify();
      assert.equal(f.runtime.manager.list().plugins.find(p => p.id === 'trusted-fixture')?.revision, before);
      assert.equal(fs.existsSync(path.join(f.dir, 'plugin-manager/transaction.json')), false);
    });
  }
}

test('failed recovery blocks only A and preserves B while the journal is pending', async t => {
  const { f, source, verify } = await fixture(t, 'update');
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  const managed = createManagedPlugins({ root: path.join(f.dir, 'plugin-manager'), userDir: path.join(f.dir, 'plugins'),
    dataDir: path.join(f.dir, 'plugin-data'), manager: f.runtime.manager, getSettings: () => f.settings,
    saveSettings: () => { throw Error('injected persistence failure'); } });
  managed.recover(); t.after(() => managed.dispose());
  // The trust dialog belongs to A's explicit setup, not its failing transaction.
  f.dialogs.length = 0;
  await assert.rejects(managed.install(managed.previewDirectory(source).token), /recovery pending/);
  await verify();
  assert.equal(f.runtime.manager.active('trusted-fixture'), false);
  assert.equal(f.runtime.payload('home').views['trusted-fixture/panel'], undefined);
  assert.equal(fs.existsSync(path.join(f.dir, 'plugin-manager/transaction.json')), true);
  assert.equal(managed.status().available, false);
  assert.throws(() => managed.assertAvailable(), /Plugin management unavailable/);
});
