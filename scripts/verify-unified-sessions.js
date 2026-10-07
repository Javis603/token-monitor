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
  [`codex:${ids[1]}`]: { client: 'codex', sessionId: ids[1], title: '修复会话筛选', totalTokens: 18300, inputTokens: 11000, outputTokens: 300, cacheReadTokens: 7000, costUsd: 0.08, models: { 'codex-model': 18300 }, messageCount: 3, lastUsedAt: iso(7), startedAt: iso(20) }
};
const period = { totalTokens: 42800, costUsd: 0.2, models: { 'claude-model': 24500, 'codex-model': 18300 }, clients: { claude: 24500, codex: 18300 }, sessions: local };
const stats = { snapshot: { id: 'ui-fixture', source: 'ui-fixture' }, periods: { today: period, month: period, allTime: period }, devices: [], updatedAt: iso(0), nativeSessions: {}, historyEnabled: true };
const cloud = { version: 1, state: 'listening', errorCode: null, service: { installed: true, running: true, canControl: true }, stale: false, observedAt: iso(0), threads: [
  { threadId: ids[2], kind: 'aeon_child', engineParentId: null, delegationParentId: ids[3], runtimeStatus: 'active', listening: true, status: 'observed', total: { inputTokens: 15400, cachedInputTokens: 12000, outputTokens: 600, reasoningOutputTokens: 120, totalTokens: 16000 }, observedAt: iso(0), createdAt: iso(3), lastActivityAt: iso(1), gapCount: 0 },
  { threadId: ids[3], kind: 'subagent', engineParentId: ids[2], delegationParentId: null, runtimeStatus: 'idle', listening: false, status: 'no-usage-notification', total: null, observedAt: null, createdAt: iso(5), lastActivityAt: iso(4), gapCount: 1 }
] };
const audit = { localDetailReads: 0, controls: [], cloudReads: 0 };
let failCloudRead = false;
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
    'cloudUsage:get': () => { audit.cloudReads++; if (failCloudRead) throw new Error('fixture read failure'); return cloud; },
    'cloudUsage:control': (action) => { audit.controls.push(action); cloud.service.running = action === 'start'; return { ok: true, snapshot: cloud }; }
  };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 530, height: 820, useContentSize: true, show: false, backgroundColor: '#282b2d', webPreferences: { contextIsolation: true, nodeIntegration: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.on('console-message', (event) => { if (event.level === 'error') errors.push(String(event.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'), { query: { period: 'allTime', breakdown: 'session', suppressInitialNumberAnimation: '1' } });
  win.show();
  await waitFor('document.querySelectorAll("#breakdown .row").length === 4');
  const state = await evaluate(`({ rows:document.querySelectorAll('#breakdown .row').length, cloudRows:document.querySelectorAll('#breakdown [data-cloud-only="true"]').length, total:document.getElementById('totalTokens').textContent, separateCloudButton:!!document.getElementById('cloudUsageButton'), activeSession:document.querySelector('.shell').classList.contains('session-mode') })`);
  assert.equal(state.cloudRows, 2); assert.equal(state.total, '42,800'); assert.equal(state.separateCloudButton, false); assert.equal(state.activeSession, true);
  await capture('unified-sessions.png');
  await evaluate(`document.querySelector('#breakdown [data-cloud-only="true"]').click()`);
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail') !== null`);
  assert.equal(audit.localDetailReads, 0);
  await capture('unified-session-detail.png');
  await evaluate(`document.querySelector('#session-detail-head .detail-back').click(); document.querySelector('#breakdown [data-client="claude"]').click()`);
  await waitFor(`document.querySelector('#session-detail .cloud-session-detail') === null`);
  assert.equal(audit.localDetailReads, 1);
  await evaluate(`document.querySelector('#session-detail-head .detail-back').click()`);
  cloud.threads[0].total.inputTokens = 16400; cloud.threads[0].total.totalTokens = 17000;
  await waitFor(`document.querySelector('[data-cloud-only="true"] .row-value')?.textContent === '17,000'`);
  assert.equal(await evaluate(`document.getElementById('totalTokens').textContent`), '42,800');
  cloud.threads[1].lastActivityAt = new Date(now - 10 * 86400000).toISOString();
  cloud.threads[0].lastActivityAt = new Date().toISOString();
  await evaluate(`document.querySelector('.tab[data-period="today"]').click()`);
  await waitFor(`document.querySelectorAll('#breakdown .row').length === 3`);
  await evaluate(`document.getElementById('settingsButton').click(); document.querySelector('[data-settings-section="general"]').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  await evaluate(`document.getElementById('cloudSessionsEnabled').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  await evaluate(`document.getElementById('cloudSessionsEnabled').click()`);
  await waitFor(`!document.getElementById('cloudSessionsEnabled').disabled`);
  assert.deepEqual(audit.controls, ['stop', 'start']);
  failCloudRead = true;
  await waitFor(`document.getElementById('cloudSessionsSettingStatus').textContent === window.TokenMonitorCloudSessionRows.labels('zh-CN').error`);
  assert.equal(await evaluate(`document.getElementById('cloudSessionsEnabled').disabled`), true);
  assert.deepEqual(errors, []);
  const result = { actualRenderer: true, actualPreload: true, syntheticData: true, rows: state.rows, cloudRows: state.cloudRows, totalUnchanged: 42800, cloudDetailNoLocalRead: true, localDetailPreserved: true, pollingUpdatesRows: true, periodFilterByActivity: true, settingsControls: audit.controls, cloudReads: audit.cloudReads, noCloudTabOrButton: true };
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('UNIFIED_SESSIONS_PASS', JSON.stringify(result)); finish();
}).catch(finish);
