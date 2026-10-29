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
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({ document, container: box,
      t: (key, params) => TokenMonitorI18n.translate('zh-TW', key, params), api: {
        list: async () => structuredClone(data), catalog: async () => ({ entries: [], sources: [] }),
        selectContent: async (target, ref) => { calls.push([target, ref]); if (ref === null) delete data.contentSelections[target]; else data.contentSelections[target] = ref; return structuredClone(data); },
        setEnabled: async (_id, enabled) => { data.plugins[0].enabled = enabled; data.plugins[0].status = enabled ? 'active' : 'disabled'; return structuredClone(data); }
      } });
    await panel.refresh(); box.querySelector('.plugin-manage').click();
    window.contentFixture = { data, panel, box, calls, target, ref };
    return { selectors: box.querySelectorAll('.plugin-content-choice').length,
      redundantAction: [...box.querySelectorAll('button')].some(node => /使用此內容|恢復原生內容/.test(node.textContent)),
      rawTarget: box.textContent.includes(target), enabled: box.querySelector('.plugin-enable').checked };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-single.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(single, { selectors: 1, redundantAction: false, rawTarget: false, enabled: true });
  const native = await win.webContents.executeJavaScript(`(async () => {
    const { box } = contentFixture;
    const select = box.querySelector('.plugin-content-choice select');
    const options = [...select.options].map(option => option.value);
    select.value = ''; select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { options, selected: box.querySelector('.plugin-content-choice select').value, enabled: box.querySelector('.plugin-enable').checked };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-native.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(native, { options: ['', 'tool-details/details'], selected: '', enabled: true });
  const multiple = await win.webContents.executeJavaScript(`(async () => {
    const { data, panel, box, target, ref } = contentFixture;
    data.plugins[0].views.push({ ...data.plugins[0].views[0], ref: 'tool-details/compact', title: 'Compact details' });
    await panel.refresh();
    const select = box.querySelector('.plugin-content-choice select');
    const result = { label: select.getAttribute('aria-label'), value: select.value,
      options: [...select.options].map(option => option.value), rawTarget: box.textContent.includes(target) };
    select.value = 'tool-details/compact'; select.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { ...result, calls: contentFixture.calls, selected: box.querySelector('.plugin-content-choice select').value };
  })()`);
  fs.writeFileSync(path.join(evidence, 'content-choices.png'), (await win.webContents.capturePage()).toPNG());
  assert.deepEqual(multiple, { label: '主 App 分頁 · 主頁', value: '', options: ['', 'tool-details/details', 'tool-details/compact'], rawTarget: false,
    calls: [['main.home.content', null], ['main.home.content', 'tool-details/compact']], selected: 'tool-details/compact' });
  const disabled = await win.webContents.executeJavaScript(`(async () => {
    const { box } = contentFixture;
    const toggle = box.querySelector('.plugin-enable'); toggle.checked = false; toggle.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(resolve => setTimeout(resolve, 30));
    return { selectors: box.querySelectorAll('.plugin-content-choice').length, enabled: box.querySelector('.plugin-enable').checked };
  })()`);
  assert.deepEqual(disabled, { selectors: 0, enabled: false });
  console.log('PASS single replacement offers native content independently of the enable switch');
  console.log('PASS restoring native content keeps the plugin enabled');
  console.log('PASS multiple replacements use a named selector and persist changes');
  console.log('PASS disabling removes replacement controls');
  console.log('Evidence:', evidence);
  win.destroy(); app.exit(0);
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
