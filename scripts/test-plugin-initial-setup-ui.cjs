'use strict';
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { pathToFileURL } = require('node:url');
const { normalizeManifest } = require('../src/shared/plugins/manifest');
const { describePackage } = require('../src/electron/plugins/package');
const { initialSetupReview } = require('../src/electron/plugins/initialSetup');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-initial-ui-'));
app.setPath('userData', path.join(scratch, 'data'));
const evidence = process.env.TM_PLUGIN_CONTENT_EVIDENCE_DIR || scratch;
fs.mkdirSync(evidence, { recursive: true });

async function main() {
  const manifest = normalizeManifest({ tmApi: 1, id: 'setup-demo', name: 'Custom Dashboard', version: '1.0.0', ui: 'ui.mjs', backend: 'backend.cjs', files: ['ui.mjs', 'backend.cjs'], background: true,
    views: [{ id: 'page', title: 'Dashboard', surfaces: ['page'], defaultSurfaces: ['page'] }, { id: 'content', title: 'Dashboard', mode: 'replace', targets: ['main.home.content'] }],
    skins: [{ id: 'blue', name: 'Blue', colors: { accent: '#abcdef' } }], defaults: { background: true, skin: 'blue' } }).manifest;
  const dto = describePackage({ manifest, hash: 'fixture' });
  const preview = { ...dto, token: 'initial-token', operation: 'install', origin: { kind: 'official' }, initialSetup: initialSetupReview({}, dto) };
  const locationManifest = normalizeManifest({ tmApi: 1, id: 'locations-demo', name: 'Locations demo', version: '1.0.0', ui: 'ui.mjs', files: ['ui.mjs'],
    views: [{ id: 'dashboard', title: 'Dashboard', surfaces: ['page', 'edgeDock', 'notch'], defaultSurfaces: ['page', 'edgeDock', 'notch'] }] }).manifest;
  const locationDto = describePackage({ manifest: locationManifest, hash: 'locations' });
  locationDto.initialSetup = initialSetupReview({}, locationDto);
  const css = ['styles.css', 'pluginViews.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}">`).join('');
  const scripts = ['i18n.js', 'pluginUi.js', 'pluginViews.js', 'selectControl.js', 'pluginSettings.js'].map(file => `<script src="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}"></script>`).join('');
  const html = path.join(scratch, 'index.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8">${css}<style>body{padding:16px;overflow:auto}#settings{display:block}</style></head><body><div id="settings" class="settings-panel"></div>${scripts}</body></html>`);
  const win = new BrowserWindow({ show: false, width: 390, height: 880, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(html);
  const initial = await win.webContents.executeJavaScript(`(async () => {
    const preview = ${JSON.stringify(preview)}, box = document.getElementById('settings'), data = { enabled: true, plugins: [] }, calls = [];
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box,
      getLocale: () => window.initialLocale || 'zh-TW',
      t: (key, params) => TokenMonitorI18n.translate(window.initialLocale || 'zh-TW', key, params), api: {
        list: async () => structuredClone(data), catalog: async () => ({ entries: [], sources: [] }),
        importPackage: async () => structuredClone(preview), cancelInstall: async () => {},
        install: async (token, options) => { calls.push({ token, options }); return structuredClone(data); },
        setEnabled: async (id, enabled, initialSetup) => { calls.push({ id, enabled, initialSetup }); data.plugins[0].enabled = enabled; data.plugins[0].trusted = true; data.plugins[0].status = 'active'; data.plugins[0].initialSetup = { fields: [], values: {} }; return structuredClone(data); }
      } });
    await panel.refresh();
    [...box.querySelectorAll('button')].find(node => node.textContent === TokenMonitorI18n.translate('zh-TW', 'plugins.package.import')).click();
    await new Promise(resolve => setTimeout(resolve, 30));
    window.initialFixture = { box, panel, preview, data, calls };
    const inputs = [...box.querySelectorAll('.plugin-initial-setup input,.plugin-initial-setup select')];
    const rows = [...box.querySelectorAll('.plugin-initial-setup label')].map(node => node.getBoundingClientRect());
    return { fields: inputs.map(node => node.dataset.controlKey), values: inputs.map(node => node.checked),
      names: [...box.querySelectorAll('.plugin-initial-setup label')].map(node => node.querySelector('.plugin-choice-name').textContent),
      purposes: [...box.querySelectorAll('.plugin-initial-setup label')].map(node => node.querySelector('.plugin-purpose-tag')?.textContent || null),
      tagRights: [...box.querySelectorAll('.plugin-initial-setup .plugin-purpose-tag')].map(node => node.getBoundingClientRect().right),
      gaps: rows.slice(1).map((rect, index) => rect.top - rows[index].bottom), heights: rows.map(rect => rect.height), lefts: inputs.map(node => node.getBoundingClientRect().left),
      dropdowns: box.querySelectorAll('.plugin-initial-setup select').length, fits: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  assert.deepEqual(initial.values, [true, true, true, true]); assert.equal(initial.fits, true); assert.equal(initial.dropdowns, 0);
  assert.deepEqual(initial.names, ['Dashboard', 'Custom Dashboard', '背景執行', 'Blue']);
  assert.deepEqual(initial.purposes, ['獨立分頁', '替換主頁', null, '外觀']);
  assert.ok(initial.tagRights.every(right => Math.abs(right - initial.tagRights[0]) < 0.5), 'Purpose tags must align on the right');
  assert.ok(initial.gaps.length === 3 && initial.gaps.every(gap => Math.abs(gap - 8) < 0.5), `Uneven initial-choice gaps: ${initial.gaps}`);
  assert.ok(initial.heights.every(height => height < 24), `Initial choices should keep the original compact row height: ${initial.heights}`);
  assert.ok(initial.lefts.every(left => Math.abs(left - initial.lefts[0]) < 0.5), 'Initial checkboxes must align');
  fs.writeFileSync(path.join(evidence, 'initial-install-defaults.png'), (await win.webContents.capturePage()).toPNG());
  const reviewBounds = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.plugin-package-preview').getBoundingClientRect();
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  })()`);
  fs.writeFileSync(path.join(evidence, 'initial-actions.png'), (await win.webContents.capturePage(reviewBounds)).toPNG());
  const pending = await win.webContents.executeJavaScript(`(async () => {
    const { box, calls } = initialFixture;
    for (const node of box.querySelectorAll('.plugin-initial-setup input,.plugin-initial-setup select')) {
      if (node.type === 'checkbox') node.checked = false; else node.value = '';
      node.dispatchEvent(new Event('change', { bubbles: true }));
    }
    [...box.querySelectorAll('button')].find(node => node.textContent === TokenMonitorI18n.translate('zh-TW', 'plugins.package.installOnly')).click();
    await new Promise(resolve => setTimeout(resolve, 30)); return calls[0];
  })()`);
  assert.deepEqual(pending, { token: 'initial-token', options: { trustUpdate: false, trustInstall: false, initialSetup: { 'placement:setup-demo/page:page': false, 'content:main.home.content': null, background: false, skin: null } } });
  const enabled = await win.webContents.executeJavaScript(`(async () => {
    const { box, panel, preview, data, calls } = initialFixture;
    data.plugins = [{ ...preview, source: 'user', status: 'disabled', enabled: false, trusted: false, installation: { origin: { kind: 'official' } }, views: preview.views.map(view => ({ ...view, placements: {} })) }];
    await panel.refresh(); const toggle = box.querySelector('.plugin-enable'); toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { fields: [...box.querySelectorAll('.plugin-initial-setup input,.plugin-initial-setup select')].map(node => node.dataset.controlKey), fits: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  assert.deepEqual(enabled.fields, initial.fields); assert.equal(enabled.fits, true);
  fs.writeFileSync(path.join(evidence, 'initial-enable.png'), (await win.webContents.capturePage()).toPNG());
  const confirmed = await win.webContents.executeJavaScript(`(async () => {
    const { box, calls } = initialFixture;
    const background = box.querySelector('[data-control-key="initial/background"]'); background.checked = false; background.dispatchEvent(new Event('change', { bubbles: true }));
    box.querySelector('.plugin-allow').click(); await new Promise(resolve => setTimeout(resolve, 30)); return calls.at(-1);
  })()`);
  assert.equal(confirmed.initialSetup.background, false); assert.equal(confirmed.enabled, true);
  const trustedReview = await win.webContents.executeJavaScript(`(async () => {
    const { box, panel, preview, data } = initialFixture;
    Object.assign(data.plugins[0], { enabled: false, status: 'disabled', trusted: true, installation: { origin: { kind: 'community' } }, initialSetup: structuredClone(preview.initialSetup) });
    await panel.refresh(); const toggle = box.querySelector('.plugin-enable'); toggle.checked = true; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    const consent = box.querySelector('.plugin-consent');
    return { title: consent.querySelector('.plugin-consent-title').textContent, warning: Boolean(consent.querySelector('.plugin-risk')),
      expected: TokenMonitorI18n.translate('zh-TW', 'settings.plugins.enable', { name: preview.name }) };
  })()`);
  assert.equal(trustedReview.title, trustedReview.expected); assert.equal(trustedReview.warning, false);
  const existingSource = await win.webContents.executeJavaScript(`(async () => {
    const { box, panel, preview, data, calls } = initialFixture;
    const review = structuredClone(preview.initialSetup);
    review.fields.find(field => field.kind === 'content').options.push({ value: 'other/home', label: 'Other dashboard', current: true });
    Object.assign(data.plugins[0], { enabled: false, status: 'disabled', initialSetup: review });
    await panel.refresh(); box.querySelector('.plugin-enable').click(); await new Promise(resolve => setTimeout(resolve, 30));
    const group = box.querySelector('[data-choice-key="initial/content:main.home.content"]');
    const labels = [...group.querySelectorAll(':scope > label')].map(node => node.querySelector('.plugin-choice-name').textContent);
    [...group.querySelectorAll('input')].find(node => node.value === 'other/home').click();
    box.querySelector('.plugin-allow').click(); await new Promise(resolve => setTimeout(resolve, 30));
    return { labels, selected: calls.at(-1).initialSetup['content:main.home.content'] };
  })()`);
  assert.deepEqual(existingSource, { labels: ['內建內容', '保留已選內容', 'Custom Dashboard'], selected: 'other/home' });
  win.setContentSize(320, 880);
  const longNames = await win.webContents.executeJavaScript(`(async () => {
    const { box, panel, preview, data } = initialFixture, results = [];
    for (const locale of ['zh-TW', 'en', 'pt-BR']) {
      window.initialLocale = locale;
      const review = structuredClone(preview.initialSetup);
      review.fields.find(field => field.kind === 'placement').title = 'Dashboard with detailed usage and activity';
      review.fields.find(field => field.kind === 'skin').options[0].label = 'Blue with custom interface appearance';
      Object.assign(data.plugins[0], { name: 'Custom Dashboard for all usage and activity', enabled: false, status: 'disabled', initialSetup: review });
      await panel.refresh(); box.querySelector('.plugin-enable').click(); await new Promise(resolve => setTimeout(resolve, 30));
      const rows = [...box.querySelectorAll('.plugin-initial-setup .plugin-tagged-choice')];
      const rects = rows.map(row => ({ name: row.querySelector('.plugin-choice-name').getBoundingClientRect(), tag: row.querySelector('.plugin-purpose-tag').getBoundingClientRect() }));
      const panelBounds = box.querySelector('.plugin-consent').getBoundingClientRect();
      results.push({ locale, fits: document.documentElement.scrollWidth <= innerWidth,
        aligned: rects.every(rect => Math.abs(rect.tag.right - rects[0].tag.right) < 0.5),
        separate: rects.every(rect => rect.name.right <= rect.tag.left - 7.5),
        wraps: rects.some(rect => rect.name.height > 24), tagText: rows.map(row => row.querySelector('.plugin-purpose-tag').textContent),
        actionsFit: [...box.querySelectorAll('.plugin-consent-actions button')].every(button => {
          const rect = button.getBoundingClientRect(); return rect.left >= panelBounds.left && rect.right <= panelBounds.right + 0.5;
        }) });
    }
    return results;
  })()`);
  for (const result of longNames) {
    assert.ok(result.fits && result.aligned && result.separate && result.wraps && result.actionsFit, JSON.stringify(result));
    assert.ok(result.tagText.every(text => text && !text.startsWith('plugins.')), JSON.stringify(result));
  }
  assert.deepEqual(longNames.map(result => result.tagText[0]), ['獨立分頁', 'Separate page', 'Página independente']);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(evidence, 'initial-long-names.png'), (await win.webContents.capturePage()).toPNG());
  win.setContentSize(390, 880);
  const locations = await win.webContents.executeJavaScript(`(async () => {
    const { box, panel, data } = initialFixture, source = ${JSON.stringify(locationDto)}, results = [];
    const configure = async locale => {
      window.initialLocale = locale;
      data.plugins = [{ ...structuredClone(source), source: 'user', trusted: true, enabled: false, status: 'disabled' }];
      await panel.refresh(); box.querySelector('.plugin-enable').click(); await new Promise(resolve => setTimeout(resolve, 30));
    };
    for (const locale of ['zh-TW', 'zh-CN', 'en', 'ja', 'ko', 'pt-BR']) {
      await configure(locale);
      const labels = [...box.querySelectorAll('.plugin-initial-setup .plugin-purpose-tag')].map(node => node.textContent);
      const expected = ['plugins.initial.purpose.page', 'settings.display.edgeDock', 'settings.notch.title'].map(key => TokenMonitorI18n.translate(locale, key));
      box.querySelector('.plugin-allow').click(); await new Promise(resolve => setTimeout(resolve, 30));
      const detailLabels = [...box.querySelectorAll('.plugin-surface-chip')].map(node => node.textContent);
      results.push({ locale, labels, expected, detailLabels });
    }
    await configure('zh-TW'); return results;
  })()`);
  for (const result of locations) {
    assert.deepEqual(result.labels, result.expected, result.locale);
    assert.deepEqual(result.detailLabels, result.expected, result.locale);
  }
  assert.deepEqual(locations[0].labels, ['獨立分頁', '側邊欄', '瀏海面板']);
  await win.webContents.executeJavaScript('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const locationBounds = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.plugin-initial-setup').getBoundingClientRect();
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  })()`);
  fs.writeFileSync(path.join(evidence, 'initial-location-names.png'), (await win.webContents.capturePage(locationBounds)).toPNG());
  console.log('PASS install review renders all four author recommendations without overflow');
  console.log('PASS install-only submits explicit empty, false and native choices together');
  console.log('PASS first-enable review reuses the same fields and submits user overrides');
  console.log('PASS pending setup for trusted code does not ask for trust again');
  console.log('PASS first-use review can keep the existing provider without offering layout controls');
  console.log('PASS right-aligned purpose tags keep compact spacing and fit long names at 320px in three locales');
  console.log('PASS placement tags and detail controls reuse the App display names in all six locales');
  console.log('Evidence:', evidence); win.destroy(); app.exit(0);
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
