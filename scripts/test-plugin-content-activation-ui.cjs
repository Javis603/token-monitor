'use strict';
// Isolated Chromium fixture: no App user data or installed plugins are loaded.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-content-ui-'));
app.setPath('userData', path.join(scratch, 'user-data'));
const evidence = process.env.TM_PLUGIN_CONTENT_EVIDENCE_DIR || scratch;
fs.mkdirSync(evidence, { recursive: true });

async function main() {
  const assets = ['styles.css', 'pluginViews.css'].map(file => `<link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}">`).join('');
  const scripts = ['i18n.js', 'pluginUi.js', 'pluginViews.js', 'selectControl.js', 'pluginSettings.js'].map(file => `<script src="${pathToFileURL(path.join(root, 'src/electron/renderer', file))}"></script>`).join('');
  const html = path.join(scratch, 'index.html');
  fs.writeFileSync(html, `<!doctype html><html><head><meta charset="utf-8">${assets}<style>body{overflow:auto;padding:16px}#settings{display:block}</style></head><body><div id="settings" class="settings-panel"></div>${scripts}</body></html>`);
  const win = new BrowserWindow({ show: false, width: 390, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false } });
  await win.loadFile(html);
  const single = await win.webContents.executeJavaScript(`(async () => {
    const target = 'main.home.content', ref = 'tool-details/details';
    const view = { ref, title: 'Tool details', mode: 'replace', targets: [target], surfaces: [] };
    const data = { enabled: true, contentSelections: { [target]: ref }, plugins: [{ id: 'tool-details', name: 'Tool details', author: 'Fixture', version: '0.5.0', source: 'user', status: 'active', enabled: true, trusted: true, views: [view] }] };
    const calls = [], box = document.getElementById('settings');
    const schema = { version: 1, fields: [{ id: 'usage', label: '顯示總用量', type: 'boolean', default: true }, { id: 'tools', label: '顯示工具明細', type: 'boolean', default: false }] };
    const preferences = { usage: true, tools: false };
    const settingsSnapshot = () => ({ schema, schemaVersion: 1, revision: 1, values: { ...preferences }, errors: {}, readOnly: false });
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box,
      t: (key, params) => TokenMonitorI18n.translate('zh-TW', key, params), api: {
        list: async () => structuredClone(data), catalog: async () => ({ entries: [], sources: [] }),
        selectContent: async (target, ref) => { calls.push([target, ref]); if (ref === null) delete data.contentSelections[target]; else data.contentSelections[target] = ref; return structuredClone(data); },
        setEnabled: async (_id, enabled) => { data.plugins[0].enabled = enabled; data.plugins[0].status = enabled ? 'active' : 'disabled'; return structuredClone(data); },
        getSettings: async () => settingsSnapshot(), updateSettings: async (_id, input) => { Object.assign(preferences, input.patch); calls.push(['settings', input.patch]); return settingsSnapshot(); }
      } });
    await panel.refresh(); box.querySelector('.plugin-manage').click();
    window.contentFixture = { data, panel, box, calls, target, ref, schema, preferences };
    return { selectors: box.querySelectorAll('.plugin-content-choice').length,
      redundantAction: [...box.querySelectorAll('button')].some(node => /使用此內容|恢復原生內容/.test(node.textContent)),
      rawTarget: box.textContent.includes(target), enabled: box.querySelector('.plugin-enable').checked,
      action: box.querySelector('.plugin-content-choice label').textContent, dropdowns: box.querySelectorAll('.plugin-content-choice select').length };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-single.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(single, { selectors: 1, redundantAction: false, rawTarget: false, enabled: true, action: '用 Tool details 替換主頁內容', dropdowns: 0 });
  const native = await win.webContents.executeJavaScript(`(async () => {
    const { box } = contentFixture;
    const toggle = box.querySelector('.plugin-content-choice input');
    toggle.click();
    await new Promise(resolve => setTimeout(resolve, 30));
    return { selected: box.querySelector('.plugin-content-choice input').checked, enabled: box.querySelector('.plugin-enable').checked };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-native.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(native, { selected: false, enabled: true });
  const providers = await win.webContents.executeJavaScript(`(async () => {
    const { data, panel, box, target } = contentFixture;
    data.plugins.push({ id: 'other', name: 'Other dashboard', status: 'active', enabled: true, trusted: true,
      views: [{ ref: 'other/home', title: 'Dashboard', mode: 'replace', targets: [target], surfaces: [] }] });
    await panel.refresh(); const group = box.querySelector('.plugin-content-choice');
    const options = [...group.querySelectorAll(':scope > label')].map(label => label.textContent);
    [...group.querySelectorAll(':scope > label input')].find(input => input.value === 'other/home').click();
    await new Promise(resolve => setTimeout(resolve, 30));
    return { options, selected: contentFixture.calls.at(-1), extraDetails: group.querySelectorAll('details').length };
  })()`);
  assert.deepEqual(providers, { options: ['內建內容', '使用 Tool details', '使用 Other dashboard'], selected: ['main.home.content', 'other/home'], extraDetails: 0 });
  fs.writeFileSync(path.join(evidence, 'content-choices.png'), (await win.webContents.capturePage()).toPNG());
  const configured = await win.webContents.executeJavaScript(`(async () => {
    const { data, panel, box, target, ref, schema, preferences, calls } = contentFixture;
    data.plugins[0].settings = schema;
    data.plugins[0].background = { supported: true, enabled: true, description: '定期更新用量資料。' };
    await panel.refresh(); await new Promise(resolve => setTimeout(resolve, 40));
    const before = data.contentSelections[target];
    box.querySelector('[data-control-key="author-tools"]').click();
    box.querySelector('[data-control-key="author-save"]').click(); await new Promise(resolve => setTimeout(resolve, 30));
    const combined = { ...preferences };
    box.querySelector('[data-control-key="author-usage"]').click();
    box.querySelector('[data-control-key="author-save"]').click(); await new Promise(resolve => setTimeout(resolve, 30));
    const result = { combined, preferences: { ...preferences }, provider: data.contentSelections[target], before,
      purpose: box.querySelector('.plugin-background .settings-item-desc').textContent,
      generic: box.querySelector('.plugin-background input').getAttribute('aria-description'),
      extraDetails: box.querySelector('.plugin-background').nextElementSibling?.tagName === 'DETAILS' };
    [...box.querySelectorAll('.plugin-content-choice > label input')].find(input => input.value.startsWith('tool-details/')).click();
    await new Promise(resolve => setTimeout(resolve, 30));
    return result;
  })()`);
  assert.deepEqual(configured, { combined: { usage: true, tools: true }, preferences: { usage: false, tools: true }, provider: 'other/home', before: 'other/home', purpose: '定期更新用量資料。',
    generic: '沒有顯示插件畫面時，仍允許插件繼續工作。', extraDetails: false });
  await win.webContents.executeJavaScript("window.scrollTo(0, 0); new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  fs.writeFileSync(path.join(evidence, 'content-modules.png'), (await win.webContents.capturePage()).toPNG());
  const configurationBounds = await win.webContents.executeJavaScript(`(() => {
    const rect = document.querySelector('.plugin-content-choice').getBoundingClientRect();
    const bottom = document.querySelector('.plugin-background').getBoundingClientRect().bottom;
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(bottom - rect.y) };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-configuration.png'), (await win.webContents.capturePage(configurationBounds)).toPNG());
  const backgroundBounds = await win.webContents.executeJavaScript(`(() => {
    const label = document.querySelector('.plugin-background');
    label.scrollIntoView({ block: 'center' });
    const rect = label.getBoundingClientRect();
    return { x: Math.floor(rect.x), y: Math.floor(rect.y), width: Math.ceil(rect.width), height: Math.ceil(rect.height) };
  })()`);
  fs.writeFileSync(path.join(evidence, 'background-purpose.png'), (await win.webContents.capturePage(backgroundBounds)).toPNG());
  const fallback = await win.webContents.executeJavaScript(`(async () => {
    const { data, panel, box } = contentFixture; delete data.plugins[0].background.description;
    await panel.refresh(); return { note: box.querySelector('.plugin-background .settings-item-desc').textContent };
  })()`);
  assert.deepEqual(fallback, { note: '沒有顯示插件畫面時，仍允許插件繼續工作。' });
  const disabled = await win.webContents.executeJavaScript(`(async () => {
    const { box } = contentFixture;
    const toggle = box.querySelector('.plugin-enable'); toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { selectors: box.querySelectorAll('.plugin-content-choice').length, enabled: box.querySelector('.plugin-enable').checked };
  })()`);
  assert.deepEqual(disabled, { selectors: 0, enabled: false });
  console.log('PASS single replacement uses a clearly named independent checkbox');
  console.log('PASS restoring native content keeps the plugin enabled');
  console.log('PASS content source choices list providers without an extra display-style layer');
  console.log('PASS plugin module choices combine independently of the selected content provider');
  console.log('PASS author background purpose takes precedence without an extra details section; generic fallback remains available');
  console.log('PASS disabling removes replacement controls');
  console.log('Evidence:', evidence);
  win.destroy(); app.exit(0);
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
