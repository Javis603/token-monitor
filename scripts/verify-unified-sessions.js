'use strict';
// Electron-only UI regression. Real index.html, preload, session renderer and
// settings; every account/session value is a fixture. No cloud connection.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.TM_SESSIONS_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw new Error('Set TM_SESSIONS_VERIFY_DIR to a private absolute output directory');
const root = path.resolve(__dirname, '..');
const ids = Array.from({ length: 4 }, (_, n) => `00000000-0000-7000-8000-${String(n + 1).padStart(12, '0')}`);
const now = Date.now(), iso = (minutes) => new Date(now - minutes * 60000).toISOString();
const settings = { language: 'zh-CN', locale: 'zh-CN', theme: 'dark', blurEnabled: false,
  historyEnabled: true, refreshMs: 60000, hubMode: 'local', clients: 'claude,codex',
  showToolIcons: true, compactTokenUnits: 'western', currency: 'USD', reduceMotion: 'always',
  sessionTitlesEnabled: true, sessionUsageArchiveEnabled: true, showLiveTokenRate: false };
const local = {
  [`claude:${ids[0]}`]: { client: 'claude', sessionId: ids[0], title: '剪辑工作流测试', totalTokens: 24500, inputTokens: 20000, outputTokens: 500, cacheReadTokens: 4000, costUsd: 0.12, models: { 'claude-model': 24500 }, messageCount: 4, lastUsedAt: iso(2), startedAt: iso(15) },
  [`codex:${ids[1]}`]: { client: 'codex', sessionId: ids[1], title: '修复会话筛选', totalTokens: 18300, inputTokens: 11000, outputTokens: 300, cacheReadTokens: 7000, costUsd: 0.08, unpricedTokens: 300, usageSource: 'codex-dots-local', usageCoverage: 'observed-only', models: { 'codex-model': 18300 }, messageCount: 3, lastUsedAt: iso(7), startedAt: iso(20) }
};
const period = { totalTokens: 58800, costUsd: 0.2, models: { 'claude-model': 24500, 'codex-model': 18300 }, clients: { claude: 24500, codex: 34300 }, sessions: local };
const cloudAccounting = { version: 1, state: 'active', reason: null, observedAt: iso(0), reportAt: iso(0), updatedAt: iso(0),
  periods: { today: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, threadCount: 0 },
    month: { totalTokens: 0, inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0, threadCount: 0 },
    allTime: { totalTokens: 16000, inputTokens: 15400, cachedInputTokens: 12000, outputTokens: 600, reasoningOutputTokens: 120, threadCount: 1, partialComponents: false } },
  baselineTokens: 16000, observedTokens: 0, excludedThreads: 1, excludedReasons: { matchedLocal: 0, parentOverlap: 1 }, partialThreads: 0, bridgedThreads: 0, partialComponents: false, unknownCost: true,
  threads: { [ids[2]]: { threadId: ids[2], status: 'included', partial: false, bridged: false, includedTokens: 16000, baselineTokens: 16000, observedTokens: 0, resetCount: 0, overflowCount: 0, lastObservedAt: iso(0) },
    [ids[3]]: { threadId: ids[3], status: 'parent-overlap', partial: false, bridged: false, includedTokens: 0, baselineTokens: 0, observedTokens: 0, resetCount: 0, overflowCount: 0, lastObservedAt: null } } };
const stats = { snapshot: { id: 'ui-fixture', source: 'ui-fixture' }, periods: { today: { ...period, totalTokens: 42800, clients: { claude: 24500, codex: 18300 } }, month: { ...period, totalTokens: 42800, clients: { claude: 24500, codex: 18300 } }, allTime: period }, cloudAccounting, devices: [], updatedAt: iso(0), nativeSessions: {}, historyEnabled: true };
const cloud = { version: 1, state: 'listening', errorCode: null, service: { installed: true, running: true, canControl: true }, stale: false, observedAt: iso(0), threads: [
  { threadId: ids[1], kind: 'aeon_child', runtimeStatus: 'active', status: 'observed', total: { inputTokens: 99000, outputTokens: 1000, totalTokens: 100000 }, observedAt: iso(0), createdAt: iso(20), lastActivityAt: iso(7), gapCount: 0 },
  { threadId: ids[2], kind: 'aeon_child', engineParentId: null, delegationParentId: ids[3], runtimeStatus: 'active', listening: true, status: 'observed', total: { inputTokens: 15400, cachedInputTokens: 12000, outputTokens: 600, reasoningOutputTokens: 120, totalTokens: 16000 }, observedAt: iso(0), createdAt: iso(3), lastActivityAt: iso(1), gapCount: 0 },
  { threadId: ids[3], kind: 'subagent', engineParentId: ids[2], delegationParentId: null, runtimeStatus: 'idle', listening: false, status: 'no-usage-notification', total: null, observedAt: null, createdAt: iso(5), lastActivityAt: iso(4), gapCount: 1 }
] };
const audit = { localDetailReads: 0, controls: [], cloudReads: 0 };
let failCloudRead = false;
// While held, every cloud read resolves only when the harness releases it, so
// a pre-control or pre-login-change result can be replayed after the boundary.
let heldReads = null;
function holdCloudReads() { heldReads = []; }
function releaseFirstHeldRead(value) { const resolve = heldReads.splice(0, 1)[0]; resolve(value); return heldReads.length; }
function releaseHeldReads(value) { const pending = heldReads || []; heldReads = null; for (const resolve of pending) resolve(value); return pending.length; }
let win, done = false;
const errors = [];
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(output, 'electron-profile'));
const deadline = setTimeout(() => finish(new Error('UI verification timeout')), 45000);
function finish(error) {
  if (done) return; done = true; clearTimeout(deadline);
  if (error) console.error('UNIFIED_SESSIONS_FAILED', error.stack || String(error), JSON.stringify(errors));
  app.exit(error ? 1 : 0);
}
async function evaluate(expression) { return win.webContents.executeJavaScript(expression, true); }
async function waitFor(expression) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (await evaluate(expression)) return; await new Promise(r => setTimeout(r, 100)); }
  throw new Error('Condition not reached: ' + expression);
}
async function waitUntil(check, label) {
  const deadline = Date.now() + 12000;
  while (Date.now() < deadline) { if (check()) return; await new Promise(r => setTimeout(r, 50)); }
  throw new Error('Condition not reached: ' + label);
}
async function capture(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG(), { mode: 0o600 });
}
app.whenReady().then(async () => {
  // Use the actual preload. Provide inert defaults only for unrelated app APIs.
  const responses = {
    'settings:get': () => settings, 'settings:update': (p) => Object.assign(settings, p),
    'stats:get': () => stats, 'stats:allTimeSessions': () => local,
    'app:getInfo': () => ({ version: '0.66.0-cloud.2', platform: 'darwin', systemDarkUi: true, loginItemSupported: false }),
    'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
    'appUpdate:getState': () => ({ status: 'idle', supported: false, currentVersion: '0.66.0-cloud.2' }),
    'hub:getInfo': () => ({ mode: 'local' }), 'tokscale:getStatus': () => ({ installed: true, version: 'fixture' }),
    'stream:status': () => ({ connected: true, mode: 'local' }), 'dashboard:getHistory': () => ({ daily: [], monthly: [] }),
    'session:getDetail': () => { audit.localDetailReads++; return { found: false }; },
    'cloudUsage:get': () => { audit.cloudReads++; if (failCloudRead) throw new Error('fixture read failure');
      if (heldReads) return new Promise((resolve) => { heldReads.push(resolve); });
      return cloud; },
    'cloudUsage:control': (action) => { audit.controls.push(action); cloud.service.running = action === 'start'; return { ok: true, snapshot: cloud }; }
  };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 530, height: 820, useContentSize: true, show: false, backgroundColor: '#282b2d', webPreferences: { contextIsolation: true, nodeIntegration: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (event, details) => { const entry = details || event; if (entry.level === 'error') errors.push(String(entry.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'), { query: { period: 'allTime', breakdown: 'session', suppressInitialNumberAnimation: '1' } });
  win.show();
  await waitFor('document.querySelectorAll("#breakdown .row").length === 4');
  const state = await evaluate(`({ rows:document.querySelectorAll('#breakdown .row').length, cloudRows:document.querySelectorAll('#breakdown [data-cloud-only="true"]').length, total:document.getElementById('totalTokens').textContent, separateCloudButton:!!document.getElementById('cloudUsageButton'), activeSession:document.querySelector('.shell').classList.contains('session-mode') })`);
  assert.equal(state.cloudRows, 2); assert.equal(state.total, '58,800'); assert.equal(state.separateCloudButton, false); assert.equal(state.activeSession, true);
  await waitFor(`document.querySelector('[data-cloud-thread-id="${ids[1]}"] .row-value')?.textContent === '18,300'`);
  const dots = await evaluate(`(() => { const row = document.querySelector('[data-cloud-thread-id="${ids[1]}"]'); return { count: document.querySelectorAll('[data-cloud-thread-id="${ids[1]}"]').length, cloudOnly: row?.dataset.cloudOnly, value: row?.querySelector('.row-value').textContent, cost: row?.querySelector('.row-cost').textContent, costTitle: row?.querySelector('.row-cost').title }; })()`);
  assert.equal(dots.count, 1); assert.equal(dots.cloudOnly, 'false'); assert.equal(dots.value, '18,300');
  assert.match(dots.cost, /\+ \?/); assert.doesNotMatch(dots.costTitle, /云端|cloud/i);
  assert.equal(await evaluate(`document.querySelector('[data-cloud-only="true"] .row-cost').title`), '累计 · 云端');
  await waitFor(`document.querySelector('[data-cloud-only="true"] .row-value')?.textContent === '16,000'`);
  await new Promise(resolve => setTimeout(resolve, 700));
  await capture('unified-sessions.png');
  await evaluate(`document.querySelector('#breakdown [data-cloud-only="true"]').click()`);
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail') !== null`);
  assert.equal(audit.localDetailReads, 0);
  await capture('unified-session-detail.png');
  await evaluate(`document.querySelector('#session-detail-head .detail-back').click(); document.querySelector('#breakdown [data-client="claude"]').click()`);
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail') === null`);
  assert.equal(audit.localDetailReads, 1);
  await evaluate(`document.querySelector('#session-detail-head .detail-back').click()`);
  cloud.threads[1].total.inputTokens = 16400; cloud.threads[1].total.totalTokens = 17000;
  await waitFor(`document.querySelector('[data-cloud-only="true"] .row-value')?.textContent === '17,000'`);
  assert.equal(await evaluate(`document.getElementById('totalTokens').textContent`), '58,800');
  // Main-process republish: when the ledger changes, republishPresentationStats
  // pushes projected stats with no new local usage and no Sessions/Settings
  // interaction. The Home header and its cloud note must move on that push alone.
  const pushed = JSON.parse(JSON.stringify(stats));
  pushed.periods.allTime = { ...pushed.periods.allTime, totalTokens: 60800, clients: { ...pushed.periods.allTime.clients, codex: 36300 } };
  pushed.cloudAccounting = { ...pushed.cloudAccounting, observedTokens: 2000,
    periods: { ...pushed.cloudAccounting.periods, allTime: { ...pushed.cloudAccounting.periods.allTime, totalTokens: 18000, observedTokens: 2000 } },
    threads: { ...pushed.cloudAccounting.threads, [ids[2]]: { ...pushed.cloudAccounting.threads[ids[2]], includedTokens: 18000, observedTokens: 2000 } } };
  win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'presentation', mode: 'local', stats: pushed } });
  await waitFor(`document.getElementById('totalTokens').textContent === '60,800'`);
  assert.match(await evaluate(`document.getElementById('cloudAccountingNote').textContent`), /含云端\s*18,000/);
  cloud.threads[2].lastActivityAt = new Date(now - 10 * 86400000).toISOString();
  cloud.threads[1].lastActivityAt = new Date().toISOString();
  await evaluate(`document.querySelector('.tab[data-period="today"]').click()`);
  await waitFor(`document.querySelectorAll('#breakdown .row').length === 3`);
  await evaluate(`document.getElementById('settingsButton').click(); document.querySelector('[data-settings-section="general"]').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  await evaluate(`document.getElementById('cloudSessionsEnabled').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  await evaluate(`document.getElementById('cloudSessionsEnabled').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  assert.deepEqual(audit.controls, ['stop', 'start']);

  // Login switch: the previous account's cloud rows and open cloud detail must
  // leave synchronously, before the held replacement read is released. Every
  // id, counter and account below is a synthetic fixture, never a real login.
  await evaluate(`document.getElementById('settingsButton').click()`);
  await waitFor(`document.getElementById('settingsPanel').classList.contains('hidden')`);
  await evaluate(`document.querySelector('#breakdown [data-cloud-only="true"]').click()`);
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail') !== null`);
  holdCloudReads();
  win.webContents.send('codex:activeAccount', { id: 'fixture-account-b', accountKey: 'fixture-account-b', email: 'fixture-b@example.invalid', accountLabel: 'Fixture B', enabled: true });
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail')?.textContent.includes(window.TokenMonitorCloudSessionRows.labels('zh-CN').notFound)`);
  await evaluate(`document.querySelector('#session-detail-head .detail-back').click()`);
  await waitFor(`document.querySelectorAll('#breakdown [data-cloud-only="true"]').length === 0`);
  await capture('account-switch-cleared.png');
  assert.ok(releaseHeldReads(cloud) >= 1, 'the login switch did not request a fresh read');
  await waitFor(`document.querySelectorAll('#breakdown [data-cloud-only="true"]').length === 1`);

  // Monitoring control: hold the pre-control periodic read, stop the listener,
  // wait until the post-control fresh read has been requested, replay the held
  // stale result, and prove it can neither repaint rows nor be reused.
  await evaluate(`document.getElementById('settingsButton').click(); document.querySelector('[data-settings-section="general"]').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  holdCloudReads();
  await waitUntil(() => heldReads.length >= 1, 'held periodic read');
  const readsBeforeControl = audit.cloudReads;
  const staleCloud = JSON.parse(JSON.stringify(cloud));
  staleCloud.observedAt = new Date(now - 3600000).toISOString();
  staleCloud.threads[1].total.totalTokens = 111111;
  await evaluate(`document.getElementById('cloudSessionsEnabled').click()`);
  await waitUntil(() => heldReads.length >= 2, 'post-control fresh read');
  releaseFirstHeldRead(staleCloud);
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  const heldState = await evaluate(`({ disabled: document.getElementById('cloudSessionsEnabled').disabled, value: document.querySelector('[data-cloud-only="true"] .row-value')?.textContent })`);
  assert.equal(heldState.disabled, true);                    // the fresh read is still pending; the stale one cannot release the toggle
  assert.notEqual(heldState.value, '111,111');               // the held pre-control read must not repaint
  releaseHeldReads(cloud);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  const controlState = await evaluate(`({ checked: document.getElementById('cloudSessionsEnabled').checked, status: document.getElementById('cloudSessionsSettingStatus').textContent, values: [...document.querySelectorAll('[data-cloud-only="true"] .row-value')].map((el) => el.textContent) })`);
  assert.equal(controlState.checked, false);
  assert.equal(controlState.status, await evaluate(`window.TokenMonitorCloudSessionRows.labels('zh-CN').disabled`));
  assert.ok(!controlState.values.includes('111,111'), 'the held pre-control read repainted rows');
  assert.ok(audit.cloudReads > readsBeforeControl, 'the control did not refresh freshly');

  assert.deepEqual(audit.controls, ['stop', 'start', 'stop']);
  failCloudRead = true;
  await waitFor(`document.getElementById('cloudSessionsSettingStatus').textContent === window.TokenMonitorCloudSessionRows.labels('zh-CN').error`);
  assert.equal(await evaluate(`document.getElementById('cloudSessionsEnabled').disabled`), true);
  assert.deepEqual(errors, []);
  const result = { actualRenderer: true, actualPreload: true, syntheticData: true, rows: state.rows, cloudRows: state.cloudRows, totalUnchanged: 42800, dotsSameThreadSingleRow: true, dotsPeriodValuePreserved: true, dotsUnpricedCostPreserved: true, cloudCostTooltipIsLifetime: true, cloudDetailNoLocalRead: true, localDetailPreserved: true, pollingUpdatesRows: true, periodFilterByActivity: true, settingsControls: audit.controls, cloudReads: audit.cloudReads, noCloudTabOrButton: true, loginSwitchClearedRowsSynchronously: true, controlHeldStaleReadSuppressed: true };
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('UNIFIED_SESSIONS_PASS', JSON.stringify(result)); finish();
}).catch(finish);
