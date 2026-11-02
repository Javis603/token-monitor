'use strict';
// Isolated synthetic fixture; no primary app, profile, network or live ports.
// env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-author-settings-ui.cjs
const { app, BrowserWindow } = require('electron');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const assert = require('node:assert/strict');
const { normalizeSettings } = require('../src/shared/plugins/settings');
const root = path.resolve(__dirname, '..');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-author-settings-ui-'));
app.setPath('userData', path.join(scratch, 'profile'));
app.on('window-all-closed', () => {});
const schema = normalizeSettings({ version: 1, fields: [
  { id: 'grid', type: 'boolean', label: 'Show grid', default: true, description: 'Keep drawing guides visible.' },
  { id: 'width', type: 'number', label: 'Stroke width', default: 2, min: 1, max: 20, integer: true },
  { id: 'note', type: 'string', label: 'Canvas title', default: '', maxLength: 100 },
  { id: 'mode', type: 'select', label: 'Drawing mode', default: 'pen', options: [{ value: 'pen', label: 'Pen' }, { value: 'marker', label: 'Marker' }] }
] });
const copy = {
  title: 'Plugin settings', note: 'Preferences provided by this plugin.', disabledNote: 'Saved preferences take effect when the plugin is enabled.',
  save: 'Save settings', saving: 'Saving…', saved: 'Settings saved', defaults: 'Use defaults', reload: 'Reload saved settings',
  loading: 'Loading settings…', loadFailed: 'Could not load settings. Try again.', saveFailed: 'Could not save settings. Your edits are kept. Try again.',
  conflict: 'Settings changed elsewhere. Reload saved settings before saving again.', newerSchema: 'These settings were saved by a newer plugin version. Update the plugin to edit them.',
  invalid: 'Check the highlighted settings.', invalidField: 'Enter a valid value.', defaultsNote: 'Default values are ready to save.', editor: 'Open plugin settings editor', closeEditor: 'Close editor'
};
async function main() {
  app.dock?.hide();
  const html = path.join(scratch, 'fixture.html');
  fs.writeFileSync(html, `<!doctype html><html lang="en"><head><meta charset="utf-8"><link rel="stylesheet" href="file://${root}/src/electron/renderer/styles.css"><style>body{overflow:auto;padding:16px}#settings{max-width:640px;margin:auto}.settings-panel{display:block!important}h1{font-size:14px}</style></head><body><h1>Synthetic author settings fixture</h1><div id="settings" class="settings-panel"></div><button id="outside">Outside</button><script src="file://${root}/src/shared/plugins/localized.js"></script><script src="file://${root}/src/electron/renderer/selectControl.js"></script><script src="file://${root}/src/electron/renderer/pluginSettings.js"></script></body></html>`);
  const win = new BrowserWindow({ show: false, width: 420, height: 900, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(html);
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setFocusEmulationEnabled', { enabled: true });
  const result = await win.webContents.executeJavaScript(`(async () => {
    window.TokenMonitorPluginViews = { iconNode: () => document.createElement('span') };
    const schema = ${JSON.stringify(schema)}, copy = ${JSON.stringify(copy)};
    const checks = []; const check = (name, condition) => checks.push({ name, ok: Boolean(condition) });
    const box = document.getElementById('settings');
    const tick = () => new Promise(resolve => setTimeout(resolve, 25));
    let mode = 'ok', resolveSave, writes = 0, reads = 0; const mounts = [];
    let saved = { pluginId: 'demo', schema, schemaVersion: 1, storedSchemaVersion: 1, revision: 0, values: {grid:true,width:2,note:'Saved title',mode:'pen'}, errors:{}, readOnly:false,status:'ready' };
    const data = {enabled:false, safeMode:true, plugins:[{id:'demo',name:'Preferences fixture',author:'Fixture author',version:'1.0.0',source:'user',status:'disabled',enabled:false,settings:true,views:[]}]};
    const panel = TokenMonitorPluginSettings.createPluginSettingsPanel({document,container:box,mountSettings:(container,view)=>{mounts.push(view.ref);if(!container.firstChild){const marker=document.createElement('span');marker.textContent='Custom settings';container.append(marker)}},t:key=>copy[key.replace('plugins.authorSettings.','')] || ({'plugins.ui.back':'Back','plugins.ui.manage':'Manage','plugins.catalog.installed':'Installed','plugins.catalog.official':'Official','plugins.catalog.community':'Community','plugins.ui.noPlacements':'No selected locations','plugins.ui.selectedLocations':'Selected locations','settings.plugins.source.user':'Local plugin'})[key] || key,api:{
      list:async()=>structuredClone(data),
      getSettings:async()=>{reads++;if(mode==='load-error')throw Error('read failed');return structuredClone(saved)},
      updateSettings:async(id,request)=>{
        writes++;
        if(mode==='deferred')await new Promise(resolve=>{resolveSave=resolve});
        if(mode==='failure')throw Error('disk failed');
        if(mode==='invalid')throw Object.assign(Error('invalid-settings-values'),{code:'invalid-settings-values',fields:{width:'range'}});
        if(mode==='conflict'||request.expectedRevision!==saved.revision)throw Object.assign(Error('settings-conflict'),{code:'settings-conflict'});
        saved={...saved,revision:saved.revision+1,values:{...saved.values,...request.patch}};return structuredClone(saved);
      }
    }});
    await panel.refresh();box.querySelector('.plugin-manage').click();await tick();
    const control=id=>box.querySelector('[data-control-key="author-'+id+'"]');
    const edit=(id,value)=>{const node=control(id);node.value=value;node.dispatchEvent(new Event('input',{bubbles:true}));return node};
    check('disabled-master-safe-mode-form-needs-no-placement-or-code',reads===1&&box.querySelectorAll('.plugin-author-input').length===4&&!control('note').disabled&&!box.querySelector('.plugin-surface-chip'));
    check('labels-descriptions-and-types',control('width').type==='number'&&control('width').min==='1'&&control('grid').labels.length===1&&document.getElementById(control('grid').getAttribute('aria-describedby').split(' ')[0]).textContent==='Keep drawing guides visible.');
    edit('note','Unsaved title');await panel.refresh();check('list-refresh-preserves-draft',control('note').value==='Unsaved title');
    box.querySelector('.plugin-back').click();box.querySelector('.plugin-manage').click();await tick();check('navigation-preserves-draft',control('note').value==='Unsaved title');
    mode='deferred';control('save').focus();control('save').click();control('save').click();
    check('save-busy-keeps-focused-action-and-single-request',writes===1&&document.activeElement===control('save')&&box.getAttribute('aria-busy')==='true'&&control('note').disabled);
    mode='failure';resolveSave();await tick();
    check('save-failure-preserves-draft-revision-focus-and-retry',saved.revision===0&&control('note').value==='Unsaved title'&&document.activeElement===control('save')&&!control('save').disabled&&box.querySelector('.plugin-author-status').textContent===copy.saveFailed);
    mode='invalid';edit('width','30');control('save').click();await tick();
    check('validation-errors-associated-with-input',control('width').getAttribute('aria-invalid')==='true'&&!document.getElementById(control('width').id+'-error').hidden&&control('width').value==='30');
    mode='ok';edit('width','3');control('save').focus();control('save').click();await tick();
    check('successful-save-publishes-and-keeps-focus-in-form',saved.revision===1&&saved.values.note==='Unsaved title'&&box.querySelector('.plugin-author-settings').contains(document.activeElement)&&box.querySelector('.plugin-author-status').textContent===copy.saved);
    edit('note','Local conflicting title');saved={...saved,revision:2,values:{...saved.values,note:'Other window'}};mode='conflict';control('save').click();await tick();
    check('conflict-keeps-draft-and-demands-explicit-reload',control('note').value==='Local conflicting title'&&box.querySelector('.plugin-author-status').textContent===copy.conflict);
    mode='ok';control('reload').click();await tick();check('reload-adopts-current-revision',control('note').value==='Other window');
    control('defaults').focus();control('defaults').click();await tick();
    check('defaults-are-explicit-unsaved-draft-and-retain-focus',saved.values.note==='Other window'&&control('note').value===''&&control('width').value==='2'&&document.activeElement===control('defaults'));
    control('save').click();await tick();check('defaults-save-uses-current-revision',saved.revision===3&&saved.values.note==='');
    saved={...saved,readOnly:true,status:'newer-schema'};control('reload').click();await tick();
    check('downgrade-is-readonly-with-explanation',control('note').disabled&&control('save').disabled&&box.querySelector('.plugin-author-status').textContent===copy.newerSchema);
    saved={...saved,readOnly:false,status:'ready'};mode='load-error';control('reload').click();await tick();
    check('failed-reload-keeps-old-snapshot-and-retry',control('note').disabled===true&&box.querySelector('.plugin-author-status').textContent===copy.loadFailed);
    mode='ok';control('reload').click();await tick();
    check('narrow-layout-no-horizontal-overflow',document.documentElement.scrollWidth<=window.innerWidth);
    data.plugins[0].views=[{ref:'demo/editor',surfaces:['settings'],revision:'one'}];
    data.plugins[0].settingsIdentity='install-1';await panel.refresh();await tick();
    check('disabled-author-code-is-not-mounted',mounts.length===0&&!control('note').disabled);
    data.enabled=true;data.safeMode=false;data.plugins[0].enabled=true;data.plugins[0].status='active';
    await panel.refresh();await tick();
    check('active-settings-view-mounted-without-display-placement',mounts.includes('demo/editor'));
    edit('note','Retain this draft');const readsBefore=reads;await panel.refresh();await tick();
    check('settings-refresh-retains-form-draft',reads===readsBefore&&control('note').value==='Retain this draft');
    data.plugins[0].settingsIdentity='install-2';await panel.refresh();await tick();
    check('reinstall-identity-invalidates-draft',reads===readsBefore+1&&control('note').value===saved.values.note);
    edit('note','Uninstalled draft');const plugin=data.plugins.pop();await panel.refresh();data.plugins.push(plugin);await panel.refresh();box.querySelector('.plugin-manage').click();await tick();
    check('uninstall-invalidates-draft-even-same-id',control('note').value===saved.values.note);
    window.fixturePanel=panel;
    return checks;
  })()`);
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'narrow.png'), image.toPNG()));
  win.setSize(800, 950);
  await new Promise(resolve => setTimeout(resolve, 50));
  await win.webContents.capturePage().then(image => fs.writeFileSync(path.join(scratch, 'wide.png'), image.toPNG()));
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(result, null, 2));
  result.forEach(check => console.log(`${check.ok ? 'PASS' : 'FAIL'} ${check.name}`));
  console.log('Evidence:', scratch);
  assert.ok(result.every(check => check.ok), 'Author settings UI regression failed');
  win.destroy(); app.quit();
}
app.whenReady().then(main).catch(error => { console.error(error); app.exit(1); });
