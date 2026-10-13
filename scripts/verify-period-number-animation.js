'use strict';

// Actual Electron/preload/renderer, isolated profile and synthetic IPC only.
// Run frames and memory separately; sampling memory can perturb frame timings.
const { app, BrowserWindow, ipcMain } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const os = require('node:os');
const { execFileSync } = require('node:child_process');
const output = process.env.TM_ANIMATION_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw Error('Set TM_ANIMATION_VERIFY_DIR to a private absolute directory');
const root = path.resolve(process.env.TM_ANIMATION_VERIFY_ROOT || path.join(__dirname, '..'));
const mode = process.env.TM_ANIMATION_VERIFY_MODE || 'regression';
assert.ok(['regression', 'frames', 'memory'].includes(mode));
const style = process.env.TM_ANIMATION_VERIFY_STYLE || 'roll';
assert.ok(['roll', 'count'].includes(style));
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(output, 'profile'));
const hash = file => crypto.createHash('sha256').update(fs.readFileSync(path.join(root, file))).digest('hex');
const now = Date.now();
const models = Array.from({ length: 28 }, (_, i) => 'fixture-model-' + String(i + 1).padStart(2, '0'));
function period(multiplier, reverse = false) {
  const counts = Object.fromEntries(models.map((model, i) => [model, (reverse ? i + 1 : models.length - i) * multiplier]));
  const sessions = Object.fromEntries(models.slice(0, 4).map((model, i) => {
    const id = '00000000-0000-7000-8000-' + String(i + 1).padStart(12, '0');
    return ['codex:' + id, { client: 'codex', sessionId: id, title: 'Synthetic session ' + (i + 1),
      totalTokens: counts[model], inputTokens: counts[model] - 100, outputTokens: 100,
      costUsd: 0.1, models: { [model]: counts[model] }, messageCount: 4,
      lastUsedAt: new Date(now - i * 60000).toISOString(), startedAt: new Date(now - 900000).toISOString() }];
  }));
  const totalTokens = Object.values(counts).reduce((sum, value) => sum + value, 0);
  const modelCosts = Object.fromEntries(Object.entries(counts).map(([model, tokens]) => [model, tokens / 10000000]));
  const costUsd = Object.values(modelCosts).reduce((sum, cost) => sum + cost, 0);
  return { totalTokens, costUsd, models: counts, modelCosts, sessions,
    clients: { codex: totalTokens }, clientCosts: { codex: costUsd } };
}
const periods = { today: period(1229983), month: period(21166899, true), allTime: period(41166799, true) };
const daily = Array.from({ length: 40 }, (_, i) => {
  const date = new Date(now); date.setHours(12, 0, 0, 0); date.setDate(date.getDate() - 39 + i);
  const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return { date: key, tokens: 2100000 + i * 37000, cost: 0.4 + i / 100 };
});
const history = { daily, monthly: [], summary: { activeDays: daily.length } };
const settings = { language: 'en', locale: 'en-US', theme: 'dark', blurEnabled: false,
  historyEnabled: true, hubMode: 'local', clients: 'codex', refreshMs: 60000,
  reduceMotion: 'off', tokenNumberAnimation: style, periodMonthMode: 'month',
  modelAliasGrouping: 'none', compactTokenUnits: 'western', showCompactTotalTokens: false,
  showLiveTokenRate: false, sessionTitlesEnabled: true,
  homeModuleOrder: 'model,trends', hiddenHomeModules: 'limits,tool,device,session,modelspeed',
  cloudAccountingNoticeDismissed: true, cloudSessionScopeDismissed: true };
const stats = { snapshot: { id: 'period-animation-fixture', source: 'fixture' }, periods,
  nativeSessions: {}, devices: [], updatedAt: new Date(now).toISOString(),
  historyEnabled: true, historyPreview: history, historyRevision: 'fixture-history',
  modelSpeed: { version: 1, state: 'unavailable', models: [] } };
const audit = { mode, style, synthetic: true, actualRenderer: true, actualPreload: true,
  source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
    app: hash('src/electron/renderer/app.js'), animation: hash('src/electron/tokenNumberAnimation.js'),
    dependencyLock: hash('package-lock.json') },
  runtime: { platform: process.platform, arch: process.arch, versions: process.versions,
    osRelease: os.release(), cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 1024 ** 3 },
  fixture: { models: models.length, window: [530, 820], clicks: 20, intervalMs: 150 },
  errors: [], memorySamples: [] };
let win, done = false;
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
const evaluate = code => win.webContents.executeJavaScript(code, true);
const deadline = setTimeout(() => finish(Error('Period animation verification timed out')), 90000);
function finish(error) {
  if (done) return; done = true; clearTimeout(deadline);
  audit.passed = !error;
  if (error) audit.failure = error.stack;
  fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
  console.log(error ? 'PERIOD_ANIMATION_FAIL' : 'PERIOD_ANIMATION_PASS',
    error?.stack || JSON.stringify({ mode, style, stress: audit.stress, memory: audit.memory, checks: audit.checks }));
  app.exit(error ? 1 : 0);
}
async function waitFor(code) {
  const until = Date.now() + 10000;
  while (Date.now() < until) { if (await evaluate(code)) return; await pause(30); }
  throw Error('Condition timed out: ' + code);
}
async function select(selection) {
  await evaluate('document.querySelector(\'.tab[data-period="' + selection + '"]\').click()');
  await waitFor('state.period === ' + JSON.stringify(selection));
  await pause(1100);
}
async function modelValues(selection) {
  const observed = await evaluate('({ total: els.totalTokens.textContent, current: state.currentTotal,' +
    'rows: [...els.breakdown.querySelectorAll(".row[data-key]")].map(row => ({ key: row.dataset.key,' +
    'value: Number(row.dataset.motionValue), text: row.querySelector(".row-value").textContent })) })');
  const expected = periods[selection];
  assert.equal(observed.current, expected.totalTokens);
  assert.equal(observed.total, await evaluate('formatNumber(' + expected.totalTokens + ')'));
  assert.deepEqual(observed.rows.map(row => row.value), Object.values(expected.models).sort((a, b) => b - a));
  for (const row of observed.rows) assert.equal(row.text, await evaluate('formatNumber(' + row.value + ')'));
  return observed;
}
async function stress() {
  // Both modes use the same real tab click schedule and DOM-layer observations.
  // Frame sampling is deliberately disabled in the separate memory run.
  return evaluate('(' + function (page, recordFrames) {
    return new Promise(resolve => {
      const frames = [], intervals = [], clicks = [];
      const began = page.performance.now();
      let previous = null, frame = null, index = 0, headlineGlyphPeak = 0, rowGlyphPeak = 0;
      function sample(now) {
        if (previous !== null) intervals.push(now - previous);
        previous = now; frames.push(now);
        frame = page.requestAnimationFrame(sample);
      }
      if (recordFrames) frame = page.requestAnimationFrame(sample);
      function click() {
        const target = index % 2 ? 'today' : 'month';
        const start = page.performance.now();
        page.document.querySelector('.tab[data-period="' + target + '"]').click();
        clicks.push({ target, at: start, handlerMs: page.performance.now() - start });
        headlineGlyphPeak = Math.max(headlineGlyphPeak, page.document.querySelectorAll('#totalTokens .token-number-glyph').length);
        rowGlyphPeak = Math.max(rowGlyphPeak, ...[...page.document.querySelectorAll('#breakdown .row-value')]
          .map(row => row.querySelectorAll('.token-number-glyph').length));
        if (++index < 20) page.setTimeout(click, Math.max(0, index * 150 - (page.performance.now() - began)));
        else page.setTimeout(() => {
          if (frame !== null) page.cancelAnimationFrame(frame);
          const sorted = [...intervals].sort((a, b) => a - b);
          resolve({ intervals, clicks, frameCount: frames.length,
            jankyFramesOver25ms: intervals.filter(ms => ms > 25).length,
            maxFrameMs: sorted.at(-1) ?? null, p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? null,
            headlineGlyphPeak, rowGlyphPeak });
        }, 1100);
      }
      click();
    });
  }.toString() + ')(window, ' + JSON.stringify(mode === 'frames') + ')');
}
function memorySample() {
  const processes = app.getAppMetrics().filter(row => row.type === 'Tab' || row.type === 'GPU');
  const workingSetKiB = processes.reduce((sum, row) => sum + row.memory.workingSetSize, 0);
  const sample = { at: Date.now(), workingSetKiB,
    processes: processes.map(row => ({ pid: row.pid, type: row.type, memory: row.memory })) };
  audit.memorySamples.push(sample);
  return sample;
}
async function regression() {
  const before = await modelValues('today');
  await select('month'); await modelValues('month');
  const whole = await evaluate('(() => { document.querySelector(\'.tab[data-period="today"]\').click();' +
    'return [...rowNumberAnimations.keys()].map(el => el.querySelectorAll(".token-number-glyph").length); })()');
  assert.ok(whole.length > 0);
  assert.ok(whole.every(count => count <= 2), 'fresh row switches have two whole-reading layers');
  await stress();
  assert.deepEqual(await modelValues('today'), before, 'rapid switches preserve values, row identities and sorting');
  // An in-flight period transition must settle on a live Reduced Motion push.
  await evaluate('document.querySelector(\'.tab[data-period="month"]\').click()');
  Object.assign(settings, { reduceMotion: 'on' });
  win.webContents.send('settings:push', settings);
  await waitFor('prefersReducedMotion() && document.querySelectorAll("[data-token-number-animation]").length === 0');
  await modelValues('month');
  await select('today'); await modelValues('today');
  assert.equal(await evaluate('document.getAnimations().filter(a => a.playState === "running").length'), 0);
  // System preference takes the same path when Chromium reports reduced motion.
  win.webContents.debugger.attach('1.3');
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', {
    features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] });
  Object.assign(settings, { reduceMotion: 'system' });
  win.webContents.send('settings:push', settings);
  await waitFor('prefersReducedMotion()');
  await select('month'); await modelValues('month');
  assert.equal(await evaluate('document.querySelectorAll("[data-token-number-animation]").length'), 0);
  await win.webContents.debugger.sendCommand('Emulation.setEmulatedMedia', { features: [] });
  win.webContents.debugger.detach();
  Object.assign(settings, { reduceMotion: 'off', tokenNumberAnimation: 'count' });
  win.webContents.send('settings:push', settings);
  await waitFor('state.settings.tokenNumberAnimation === "count" && !prefersReducedMotion()');
  await select('today'); await modelValues('today');
  assert.equal(await evaluate('document.querySelectorAll(".token-number-glyph").length'), 0);
  Object.assign(settings, { tokenNumberAnimation: 'roll' });
  win.webContents.send('settings:push', settings);
  await waitFor('state.settings.tokenNumberAnimation === "roll"');
  await evaluate('renderBreakdownChange("session")'); await pause(1100);
  assert.ok(await evaluate('els.breakdown.querySelectorAll(".row[data-key]").length > 0'));
  for (const selection of ['month', 'today', 'allTime', 'today']) {
    await select(selection);
    assert.equal(await evaluate('state.currentTotal'), periods[selection].totalTokens);
    const values = await evaluate('[...els.breakdown.querySelectorAll(".row[data-key]")].map(row => Number(row.dataset.motionValue))');
    assert.deepEqual(values.sort((a, b) => a - b),
      Object.values(periods[selection].sessions).map(row => row.totalTokens).sort((a, b) => a - b));
    assert.equal(await evaluate('document.querySelectorAll("[data-token-number-animation]").length'), 0);
    assert.equal(await evaluate('state.sessionPage'), 0);
  }
  fs.writeFileSync(path.join(output, 'sessions.png'), (await win.webContents.capturePage()).toPNG());
  await evaluate('renderBreakdownChange("home")'); await pause(1400);
  const historyBefore = await evaluate('JSON.stringify(state.stats.historyPreview)');
  const curves = () => evaluate('[...document.querySelectorAll(".home-area-chart svg path[d]")].map(el => el.getAttribute("d"))');
  const originalCurves = await curves();
  assert.ok(originalCurves.length > 0, 'history has a rendered curve');
  await select('month'); await select('today');
  assert.deepEqual(await curves(), originalCurves, 'returning to today restores identical history curves');
  assert.equal(await evaluate('JSON.stringify(state.stats.historyPreview)'), historyBefore);
  fs.writeFileSync(path.join(output, 'home.png'), (await win.webContents.capturePage()).toPNG());
  audit.checks = { sharedPeriods: true, modelValuesAndOrdering: true, rapidRetarget: true,
    reducedMotionPush: true, systemReducedMotion: true, count: true, sessions: true, historyCurves: true };
}
app.whenReady().then(async () => {
  const responses = { 'settings:get': () => settings, 'settings:update': patch => Object.assign(settings, patch),
    'stats:get': () => stats, 'stats:allTimeSessions': () => periods.allTime.sessions,
    'app:getInfo': () => ({ version: 'fixture', platform: process.platform, systemDarkUi: true }),
    'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
    'appUpdate:getState': () => ({ status: 'idle', supported: false }),
    'hub:getInfo': () => ({ mode: 'local' }), 'tokscale:getStatus': () => ({ installed: true }),
    'stream:status': () => ({ connected: true, mode: 'local' }), 'dashboard:getHistory': () => history,
    'cloudUsage:get': () => ({ version: 1, state: 'unavailable', threads: [] }) };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(m => m[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) =>
    responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 530, height: 820, useContentSize: true, show: false,
    backgroundColor: '#15191d', webPreferences: { contextIsolation: true, nodeIntegration: false,
      backgroundThrottling: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
  win.webContents.on('console-message', event => { if (event.level === 'error') audit.errors.push(String(event.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'),
    { query: { breakdown: 'model', period: 'today', suppressInitialNumberAnimation: '1' } });
  win.showInactive();
  await waitFor('state.stats && els.breakdown.querySelectorAll(".row[data-key]").length > 0');
  await pause(2000);
  if (mode === 'regression') await regression();
  else {
    await modelValues('today');
    let sampler;
    const baseline = mode === 'memory' ? memorySample().workingSetKiB : null;
    if (mode === 'memory') sampler = setInterval(memorySample, 150);
    try { audit.stress = await stress(); } finally { clearInterval(sampler); }
    await modelValues('today');
    if (mode === 'memory') {
      const peak = Math.max(...audit.memorySamples.map(row => row.workingSetKiB));
      await pause(20000);
      const idle = memorySample();
      audit.memory = { metric: 'Electron app.getAppMetrics renderer + GPU workingSetSize, MiB',
        baselineMiB: baseline / 1024, peakAddedMiB: (peak - baseline) / 1024,
        idleAddedMiBAfter20s: (idle.workingSetKiB - baseline) / 1024 };
      assert.ok(baseline > 0, 'runtime must expose a usable working-set metric');
    }
  }
  assert.deepEqual(audit.errors, []);
  finish();
}).catch(finish);
