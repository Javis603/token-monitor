'use strict';
// Real main-process dependency wiring + native decode, with offline fixture data.
const electron = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const assert = require('node:assert/strict');
const { createPluginCatalog } = require('../src/electron/plugins/catalog');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-catalog-image-wiring-'));
electron.app.setPath('userData', path.join(scratch, 'profile'));
electron.app.whenReady().then(async () => {
  electron.app.dock?.hide();
  const main = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const startup = main.slice(main.indexOf('function startPluginRuntime()'));
  const wiring = startup.match(/electron:\s*(\{[^\n]+\}),\s*\n\s*userDataDir:/);
  assert.ok(wiring, 'locate the actual runtime dependency object in App startup');
  const injected = vm.runInNewContext(`(${wiring[1]})`, { ...electron, require });
  const png = electron.nativeImage.createFromBitmap(Buffer.alloc(40 * 20 * 4, 255), { width: 40, height: 20 }).toPNG();
  const calls = [];
  const catalog = createPluginCatalog({ root: path.join(scratch, 'catalog'), nativeImage: injected.nativeImage,
    manager: { list: () => ({ plugins: [] }) }, managed: { describe() {}, cancelSource() {} },
    maintainerSources: [{ id: 'maintainer-fixture', url: 'https://catalog.example/index.json' }],
    fetchImpl: async url => {
      calls.push(url);
      if (url.endsWith('.png')) return new Response(png);
      if (new URL(url).origin === 'https://api.github.com') return new Response(JSON.stringify({ encoding: 'base64',
        content: Buffer.from('# Preview\n\n![Page](page.png)\n\n![Notch](notch.png)\n\n![Dock](dock.png)').toString('base64'),
        download_url: 'https://raw.githubusercontent.com/author/project/main/README.md', html_url: 'https://github.com/author/project/blob/main/README.md' }));
      return new Response(JSON.stringify({ format: 1, title: 'Fixture', plugins: [{ id: 'image-fixture', name: 'Preview', repository: 'https://github.com/author/project',
        versions: [{ version: '0.1.0', url: 'https://catalog.example/plugin.tmplugin', sha256: 'a'.repeat(64) }] }] }));
    } });
  try {
    await catalog.discover(); const details = await catalog.details('maintainer-fixture', 'image-fixture');
    assert.equal(details.imageCount, 3);
    for (let index = 0; index < details.imageCount; index++) {
      const data = await catalog.readmeImage(details.documentId, index);
      const image = electron.nativeImage.createFromDataURL(data);
      assert.equal(image.isEmpty(), false); assert.deepEqual(image.getSize(), { width: 40, height: 20 });
    }
    assert.equal(calls.filter(url => url.endsWith('.png')).length, 3);
    catalog.closeDetails(); await assert.rejects(catalog.readmeImage(details.documentId, 0), /Unknown README image/);
    console.log('PASS: actual App dependency wiring loads and decodes all three README images; closed documents reject image requests.');
  } finally { catalog.dispose(); }
  electron.app.quit();
}).catch(error => { console.error(error); electron.app.exit(1); });
