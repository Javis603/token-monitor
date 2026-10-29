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
  const css = ['styles.css', 'pluginViews.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}">`).join('');
  const scripts = ['i18n.js', 'pluginUi.js', 'pluginViews.js', 'selectControl.js', 'pluginSettings.js'].map(file => `<script src="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}"></script>`).join('');
  const html = path.join(scratch, 'index.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8">${css}<style>body{padding:16px;overflow:auto}#settings{display:block}</style></head><body><div id="settings" class="settings-panel"></div>${scripts}</body></html>`);
  const win = new BrowserWindow({ show: false, width: 390, height: 880, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(html);
  const initial = await win.webContents.executeJavaScript(`(async () => {
    const preview = ${JSON.stringify(preview)}, box = document.getElementById('settings'), data = { enabled: true, plugins: [] }, calls = [];
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box,
      t: (key, params) => TokenMonitorI18n.translate('zh-TW', key, params), api: {
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
      actions: [...box.querySelectorAll('.plugin-initial-setup label')].map(node => node.textContent),
      gaps: rows.slice(1).map((rect, index) => rect.top - rows[index].bottom), heights: rows.map(rect => rect.height), lefts: inputs.map(node => node.getBoundingClientRect().left),
      dropdowns: box.querySelectorAll('.plugin-initial-setup select').length, fits: document.documentElement.scrollWidth <= innerWidth };
  })()`);
  assert.deepEqual(initial.values, [true, true, true, true]); assert.equal(initial.fits, true); assert.equal(initial.dropdowns, 0);
  assert.deepEqual(initial.actions, ['新增 Dashboard 分頁', '用 Custom Dashboard 替換主頁內容', '背景執行', '套用 Blue 外觀']);
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
    const labels = [...group.querySelectorAll(':scope > label')].map(node => node.textContent);
    [...group.querySelectorAll('input')].find(node => node.value === 'other/home').click();
    box.querySelector('.plugin-allow').click(); await new Promise(resolve => setTimeout(resolve, 30));
    return { labels, selected: calls.at(-1).initialSetup['content:main.home.content'] };
  })()`);
  assert.deepEqual(existingSource, { labels: ['內建內容', '保留已選內容', '使用 Custom Dashboard'], selected: 'other/home' });
  console.log('PASS install review renders all four author recommendations without overflow');
  console.log('PASS install-only submits explicit empty, false and native choices together');
  console.log('PASS first-enable review reuses the same fields and submits user overrides');
  console.log('PASS pending setup for trusted code does not ask for trust again');
  console.log('PASS first-use review can keep the existing provider without offering layout controls');
  console.log('Evidence:', evidence); win.destroy(); app.exit(0);
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
