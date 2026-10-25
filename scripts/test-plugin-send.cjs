'use strict';
// Production runtime, sandboxed Worker, Rich preloads and IPC for tm.send.
// env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron scripts/test-plugin-send.cjs
// Synthetic fixture plugin in a scratch profile; no network, live profile or debugging port.
const electron = require('electron');
const { app, BrowserWindow, webContents } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-send-'));
app.setPath('userData', path.join(scratch, 'profile')); registerPluginScheme(electron.protocol);
app.on('window-all-closed', () => {});
let win, runtime;
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 8000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms); })]);
  } finally { clearTimeout(timer); }
}
async function until(fn, ms = 10000, every = 30) {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) { if (await fn().catch(() => false)) return; await delay(every); }
  throw Error('condition timed out');
}
function check(name, value) { checks.push({ name, ok: Boolean(value) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); }
const execute = (wc, script, ms) => bounded(wc.executeJavaScript(script), `document ${wc.id}: ${script.slice(0, 80)}`, ms);
const host = script => execute(win.webContents, script);
const documentFor = entry => webContents.getAllWebContents().find(wc => wc.getURL().startsWith('tm-plugin-ui:') && wc.getURL().includes(`/${entry}`));
const author = (entry, script, ms) => documentFor(entry) ? execute(documentFor(entry), script, ms) : Promise.reject(new Error(`${entry} not mounted`));
const worker = () => runtime.manager.diagnostics().plugins.find(plugin => plugin.id === 'send-probe');

const MANIFEST = {
  id: 'send-probe', name: { en: 'Send probe' }, version: '1.0.0', tmApi: 1, author: 'Token Monitor tests',
  description: { en: 'Exercises tm.send from Rich documents.' },
  main: 'main.js', permissions: ['ui.web'],
  metrics: [{ id: 'results', kind: 'object', label: 'Results' }],
  views: [{ id: 'overview', title: 'Probe', surfaces: ['home'], layout: { type: 'text', text: 'Probe' } }],
  webUi: { version: 1, assets: ['page.html', 'page.js', 'settings.html', 'settings.js'], documents: [
    { id: 'home', title: 'Probe', entry: 'page.html', target: 'home', slot: 'replace', height: 300, view: 'overview' },
    { id: 'settings', title: 'Probe settings', entry: 'settings.html', target: 'settings', slot: 'replace', height: 200 }
  ] }
};
// The Worker counts ticks so a response shows whether any tick ran.
const MAIN = `let ticks = 0;
tm.onTick(() => { ticks += 1; });
tm.onAction('search', async ({ value }) => {
  const items = ['opus', 'sonnet', 'haiku'].filter(name => name.includes(value.q));
  tm.publish('results', { query: value.q, items });
  return { count: items.length, mode: tm.mode };
});
tm.onAction('slow', () => new Promise(resolve => setTimeout(() => resolve('slow-done'), 1500)));
tm.onAction('boom', () => { throw new Error('boom'); });
tm.onAction('throwNothing', () => { throw undefined; });
tm.onAction('deep', () => { let v = {}; for (let i = 0; i < 18; i++) v = { nested: v }; return v; });
tm.onAction('many', () => Array(3000).fill(0));
tm.onAction('date', () => new Date());
tm.onAction('testConnection', async () => ({ ok: true, ticks, mode: tm.mode }));
`;
const PAGE_HTML = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body style="margin:0;padding:16px;font:14px system-ui;color:#eee;background:#1d2024"><input id="q" value="o"> <button id="go" type="button">Search</button><p id="state">idle</p><ul id="list"></ul><script src="page.js"></script></body>';
const PAGE_JS = `window.slowDone = null;
tm.send('slow').then(value => { window.slowDone = value; });
const list = document.getElementById('list'), state = document.getElementById('state');
function render(readings) {
  const results = readings?.['@results']?.value;
  if (!results) return;
  list.replaceChildren(...results.items.map(item => Object.assign(document.createElement('li'), { textContent: item })));
}
tm.onData(render);
tm.subscribe(['@results']).then(render);
// Rich documents are sandboxed without allow-forms, so a form never submits.
document.getElementById('go').addEventListener('click', async () => {
  state.textContent = 'searching…';
  try { const reply = await tm.send('search', { q: document.getElementById('q').value }); state.textContent = reply.count + ' results'; }
  catch (error) { state.textContent = 'error: ' + error.message; }
});
`;
const SETTINGS_HTML = '<!doctype html><meta charset="utf-8"><link rel="icon" href="data:,"><body style="margin:0;padding:16px;font:14px system-ui;color:#eee;background:#1d2024"><button id="test">Test connection</button><p id="status"></p><script src="settings.js"></script></body>';
const SETTINGS_JS = `document.getElementById('test').addEventListener('click', async () => {
  try { const reply = await tm.send('testConnection'); document.getElementById('status').textContent = JSON.stringify(reply); }
  catch (error) { document.getElementById('status').textContent = 'error: ' + error.message; }
});
`;

async function main() {
  const userDataDir = path.join(scratch, 'profile'), dir = path.join(userDataDir, 'plugins/send-probe');
  fs.mkdirSync(dir, { recursive: true });
  const files = { 'manifest.json': JSON.stringify(MANIFEST), 'main.js': MAIN, 'page.html': PAGE_HTML, 'page.js': PAGE_JS, 'settings.html': SETTINGS_HTML, 'settings.js': SETTINGS_JS };
  for (const [name, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), text);
  let settings = { pluginsEnabled: true, pluginStates: {}, homeModuleOrder: 'plugin:send-probe/overview', pluginMainPages: [] };
  const html = path.join(scratch, 'host.html');
  fs.writeFileSync(html, '<!doctype html><meta charset="utf-8"><body style="margin:0;background:#17191c;color:#eee;font:14px system-ui"><header style="height:48px;padding:12px">Token Monitor · tm.send acceptance</header></body>');
  win = new BrowserWindow({ width: 620, height: 640, show: false, webPreferences: { preload: path.join(root, 'src/electron/preload.js'), sandbox: true, contextIsolation: true } });
  runtime = createPluginRuntime({ electron, userDataDir, getSettings: () => settings,
    applySettingsPatch: patch => { settings = { ...settings, ...patch }; runtime.settingsChanged(); },
    persistPluginStates: pluginStates => { settings = { ...settings, pluginStates }; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; },
    getLocale: () => 'en', getContext: () => ({}), isMainSender: event => event.sender === win.webContents,
    businessAdapters: { sourceId: () => 'fixture', extras: () => ({}), loadHistory: async () => ({ daily: [] }) }, env: {} });
  runtime.start(); runtime.manager.setEnabled('send-probe', true);
  runtime.publishStats({ collectedAt: Date.now(), periods: { today: { totalTokens: 0, cost: 0, models: {}, costs: {}, clients: {} } }, devices: [] });
  await win.loadFile(html); win.showInactive();
  const theme = "theme:{colors:{background:'#17191c',text:'#eeeeee',muted:'#aaaaaa',accent:'#8aafff'},dark:true,font:'system-ui'}";

  // 1. Settings: an enabled plugin with nothing visible wakes only for the action.
  check('opening nothing leaves the Worker stopped', worker().runtime === 'stopped' && worker().mode === null);
  await host(`window.api=tokenMonitor.plugins;window.syncSettings=()=>api.syncWebPresentation({surface:'settings',visible:true,entries:[{instance:'prefs',viewRef:'send-probe',ref:'send-probe/settings',rect:{x:24,y:72,width:572,height:200}}],${theme}});api.onWebPresentationReady(()=>syncSettings());syncSettings();`);
  // Re-syncing faster than the presentation offer restarts it, so poll gently.
  await until(async () => documentFor('settings.html') && (await host('syncSettings().then(value=>value.mounted.includes("prefs"))')), 10000, 250);
  check('mounting the settings document does not start the Worker', worker().runtime === 'stopped' && worker().mode === null);
  fs.writeFileSync(path.join(scratch, 'settings-before.png'), (await documentFor('settings.html').capturePage()).toPNG());
  check('the isolated settings bridge exposes tm.send', await author('settings.html', "typeof tm.send === 'function'"));
  await author('settings.html', "document.getElementById('test').click(); true");
  await until(() => author('settings.html', "document.getElementById('status').textContent.length > 0"));
  const status = JSON.parse(await author('settings.html', "document.getElementById('status').textContent"));
  check('settings test-connection resolves with the handler return value', status.ok === true);
  check('the action ran in action mode', status.mode === 'action');
  check('no tick ran for the action-only wake', status.ticks === 0);
  await until(async () => worker().mode === null);
  check('the Worker returns to idle once the action finishes', worker().mode === null && worker().runtime === 'running');
  fs.writeFileSync(path.join(scratch, 'settings-after.png'), (await documentFor('settings.html').capturePage()).toPNG());
  await until(async () => worker().runtime === 'stopped', 35000, 250);
  check('the Worker process is reclaimed after idle grace while settings stay open', worker().runtime === 'stopped' && Boolean(documentFor('settings.html')));
  await host("api.syncWebPresentation({surface:'settings',visible:false,entries:[]})");

  // 2. Home: a visible document sends, reads the result through its metric and is not held back.
  await host(`api.setDemand('home',['send-probe/overview']);window.syncHome=()=>api.syncWebPresentation({surface:'home',visible:true,entries:[{instance:'probe',viewRef:'send-probe/overview',ref:'send-probe/home',rect:{x:24,y:72,width:572,height:300}}],${theme}});api.onWebPresentationReady(()=>syncHome());syncHome();`);
  await until(async () => documentFor('page.html') && (await host('syncHome().then(value=>value.mounted.includes("probe"))')), 10000, 250);
  // page.js starts a 1.5 s action before load; the page is shown while it runs.
  check('a pending slow send does not delay presentation', (await author('page.html', 'window.slowDone')) === null);
  await until(() => author('page.html', "window.slowDone === 'slow-done'"), 6000);
  check('the slow send resolves with its value after the handler finishes', true);
  check('the visible Worker runs in visible mode', worker().mode === 'visible');
  fs.writeFileSync(path.join(scratch, 'home-before.png'), (await documentFor('page.html').capturePage()).toPNG());
  await author('page.html', "document.getElementById('go').click(); true");
  await until(() => author('page.html', "document.getElementById('state').textContent.endsWith('results')"));
  check('search resolves with the handler return value', (await author('page.html', "document.getElementById('state').textContent")) === '2 results');
  await until(() => author('page.html', "document.getElementById('list').children.length === 2"));
  check('results arrive through the @results metric', (await author('page.html', "[...document.querySelectorAll('li')].map(li => li.textContent).join(',')")) === 'opus,sonnet');
  fs.writeFileSync(path.join(scratch, 'home-after.png'), (await documentFor('page.html').capturePage()).toPNG());
  const failure = await author('page.html', "tm.send('boom').then(() => 'resolved', error => error.message)");
  check('a throwing handler rejects with an author-facing message', /handler failed/.test(failure));
  const emptyFailure = await author('page.html', "tm.send('throwNothing').then(() => 'resolved', error => error.message)");
  check('throwing undefined also rejects instead of losing completion', /handler failed/.test(emptyFailure));
  for (const action of ['deep', 'many', 'date']) {
    const rejected = await author('page.html', `tm.send('${action}').then(() => 'resolved', error => error.message)`);
    check(`${action} return rejects within the real Worker wire limits`, /not plain JSON/.test(rejected));
  }
  const missing = await author('page.html', "tm.send('nope').then(() => 'resolved', error => error.message)");
  check('an unregistered action rejects by name', /no tm.onAction handler for "nope"/.test(missing));
  const invalid = await author('page.html', "tm.send('bad-name').then(() => 'resolved', error => error.message)");
  check('an invalid action name is rejected before the Worker', /camelCase/.test(invalid));

  // 3. Disabling settles pending sends and runs no further code.
  await author('page.html', "window.pendingSlow = tm.send('slow').catch(error => error.message); true");
  runtime.manager.setEnabled('send-probe', false);
  await until(async () => !documentFor('page.html') && worker().runtime === 'stopped');
  check('disable revokes the document and stops the Worker mid-action', !documentFor('page.html') && worker().runtime === 'stopped' && worker().mode === null);
}

function finish(error) {
  if (error) {
    console.error(error);
    console.error(JSON.stringify(runtime?.manager?.diagnostics?.().plugins));
  }
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify({ checks, error: error ? String(error) : null, scratch }, null, 2));
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, total: checks.length, scratch }));
  runtime?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish()).catch(finish);
