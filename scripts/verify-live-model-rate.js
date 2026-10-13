'use strict';

// Actual Electron/preload/renderer with synthetic pushes and an isolated profile.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const output = process.env.TM_LIVE_RATE_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw Error('Set TM_LIVE_RATE_VERIFY_DIR to a private absolute directory');
const root = path.resolve(__dirname, '..');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(output, 'profile'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const startedAt = Date.now();
const settings = { language: 'en', locale: 'en-US', theme: 'dark', blurEnabled: false,
  historyEnabled: true, hubMode: 'client', deviceId: 'local', clients: 'codex', refreshMs: 60000,
  reduceMotion: 'on', tokenNumberAnimation: 'roll', modelAliasGrouping: 'none',
  compactTokenUnits: 'western', showCompactTotalTokens: false, showLiveTokenRate: true,
  tokenRateMode: 'speed', liveTokenRateScope: 'all',
  homeModuleOrder: 'model,device,trends,modelspeed', hiddenHomeModules: 'limits,tool,session',
  cloudAccountingNoticeDismissed: true, cloudSessionScopeDismissed: true };
const history = { daily: Array.from({ length: 5 }, (_, i) => {
  const date = new Date(startedAt); date.setDate(date.getDate() - 4 + i);
  return { date: [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'),
    String(date.getDate()).padStart(2, '0')].join('-'), tokens: 1000 + i * 50, cost: 0.1 };
}), monthly: [], summary: { activeDays: 5 } };
const speedHistory = { version: 1, state: 'recording', retentionDays: 90,
  range: { period: 'today', start: startedAt - 3600000, end: startedAt, labelKey: 'home.modelSpeed.range.today' },
  models: [{ id: 'historical-alpha', model: 'alpha', lastTps: 77, outputTpm: 4620,
    status: 'learning', samples: 4, recentSamples: 4, gaps: 0, baselineTps: null,
    trend: [{ at: startedAt - 300000, tps: 77, span: 60000 }, { at: startedAt - 60000, tps: 77, span: 60000 }] }] };
function period(modelThroughput) {
  const result = { timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0,
    totalTokens: 4000, outputTokens: 500, costUsd: 0, models: { 'untimed-fixture': 4000 },
    modelOutputs: { 'untimed-fixture': 500 }, modelThroughput, sessions: {},
    capabilities: { tokenComponents: true, throughput: true } };
  for (const [model, counters] of Object.entries(modelThroughput)) {
    for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs']) result[field] += counters[field];
    result.totalTokens += counters.timedTokens;
    result.outputTokens += counters.timedOutputTokens;
    result.models[model] = counters.timedTokens;
    result.modelOutputs[model] = counters.timedOutputTokens;
  }
  result.clients = { codex: result.totalTokens };
  return result;
}
let local = period({ alpha: { timedTokens: 100, timedOutputTokens: 10, timedDurationMs: 1000 },
  beta: { timedTokens: 200, timedOutputTokens: 20, timedDurationMs: 2000 } });
let remote = period({ alpha: { timedTokens: 100, timedOutputTokens: 10, timedDurationMs: 1000 } });
let sequence = 0, activeStats;
function snapshot() {
  const combined = period({});
  for (const field of ['timedTokens', 'timedOutputTokens', 'timedDurationMs', 'totalTokens', 'outputTokens']) {
    combined[field] = local[field] + remote[field];
  }
  for (const field of ['models', 'modelOutputs', 'clients']) {
    combined[field] = {};
    for (const part of [local, remote]) for (const [key, value] of Object.entries(part[field])) {
      combined[field][key] = (combined[field][key] || 0) + value;
    }
  }
  combined.modelThroughput = {};
  return { snapshot: { id: `live-model-fixture-${++sequence}`, source: 'fixture' },
    periods: { today: combined, month: combined, allTime: combined },
    devices: [{ deviceId: 'local', displayName: 'Local', periods: { today: local } },
      { deviceId: 'remote', displayName: 'Remote', periods: { today: remote } }],
    nativeSessions: {}, updatedAt: new Date().toISOString(), historyEnabled: true,
    historyPreview: history, historyRevision: 'unchanged-history-fixture', modelSpeed: speedHistory };
}
activeStats = snapshot();
let win, done = false;
const audit = { synthetic: true, actualElectron: true, actualPreload: true, startedAt: new Date(startedAt).toISOString(),
  source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    tokenRate: hash('src/electron/renderer/tokenRatePresentation.js'), app: hash('src/electron/renderer/app.js'),
    animation: hash('src/electron/tokenNumberAnimation.js'), dependencyLock: hash('package-lock.json') },
  runtime: { platform: process.platform, arch: process.arch, versions: process.versions }, stages: [], errors: [] };
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
const deadline = setTimeout(() => finish(Error('Live model rate UI verification timed out')), 60000);
function finish(error) {
  if (done) return; done = true; clearTimeout(deadline);
  audit.passed = !error;
  if (error) audit.failure = error.stack;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
  console.log(error ? 'LIVE_MODEL_RATE_FAIL' : 'LIVE_MODEL_RATE_PASS', error?.stack || JSON.stringify(audit.checks));
  app.exit(error ? 1 : 0);
}
async function waitFor(code) {
  const until = Date.now() + 11000;
  while (Date.now() < until) { if (await evaluate(code)) return; await pause(25); }
  audit.timeoutState = await evaluate('({ hasStats: !!state.stats, settings: state.settings,' +
    'footerHidden: els.liveTokenRate.classList.contains("hidden"), footerText: els.liveTokenRateValue.textContent,' +
    'modules: [...document.querySelectorAll(".home-module")].map(el => el.className) })');
  throw Error('Condition timed out: ' + code);
}
async function push() {
  activeStats = snapshot();
  win.webContents.send('stats:push', { event: 'stats', data: { stats: activeStats, reason: 'local' } });
  await waitFor(`state.stats.snapshot.id === ${JSON.stringify(activeStats.snapshot.id)}`);
}
async function reading(name, expected, labels) {
  await waitFor(`els.liveTokenRateValue.textContent === formatLiveTokenRate(${expected}) + ' tok/s'`);
  const observed = await evaluate('({ sample: liveTokenRateTracker.getSample(), text: els.liveTokenRateValue.textContent,' +
    'labels: [...els.liveTokenRate.querySelectorAll(".live-token-rate-model-label")].map(el => el.textContent),' +
    'idle: els.liveTokenRate.classList.contains("is-idle"), coverage: els.liveTokenRate.dataset.coverage })');
  assert.ok(Math.abs(observed.sample.speed - expected) < 1e-9);
  assert.deepEqual(observed.labels.sort(), [...labels].sort());
  assert.equal(observed.coverage, 'partial', 'untimed output remains outside the measured rate');
  audit.stages.push({ name, at: Date.now() - startedAt, ...observed });
  return observed;
}
async function accounting() {
  await pause(100);
  const observed = await evaluate('({ total: state.currentTotal, models: state.stats.periods.today.models,' +
    'rows: [...document.querySelectorAll(".home-model-row")].map(el => ({ name: el.querySelector(".home-list-name").textContent, value: el.querySelector(".home-list-value").textContent })),' +
    'devices: [...document.querySelectorAll(".home-device-row")].map(el => ({ name: el.querySelector(".home-device-name").textContent, value: el.querySelector(".home-list-value").textContent })),' +
    'history: state.stats.historyPreview, speedHistory: state.stats.modelSpeed,' +
    'historyText: document.querySelector(".home-module-modelspeed")?.textContent })');
  assert.equal(observed.total, activeStats.periods.today.totalTokens);
  assert.deepEqual(observed.models, activeStats.periods.today.models);
  const expectedModels = await evaluate('Object.entries(state.stats.periods.today.models)' +
    '.map(([name, value]) => ({ name, value: formatCompact(value) }))');
  const expectedDevices = await evaluate('state.stats.devices.map(device => ({ name: device.displayName,' +
    'value: formatCompact(device.periods.today.totalTokens) }))');
  const byName = (a, b) => a.name.localeCompare(b.name);
  assert.deepEqual(observed.rows.sort(byName), expectedModels.sort(byName));
  assert.deepEqual(observed.devices.sort(byName), expectedDevices.sort(byName));
  assert.deepEqual(observed.history, history);
  assert.deepEqual(observed.speedHistory, speedHistory);
  assert.match(observed.historyText, /77/);
}
app.whenReady().then(async () => {
  const responses = { 'settings:get': () => settings, 'settings:update': patch => Object.assign(settings, patch),
    'stats:get': () => activeStats, 'stats:allTimeSessions': () => ({}),
    'app:getInfo': () => ({ version: 'fixture', platform: process.platform, systemDarkUi: true }),
    'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
    'appUpdate:getState': () => ({ status: 'idle', supported: false }), 'hub:getInfo': () => ({ mode: 'client' }),
    'tokscale:getStatus': () => ({ installed: true }), 'stream:status': () => ({ connected: true, mode: 'client' }),
    'dashboard:getHistory': () => history, 'modelSpeed:list': () => speedHistory,
    'cloudUsage:get': () => ({ version: 1, state: 'unavailable', threads: [] }) };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) =>
    responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 530, height: 950, useContentSize: true, show: false,
    backgroundColor: '#15191d', webPreferences: { contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  win.webContents.on('console-message', event => { if (event.level === 'error') audit.errors.push(String(event.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'),
    { query: { breakdown: 'home', period: 'today', suppressInitialNumberAnimation: '1' } });
  win.showInactive();
  await waitFor('state.stats && !els.liveTokenRate.classList.contains("hidden") && document.querySelector(".home-module-modelspeed")');
  await accounting();
  local = period({ alpha: { timedTokens: 200, timedOutputTokens: 50, timedDurationMs: 2000 },
    beta: { timedTokens: 200, timedOutputTokens: 20, timedDurationMs: 2000 } });
  await push(); await reading('alpha', 40, ['alpha']);
  await pause(600);
  local = period({ alpha: { timedTokens: 200, timedOutputTokens: 50, timedDurationMs: 2000 },
    beta: { timedTokens: 400, timedOutputTokens: 40, timedDurationMs: 4000 } });
  await push(); await reading('beta retains alpha', 20, ['alpha', 'beta']);
  await pause(600);
  local = period({ alpha: { timedTokens: 300, timedOutputTokens: 110, timedDurationMs: 3000 },
    beta: { timedTokens: 400, timedOutputTokens: 40, timedDurationMs: 4000 } });
  await push(); await reading('alpha replaces alpha', 80 / 3, ['alpha', 'beta']);
  await pause(600);
  remote = period({ alpha: { timedTokens: 250, timedOutputTokens: 55, timedDurationMs: 2500 } });
  await push(); const combined = await reading('two devices', 80 / 3 + 30, ['alpha · Local', 'alpha · Remote', 'beta · Local']);
  await accounting();
  await push(); const duplicate = await reading('duplicate', 80 / 3 + 30, ['alpha · Local', 'alpha · Remote', 'beta · Local']);
  assert.equal(duplicate.sample.revision, combined.sample.revision);
  assert.equal(duplicate.sample.expiresAt, combined.sample.expiresAt);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(output, 'concurrent-models.png'), image.toPNG());
  // No push/render call here: the real expiry timer must repaint each transition.
  await reading('beta expires automatically', 90, ['alpha · Local', 'alpha · Remote']);
  await reading('local expires automatically', 30, ['alpha']);
  await waitFor('els.liveTokenRate.classList.contains("is-idle")');
  const idle = await reading('remote expires to idle', 30, ['alpha']);
  assert.equal(idle.idle, true);
  await accounting();
  assert.deepEqual(audit.errors, []);
  audit.checks = { alternatingModels: true, latestSampleOnly: true, crossDeviceSum: true,
    duplicateStable: true, realEightSecondExpiryTimers: true, modelListTotals: true,
    deviceTotals: true, mixedTiming: true, usageHistoryUnchanged: true, speedHistoryUnchanged: true };
  finish();
}).catch(finish);
