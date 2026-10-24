'use strict';
// Production runtime, manager, brokers and preloads; synthetic captured data.
// No collector, live profile, network fixture or debugging port.
const electron = require('electron');
const { app, BrowserWindow, webContents } = electron;
const fs = require('node:fs'), os = require('node:os'), path = require('node:path'), assert = require('node:assert/strict');
const { createPluginRuntime, registerPluginScheme } = require('../src/electron/plugins/runtime');
const subscriptionDisplay = require('../src/shared/subscriptionDisplay');
const root = path.resolve(__dirname, '..'), scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shared-runtime-'));
app.setPath('userData', path.join(scratch, 'profile')); registerPluginScheme(electron.protocol);
app.on('window-all-closed', () => {});
let win, runtime, preferredChildId, historyReads = 0;
const checks = [];
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function bounded(promise, label, ms = 4000) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(`${label} timed out after ${ms}ms`)), ms);
    })]);
  } finally { clearTimeout(timer); }
}
async function until(fn) {
  const deadline = Date.now() + 10000;
  while (Date.now() < deadline) {
    if (await bounded(Promise.resolve().then(fn), 'condition probe', Math.min(4000, deadline - Date.now()))) return;
    await delay(30);
  }
  throw Error('condition timed out');
}
function check(name, value) { checks.push({ name, ok: Boolean(value) }); console.log(`${value ? 'PASS' : 'FAIL'} ${name}`); assert.ok(value, name); }
const execute = (wc, script) => bounded(wc.executeJavaScript(script), `document ${wc.id}: ${script.slice(0, 100)}`);
const host = script => execute(win.webContents, script);
const child = () => {
  const children = webContents.getAllWebContents().filter(wc => wc.getURL().startsWith('tm-plugin-ui:'));
  return preferredChildId === undefined ? children[0] : children.find(wc => wc.id === preferredChildId);
};
const author = script => child() ? execute(child(), script) : Promise.reject(new Error('child not mounted'));
const activeChild = (owner, wc) => !owner.isDestroyed() && owner.isVisible() && !owner.isMinimized()
  && !wc.isDestroyed() && !wc.debugger.isAttached()
  && owner.contentView.children.some(view => view.webContents === wc && view.getVisible());
const snapshotRevision = summary => Number(/snapshot (\d+)/.exec(summary)?.[1]);

// Open through the real management IPC: pages.js owns the native window,
// pagePreload/page.js own rendering, and the production adapter supplies bounds.
async function largeSessionAcceptance(stats) {
  const sessions = Object.fromEntries(Array.from({ length: 30000 }, (_, index) => [`codex:large-${index}`, {
    client: 'codex', sessionId: `large-${index}`, title: `Large session ${index}`, totalTokens: index + 1,
    costUsd: index / 10000, models: { model: index + 1 }, modelCosts: { model: index / 10000 }
  }]));
  const large = { ...stats, periods: { ...stats.periods, today: { ...stats.periods.today, sessions } } };
  runtime.publishStats(large);
  await author("document.getElementById('resource').value='sessions';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => author("document.getElementById('summary').textContent.includes('30000') || document.getElementById('summary').textContent.includes('budgetExceeded')"));
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(scratch, 'large-sessions-first-child.png'), (await child().capturePage()).toPNG());
  const q = { version: 1, resource: 'sessions', sort: { field: 'totalTokens', direction: 'asc' }, page: { limit: 500 } };
  let result = await author(`tm.data.query(${JSON.stringify(q)})`);
  const retries = [], deadline = Date.now() + 10000;
  while (result.availability === 'rateLimited' && Date.now() < deadline) {
    retries.push(result.retryAfterMs);
    await delay(Math.max(1, Math.min(result.retryAfterMs, deadline - Date.now())));
    result = await author(`tm.data.query(${JSON.stringify(q)})`);
  }
  fs.writeFileSync(path.join(scratch, 'large-sessions-rate-retries.json'), JSON.stringify(retries));
  fs.writeFileSync(path.join(scratch, 'large-sessions-first.json'), JSON.stringify(result, null, 2));
  check('real Rich bridge admits 30000 session records', result.availability === 'available' && result.aggregateCoverage.totalRows === 30000);
  const ids = new Set(); let cursor, expected = 1, pages = 0, row = result;
  do {
    checkPayload(row);
    for (const item of row.rows) {
      assert.equal(item.totalTokens, expected++);
      assert.ok(!ids.has(item.id), 'duplicate session in traversal'); ids.add(item.id);
    }
    pages++; cursor = row.pageInfo.nextCursor;
    await author('tm.settings.get()');
    if (cursor) row = await author(`tm.data.query(${JSON.stringify({ ...q, page: { limit: 500, cursor } })})`);
  } while (cursor);
  check('real Rich traversal returns every session once in stable order', ids.size === 30000 && expected === 30001);
  check('large session pages remain byte bounded', pages > 21);
  const visibleBefore = await author("document.getElementById('rows').textContent");
  await author("document.getElementById('next').click();true;");
  await until(async () => (await author("document.getElementById('rows').textContent")) !== visibleBefore);
  fs.writeFileSync(path.join(scratch, 'large-sessions-next-child.png'), (await child().capturePage()).toPNG());
  fs.writeFileSync(path.join(scratch, 'large-sessions-traversal.json'), JSON.stringify({ rows: ids.size, pages, expectedRows: 30000 }));
  // Valid smallest pages plus unrelated capability traffic must finish within
  // the original snapshot lifetime, without author-side pacing.
  const small = { ...large, periods: { ...large.periods, today: {
    ...large.periods.today, sessions: Object.fromEntries(Object.entries(sessions).slice(0, 2000))
  } } };
  runtime.publishStats(small);
  const tinyQuery = { ...q, page: { limit: 1 } };
  let tiny = await author(`tm.data.query(${JSON.stringify(tinyQuery)})`);
  const tinyDeadline = Date.now() + 10000;
  while (tiny.availability === 'rateLimited' && Date.now() < tinyDeadline) {
    assert.ok(Number.isInteger(tiny.retryAfterMs) && tiny.retryAfterMs > 0);
    await delay(Math.min(tiny.retryAfterMs, tinyDeadline - Date.now()));
    tiny = await author(`tm.data.query(${JSON.stringify(tinyQuery)})`);
  }
  const started = Date.now(), tinyIds = new Set(); let tinyExpected = 1;
  for (;;) {
    checkPayload(tiny);
    assert.equal(tiny.rows.length, 1);
    assert.equal(tiny.rows[0].totalTokens, tinyExpected++);
    assert.ok(!tinyIds.has(tiny.rows[0].id)); tinyIds.add(tiny.rows[0].id);
    await author('tm.settings.get()');
    const next = tiny.pageInfo.nextCursor;
    if (!next) break;
    tiny = await author(`tm.data.query(${JSON.stringify({ ...tinyQuery, page: { limit: 1, cursor: next } })})`);
  }
  check('real Rich limit-1 mixed traffic completes 2000 rows without expiry', tinyIds.size === 2000);
  fs.writeFileSync(path.join(scratch, 'small-page-mixed-traversal.json'), JSON.stringify({ rows: tinyIds.size, elapsedMs: Date.now() - started }));
  function checkPayload(value) {
    assert.equal(value.availability, 'available');
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= 56 * 1024);
  }
}

async function detachedAcceptance(settings) {
  check('detached explicit open starts with no main-menu placement', settings.pluginMainPages.length === 0);
  await host("tokenMonitor.plugins.openPage('business-studio/overview')");
  await until(() => BrowserWindow.getAllWindows().some(candidate => candidate.webContents.getURL().endsWith('/renderer/plugins/page.html')));
  const detached = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.webContents.getURL().endsWith('/renderer/plugins/page.html'));
  assert.ok(detached, 'production detached window exists');
  const run = script => execute(detached.webContents, script);
  const geometry = () => run(`(() => {
    const area = document.getElementById('pageContent'), mount = area.firstElementChild;
    const rect = node => node?.getBoundingClientRect().toJSON();
    return { viewport: [innerWidth, innerHeight], area: rect(area), mount: rect(mount),
      areaClientHeight: area.clientHeight, areaScrollHeight: area.scrollHeight,
      preferredHeight: mount?.style.height, mounted: mount?.classList.contains('pv-web-mounted'),
      accepted: mount && TokenMonitorPluginPresentationWeb.rectangle(mount, document, window),
      text: document.body.innerText };
  })()`);
  await until(() => detached.isVisible());
  await until(() => run("document.getElementById('pageContent').firstElementChild?.style.height==='460px'"));
  await until(async () => Boolean((await geometry()).accepted));
  const firstGeometry = await geometry();
  fs.writeFileSync(path.join(scratch, 'detached-opening.json'), JSON.stringify({ windowSize: detached.getSize(), ...firstGeometry }, null, 2));
  fs.writeFileSync(path.join(scratch, 'detached-opening-host.png'), (await detached.capturePage()).toPNG());
  check('production detached window opens at default 880x640', JSON.stringify(detached.getSize()) === '[880,640]');
  check('default detached preferred height fits available page area', Boolean(firstGeometry.accepted));
  await until(() => child()?.getURL().startsWith('tm-plugin-ui:'));
  await until(() => author("document.getElementById('rows')?.children.length>0").catch(() => false));
  await until(() => run("document.querySelector('#pageContent > .pv-web-mounted') !== null"));
  const first = child();
  check('production detached preload mounts Business Studio without menu placement', (await author('tm.context()')).surface === 'page');
  check('production detached body queries all 601 real runtime models', (await author("tm.data.query({version:1,resource:'models',page:{limit:1}})")).aggregateCoverage.totalRows === 601);
  const sizes = [[880, 640], [380, 360], [1100, 820], [880, 640]];
  const samples = [];
  for (const [width, height] of sizes) {
    detached.setSize(width, height);
    await until(() => run("document.querySelector('#pageContent > .pv-web-mounted') !== null"));
    await delay(250);
    await until(async () => (await geometry()).mounted);
    const current = await geometry();
    const scroll = await author(`(() => {
      const node = document.scrollingElement; node.scrollTop = node.scrollHeight;
      return { viewport: [innerWidth, innerHeight], height: node.scrollHeight, scrollTop: node.scrollTop };
    })()`);
    check(`detached ${width}x${height} keeps Rich inside the available viewport`, Boolean(current.accepted) && current.mount.height <= 460 && current.areaScrollHeight <= current.areaClientHeight + 1);
    check(`detached ${width}x${height} scrolls inside the authored document`, scroll.height <= scroll.viewport[1] || scroll.scrollTop > 0);
    check(`detached ${width}x${height} retains the same child`, child() === first);
    const nativeView = detached.contentView.children.find(view => view.webContents === first);
    check(`detached ${width}x${height} native child is visible at the admitted bounds`, nativeView?.getVisible() && nativeView.getBounds().height <= current.mount.height + 1);
    samples.push({ windowSize: [width, height], ...current, child: scroll, native: { visible: nativeView.getVisible(), bounds: nativeView.getBounds() } });
    await author('document.scrollingElement.scrollTop=0');
    await delay(60);
    fs.writeFileSync(path.join(scratch, `detached-${width}x${height}-host.png`), (await detached.capturePage()).toPNG());
    fs.writeFileSync(path.join(scratch, `detached-${width}x${height}-child.png`), (await first.capturePage()).toPNG());
  }
  fs.writeFileSync(path.join(scratch, 'detached-viewports.json'), JSON.stringify(samples, null, 2));
  detached.hide(); await delay(200);
  check('hidden detached document is retained under native lifecycle control', !first.isDestroyed() && first.debugger.isAttached() && detached.contentView.children.every(view => !view.getVisible()));
  await host("tokenMonitor.plugins.openPage('business-studio/overview')");
  await until(() => run("document.querySelector('#pageContent > .pv-web-mounted') !== null"));
  check('explicit reopen reuses the detached child', child() === first);
  detached.close(); await until(() => first.isDestroyed());
  check('closing production detached owner destroys its child', first.isDestroyed());
}

async function detachedFallbackAcceptance(userDataDir) {
  // A package that becomes unreadable after discovery reproduces mount failure
  // without mocking runtime authority, the production renderer or its adapter.
  const dir = path.join(userDataDir, 'plugins/fallback-probe');
  fs.mkdirSync(dir);
  const manifest = { id: 'fallback-probe', name: 'Fallback scroll probe', version: '1.0.0', tmApi: 1, permissions: ['ui.web'],
    views: [{ id: 'page', title: 'Tall lightweight page', surfaces: ['page'], layout: { type: 'stack', dir: 'col', gap: 16,
      children: Array.from({ length: 24 }, (_, i) => ({ type: 'text', text: `Fallback row ${i + 1}: content must remain reachable if the authored document cannot initialize.` })) } }],
    webUi: { version: 1, assets: ['index.html'], documents: [{ id: 'page-rich', view: 'page', target: 'page', slot: 'replace', entry: 'index.html', height: 460 }] } };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><p>Not loaded</p>');
  runtime.manager.reload(); runtime.manager.setEnabled('fallback-probe', true);
  fs.unlinkSync(path.join(dir, 'index.html'));
  await host("tokenMonitor.plugins.openPage('fallback-probe/page')");
  await until(() => BrowserWindow.getAllWindows().some(candidate => candidate.webContents.getURL().endsWith('/renderer/plugins/page.html')));
  const detached = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.webContents.getURL().endsWith('/renderer/plugins/page.html'));
  const run = script => execute(detached.webContents, script);
  await until(() => run("document.querySelector('.page-rich-viewport')?.innerText.includes('Fallback row 24')"));
  await delay(700);
  const state = await run(`(() => {
    const mount = document.querySelector('.page-rich-viewport');
    mount.scrollTop = mount.scrollHeight;
    const last = [...mount.querySelectorAll('*')].find(node => !node.childElementCount && node.textContent.startsWith('Fallback row 24:'));
    return { overflow: getComputedStyle(mount).overflowY, scrollTop: mount.scrollTop,
      clientHeight: mount.clientHeight, scrollHeight: mount.scrollHeight,
      mounted: mount.classList.contains('pv-web-mounted'), text: mount.innerText,
      bounds: mount.getBoundingClientRect().toJSON(), last: last?.getBoundingClientRect().toJSON() };
  })()`);
  check('failed Rich initialization preserves scrollable tall lightweight fallback', !state.mounted && state.overflow === 'auto' && state.scrollTop > 0 && state.scrollHeight > state.clientHeight);
  check('failed Rich fallback last row remains reachable', state.text.includes('Fallback row 24') && state.last?.bottom <= state.bounds.bottom + 1);
  check('failed Rich package never mounts a native child', !child());
  fs.writeFileSync(path.join(scratch, 'detached-fallback.json'), JSON.stringify(state, null, 2));
  fs.writeFileSync(path.join(scratch, 'detached-fallback-host.png'), (await detached.capturePage()).toPNG());
  detached.close(); runtime.manager.setEnabled('fallback-probe', false);
}

async function main() {
  const userDataDir = path.join(scratch, 'profile');
  fs.mkdirSync(path.join(userDataDir, 'plugins'), { recursive: true });
  fs.cpSync(path.join(root, 'docs/plugins/examples/business-studio'), path.join(userDataDir, 'plugins/business-studio'), { recursive: true });
  // Add a read grant for a loader-backed lifecycle probe; never a real scan.
  const file = path.join(userDataDir, 'plugins/business-studio/manifest.json');
  const manifest = JSON.parse(fs.readFileSync(file)); manifest.permissions.push('tm.data.history'); fs.writeFileSync(file, JSON.stringify(manifest));
  let settings = { pluginsEnabled: true, pluginStates: {}, homeModuleOrder: 'plugin:business-studio/overview', pluginMainPages: [] };
  const html = path.join(scratch, 'host.html');
  fs.writeFileSync(html, `<!doctype html><meta charset="utf-8"><style>body{margin:0;background:#17191c;color:#eee;font:14px system-ui}header{height:48px;padding:12px;box-sizing:border-box}main{margin:12px;padding:12px;border:1px solid #454950;border-radius:12px;height:460px}p{color:#aaa}</style><header>Token Monitor · production runtime / synthetic data</header><main id="card"><h2>Usage explorer</h2><p>Lightweight view · shared host data</p><p>601 models · 180,901 tokens</p><p>Lightweight summary, without the authored browser controls.</p></main>`);
  win = new BrowserWindow({ width: 620, height: 640, show: false, webPreferences: { preload: path.join(root, 'src/electron/preload.js'), sandbox: true, contextIsolation: true } });
  const subscriptionFixture = subscriptionDisplay.normalizeSubscriptions([
    { id: 'plan', provider: 'codex', kind: 'subscription', planName: 'Monthly plan', amountMinor: 2000, currency: 'USD', interval: 'month', startDate: '2026-10-01', autoRenew: true },
    { id: 'credits', provider: 'openrouter', kind: 'topup', planName: 'API credit ledger', currency: 'HKD', binding: { accountKey: 'fixture-account' }, topUps: [{ id: 't1', date: '2026-10-01', amountMinor: 10000 }] }
  ]);
  const runtimeOptions = { electron, userDataDir, getSettings: () => settings,
    applySettingsPatch: patch => { settings = { ...settings, ...patch }; runtime.settingsChanged(); },
    persistPluginStates: pluginStates => { settings = { ...settings, pluginStates }; },
    persistManagementSettings: patch => { settings = { ...settings, ...patch }; },
    getLocale: () => 'en', getContext: () => ({}), isMainSender: event => event.sender === win.webContents,
    businessAdapters: { sourceId: () => 'fixture', extras: () => ({ subscriptions: subscriptionFixture, subscriptionContext: { date: '2026-10-23', rates: { USD: 1, HKD: 8 } } }), loadHistory: async () => { historyReads++; return { daily: [] }; } }, env: {} };
  runtime = createPluginRuntime(runtimeOptions);
  runtime.start(); runtime.manager.setEnabled('business-studio', true);
  const models = Object.fromEntries(Array.from({ length: 601 }, (_, i) => [`Model ${i}`, i + 1]));
  let stats = { collectedAt: Date.now(), periods: { today: { totalTokens: 180901, cost: 2, models, costs: {}, clients: { codex: 180901 }, clientModels: { codex: models } } }, devices: [] };
  stats.periods.today.sessions = {
    root: { client: 'codex', sessionId: 'root', title: 'Main task', totalTokens: 100, costUsd: 0.1 },
    child: { client: 'codex', sessionId: 'child', parentSessionId: 'root', title: 'Delegated task', sessionKind: 'subagent', totalTokens: 50, costUsd: 0.05 }
  };
  stats.limits = { providers: [{ provider: 'openrouter', accountKey: 'fixture-account', status: 'ok', updatedAt: '2026-10-23T00:00:00Z', windows: [{ metric: 'credits', remaining: 40, currency: 'HKD' }] }] };
  runtime.publishStats(stats);
  await win.loadFile(html); win.showInactive();
  await detachedAcceptance(settings);
  await detachedFallbackAcceptance(userDataDir);
  fs.writeFileSync(path.join(scratch, 'before.png'), (await win.capturePage()).toPNG());
  await host("window.api=tokenMonitor.plugins;api.setDemand('home',['business-studio/overview']);window.sync=()=>api.syncWebPresentation({surface:'home',visible:true,entries:[{instance:'proof',viewRef:'business-studio/overview',ref:'business-studio/home',rect:{x:24,y:72,width:572,height:460}}],theme:{colors:{background:'#17191c',text:'#eeeeee',muted:'#aaaaaa',accent:'#8aafff'},dark:true,font:'system-ui'}});api.onWebPresentationReady(()=>sync());sync();");
  await until(() => child()?.getURL().startsWith('tm-plugin-ui:'));
  await until(() => author("document.getElementById('rows')?.children.length>0").catch(() => false));
  await until(() => host('sync().then(value=>value.mounted.includes("proof"))'));
  check('real runtime admits Home Rich without original-page dependency', await author("typeof tm.data.query==='function' && typeof tokenMonitor==='undefined' && typeof require==='undefined'"));
  check('no unrequested history adapter work', historyReads === 0);
  const first = child(); preferredChildId = first.id;
  const query = { version: 1, resource: 'models', page: { limit: 500 } };
  const firstPage = await author(`tm.data.query(${JSON.stringify(query)})`);
  let count = firstPage.rows.length, cursor = firstPage.pageInfo.nextCursor;
  while (cursor) { const next = await author(`tm.data.query(${JSON.stringify({ ...query, page: { limit: 500, cursor } })})`); count += next.rows.length; cursor = next.pageInfo.nextCursor; }
  check('byte-bounded pagination traverses all 601 host rows', count === 601);
  // Keep the two real owners exposed: centered overlapping macOS windows can
  // emit native hide/occlusion events and legitimately freeze the Home child.
  const area = electron.screen.getPrimaryDisplay().workArea;
  assert.ok(area.width >= 1020 && area.height >= 640, 'dual-owner fixture needs a 1020x640 work area');
  win.setPosition(area.x, area.y);
  await host("tokenMonitor.plugins.openPage('business-studio/overview')");
  await until(() => BrowserWindow.getAllWindows().some(candidate => candidate !== win && candidate.webContents.getURL().endsWith('/renderer/plugins/page.html')));
  const siblingWindow = BrowserWindow.getAllWindows().find(candidate => candidate !== win && candidate.webContents.getURL().endsWith('/renderer/plugins/page.html'));
  siblingWindow.setBounds({ x: area.x + 640, y: area.y, width: Math.min(620, area.width - 640), height: 640 });
  await until(() => webContents.getAllWebContents().some(wc => wc !== first && wc.getURL().startsWith('tm-plugin-ui:')));
  const sibling = webContents.getAllWebContents().find(wc => wc !== first && wc.getURL().startsWith('tm-plugin-ui:'));
  const siblingRun = script => execute(sibling, script);
  await until(() => siblingRun("document.getElementById('rows')?.children.length>0"));
  await siblingRun("document.getElementById('resource').value='models';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => siblingRun("document.getElementById('rows').children.length>1"));
  await host("api.setDemand('home',['business-studio/overview'])");
  await until(() => host('sync().then(value=>value.mounted.includes("proof"))'));
  await until(() => activeChild(win, first) && activeChild(siblingWindow, sibling));
  await author("document.getElementById('resource').value='models';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => author("document.getElementById('rows').children.length>1 && !document.getElementById('next').disabled"));
  const firstLabel = await author("document.getElementById('rows').firstElementChild.textContent");
  await author("document.getElementById('next').click()");
  await until(async () => (await author("document.getElementById('rows').firstElementChild.textContent")) !== firstLabel);
  const secondPage = await author("document.getElementById('rows').textContent");
  const browsingRevision = snapshotRevision(await author("document.getElementById('summary').textContent"));
  assert.ok(Number.isFinite(browsingRevision), 'Home page two has a snapshot revision');
  const siblingPageOne = await siblingRun("document.getElementById('rows').textContent");
  const siblingUpdates = [];
  for (let update = 0; update < 12; update++) {
    assert.ok(activeChild(win, first) && activeChild(siblingWindow, sibling), 'both native documents remain active before publish');
    const previousRevision = snapshotRevision(await siblingRun("document.getElementById('summary').textContent"));
    stats = JSON.parse(JSON.stringify({ ...stats, updatedAt: new Date().toISOString() }));
    runtime.publishStats(stats);
    await until(async () => {
      const summary = await siblingRun("document.getElementById('summary').textContent");
      return snapshotRevision(summary) > previousRevision && summary.includes('authorized rows');
    });
    const siblingRevision = snapshotRevision(await siblingRun("document.getElementById('summary').textContent"));
    assert.equal(await siblingRun("document.getElementById('rows').textContent"), siblingPageOne, 'live sibling remains on page one');
    assert.equal(await author("document.getElementById('rows').textContent"), secondPage, 'Home retains page two during sibling refresh');
    assert.equal(snapshotRevision(await author("document.getElementById('summary').textContent")), browsingRevision, 'Home retains its admitted snapshot');
    assert.ok(activeChild(win, first) && activeChild(siblingWindow, sibling), 'both native documents remain active after refresh');
    siblingUpdates.push({ publish: update + 1, homeRevision: browsingRevision, siblingRevision, homeChild: first.id, siblingChild: sibling.id });
  }
  fs.writeFileSync(path.join(scratch, 'sibling-updates.json'), JSON.stringify(siblingUpdates, null, 2));
  check('two real Rich owners coexist during twelve live sibling refreshes', siblingUpdates.length === 12 && child() === first);
  check('live sibling updates preserve the browsing Home rows', await author("document.getElementById('rows').textContent") === secondPage);
  stats = JSON.parse(JSON.stringify({ ...stats, updatedAt: new Date().toISOString() }));
  runtime.publishStats(stats);
  await until(() => author("document.getElementById('summary').textContent.includes('New data available')"));
  check('ordinary cloned stats push does not jump the authored browser back to page one', await author("document.getElementById('rows').textContent") === secondPage);
  check('existing traversal stays available after an ordinary update', await author("!document.getElementById('next').disabled"));
  fs.writeFileSync(path.join(scratch, 'paging-update-child.png'), (await child().capturePage()).toPNG());
  await author("document.getElementById('next').click()");
  await until(async () => (await author("document.getElementById('rows').textContent")) !== secondPage);
  check('next page still belongs to the admitted snapshot after a cloned push', await author("document.getElementById('rows').firstElementChild.textContent") !== firstLabel);
  check('Home cursor advances within its original snapshot after twelve sibling refreshes', snapshotRevision(await author("document.getElementById('summary').textContent")) === browsingRevision && activeChild(win, first) && activeChild(siblingWindow, sibling));
  siblingWindow.close(); await until(() => sibling.isDestroyed());
  await author("document.getElementById('refresh').click()");
  await until(() => author("!document.getElementById('summary').textContent.includes('New data available')"));
  check('explicit refresh starts the current snapshot at page one', await author("document.getElementById('rows').firstElementChild.textContent") === firstLabel);

  await author("document.getElementById('resource').value='subscriptions';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => author("document.getElementById('rows').textContent.includes('Next renewal: 2026-11-01')"));
  const subscriptionRows = await author("tm.data.query({version:1,resource:'subscriptions'})");
  const recurring = subscriptionRows.rows.find(row => row.kind === 'subscription');
  const credits = subscriptionRows.rows.find(row => row.kind === 'topup');
  check('real Rich bridge delivers host recurring derivations', recurring.derived.paidToDateMinor === 2000 && recurring.derived.monthlyAmountUsd === 20);
  check('real Rich bridge delivers authorized top-up forecast', credits.derived.forecast.status === 'available' && credits.derived.forecast.balanceAmount === 40);
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(scratch, 'derivations-subscriptions-child.png'), (await child().capturePage()).toPNG());
  await author('document.scrollingElement.scrollTop=document.scrollingElement.scrollHeight');
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(scratch, 'derivations-subscriptions-detail-child.png'), (await child().capturePage()).toPNG());
  await author('document.scrollingElement.scrollTop=0');
  await author("document.getElementById('resource').value='sessions';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => author("document.getElementById('rows').textContent.includes('Parent: Main task')"));
  const sessionRows = (await author("tm.data.query({version:1,resource:'sessions'})")).rows;
  check('real Rich bridge links child to the same opaque parent identity', sessionRows.find(row => row.title === 'Delegated task').parentId === sessionRows.find(row => row.title === 'Main task').id);
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(scratch, 'derivations-sessions-child.png'), (await child().capturePage()).toPNG());
  await author('document.scrollingElement.scrollTop=document.scrollingElement.scrollHeight');
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(scratch, 'derivations-sessions-detail-child.png'), (await child().capturePage()).toPNG());
  await author('document.scrollingElement.scrollTop=0');
  check('ungranted data is denied independent of surface', (await author("tm.data.query({version:1,resource:'projects'})")).availability === 'denied');
  const saved = await host("api.getSettings('business-studio')");
  check('management gets schema while author gets values only', Boolean(saved.schema) && !Object.hasOwn(await author('tm.settings.get()'), 'schema'));
  const next = await author(`tm.settings.update(${JSON.stringify({ schemaVersion: saved.schemaVersion, expectedRevision: saved.revision, patch: { pageSize: 5 } })})`);
  check('author settings commit visible through host management IPC', (await host("api.getSettings('business-studio')")).revision === next.revision);
  check('real Rich IPC preserves conflict code', await author(`tm.settings.update(${JSON.stringify({ schemaVersion: saved.schemaVersion, expectedRevision: saved.revision, patch: { pageSize: 7 } })}).then(()=>false,e=>e.code==='settings-conflict')`));
  check('real host IPC preserves validation fields', await host(`api.updateSettings('business-studio',${JSON.stringify({ schemaVersion: next.schemaVersion, expectedRevision: next.revision, patch: { pageSize: -1 } })}).then(()=>false,e=>Boolean(e.fields.pageSize))`));
  await author("window.events=[];window.off=tm.data.subscribe({version:1,resource:'history'},e=>events.push(e));true;");
  await until(() => historyReads === 1);
  await host("api.setDemand('home',[]);api.syncWebPresentation({surface:'home',visible:false})");
  stats = { ...stats, collectedAt: Date.now() }; runtime.publishStats(stats);
  await delay(200);
  check('hidden owner releases business subscription without further reads', historyReads === 1);
  await host("api.setDemand('home',['business-studio/overview']);sync()");
  await until(() => author('events.length>=2').catch(() => false));
  check('reopening retains document and restores current subscription', child() === first && historyReads === 2);
  await author("off();document.getElementById('resource').value='models';document.getElementById('resource').dispatchEvent(new Event('change'));true;");
  await until(() => author("document.getElementById('rows').children.length===5"));
  await author('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  await delay(120);
  fs.writeFileSync(path.join(scratch, 'after-content.png'), (await child().capturePage()).toPNG());
  fs.writeFileSync(path.join(scratch, 'after.png'), (await win.capturePage()).toPNG());
  await largeSessionAcceptance(stats);
  runtime.manager.setEnabled('business-studio', false);
  await until(() => first.isDestroyed());
  check('disable revokes live Rich document', first.isDestroyed());
  check('disabled plugin settings remain editable without a display', Boolean((await host("api.getSettings('business-studio')")).schema));
  const settingsFile = path.join(userDataDir, 'plugin-settings/business-studio.json');
  const bytesBeforeDispose = fs.readFileSync(settingsFile);
  const beforeDispose = await host("api.getSettings('business-studio')");
  runtime.dispose();
  check('disposed runtime rejects real settings IPC', await host(`api.updateSettings('business-studio',${JSON.stringify({schemaVersion:beforeDispose.schemaVersion,expectedRevision:beforeDispose.revision,patch:{pageSize:7}})}).then(()=>false,()=>true)`));
  check('disposed settings write leaves disk bytes intact', fs.readFileSync(settingsFile).equals(bytesBeforeDispose));
  runtime = createPluginRuntime(runtimeOptions); runtime.start();
  check('replacement runtime registers real IPC without duplicate handlers', (await host("api.getSettings('business-studio')")).revision === beforeDispose.revision);

}
function finish(error) {
  if (error) {
    console.error(error);
    console.error(webContents.getAllWebContents().map(wc => ({ id: wc.id, url: wc.getURL(), debugger: wc.debugger.isAttached() })));
  }
  fs.writeFileSync(path.join(scratch, 'results.json'), JSON.stringify({ checks, error: error ? String(error) : null, scratch, limits: ['Synthetic data; Home host geometry is synthetic, detached uses production page shell', 'Host capturePage omits native child layers; paired child captures and native visibility/bounds are recorded', 'No native hardware/IME/other-platform/package acceptance'] }, null, 2));
  console.log(JSON.stringify({ passed: checks.filter(x => x.ok).length, total: checks.length, scratch }));
  runtime?.dispose(); if (win && !win.isDestroyed()) win.destroy(); app.exit(error ? 1 : 0);
}
app.whenReady().then(main).then(() => finish()).catch(finish);
