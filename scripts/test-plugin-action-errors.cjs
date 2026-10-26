'use strict';
// Exact production action wiring and renderer/CSS, isolated synthetic failures.
// TM_PLUGIN_ACTION_BASELINE points to frozen renderer files; no source swapping.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { pathToFileURL } = require('node:url');
const root = path.resolve(__dirname, '..'), renderer = path.join(root, 'src/electron/renderer');
const baseline = process.env.TM_PLUGIN_ACTION_BASELINE;
const sourcePath = name => baseline && fs.existsSync(path.join(baseline, name)) ? path.join(baseline, name) : path.join(renderer, name);
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-action-errors-'));
const out = process.env.TM_PLUGIN_ACTION_OUTPUT || scratch; fs.mkdirSync(out, { recursive: true });
app.setPath('userData', path.join(scratch, 'profile'));
const source = fs.readFileSync(sourcePath('app.js'), 'utf8');
function declaration(name, optional = false) {
  const match = new RegExp(`^(?:async )?function ${name}\\(`, 'm').exec(source);
  if (!match) { if (optional) return ''; throw Error(`missing declaration ${name}`); }
  return source.slice(match.index, source.indexOf('\n}', match.index) + 2);
}
const markup = fs.readFileSync(path.join(renderer, 'index.html'), 'utf8');
const headerStart = markup.indexOf('      <header class="titlebar">');
const header = markup.slice(headerStart, markup.indexOf('</header>', headerStart) + 9);
const groupStart = markup.indexOf('        <div class="settings-group settings-collapsible-group settings-plugins-group">');
const group = markup.slice(groupStart, markup.indexOf('\n        </div>', groupStart) + '\n        </div>'.length)
  .replace('settings-section-details hidden', 'settings-section-details').replace('aria-expanded="false"', 'aria-expanded="true"');
const notch = markup.match(/<div class="notch-page-settings">.*?<\/p><\/div>/)[0];
const appearanceStart = markup.indexOf('            <div class="settings-subgroup settings-theme-group">');
const appearanceEnd = markup.indexOf('              <div class="settings-field theme-code-field">', appearanceStart);
const appearance = markup.slice(appearanceStart, appearanceEnd) + '</div>';
const pageMarkup = markup.match(/<section id="pluginMainPanel".*?<\/section>/)[0];
const skinCallback = source.match(/onApplySkin: (.*),\n/)[1];
const mainStart = source.indexOf('pluginMainPages = pluginViewHost ?');
const mainSetup = source.slice(mainStart, source.indexOf('}) : null;', mainStart) + '}) : null;'.length);
const scripts = [path.join(root, 'src/shared/plugins/placements.js'), path.join(root, 'src/shared/vendorPresentation.js'),
  ...['i18n.js', 'selectControl.js', 'pluginViews.js', 'themePresets.js', 'pluginSettings.js', 'notch/pageSettings.js', 'pluginMainPages.js'].map(sourcePath)];
fs.writeFileSync(path.join(scratch, 'index.html'), `<!doctype html><html lang="zh-TW"><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(sourcePath('styles.css'))}"><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'pluginViews.css'))}"><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'edgeDock/composer.css'))}"><body><main class="shell settings-open" style="height:100vh;box-sizing:border-box">${header}<section class="settings-panel" style="display:block;overflow:auto"><div id="skinFixture">${group}</div><div id="notchFixture" hidden>${notch}</div><div id="appearanceFixture" hidden>${appearance}</div></section>${pageMarkup}</main>${scripts.map(file => `<script src="${pathToFileURL(file)}"></script>`).join('')}<script>
let locale='zh-TW'; const t=(key,params)=>TokenMonitorI18n.translate(locale,key,params);
const els={status:document.getElementById('status'),themePresetChips:document.getElementById('themePresetChips')};
const state={settings:{},pluginCatalog:{enabled:true,plugins:[{id:'weather-demo',name:'Weather demo',version:'1.0.0',status:'active',enabled:true,source:'user',views:[{ref:'weather-demo/overview',title:'Weather',surfaces:['notch','page'],placements:{page:true,notch:false}}],skins:[{ref:'weather-demo/blue',name:'Ocean',colors:{accent:'#3698e8'}}]}]}};
let failure=true,calls=0,pending=null,hold=false;
const failAction=async()=>{calls++;if(hold)await new Promise((resolve,reject)=>{pending={resolve,reject}});else if(failure)throw Error("Error invoking remote method 'fixture:action': Error: fixture-write-failed");};
// Execute App's real rejection/rollback path, including its form rebuild.
const pendingSettingsPatches=new Set(),appearancePreview={},syncContentForm=null;
const setSyncContentEditError=()=>{},applyEffectiveCurrencyRates=()=>{},isSettingsSurfaceVisible=()=>true,render=()=>{},restartTimer=()=>{},maybeUpdateBarsIcon=()=>{};
const syncSettingsForm=()=>{renderThemePresetChips();renderNotchPageChoices();};
const applyPersistedSettings=next=>{state.settings=next;syncSettingsForm();};
window.tokenMonitor={updateSettings:async patch=>{await failAction();return {...state.settings,...patch};},getSettings:async()=>structuredClone(state.settings)};
const pluginApi={list:async()=>state.pluginCatalog,catalog:async()=>({sources:[],entries:[]}),place:async(ref,surface,value)=>{await failAction();state.pluginCatalog.plugins[0].views[0].placements[surface]=value;}};
const pluginBridge={openPage:()=>failAction()};
const themePresetsApi=TokenMonitorThemePresets,selectThemePreset=()=>{},buildAppearanceColorControls=()=>renderThemePresetChips(),renderSettingsSummaries=()=>{};
const rowDragControllerApi={createRowDragController:()=>null},verticalDragSortApi={},preserveSettingsPanelScroll=fn=>fn();
${['saveSettings','setStatus','applyPluginSkin','matchingThemePresetId','renderThemePresetChips','renderNotchPageChoices'].map(name=>declaration(name)).join('\n')}
${declaration('applyAppearancePluginSkin',true)}
const panel=TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:document.getElementById('pluginSettingsList'),api:pluginApi,t,onApplySkin:${skinCallback}});
const pluginViewHost={mount(){},refreshDemand(){}};let pluginMainPages;${mainSetup}
const pages=TokenMonitorPluginMainPages.entries(state.pluginCatalog);
const tick=async()=>{await new Promise(r=>setTimeout(r,30));await new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)));};
const checks=[];const check=(name,ok)=>checks.push({name,ok:!!ok});
function show(which){for(const name of ['skin','notch','appearance'])document.getElementById(name+'Fixture').hidden=name!==which;const standalone=which==='main';document.querySelector('.settings-panel').style.display=standalone?'none':'block';document.querySelector('.shell').classList.toggle('settings-open',!standalone);document.getElementById('pluginMainPanel').classList.toggle('hidden',!standalone);setStatus('');}
</script></body></html>`);
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^(https?|wss?):/.test(details.url) }));
  const win = new BrowserWindow({ width: 680, height: 760, show: false, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  win.webContents.on('console-message', event => { if (event.level === 'error') console.error(event.message); });
  await win.loadFile(path.join(scratch, 'index.html')); win.show(); win.webContents.focus();
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Tab' });
  win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Tab' });
  const run = async code => {
    const result = await win.webContents.executeJavaScript(`(async()=>{try{${code}}catch(error){return {fixtureError:error.stack}}})()`);
    if (result?.fixtureError) throw Error(result.fixtureError); return result;
  };
  const capture = async name => {
    await run("document.scrollingElement.scrollTop=0;document.querySelectorAll('.shell,.settings-panel').forEach(n=>n.scrollTop=0);await tick();");
    const image = await win.webContents.capturePage(); if (image.isEmpty()) throw Error('empty capture');
    fs.writeFileSync(path.join(out, name+'.png'), image.toPNG());
  };
  await run(`TokenMonitorI18n.applyTranslations(document,locale);setStatus('');await panel.refresh();document.querySelector('.plugin-manage').click();
    let chip=document.querySelector('.plugin-skin-chip');chip.focus();chip.click();await tick();
    check('skin error is next to skin controls',!!document.querySelector('.plugin-skins > .plugin-action-error'));
    check('skin failure leaves global status untouched',!els.status.textContent);
    check('skin failure preserves focus',document.activeElement?.dataset.controlKey==='skin/weather-demo/blue');`);
  await capture('skin-zh-TW');win.setSize(420,760);await capture('skin-narrow-zh-TW');win.setSize(680,760);
  await run(`failure=false;document.querySelector('.plugin-skin-chip').click();await tick();check('skin retry clears error',!document.querySelector('.plugin-skins > .plugin-action-error'));failure=true;
    show('appearance');renderThemePresetChips();let chip=document.querySelector('.theme-preset-chip-plugin');chip.focus();chip.click();await tick();
    check('appearance skin failure is local',!!els.themePresetChips.querySelector('.plugin-action-error'));
    check('appearance skin failure leaves status untouched',!els.status.textContent);
    check('appearance error describes focused control',!!document.activeElement.getAttribute('aria-describedby'));`);
  await capture('appearance-zh-TW');win.setSize(420,760);await capture('appearance-narrow-zh-TW');win.setSize(680,760);
  await run(`locale='en';TokenMonitorI18n.applyTranslations(document,locale);renderThemePresetChips();document.querySelector('.theme-preset-chip-plugin').click();await tick();`);
  await capture('appearance-en');
  await run(`locale='zh-TW';TokenMonitorI18n.applyTranslations(document,locale);`);
  await run(`failure=false;document.querySelector('.theme-preset-chip-plugin').click();await tick();check('appearance retry clears error',!els.themePresetChips.querySelector('.plugin-action-error'));failure=true;
    show('notch');renderNotchPageChoices();let chip=document.querySelector('[data-page="plugin:weather-demo/overview"]');chip.focus();chip.click();await tick();
    check('Notch error stays with page controls',!!document.querySelector('#notchPageChoices > .plugin-action-error'));
    check('Notch failure leaves status untouched',!els.status.textContent);
    check('Notch preserves choice and focus',document.activeElement?.dataset.page==='plugin:weather-demo/overview'&&document.activeElement.getAttribute('aria-pressed')==='false');
    check('Notch error strips IPC wrapper',document.querySelector('#notchPageChoices > .plugin-action-error')?.textContent===t('settings.plugins.actionFailed',{error:'fixture-write-failed'}));`);
  await capture('notch-zh-TW');win.setSize(420,760);await capture('notch-narrow-zh-TW');win.setSize(680,760);
  await run(`failure=false;document.querySelector('[data-page="plugin:weather-demo/overview"]').click();await tick();check('Notch retry clears error and updates choice',!document.querySelector('#notchPageChoices > .plugin-action-error')&&document.querySelector('[data-page="plugin:weather-demo/overview"]').getAttribute('aria-pressed')==='true');failure=true;
    state.settings.notchPageOrder=['limits','home','sessions','breakdown'];renderNotchPageChoices();
    let reset=document.getElementById('resetNotchPageOrderButton');reset.focus();reset.click();await tick();
    check('failed Notch reset focuses Reset',document.activeElement===reset);
    check('failed Notch reset describes Reset',reset.getAttribute('aria-describedby')===document.querySelector('#notchPageChoices > .plugin-action-error')?.id);
    check('failed reset does not describe a page',![...document.querySelectorAll('#notchPageChoices button')].some(n=>n.hasAttribute('aria-describedby')));
    check('failed reset retains saved order',state.settings.notchPageOrder[0]==='limits');`);
  await capture('notch-reset-zh-TW');win.setSize(420,760);await capture('notch-reset-narrow-zh-TW');win.setSize(680,760);
  await run(`locale='en';TokenMonitorI18n.applyTranslations(document,locale);renderNotchPageChoices();`);
  await capture('notch-reset-en');
  await run(`failure=false;document.getElementById('resetNotchPageOrderButton').click();await tick();
    check('reset retry clears association and error',!document.getElementById('resetNotchPageOrderButton').hasAttribute('aria-describedby')&&!document.querySelector('#notchPageChoices > .plugin-action-error'));
    check('successful reset focuses first page',document.activeElement?.dataset.page==='home');failure=true;
    locale='zh-TW';TokenMonitorI18n.applyTranslations(document,locale);
    show('main');pluginMainPages.render(pages,pages[0].id);let button=document.querySelector('.plugin-main-detach');button.focus();button.click();await tick();
    check('detach failure stays in page heading',!!document.querySelector('.plugin-main-heading > .plugin-action-error'));
    check('detach failure leaves status untouched',!els.status.textContent);
    check('detach error is accessible and focused',!!button.getAttribute('aria-describedby')&&document.activeElement===button&&document.querySelector('.plugin-main-heading > .plugin-action-error')?.getAttribute('role')==='alert');`);
  await capture('detach-zh-TW');win.setSize(420,760);await capture('detach-narrow-zh-TW');win.setSize(680,760);
  await run(`locale='en';TokenMonitorI18n.applyTranslations(document,locale);pluginMainPages.render(pages,pages[0].id);check('detach error retranslates',document.querySelector('.plugin-main-heading > .plugin-action-error')?.textContent===t('settings.plugins.actionFailed',{error:'fixture-write-failed'}));`);
  await capture('detach-en');
  await run(`failure=false;document.querySelector('.plugin-main-detach').click();await tick();check('detach retry clears error',!document.querySelector('.plugin-main-heading > .plugin-action-error'));
    hold=true;const previous=calls;document.querySelector('.plugin-main-detach').click();document.querySelector('.plugin-main-detach').click();check('detach prevents duplicate submission',calls===previous+1);
    pluginMainPages.render(pages,'home');pending.reject(Error('stale'));await tick();pluginMainPages.render(pages,pages[0].id);check('late detach rejection discarded after navigation',!document.querySelector('.plugin-main-heading > .plugin-action-error'));hold=false;
    show('appearance');renderThemePresetChips();const count=calls;hold=true;document.querySelector('.theme-preset-chip-plugin').click();document.querySelector('.theme-preset-chip-plugin').click();check('appearance prevents duplicate submission',calls===count+1);state.pluginCatalog.plugins=[];renderThemePresetChips();pending.reject(Error('stale'));await tick();check('removed appearance skin ignores late failure',!els.themePresetChips.querySelector('.plugin-action-error'));hold=false;
  `);
  const checks = await run('return checks;');
  const result = { scratch, out, baseline: baseline || null, passed: checks.filter(c => c.ok).length, total: checks.length, checks };
  fs.writeFileSync(path.join(out, 'results.json'), JSON.stringify(result,null,2));console.log(JSON.stringify(result));
  win.destroy();app.exit(checks.every(c=>c.ok)?0:1);
}).catch(error=>{console.error(error);app.exit(1);});
