'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
// Model the declared target host in this isolated worker without changing release metadata.
const app = require('../../package.json');
const checkoutVersion = app.version;
app.version = '0.82.0';
test.after(() => { app.version = checkoutVersion; });
const { packageDirectory, parsePackage } = require('../../src/electron/plugins/package');
const { createPluginCatalog } = require('../../src/electron/plugins/catalog');
const { createPluginManager } = require('../../src/electron/plugins/manager');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const { buildDistribution } = require('../../scripts/official-plugin-distribution.cjs');
const officialSources = require('../../src/electron/plugins/officialSources');
const definition = officialSources[0];
const root = path.resolve(__dirname, '../..');
const source = path.join(root, 'plugins/quota-alerts');
function scratch(t) { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'qa-official-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; }

test('the package rejects a 0.81.0 host and accepts a 0.82.0 host', t => {
  const output = path.join(scratch(t), 'build'); buildDistribution(output);
  const bytes = fs.readFileSync(path.join(output, 'quota-alerts-0.1.0.tmplugin'));
  try {
    app.version = '0.81.0';
    assert.throws(() => parsePackage(bytes), /incompatible Token Monitor version/);
    app.version = '0.82.0';
    const pkg = parsePackage(bytes);
    assert.equal(pkg.rawManifest.engines.tokenMonitor, '>=0.82.0');
  } finally { app.version = '0.82.0'; }
});

test('the actual published catalog installs the source-matching official package only after approval', async t => {
  const dir = scratch(t), output = path.join(dir, 'build'), index = buildDistribution(output);
  const bytes = fs.readFileSync(path.join(output, 'quota-alerts-0.1.0.tmplugin'));
  let settings = { pluginsEnabled: true, pluginStates: {} };
  const userDir = path.join(dir, 'plugins'), dataDir = path.join(dir, 'data');
  const manager = createPluginManager({ userDir, dataDir, getSettings: () => settings, saveStates: pluginStates => { settings = { ...settings, pluginStates }; }, fork: () => assert.fail('install-only must not start a backend') });
  const managed = createManagedPlugins({ root: path.join(dir, 'managed'), userDir, dataDir, manager, getSettings: () => settings, saveSettings: patch => { settings = { ...settings, ...patch }; } });
  const catalog = createPluginCatalog({ root: path.join(dir, 'catalog'), manager, managed, officialSources,
    fetchImpl: async url => {
      assert.ok(url === definition.url || url === index.plugins[0].versions[0].url);
      return new Response(url === definition.url ? JSON.stringify(index) : bytes);
    } });
  t.after(async () => { catalog.dispose(); managed.dispose(); await manager.dispose(); });
  managed.recover(); await manager.reload(); await catalog.discover();
  assert.equal(manager.list().plugins.length, 0, 'discovery does not install');
  const archive = parsePackage(bytes);
  assert.equal(archive.hash, packageDirectory(source).hash);
  assert.equal(archive.manifest.version, '0.1.0');
  assert.equal(archive.rawManifest.defaults.background, true);
  assert.deepEqual(archive.manifest.views.map(view => view.surfaces), [['settings']]);
  const entry = catalog.list().entries.find(entry => entry.id === 'quota-alerts');
  assert.deepEqual(entry.types, ['automation']);
  assert.equal(entry.origin.kind, 'official'); assert.equal(entry.author, 'Javis603');
  assert.equal(entry.identityIcon, 'data:image/png;base64,' + fs.readFileSync(path.join(source, 'assets/icon.png')).toString('base64'));
  const preview = await catalog.preview(definition.id, 'quota-alerts', '0.1.0');
  assert.deepEqual(preview.types, ['automation']);
  await managed.install(preview.token);
  assert.deepEqual(manager.list().plugins.find(p => p.id === 'quota-alerts').types, ['automation']);
  assert.equal(manager.list().plugins.find(p => p.id === 'quota-alerts').status, 'disabled');
  assert.equal(manager.backendCount(), 0);
  assert.equal(managed.describe('quota-alerts').origin.id, definition.id);
});

test('remote official details use localized plugin README instead of repository overview', async t => {
  const output = path.join(scratch(t), 'build'), index = buildDistribution(output), calls = [];
  let locale = 'en', file = 'README.md';
  const catalog = createPluginCatalog({ root: scratch(t), getLocale: () => locale, officialSources, manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    fetchImpl: async url => {
      if (url === definition.url) return new Response(JSON.stringify(index));
      calls.push(String(url));
      assert.ok(String(url).endsWith(`/contents/plugins/quota-alerts/${file}`));
      return new Response(JSON.stringify({ type: 'file', path: `plugins/quota-alerts/${file}`, encoding: 'base64', content: fs.readFileSync(path.join(source, file)).toString('base64'),
        html_url: `https://github.com/Javis603/token-monitor/blob/main/plugins/quota-alerts/${file}`,
        download_url: `https://raw.githubusercontent.com/Javis603/token-monitor/main/plugins/quota-alerts/${file}` }));
    } });
  t.after(() => catalog.dispose());
  await catalog.discover(); assert.equal(calls.length, 0, 'discovery does not fetch README');
  const cases = [['en', 'README.md', 'Quota alerts'], ['zh-CN', 'README.zh-CN.md', '配额提醒'], ['zh-TW', 'README.zh-TW.md', '配額提醒'],
    ['ko', 'README.ko.md', '할당량 알림'], ['ja', 'README.ja.md', 'クォータ通知'], ['pt-BR', 'README.pt-BR.md', 'Alertas de cota'], ['fr', 'README.md', 'Quota alerts']];
  for (const [language, filename, title] of cases) {
    locale = language; file = filename;
    const details = await catalog.details(definition.id, 'quota-alerts');
    assert.ok(details.html.includes(title), `${language} README title`);
    assert.equal(details.imageCount, 0, `${language} README omits the catalog icon`);
  }
  assert.equal(calls.length, cases.length);
});

test('the App ships no production package and listing does not fetch or execute remote code', t => {
  const catalog = createPluginCatalog({ root: scratch(t), officialSources, manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    fetchImpl: () => assert.fail('listing must not fetch') });
  t.after(() => catalog.dispose());
  assert.deepEqual(catalog.list().entries, []);
  assert.equal(catalog.list().error, '');
  assert.equal(catalog.list().sources.filter(s => s.kind === 'official' && s.url).length, 1);
});
