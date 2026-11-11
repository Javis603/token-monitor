'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createPluginUpdates } = require('../../src/electron/plugins/updates');
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-auto-updates-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const entries = ['official', 'maintainer', 'community'].map(kind => ({ id: kind, version: '1.1.0', status: 'update', origin: { id: kind, kind } }));
  const plugins = entries.map(entry => ({ id: entry.id, trusted: true, enabled: true }));
  const installed = Object.fromEntries(entries.map(entry => [entry.id, { origin: entry.origin }]));
  let enabled = true, fields = [], fail = false;
  const applied = [], cancelled = [], previews = [];
  const options = { root, manager: { list: () => ({ plugins }) }, managed: { describe: id => installed[id], cancel: token => cancelled.push(token) },
    catalog: { list: () => ({ entries }), preview: async (_source, id) => { previews.push(id); return { token: id, id, operation: 'update', initialSetup: { fields } }; } },
    enabled: () => enabled, apply: async (preview, check) => { check(); if (fail) throw Error('unsaved UI'); applied.push(preview.id); } };
  return { options, entries, plugins, applied, cancelled, previews, installed, root,
    setEnabled: value => { enabled = value; }, setFields: value => { fields = value; }, setFail: value => { fail = value; } };
}
test('automatic updates default to host official/community sources and retain per-plugin opt-outs across restart', async t => {
  const f = fixture(t), updates = createPluginUpdates(f.options);
  updates.configure('maintainer', false);
  await updates.run();
  assert.deepEqual(f.applied, ['official']);
  assert.deepEqual(f.cancelled, ['official']);
  const restart = createPluginUpdates(f.options);
  assert.equal(restart.list().plugins.maintainer, false);
  restart.configure(null, false); await restart.run(); assert.equal(f.applied.length, 1);
  assert.equal(createPluginUpdates(f.options).list().enabled, false);
});
test('safe/master-off, untrusted revisions, different origins and prereleases never auto-install', async t => {
  const f = fixture(t), updates = createPluginUpdates(f.options);
  f.setEnabled(false); await updates.run(); assert.equal(f.previews.length, 0);
  f.setEnabled(true); f.plugins[0].trusted = false; f.entries[1].version = '2.0.0-beta.1';
  await updates.run(); assert.equal(f.previews.length, 0);
  f.plugins[0].trusted = true; f.installed.official.origin = { id: 'another-source' };
  await updates.run(); assert.equal(f.previews.length, 0);
});
test('new choices and lifecycle failures defer updates and discard preview tokens', async t => {
  const f = fixture(t), updates = createPluginUpdates(f.options);
  f.setFields([{ key: 'background' }]); await updates.run(); assert.deepEqual(f.applied, []);
  assert.deepEqual(f.cancelled, ['official', 'maintainer']);
  f.setFields([]); f.setFail(true); await updates.run(); assert.deepEqual(f.applied, []);
  f.setFail(false); await updates.run(); assert.deepEqual(f.applied, ['official', 'maintainer']);
});
test('opt-out while a download is pending is rechecked before application', async t => {
  const f = fixture(t); let downloaded;
  f.options.catalog.preview = async (_source, id) => { await new Promise(resolve => { downloaded = resolve; }); return { token: id, id, operation: 'update', initialSetup: { fields: [] } }; };
  const updates = createPluginUpdates(f.options); const run = updates.run();
  updates.configure(null, false); downloaded(); await run;
  assert.deepEqual(f.applied, []);
});
test('corrupt preferences fail closed without overwriting the file', async t => {
  const f = fixture(t); fs.writeFileSync(path.join(f.root, 'updates.json'), '{broken');
  const updates = createPluginUpdates(f.options); await updates.run(); assert.deepEqual(f.previews, []);
  assert.ok(updates.list().error); assert.throws(() => updates.configure(null, true));
  assert.equal(fs.readFileSync(path.join(f.root, 'updates.json'), 'utf8'), '{broken');
});

const { runtimeFixture } = require('../helpers/trustedPlugin');
const { packageDirectory, contentDigest, describePackage, digest } = require('../../src/electron/plugins/package');
const { initialSetupReview } = require('../../src/electron/plugins/initialSetup');
const source = require('../../src/electron/plugins/maintainerSources')[0];
for (const scenario of ['enabled', 'disabled', 'unsaved', 'editing-settings', 'late-draft', 'late-settings', 'opt-out-during-release', 'opt-out-during-stop', 'cleanup-failure', 'resume-failure', 'safe-mode']) test(`runtime automatic update: ${scenario}`, async t => {
  const directory = path.resolve(__dirname, '../fixtures/trusted-plugin');
  const old = packageDirectory(directory), next = JSON.parse(old.bytes);
  next.manifest.version = '1.1.0'; const bytes = Buffer.from(JSON.stringify(next));
  const fields = initialSetupReview({}, describePackage(old)).fields;
  let release; const download = new Promise(resolve => { release = resolve; });
  const f = await runtimeFixture(t, {
    safeMode: scenario === 'safe-mode',
    initialSettings: { pluginStates: { 'trusted-fixture': { enabled: scenario !== 'disabled', background: false, trustedRevision: contentDigest(old) } },
      pluginInitialSetup: { 'trusted-fixture': { values: Object.fromEntries(fields.map(field => [field.key, field.value])), applied: fields.map(field => field.key) } } },
    beforeStart(root) {
      fs.cpSync(directory, path.join(root, 'plugins/trusted-fixture'), { recursive: true });
      fs.mkdirSync(path.join(root, 'plugin-manager'), { recursive: true });
      fs.writeFileSync(path.join(root, 'plugin-manager/installed.json'), JSON.stringify({ 'trusted-fixture': { version: '1.0.0', sha256: old.hash, contentSha256: contentDigest(old), installedAt: 1, origin: { id: source.id, kind: 'maintainer' } } }));
    },
    catalogFetch: async url => {
      await download;
      return new Response(url === source.url ? JSON.stringify({ format: 1, title: 'Community fixture', plugins: [{ id: 'trusted-fixture', name: 'Fixture', versions: [{ version: '1.1.0', url: 'https://catalog.example/fixture.tmplugin', sha256: digest(bytes) }] }] }) : bytes);
    }
  });
  const lifecycle = [];
  if (scenario === 'unsaved') f.lifecycle(f.main, request => { lifecycle.push(request.action); return request.action === 'inspect-update' ? {} : { loaded: true, unsaved: true }; });
  if (scenario === 'editing-settings') f.lifecycle(f.main, request => ({ blocked: request.action === 'inspect-update' }));
  if (scenario === 'late-settings') {
    let editing = false;
    f.lifecycle(f.main, request => {
      lifecycle.push(request.action);
      if (request.action === 'inspect') { editing = true; return { loaded: false }; }
      if (request.action === 'release') { assert.equal(request.automatic, true); return { deferred: editing }; }
      return {};
    });
  }
  if (scenario === 'late-draft') {
    let dirty = false;
    const respond = (host, request) => {
      lifecycle.push(`${host}:${request.action}`);
      if (request.action === 'inspect') { if (host === 'notch') dirty = true; return { loaded: true, unsaved: false }; }
      if (request.action === 'release') { assert.equal(request.automatic, true); return host === 'notch' && dirty ? { deferred: true } : {}; }
      return {};
    };
    f.lifecycle(f.main, request => respond('main', request));
    f.lifecycle(f.notch, request => respond('notch', request));
  }
  if (scenario === 'opt-out-during-stop') {
    const begin = f.runtime.manager.beginMutation;
    f.runtime.manager.beginMutation = async id => { await begin(id); f.invoke('plugins:configureUpdates', null, false); };
  }
  if (['opt-out-during-release', 'cleanup-failure', 'resume-failure'].includes(scenario)) f.lifecycle(f.main, request => {
    if (request.action === 'inspect') return { loaded: true, unsaved: false };
    if (request.action === 'release' && scenario === 'opt-out-during-release') f.invoke('plugins:configureUpdates', null, false);
    if (request.action === 'release' && scenario === 'cleanup-failure' || request.action === 'resume' && scenario === 'resume-failure') throw Error('fixture lifecycle failure');
    return {};
  });
  release();
  // The fake transport and lifecycle replies complete entirely in microtasks.
  await new Promise(setImmediate); await new Promise(setImmediate);
  const plugin = f.invoke('plugins:list').plugins.find(item => item.id === 'trusted-fixture');
  assert.equal(plugin.version, ['unsaved', 'editing-settings', 'late-draft', 'late-settings', 'opt-out-during-release', 'opt-out-during-stop', 'cleanup-failure', 'safe-mode'].includes(scenario) ? '1.0.0' : '1.1.0');
  assert.equal(plugin.enabled, scenario !== 'disabled');
  assert.equal(f.dialogs.length, 0, 'automatic updates never prompt in the background');
  if (scenario === 'unsaved') assert.deepEqual(lifecycle, ['inspect-update', 'inspect']);
  if (scenario === 'cleanup-failure' || scenario === 'resume-failure') {
    assert.equal(plugin.recoveryRequired, true);
    assert.equal(f.main.webContents.reloads, 0, 'automatic failure must not reload unrelated drafts');
    const before = structuredClone(f.settings.pluginStates);
    await f.invoke('plugins:recover', 'trusted-fixture');
    await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal(f.main.webContents.reloads, 1);
    assert.deepEqual(f.settings.pluginStates, before, 'recovery does not change enablement or trust');
    assert.equal(f.invoke('plugins:list').plugins[0].recoveryRequired, false);
    assert.equal(f.dialogs.length, 1);
  }
  if (scenario === 'late-settings') assert.deepEqual(lifecycle, ['inspect-update', 'inspect', 'release', 'resume']);
  if (scenario === 'late-draft') {
    assert.deepEqual(lifecycle.filter(action => action.startsWith('main:')), ['main:inspect-update', 'main:inspect', 'main:release', 'main:resume']);
    assert.deepEqual(lifecycle.filter(action => action.startsWith('notch:')), ['notch:inspect-update', 'notch:inspect', 'notch:release', 'notch:resume']);
  }
  if (scenario === 'enabled' || scenario === 'disabled') {
    assert.equal(plugin.installation.previousVersion, '1.0.0');
    assert.equal(plugin.trusted, true);
    await f.invoke('plugins:rollback', 'trusted-fixture');
    assert.equal(f.invoke('plugins:list').plugins[0].version, '1.0.0');
  }
});
