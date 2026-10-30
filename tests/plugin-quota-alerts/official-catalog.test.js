'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { packageDirectory, parsePackage } = require('../../src/electron/plugins/package');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'plugins/quota-alerts');
function scratch(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-official-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('official archive matches source and installs offline without executing or enabling', async t => {
  const dir = scratch(t); let settings = { pluginsEnabled: true, pluginStates: {} };
  const userDir = path.join(dir, 'plugins'), dataDir = path.join(dir, 'data');
  const manager = createPluginManager({ userDir, dataDir, getSettings: () => settings, saveStates: pluginStates => { settings = { ...settings, pluginStates }; }, fork: () => assert.fail('install-only must not start a backend') });
  const managed = createManagedPlugins({ root: path.join(dir, 'managed'), userDir, dataDir, manager, getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } });
  const catalog = createPluginCatalog({ root: path.join(dir, 'catalog'), manager, managed, fetchImpl: () => assert.fail('official package installation must be offline') });
  t.after(async () => { catalog.dispose(); managed.dispose(); await manager.dispose(); });
  managed.recover(); await manager.reload();
  const archive = parsePackage(fs.readFileSync(path.join(root, 'src/electron/plugins/catalog/quota-alerts.tmplugin')));
  assert.equal(archive.hash, packageDirectory(source).hash, 'rebuild official archive after source changes');
  assert.equal(archive.manifest.version, '0.1.0');
  assert.equal(archive.rawManifest.defaults.background, true);
  assert.deepEqual(archive.manifest.views.map(view => view.surfaces), [['settings']]);
  const entry = catalog.list().entries.find(entry => entry.id === 'quota-alerts');
  assert.deepEqual(entry.types, ['automation']);
  assert.equal(entry.origin.kind, 'official'); assert.equal(entry.author, 'Javis603');
  assert.equal(entry.identityIcon, 'data:image/png;base64,' + fs.readFileSync(path.join(source, 'assets/icon.png')).toString('base64'));
  const preview = await catalog.preview('bundled', 'quota-alerts', '0.1.0');
  assert.deepEqual(preview.types, ['automation']);
  await managed.install(preview.token);
  assert.deepEqual(manager.list().plugins.find(p => p.id === 'quota-alerts').types, ['automation']);
  assert.equal(manager.list().plugins.find(p => p.id === 'quota-alerts').status, 'disabled');
  assert.equal(manager.backendCount(), 0);
  assert.equal(managed.describe('quota-alerts').origin.id, 'bundled');
});

test('official details use localized plugin README instead of repository overview', async t => {
  const calls = []; let locale = 'en', file = 'README.md';
  const catalog = createPluginCatalog({ root: scratch(t), getLocale: () => locale, manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    fetchImpl: async url => {
      calls.push(String(url));
      assert.ok(String(url).endsWith(`/contents/plugins/quota-alerts/${file}`));
      return new Response(JSON.stringify({ type: 'file', path: `plugins/quota-alerts/${file}`, encoding: 'base64', content: fs.readFileSync(path.join(source, file)).toString('base64'),
        html_url: `https://github.com/Javis603/token-monitor/blob/main/plugins/quota-alerts/${file}`,
        download_url: `https://raw.githubusercontent.com/Javis603/token-monitor/main/plugins/quota-alerts/${file}` }));
    } });
  t.after(() => catalog.dispose());
  assert.equal(calls.length, 0);
  const cases = [
    ['en', 'README.md', 'Quota alerts'],
    ['zh-CN', 'README.zh-CN.md', '配额提醒'],
    ['zh-TW', 'README.zh-TW.md', '配額提醒'],
    ['ko', 'README.ko.md', '할당량 알림'],
    ['ja', 'README.ja.md', 'クォータ通知'],
    ['pt-BR', 'README.pt-BR.md', 'Alertas de cota'],
    ['fr', 'README.md', 'Quota alerts']
  ];
  for (const [language, filename, title] of cases) {
    locale = language; file = filename;
    const details = await catalog.details('bundled', 'quota-alerts');
    assert.ok(details.html.includes(title), `${language} README title`);
    assert.equal(details.imageCount, 0, `${language} README omits the catalog icon`);
  }
  assert.equal(calls.length, cases.length);
});

test('renaming a bundled archive preserves its installed identity and official source', async t => {
  const directory = scratch(t);
  const bytes = fs.readFileSync(path.join(root, 'src/electron/plugins/catalog/quota-alerts.tmplugin'));
  const manager = { list: () => ({ plugins: [{ id: 'quota-alerts', version: '0.1.0' }] }) };
  const managed = { describe: () => ({ version: '0.1.0', origin: { id: 'bundled' } }), cancelSource() {} };
  fs.writeFileSync(path.join(directory, 'renamed-file.tmplugin'), bytes);
  const catalog = createPluginCatalog({ catalogDirectory: directory, root: path.join(directory, 'cache'), manager, managed,
    fetchImpl: () => assert.fail('filename changes need no remote source') });
  t.after(() => catalog.dispose());
  const entries = catalog.list().entries;
  assert.equal(entries.length, 1);
  assert.equal(entries[0].id, 'quota-alerts');
  assert.equal(entries[0].origin.id, 'bundled');
  assert.equal(entries[0].status, 'installed');
  assert.equal(catalog.list().error, '');
});
