'use strict';
// Isolated Chromium fixture. No real installed plugins, account data or network.
const { app, BrowserWindow } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { createPluginCatalog } = require('../src/electron/plugins/catalog');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-update-notes-'));
app.setPath('userData', path.join(scratch, 'profile'));
app.on('window-all-closed', () => {});
async function main() {
  app.dock?.hide();
  let installedVersion = null;
  const catalog = createPluginCatalog({ root: path.join(scratch, 'catalog'), getLocale: () => 'zh-TW',
    manager: { list: () => ({ plugins: installedVersion ? [{ id: 'notes-fixture', version: installedVersion }] : [] }) },
    managed: { describe: () => installedVersion ? { version: installedVersion, origin: { id: 'maintainer-notes' } } : null, cancelSource() {} },
    maintainerSources: [{ id: 'maintainer-notes', url: 'https://catalog.example/index.json' }],
    fetchImpl: async () => new Response(JSON.stringify({ format: 1, title: 'Fixture catalog', plugins: [{
      id: 'notes-fixture', name: '路由外掛', author: 'Fixture', description: '在主視窗、瀏海面板與側邊欄查看即時路由。',
      repository: 'https://github.com/example/routes', versions: ['0.4.0', '0.3.0', '0.2.0', '0.1.0'].map(version => ({
        version, url: `https://catalog.example/${version}.tmplugin`, sha256: 'a'.repeat(64), types: ['widget', 'page'],
        changelog: { 'zh-TW': { '0.4.0': '新增請求篩選，方便查看指定 Agent 的路由。', '0.3.0': '新增上下文摘要。', '0.2.0': '新增側邊欄路由卡片。', '0.1.0': '首次發布即時路由檢視。' }[version] }
      }))
    }] })) });
  await catalog.discover();
  const source = process.env.TM_PLUGIN_SETTINGS_SCRIPT || path.join(root, 'src/electron/renderer/pluginSettings.js');
  const i18n = require(process.env.TM_PLUGIN_I18N_MODULE || path.join(root, 'src/electron/renderer/i18n.js'));
  const html = path.join(scratch, 'index.html');
  const scripts = ['pluginUi.js', 'pluginViews.js', 'selectControl.js'].map(file => path.join(root, 'src/electron/renderer', file)).concat(source);
  fs.writeFileSync(html, `<!doctype html><html lang="zh-TW"><head><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(root, 'src/electron/renderer/styles.css'))}"><style>body{margin:0;background:#111316}#settings{padding:20px;max-width:720px;margin:auto}</style></head><body><div id="settings" class="settings-panel"></div>${scripts.map(file => `<script src="${pathToFileURL(file)}"></script>`).join('')}</body></html>`);
  const win = new BrowserWindow({ show: false, width: 780, height: 760, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => console.log('Renderer:', event.message));
  await win.loadFile(html);
  const translations = i18n.MESSAGES['zh-TW'];
  const setup = async (installed, review = true, thirdParty = false) => {
    installedVersion = installed;
    await win.webContents.executeJavaScript(`(async () => {
      window.installCalls = 0; window.installError = false; window.panel?.dispose(); document.getElementById('settings').replaceChildren();
      const data = ${JSON.stringify(catalog.list())}, installed = ${JSON.stringify(installed)}, translations = ${JSON.stringify(translations)};
      data.autoUpdate={enabled:true,plugins:{}};
      if (${thirdParty}) for (const entry of data.entries) entry.origin.kind='community';
      const t = (key, values = {}) => Object.entries(values).reduce((text, [name, value]) => text.replace('{'+name+'}', value), translations[key] || key);
      window.panel = TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:document.getElementById('settings'),t,api:{
        list:async()=>({enabled:true,plugins:installed?[{id:'notes-fixture',name:'路由外掛',version:installed,source:'user',status:'active',enabled:true,trusted:true,views:[],installation:{origin:{id:'maintainer-notes',kind:'maintainer'}}}]:[]}),catalog:async()=>data,discoverCatalog:async()=>data,
        catalogDetails:async()=>({html:'<h2>使用方式</h2><p>連接本機服務後，選擇要查看的路由。</p>',imageCount:0}),closeCatalogDetails:async()=>{},
        catalogPreview:async(source,id,version)=>({id,name:'路由外掛',version,installedVersion:installed,description:'即時路由檢視',origin:{id:source,kind:${thirdParty}?'community':'maintainer'},operation:installed?'update':'install',sha256:'a'.repeat(64),token:version,initialSetup:{fields:installed && ${review}?[{key:'background',kind:'background',value:false}]:[]}}),cancelInstall:async()=>{},configureUpdates:async(id,value)=>{if(id===null)data.autoUpdate.enabled=value;else data.autoUpdate.plugins[id]=value;return data;},install:async()=>{window.installCalls++;if(window.installError)throw Error('fixture update failed');return {enabled:true,plugins:[]};}
      }});
      await panel.refresh();document.querySelector('[data-tab="discover"]').click();
      await new Promise(resolve=>setTimeout(resolve,30));
    })()`);
  };
  const checks = [];
  const check = async (name, expression) => { const ok = await win.webContents.executeJavaScript(expression); checks.push({ name, ok }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}`); };
  for (const version of ['0.4.0', '0.5.0']) {
    await setup(version);
    await check(`installed-${version}-has-no-update-action`, "![...document.querySelectorAll('.plugin-catalog-grid .settings-actions button')].some(button=>button.textContent==='更新') && Boolean(document.querySelector('.plugin-installed-check'))");
    await win.capturePage().then(image => fs.writeFileSync(path.join(scratch, `installed-${version}.png`), image.toPNG()));
  }
  await setup(null);
  await check('uninstalled-card-offers-install', "[...document.querySelectorAll('.plugin-catalog-grid .settings-actions button')].some(button=>button.textContent==='安裝' && !button.disabled)");
  await win.webContents.executeJavaScript("document.querySelector('.plugin-catalog-title').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('uninstalled-details-show-introduction-without-release-notes', "Boolean(document.querySelector('dialog .plugin-catalog-readme')) && !document.querySelector('dialog').textContent.includes('新增請求篩選')");
  await win.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'uninstalled-details.png'), image.toPNG()));
  await win.webContents.executeJavaScript("document.querySelector('dialog .plugin-allow').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('first-install-review-has-no-update-notes', "!document.querySelector('.plugin-update-notes') && !document.querySelector('.plugin-catalog-review').textContent.includes('新增請求篩選')");
  await setup('0.1.0');
  await check('older-install-offers-enabled-update', "[...document.querySelectorAll('.plugin-catalog-grid .settings-actions button')].some(button=>button.textContent==='更新' && !button.disabled)");
  await win.webContents.executeJavaScript("document.querySelector('.plugin-catalog-title').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('installed-details-also-remain-introduction-only', "!document.querySelector('dialog').textContent.includes('新增請求篩選')");
  await win.webContents.executeJavaScript("document.querySelector('dialog .plugin-allow').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('update-review-shows-installed-to-target-range', "document.querySelector('.plugin-update-notes h3')?.textContent === '更新內容 · v0.1.0 → v0.4.0'");
  await check('update-review-includes-intermediate-versions-newest-first', "JSON.stringify([...document.querySelectorAll('.plugin-update-notes h4')].map(n=>n.textContent)) === JSON.stringify(['v0.4.0','v0.3.0','v0.2.0'])");
  await check('notes-belong-to-the-package-card', "Boolean(document.querySelector('.plugin-package-preview > .plugin-update-notes'))");
  await check('technical-urls-are-collapsed', "!document.querySelector('.plugin-package-preview .plugin-logs').open");
  await win.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'update-review.png'), image.toPNG()));
  win.setSize(361, 799);
  await check('narrow-update-review-does-not-overflow-horizontally', "document.documentElement.scrollWidth <= window.innerWidth");
  await win.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'update-review-narrow.png'), image.toPNG()));
  await win.webContents.executeJavaScript("const select=document.querySelector('.plugin-version-picker select');select.value='0.2.0';select.dispatchEvent(new Event('change'));new Promise(resolve=>setTimeout(resolve,30))");
  await check('changing-target-trims-history-and-aligns-package-preview', "document.querySelector('.plugin-update-notes h3')?.textContent === '更新內容 · v0.1.0 → v0.2.0' && document.querySelectorAll('.plugin-update-notes h4').length===1 && document.querySelector('.plugin-package-preview .plugin-version').textContent==='0.1.0 → 0.2.0'");
  await setup('0.1.0', false);
  await win.webContents.executeJavaScript("document.querySelector('[data-tab=installed]').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('installed-card-shows-notes-by-default-without-preview', "Boolean(document.querySelector('.plugin-installed-card section.plugin-update-notes .plugin-update-note')?.getClientRects().length) && !document.querySelector('.plugin-installed-card .plugin-update-notes summary') && !document.querySelector('dialog')");
  await win.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'installed-update-notes.png'), image.toPNG()));
  await win.webContents.executeJavaScript("document.querySelector('.plugin-update-action').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('official-update-installs-once-without-introduction-or-review', "window.installCalls===1 && !document.querySelector('dialog') && !document.querySelector('.plugin-package-preview')");
  await setup('0.1.0', false, true);
  await win.webContents.executeJavaScript("document.querySelector('[data-tab=installed]').click();new Promise(resolve=>setTimeout(resolve,30))");
  await win.webContents.executeJavaScript("document.querySelector('.plugin-update-action').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('third-party-update-has-one-trust-review-with-notes', "window.installCalls===0 && !document.querySelector('dialog') && Boolean(document.querySelector('.plugin-package-preview .plugin-update-notes')) && document.querySelector('.plugin-package-preview .plugin-allow').textContent==='信任並更新' && document.querySelector('.plugin-package-preview .plugin-origin-label').textContent==='第三方 · 未經審核'");
  await win.webContents.executeJavaScript("document.querySelector('.plugin-package-preview .plugin-allow').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('third-party-confirmation-installs-once', "window.installCalls===1 && !document.querySelector('.plugin-package-preview')");
  await setup('0.1.0', false);
  await win.webContents.executeJavaScript("document.querySelector('[data-tab=installed]').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('automatic-update-switch-is-enabled-by-default', "document.querySelector('.plugin-auto-update input')?.checked===true");
  await win.webContents.executeJavaScript("const auto=document.querySelector('.plugin-auto-update input');auto.checked=false;auto.dispatchEvent(new Event('change'));new Promise(resolve=>setTimeout(resolve,30))");
  await check('automatic-update-switch-retains-opt-out', "document.querySelector('.plugin-auto-update input')?.checked===false");
  await win.webContents.executeJavaScript("window.installError=true;document.querySelector('.plugin-update-action').click();new Promise(resolve=>setTimeout(resolve,30))");
  await check('failed-one-click-update-is-visible-and-retryable', "window.installCalls===1 && document.querySelector('.plugin-action-error')?.textContent.includes('fixture update failed') && !document.querySelector('.plugin-update-action').disabled && !document.querySelector('.plugin-package-preview')");
  await win.webContents.executeJavaScript('panel.dispose()'); win.destroy(); catalog.dispose();
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(checks, null, 2));
  console.log('Evidence:', scratch);
  assert.ok(checks.every(check => check.ok), 'Plugin update notes UI checks failed'); app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
