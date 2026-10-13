'use strict';
// Real renderer + preload; all data and IPC are isolated fixtures, no accounts.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.TM_SPEED_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw Error('Set TM_SPEED_VERIFY_DIR to an absolute private directory');
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(output, 'profile'));
const root = path.resolve(__dirname, '..');
const settings = { language: 'zh-CN', locale: 'zh-CN', reduceMotion: 'off', blurEnabled: false,
  historyEnabled: true, hubMode: 'local', clients: 'codex', showToolIcons: true,
  compactTokenUnits: 'western', currency: 'USD', modelAliasGrouping: 'prefix',
  homeModuleOrder: 'model,trends,modelspeed', hiddenHomeModules: 'limits,session,tool,device',
  cloudAccountingNoteDismissed: true, cloudSessionScopeDismissed: true };
const now = Date.now();
const trend = Array.from({ length: 16 }, (_, i) => ({ at: now - (20 - i - (i > 7 ? 4 : 0)) * 3600000,
  tps: 18 + Math.sin(i / 2) * 8, span: 3600000 }));
const models = Array.from({ length: 23 }, (_, i) => ({
  id: `model-list-fixture-${i}`, model: i === 0 ? 'gpt-model-main' : `provider/model-${i}-long-context-variant`,
  lastTps: i % 4 ? null : 20 + i, outputTpm: i % 4 ? null : (20 + i) * 60,
  status: i % 4 ? 'unmeasured' : 'learning', samples: i % 4 ? 0 : 14,
  trend: i % 4 ? [] : trend, baselineTps: null, recentSamples: 3, gaps: 1
}));
const daily = Array.from({ length: 40 }, (_, i) => ({ date: new Date(now - (39 - i) * 86400000).toISOString().slice(0, 10), tokens: 1000 + i * 51, cost: 1 }));
const history = { daily, monthly: [], summary: { activeDays: 40 } };
const period = { totalTokens: 4000000, costUsd: 20, clients: { codex: 4000000 },
  models: Object.fromEntries(models.map((row, i) => [row.model, 1000 + i])), sessions: {} };
// The list and the detail both report the window main resolved from the
// top-level DAY/MONTH/TOTAL selection.
const range = { period: 'allTime', start: now - 89 * 86400000, end: now, labelKey: 'home.modelSpeed.range.allTime' };
const summary = { version: 1, state: 'recording', models: models.slice(0, 5), candidateCount: models.length, revision: 1, range };
const stats = { snapshot: { id: 'full-list-fixture', source: 'fixture' },
  periods: { today: period, month: period, allTime: period }, updatedAt: new Date(now).toISOString(),
  nativeSessions: {}, devices: [], historyPreview: history, historyEnabled: true, modelSpeed: summary };
let win, detailRevision = 0, listFailure = false, listDelay = 0, done = false;
const audit = { synthetic: true, errors: [], listRequests: 0, historyRequests: 0, sizes: [] };
const deadline = setTimeout(() => finish(Error('List/motion verification timeout')), 90000);
function finish(error) {
  if (done) return; done = true; clearTimeout(deadline);
  if (error) audit.failure = error.stack;
  audit.passed = !error;
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
  console.log(error ? 'ALL_MODEL_UI_FAIL' : 'ALL_MODEL_UI_PASS', error?.stack || JSON.stringify(audit));
  app.exit(error ? 1 : 0);
}
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = expression => win.webContents.executeJavaScript(expression, true);
async function waitFor(expression) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await evaluate(expression)) return; await pause(35); }
  throw Error('Condition timed out: ' + expression);
}
async function capture(name) {
  await evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG(), { mode: 0o600 });
}
app.whenReady().then(async () => {
  const responses = {
    'settings:get': () => settings, 'settings:update': patch => Object.assign(settings, patch),
    'stats:get': () => stats, 'stats:allTimeSessions': () => ({}),
    'app:getInfo': () => ({ version: '0.66.0-cloud.9', platform: 'darwin', systemDarkUi: true }),
    'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
    'appUpdate:getState': () => ({ status: 'idle', supported: false }),
    'hub:getInfo': () => ({ mode: 'local' }), 'tokscale:getStatus': () => ({ installed: true }),
    'stream:status': () => ({ connected: true, mode: 'local' }), 'dashboard:getHistory': () => history,
    'cloudUsage:get': () => ({ version: 1, state: 'unavailable', threads: [] }),
    'modelSpeed:list': async () => {
      audit.listRequests++; await pause(listDelay);
      if (listFailure) return null;
      return { ...summary, models, range };
    },
    'modelSpeed:history': async request => {
      audit.historyRequests++;
      const row = models.find(row => row.id === request.id);
      if (!row) return null;
      return { ...row, period: request.period, state: 'recording', range,
        weightedTps: row.lastTps === null ? null : 27 + detailRevision };
    }
  };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 350, height: 780, useContentSize: true, show: false,
    backgroundColor: '#15191d', webPreferences: { contextIsolation: true, nodeIntegration: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  win.webContents.on('console-message', event => { if (event.level === 'error') audit.errors.push(String(event.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'), { query: { breakdown: 'home', period: 'allTime', suppressInitialNumberAnimation: '1' } });
  win.showInactive();
  await waitFor('document.querySelectorAll("#homePanel .model-speed-row").length === 5');
  assert.equal(await evaluate('document.querySelectorAll("#homePanel .home-module-modelspeed > .model-speed-all-link").length'), 0, 'only the upper header opens the list');
  await pause(1050);
  await evaluate(`document.querySelector('#homePanel .model-speed-head').click()`);
  await waitFor('document.querySelectorAll(".model-speed-list .model-speed-row").length === 23');
  assert.match(await evaluate(`document.querySelector('.model-speed-list-head').textContent`), /23/);
  assert.equal(await evaluate(`document.querySelector('.model-speed-detail') === null`), true, 'header opens all models, never the first chart');
  for (const [width, height] of [[240,620],[350,780],[900,780]]) {
    win.setContentSize(width, height); await pause(70);
    const layout = await evaluate(`(() => { const p = document.getElementById('modelSpeedPanel'); return {
      width: innerWidth, height: innerHeight, rows: p.querySelectorAll('.model-speed-row').length,
      fits: p.scrollWidth <= p.clientWidth + 1, scrollable: p.scrollHeight > p.clientHeight,
      footerFits: document.querySelector('.footer').getBoundingClientRect().bottom <= innerHeight,
      rowsFit: [...p.querySelectorAll('.model-speed-row')].every(n => n.scrollWidth <= n.clientWidth + 1)
    }; })()`);
    assert.ok(layout.fits && layout.rowsFit && layout.footerFits && layout.scrollable, JSON.stringify(layout));
    audit.sizes.push(layout); await capture(`all-models-${width}.png`);
  }
  win.setContentSize(350,620); await pause(70);
  await evaluate(`document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-16"]').scrollIntoView({block:'center'});
    window.__listScroll = document.getElementById('modelSpeedPanel').scrollTop;
    document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-16"]').click();`);
  await waitFor('document.querySelector(".model-speed-chart") !== null');
  assert.match(await evaluate(`document.getElementById('backHomeButton').textContent`), /返回模型速度/);
  detailRevision = 1;
  audit.motion = await evaluate(`new Promise(resolve => {
    const svg = document.querySelector('.model-speed-chart');
    const animation = svg.getAnimations()[0];
    const samples = []; const start = performance.now();
    window.__motionCurve = svg;
    setTimeout(() => { void state.openModelSpeed.view.refresh(); }, 130);
    setTimeout(() => { void state.openModelSpeed.view.refresh(); }, 290);
    function frame(now) {
      samples.push({ at: now-start, time: animation.currentTime, sameNode: svg === document.querySelector('.model-speed-chart'),
        state: animation.playState, progress: animation.effect.getComputedTiming().progress });
      if (now-start < 1050) requestAnimationFrame(frame); else resolve({ samples, frames: animation.effect.getKeyframes(),
        timing: animation.effect.getTiming(), lineAnimations: svg.querySelector('.model-speed-line').getAnimations().length });
    }
    requestAnimationFrame(frame);
  })`);
  const frames = audit.motion.samples;
  const playing = frames.filter(frame => frame.state === 'running');
  assert.ok(playing.length >= 8, 'capture real in-progress frames');
  assert.ok(playing.every(frame => frame.sameNode), 'a background poll cannot replace a playing SVG');
  for (let i=1;i<playing.length;i++) assert.ok(playing[i].time >= playing[i-1].time, 'entry never restarts');
  assert.equal(audit.motion.timing.easing, 'linear');
  assert.equal(audit.motion.lineAnimations, 0, 'no per-path dash animation to pause at a gap');
  assert.ok(audit.motion.frames.every(frame => typeof frame.clipPath === 'string'));
  await waitFor(`document.querySelector('.model-speed-figure-value').textContent === '28'`);
  await evaluate(`window.__settledCurve = document.querySelector('.model-speed-chart'); state.openModelSpeed.view.refresh(); undefined`);
  await pause(60);
  assert.equal(await evaluate(`document.querySelector('.model-speed-chart') === window.__settledCurve`), true, 'identical polls keep the chart');
  await capture('detail-after-refresh.png');
  await evaluate(`document.getElementById('backHomeButton').click()`);
  await waitFor('document.querySelectorAll(".model-speed-list .model-speed-row").length === 23');
  assert.equal(await evaluate(`document.activeElement.dataset.speedId`), 'model-list-fixture-16');
  assert.ok(await evaluate(`Math.abs(document.getElementById('modelSpeedPanel').scrollTop-window.__listScroll) < 2`));

  await evaluate(`window.__retainedRow = document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-16"]');
    state.openModelSpeed.view.refresh(); undefined`);
  await pause(60);
  assert.equal(await evaluate(`window.__retainedRow === document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-16"]')`), true);
  listFailure = true;
  await evaluate('state.openModelSpeed.view.refresh(); undefined');
  await waitFor('document.querySelector(".model-speed-list .model-speed-all-link").hidden === false');
  assert.equal(await evaluate(`document.querySelectorAll('.model-speed-list .model-speed-row').length`), 23, 'a failed refresh preserves the last successful list');
  listFailure = false;
  await evaluate(`document.querySelector('.model-speed-list .model-speed-all-link').click()`);
  await waitFor('document.querySelector(".model-speed-list .model-speed-all-link").hidden === true');
  await evaluate(`document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-22"]').click()`);
  await waitFor('document.querySelector(".model-speed-status.unmeasured") !== null');
  assert.equal(await evaluate(`document.querySelector('#modelSpeedPanel .model-speed-figures') === null`), true);
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', {key:'Escape',bubbles:true}))`);
  await waitFor('document.querySelector(".model-speed-list") !== null');
  await evaluate(`document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-0"]').click()`);
  await waitFor('document.querySelector(".model-speed-chart") !== null');
  await evaluate(`document.querySelector('.view-switcher-disclosure').click(); document.querySelector('.view-switcher-menu-item[data-view="home"]').click()`);
  assert.equal(await evaluate('state.openModelSpeed === null'), true, 'explicit Home exits the entire speed hierarchy');
  // Source data pushed during Home entry must not replace the animated chart.
  await evaluate(`renderBreakdownChange('model'); renderBreakdownChange('home'); undefined`);
  await waitFor(`document.querySelector('.home-area-chart svg')?.getAnimations().length > 0`);
  await evaluate(`window.__homeEntry = document.querySelector('.home-area-chart svg'); undefined`);
  win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'presentation', mode: 'local', stats } });
  await pause(110);
  assert.equal(await evaluate(`document.querySelector('.home-area-chart svg') === window.__homeEntry`), true);
  await pause(1000);
  listDelay = 160;
  await evaluate(`document.querySelector('#homePanel .model-speed-head').click(); document.getElementById('backHomeButton').click();`);
  await pause(210);
  assert.equal(await evaluate('state.openModelSpeed === null && document.getElementById("modelSpeedPanel").children.length === 0'), true);
  listDelay = 0;
  settings.reduceMotion = 'on';
  win.webContents.send('settings:push', settings);
  await waitFor(`document.documentElement.dataset.reduceMotion === 'on'`);
  await evaluate(`document.querySelector('#homePanel .model-speed-head').click()`);
  await waitFor('document.querySelectorAll(".model-speed-list .model-speed-row").length === 23');
  await evaluate(`document.querySelector('.model-speed-list [data-speed-id="model-list-fixture-0"]').click()`);
  await waitFor('document.querySelector(".model-speed-chart") !== null');
  assert.equal(await evaluate(`document.querySelector('.model-speed-chart').getAnimations().length`), 0);
  await evaluate(`document.getElementById('backHomeButton').click(); document.getElementById('backHomeButton').click();`);
  assert.equal(await evaluate('state.openModelSpeed === null'), true);
  assert.deepEqual(audit.errors, []);
  audit.completeListCount = 23;
  audit.previewCount = 5;
  audit.navigation = { nestedBackAndEscape: true, focusAndScrollRestored: true, explicitHome: true,
    failedListRetry: true, unchangedRowsRetained: true, pendingListDisposal: true, reducedMotion: true };
  const times = frames.slice(1).map((frame, i) => frame.at - frames[i].at).sort((a,b) => a-b);
  audit.frameTimingMs = { frames: frames.length, median: times[Math.floor(times.length/2)], p95: times[Math.floor(times.length*.95)], max: times.at(-1) };
  finish();
}).catch(finish);
