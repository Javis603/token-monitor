'use strict';
// Real CSSOM/layout regression: a plain-object DOM cannot model flex shorthand resets.
// Run with Electron. TM_PLUGIN_LAYOUT_BASELINE optionally selects a frozen pluginViews.js.
const { app, BrowserWindow, session } = require('electron');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { pathToFileURL } = require('node:url');
const renderer = path.resolve(__dirname, '../src/electron/renderer');
const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-layout-'));
const source = process.env.TM_PLUGIN_LAYOUT_BASELINE || path.join(renderer, 'pluginViews.js');
app.setPath('userData', path.join(scratch, 'profile'));
app.whenReady().then(async () => {
  session.defaultSession.webRequest.onBeforeRequest((details, callback) => callback({ cancel: /^(https?|wss?):/.test(details.url) }));
  const html = path.join(scratch, 'index.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><link rel="stylesheet" href="${pathToFileURL(path.join(renderer, 'pluginViews.css'))}"><main></main><script src="${pathToFileURL(source)}"></script>`);
  const win = new BrowserWindow({ show: false, width: 640, height: 480, webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false } });
  await win.loadFile(html);
  const checks = await win.webContents.executeJavaScript(`(() => {
    const api = TokenMonitorPluginViews, checks = [], main = document.querySelector('main');
    const check = (name, actual, expected) => checks.push({name, actual, expected, ok: actual === expected});
    const tree = (dir, spacer) => ({ type:'stack', dir, gap:0, children:[
      {type:'text',text:'Start'}, {type:'spacer',...spacer}, {type:'text',text:'End'}
    ] });
    const extent = (node, dir) => node.getBoundingClientRect()[dir === 'row' ? 'width' : 'height'];
    // Auto-height columns expose physical gaps; rows may grow/shrink, so check their basis.
    for (const dir of ['col','row']) for (const size of [8,32,48]) {
      const node = api.renderTree(document, tree(dir,{size})); main.replaceChildren(node);
      const spacer = node.querySelector('.pv-spacer');
      if (dir === 'row') check(dir+' initial basis '+size,getComputedStyle(spacer).flexBasis,size+'px');
      else check(dir+' initial size '+size,extent(spacer,dir),size);
    }
    const container = document.createElement('div'); main.replaceChildren(container);
    const host = api.createPluginViewHost({document,window,t:key=>key});
    const update = (revision, spacer) => host.update({surface:'page',views:{'demo/view':{status:'ok',revision,tree:tree('col',spacer)}}});
    update(1,{size:8}); host.mount(container,'demo/view','page',{retainDrafts:true});
    const spacer = () => container.querySelector('.pv-spacer');
    check('retained initial size',extent(spacer(),'col'),8);
    update(2,{size:32}); check('retained updated size',extent(spacer(),'col'),32);
    update(3,{}); check('removed size clears basis',getComputedStyle(spacer()).flexBasis,'auto');
    check('removed size has no fixed gap',extent(spacer(),'col'),0);
    update(4,{size:48,flex:2});
    check('explicit flex overrides size',getComputedStyle(spacer()).flexBasis,'0px');
    check('explicit flex growth preserved',getComputedStyle(spacer()).flexGrow,'2');
    update(5,{size:48}); check('removing explicit flex restores size',extent(spacer(),'col'),48);
    check('removing explicit flex restores default growth',getComputedStyle(spacer()).flexGrow,'1');
    for (const flex of [0,2]) {
      const node = api.renderTree(document,tree('col',{size:32,flex})); main.append(node);
      check('initial explicit flex '+flex+' overrides size',getComputedStyle(node.querySelector('.pv-spacer')).flexBasis,'0px');
    }
    container.remove(); host.refreshDemand();
    return checks;
  })()`);
  const result = { electron: process.versions.electron, chromium: process.versions.chrome, source, scratch,
    passed: checks.filter(check => check.ok).length, total: checks.length, checks };
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  win.destroy(); app.exit(checks.every(check => check.ok) ? 0 : 1);
}).catch(error => { console.error(error); app.exit(1); });
