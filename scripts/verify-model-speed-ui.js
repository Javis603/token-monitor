'use strict';
// Real Electron renderer/preload, isolated profile and synthetic speed samples.
// Exercises navigation, asynchronous ranges, theme inheritance and actual motion.
const { app, BrowserWindow, ipcMain } = require('electron');
const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = process.env.TM_SPEED_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw new Error('Set TM_SPEED_VERIFY_DIR to an absolute private directory');
const root = path.resolve(__dirname, '..');
const settings = {
  language: 'zh-CN', locale: 'zh-CN', blurEnabled: false, historyEnabled: true,
  refreshMs: 60000, hubMode: 'local', clients: 'codex', showToolIcons: true,
  compactTokenUnits: 'western', currency: 'USD', reduceMotion: 'off',
  modelAliasGrouping: 'prefix', showLiveTokenRate: false, periodMonthMode: 'last30',
  homeModuleOrder: 'limits,model,session,trends,modelspeed', hiddenHomeModules: 'tool,device',
  limitsEnabled: true, limitProviders: 'codex,claude', showHomeLimitBars: true, sessionTitlesEnabled: true,
  cloudAccountingNoticeDismissed: true
};
const now = Date.now();
const fixtureDaily = Array.from({ length: 74 }, (_, index) => {
  const date = new Date(now);
  date.setHours(12, 0, 0, 0);
  date.setDate(date.getDate() - 73 + index);
  const key = [date.getFullYear(), String(date.getMonth() + 1).padStart(2, '0'), String(date.getDate()).padStart(2, '0')].join('-');
  return { date: key, tokens: 2400000 + (index % 9) * 340000, cost: 2.8 + (index % 7) * 0.45 };
});
const monthlyByKey = new Map();
for (const day of fixtureDaily) {
  const month = day.date.slice(0, 7);
  const row = monthlyByKey.get(month) || { month, tokens: 0, cost: 0 };
  row.tokens += day.tokens;
  row.cost += day.cost;
  monthlyByKey.set(month, row);
}
const fixtureHistory = { daily: fixtureDaily, monthly: [...monthlyByKey.values()], summary: { activeDays: 74 } };
const fixtureLimits = { providers: ['codex', 'claude'].map((provider, index) => ({
  provider, status: 'ok', accountKey: 'fixture-' + provider, accountEmail: provider + '@example.test', sourceDetail: 'fixture',
  windows: [
    { kind: 'session', label: '', remainingPercent: 64 + index * 12, resetsAt: new Date(now + 10800000).toISOString() },
    { kind: 'weekly', label: '', remainingPercent: 42 + index * 15, resetsAt: new Date(now + 518400000).toISOString() }
  ]
})) };
const models = ['gpt-6.1-sol', 'gpt-6-astra', 'group/auto-deepseek-v4-1-flash', 'cmdc-gemini/gemini-3.8-flash-high'];
const trend = Array.from({ length: 16 }, (_, i) => ({ at: now - (20 - i - (i > 7 ? 4 : 0)) * 3600000,
  tps: 24 + Math.sin(i / 2) * 6, span: 3600000, samples: i + 1 }));
const speedModels = models.map((model, i) => ({ id: `fixture-speed-${i}`, model,
  status: ['learning', 'stable', 'slower', 'insufficient'][i], lastTps: [24.6, 12.3, 158.2, 11.3][i],
  outputTpm: [1478.1, 735.7, 9494.3, 679.2][i], samples: 28 - i * 5,
  baselineTps: i === 0 ? null : 36, changePercent: i === 0 ? null : -12,
  referenceOnly: i === 3, trend: i === 3 ? [] : trend }));
const unmeasuredModel = { id: 'fixture-speed-unmeasured', model: 'Muse', status: 'unmeasured',
  lastTps: null, outputTpm: null, baselineTps: null, recentTps: null, changePercent: null,
  samples: 0, recentSamples: 0, baselineSamples: 0, gaps: 0, rejected: 0,
  referenceOnly: false, trend: [] };
let cloudSnapshot = { version: 1, state: 'unavailable', threads: [] };
// The renderer labels each speed surface with the window main resolved, so the
// fixture has to publish the same shape main sends back.
const SPEED_RANGE_LABEL_KEYS = { today: 'home.modelSpeed.range.today', week: 'home.modelSpeed.range.week',
  last7: 'home.modelSpeed.range.last7', month: 'home.modelSpeed.range.month',
  last30: 'home.modelSpeed.range.last30', allTime: 'home.modelSpeed.range.allTime' };
function speedRangeFor(period) {
  return { period, labelKey: SPEED_RANGE_LABEL_KEYS[period] || SPEED_RANGE_LABEL_KEYS.today };
}
const period = { totalTokens: 356408872, costUsd: 224.5, clients: { codex: 356408872 },
  models: Object.fromEntries(models.map((model, i) => [model, (4 - i) * 20000000])), sessions: {} };
// Derived windows require the contributing device's retained history and day
// boundary, matching dashboard:getHistory({ includeDevices: true }) in main.
const fixtureDevice = { deviceId: 'speed-ui-fixture', platform: 'darwin-arm64',
  periodWindows: { timeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    today: { key: fixtureDaily.at(-1).date, endsAt: new Date(new Date(now).setHours(24, 0, 0, 0)).toISOString() } },
  periods: { today: period, month: period, allTime: period } };
const fixtureDeviceHistory = { ...fixtureDevice, historyAvailable: true, history: fixtureHistory };
const stats = { snapshot: { id: 'speed-ui-fixture', source: 'speed-ui-fixture' },
  periods: { today: period, month: period, allTime: period }, devices: [fixtureDevice],
  nativeSessions: {}, updatedAt: new Date(now).toISOString(), historyEnabled: true,
  historyPreview: fixtureHistory, historyRevision: 'fixture-history-74', limits: fixtureLimits,
  modelSpeed: { version: 1, state: 'recording', retentionDays: 90, models: speedModels,
    range: speedRangeFor('allTime') } };
const audit = { startedAt: new Date(now).toISOString(), requests: [], errors: [], viewports: [], resizeSequence: [], sessionPreviews: [], settingsUpdates: [] };
let activeStats = stats;
const responseBehaviors = [];
let win, done = false, failNext = false, pendingDelay = 0;
fs.mkdirSync(output, { recursive: true, mode: 0o700 });
app.setPath('userData', path.join(output, 'electron-profile'));
// Source rows and viewport captures extend the full suite; each individual
// condition still has a separate 12s bound.
const deadline = setTimeout(() => finish(new Error('Speed UI verification timeout')), 240000);
function finish(error) {
  if (done) return;
  done = true;
  clearTimeout(deadline);
  audit.completedAt = new Date().toISOString();
  if (error) audit.failure = error.stack || String(error);
  fs.writeFileSync(path.join(output, 'audit.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
  if (error) console.error('MODEL_SPEED_UI_FAILED', error.stack || String(error), JSON.stringify(audit));
  app.exit(error ? 1 : 0);
}
async function evaluate(expression) { return win.webContents.executeJavaScript(expression, true); }
async function waitFor(expression) {
  const until = Date.now() + 12000;
  while (Date.now() < until) {
    if (await evaluate(expression)) return;
    await new Promise(resolve => setTimeout(resolve, 50));
  }
  throw new Error('Condition not reached: ' + expression);
}
async function capture(name) {
  await evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Renderer frame did not arrive')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  })`);
  fs.writeFileSync(path.join(output, name), (await win.webContents.capturePage()).toPNG(), { mode: 0o600 });
}
// The detail follows the window's DAY/MONTH/TOTAL selection, so the fixture
// answers with a per-period mean. The TPM assertion strings in this script
// (1,260 / 1,620 / 3,000 / 6,600) are these means times sixty.
const SPEED_PERIOD_MEAN = { today: 21, week: 27, last7: 27, month: 50, last30: 50, allTime: 110 };
function sourceFixtures(period, unmeasured = false) {
  if (unmeasured) return [{ id: 'coding-plan', client: 'dsh', platform: 'opencode-go',
    accountLabel: '账号 coding-plan-with-a-long-credential-free-display-label', accountTag: 'eeeeeeee',
    accessType: 'subscription', weightedTps: null, samples: 0, referenceOnly: true }];
  const sources = [
    { id: 'subscription-a', client: 'dsh', platform: 'codex', accountLabel: '账号 A', accountTag: 'aaaaaaaa', accessType: 'subscription' },
    { id: 'subscription-b', client: 'codex', platform: 'codex', accountLabel: '账号 B', accountTag: 'bbbbbbbb', accessType: 'subscription' },
    { id: 'api', client: 'dsh', platform: 'openai', accountLabel: '账号 API', accountTag: 'cccccccc', accessType: 'api' },
    { id: 'reference', client: 'dsh', platform: 'google', accountLabel: '账号 Google', accountTag: 'dddddddd', accessType: 'unknown', referenceOnly: true },
    { id: 'unattributed', client: '', platform: '', accountLabel: '', accountTag: '', accessType: 'unknown' }
  ].map(row => ({ ...row, weightedTps: row.referenceOnly ? null : SPEED_PERIOD_MEAN[period], samples: row.referenceOnly ? 0 : 3 }));
  return period === 'today' ? sources.slice(0, 1) : sources;
}
async function history(request) {
  audit.requests.push(request);
  const behavior = responseBehaviors.shift();
  const shouldFail = behavior?.fail ?? failNext;
  failNext = false;
  const delay = behavior?.delay ?? (pendingDelay || (request.period === 'today' ? 180 : 15));
  pendingDelay = 0;
  await new Promise(resolve => setTimeout(resolve, delay));
  if (shouldFail) throw new Error('Synthetic temporary history failure');
  const row = [...speedModels, unmeasuredModel].find(item => item.id === request.id);
  if (!row) return null;
  const mean = SPEED_PERIOD_MEAN[request.period] ?? SPEED_PERIOD_MEAN.today;
  const sources = sourceFixtures(request.period, row.status === 'unmeasured');
  if (row.status === 'unmeasured') return { ...row, period: request.period, range: speedRangeFor(request.period),
    state: 'recording', weightedTps: null, sources };
  return { ...row, period: request.period, range: speedRangeFor(request.period), state: 'recording', weightedTps: mean,
    trend: row.referenceOnly ? [] : trend, samples: 34, recentSamples: 8, gaps: 1, sources };
}
// Switching the window's own DAY/MONTH/TOTAL selection, the way a user does.
// The fixture then republishes a summary whose range matches, so Home's data and
// its label can never describe two different windows.
async function selectPeriod(period) {
  await evaluate(`window.__selectPeriod(${JSON.stringify(period)})`);
  activeStats = { ...activeStats, modelSpeed: { ...activeStats.modelSpeed, range: speedRangeFor(period) } };
  win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'presentation', mode: 'local', stats: activeStats } });
  await waitFor(`state.period === ${JSON.stringify(period)} && state.stats?.modelSpeed?.range?.period === ${JSON.stringify(period)}
    && (!window.TokenMonitorFixedPeriodRanges.isDerived(state.period)
      || (state.fixedPeriodSnapshot?.status === 'ready' && state.fixedPeriodSnapshot.selection === state.period))`);
  await settleFrames();
}
const viewportSizes = [[240, 900], [300, 620], [350, 920], [680, 720], [900, 900], [1200, 900], [1200, 160], [240, 140], [350, 1400]];
async function evaluatePage(callback, ...args) {
  return evaluate('(' + callback.toString() + ')(' + ['window', ...args.map(value => JSON.stringify(value))].join(',') + ')');
}
async function settleFrames() {
  await evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Renderer frame did not arrive')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  })`);
}
async function pause(ms) { await new Promise(resolve => setTimeout(resolve, ms)); }
async function resizeContent(width, height) {
  win.setContentSize(width, height);
  await settleFrames();
}
function pushFixtureStats(next = stats) {
  activeStats = next;
  win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'presentation', mode: 'local', stats: next } });
}
async function readLayout() {
  return evaluatePage(page => {
    const box = element => {
      if (!element) return null;
      const rect = element.getBoundingClientRect(), style = page.getComputedStyle(element);
      return { left: rect.left, top: rect.top, right: rect.right, bottom: rect.bottom,
        width: rect.width, height: rect.height, display: style.display,
        clientWidth: element.clientWidth, scrollWidth: element.scrollWidth,
        clientHeight: element.clientHeight, scrollHeight: element.scrollHeight };
    };
    const home = page.document.getElementById('homePanel');
    return { viewport: [page.innerWidth, page.innerHeight], pageWidth: page.document.documentElement.scrollWidth,
      pageHeight: page.document.documentElement.scrollHeight,
      total: box(page.document.getElementById('totalTokens')), cost: box(page.document.getElementById('cost')),
      home: box(home), detail: box(page.document.getElementById('modelSpeedPanel')),
      chart: box(page.document.querySelector('.home-area-chart')),
      lastModule: box(home.lastElementChild), footer: box(page.document.querySelector('.footer')),
      homePaddingBottom: parseFloat(page.getComputedStyle(home).paddingBottom) || 0,
      overflowingRows: [...page.document.querySelectorAll('.model-speed-row, .home-model-row, .home-limit-account, .home-session-row')]
        .filter(row => row.getClientRects().length && row.scrollWidth > row.clientWidth + 1)
        .map(row => ({ className: row.className, width: row.clientWidth, scrollWidth: row.scrollWidth }))
    };
  });
}
function assertLayout(layout, size, stage) {
  const label = stage + ' ' + size.join('x');
  assert.deepEqual(layout.viewport, size, label + ': actual viewport');
  assert.ok(layout.pageWidth <= size[0] + 1, label + ': document horizontal overflow');
  assert.ok(layout.pageHeight <= size[1] + 1, label + ': document vertical overflow');
  for (const key of ['total', 'cost']) {
    const rect = layout[key];
    assert.ok(rect && rect.width > 0 && rect.height > 0, label + ': ' + key + ' visible');
    assert.ok(rect.left >= -1 && rect.top >= -1 && rect.right <= size[0] + 1 && rect.bottom <= size[1] + 1,
      label + ': ' + key + ' outside viewport: ' + JSON.stringify(rect));
  }
  assert.ok(layout.total.scrollWidth <= layout.total.clientWidth + 1, label + ': exact total clips');
  assert.deepEqual(layout.overflowingRows, [], label + ': row horizontal overflow');
  if (stage === 'detail') {
    assert.equal(layout.detail.display === 'none', size[1] <= 240, label + ': short detail visibility');
    if (size[1] > 240) assert.ok(layout.detail.scrollWidth <= layout.detail.clientWidth + 1, label + ': detail width');
  }
}
async function verifyResponsiveLayouts() {
  await pause(1000);
  assert.equal(await evaluate('document.querySelectorAll(".home-limit-account").length'), 2);
  assert.ok(await evaluate('document.querySelectorAll(".heat[data-d]").length >= 74'));
  for (const size of viewportSizes) {
    await resizeContent(...size);
    await evaluate('document.getElementById("homePanel").scrollTop = 0');
    await settleFrames();
    const layout = await readLayout();
    audit.viewports.push({ stage: 'home', size, ...layout });
    assertLayout(layout, size, 'home');
    await capture('home-' + size.join('x') + '.png');
  }
  const regular = audit.viewports.find(item => item.stage === 'home' && item.size[0] === 350 && item.size[1] === 920);
  const tall = audit.viewports.find(item => item.stage === 'home' && item.size[0] === 350 && item.size[1] === 1400);
  assert.ok(tall.chart.height > regular.chart.height + 1, 'tall sidebar must give additional height to the trend chart');
  assert.ok(tall.home.scrollHeight <= tall.home.clientHeight + 1, 'tall fixture content should fit after growing the chart');
  const bottomGap = tall.home.bottom - tall.homePaddingBottom - tall.lastModule.bottom;
  assert.ok(Math.abs(bottomGap) <= 2, 'tall Home leaves unused space below the last module: ' + bottomGap);
  audit.tallLayout = { chartAt920: regular.chart.height, chartAt1400: tall.chart.height, bottomGap };

  await resizeContent(350, 920);
  await evaluate('document.querySelector("[data-speed-id=\\"fixture-speed-0\\"]").click()');
  await waitFor('document.querySelector("#modelSpeedPanel").textContent.includes("1,620")');
  await evaluate('window.__resizeDetailNode = document.querySelector(".model-speed-detail"); undefined');
  for (const size of viewportSizes) {
    await resizeContent(...size);
    const layout = await readLayout();
    audit.viewports.push({ stage: 'detail', size, ...layout });
    assertLayout(layout, size, 'detail');
    assert.equal(await evaluate('document.querySelector(".model-speed-detail") === window.__resizeDetailNode'), true);
    await capture('detail-' + size.join('x') + '.png');
  }
  await resizeContent(350, 920);
  assert.equal(await evaluate('getComputedStyle(document.getElementById("modelSpeedPanel")).display !== "none"'), true);
  assert.equal(await evaluate('window.__speedRangeCaption().length > 0'), true);
  await evaluate('document.getElementById("backHomeButton").click()');

  const sequence = [[350, 920], [400, 760], [500, 600], [680, 480], [900, 340], [1200, 280],
    [1200, 241], [1200, 240], [1200, 201], [1200, 200], [1200, 160], [800, 180],
    [480, 200], [300, 240], [240, 400], [350, 920]];
  for (const size of sequence) {
    await resizeContent(...size);
    const layout = await readLayout();
    audit.resizeSequence.push({ size, ...layout });
    assertLayout(layout, size, 'continuous');
  }
  // The headline tween changes TOTAL data, so select that window before pushing it.
  await selectPeriod('allTime');
  await pause(1100);
  const firstTarget = period.totalTokens + 1234567, latestTarget = period.totalTokens + 7654321;
  const statsWithTotal = total => ({ ...stats, snapshot: { ...stats.snapshot, id: 'resize-tween-' + total },
    periods: { ...stats.periods, allTime: { ...period, totalTokens: total } } });
  pushFixtureStats(statsWithTotal(firstTarget));
  await waitFor('Boolean(numberAnimHandle)');
  pushFixtureStats(statsWithTotal(latestTarget));
  await waitFor('numberAnimTarget === ' + latestTarget);
  await resizeContent(240, 140);
  const settled = await evaluate('({ handle: numberAnimHandle, value: numberAnimValue, text: document.getElementById("totalTokens").textContent })');
  audit.headlineResize = settled;
  assert.equal(settled.handle, 0, 'resize must settle the headline on the next layout frame');
  assert.equal(settled.value, latestTarget);
  assert.equal(settled.text, latestTarget.toLocaleString('en-US'));
  assertLayout(await readLayout(), [240, 140], 'active-count');
  await capture('headline-resized-during-count.png');
  pushFixtureStats(stats);
  await waitFor('state.currentTotal === ' + period.totalTokens);
  await resizeContent(350, 920);
  await selectPeriod('last7');
  return { sizes: viewportSizes, detailRestored: true, continuousSteps: sequence.length,
    latestHeadlineTarget: latestTarget, tallLayout: audit.tallLayout };
}
function runningSessionStats(count) {
  const timestamp = Date.now();
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => {
    const sessionId = '70000000-1000-4000-a000-' + String(i + 1).padStart(12, '0');
    return ['codex:' + sessionId, { client: 'codex', sessionId,
      title: '合成并发会话 ' + String(i + 1).padStart(2, '0'),
      totalTokens: 10000 + i * 200, costUsd: 0.12 + i * 0.01,
      models: { 'gpt-6.1-sol': 6000 + i * 100, 'gpt-6-astra': 4000 + i * 100 },
      lastUsedAt: new Date(timestamp - i * 1000).toISOString(),
      startedAt: new Date(timestamp - 1800000 - i * 1000).toISOString(), turnEnded: false }];
  }));
  return { ...stats, snapshot: { ...stats.snapshot, id: 'running-' + count },
    periods: Object.fromEntries(Object.entries(stats.periods).map(([key, value]) => [key, { ...value, sessions }])) };
}
async function verifySessionPopover(nextStats) {
  movePointer({ x: 8, y: 8 });
  await evaluatePage(page => {
    page.document.activeElement?.blur();
    const wrapper = page.document.querySelector('.home-session-meta .session-models.limit-detail-tooltip-wrap');
    if (!wrapper) throw new Error('Representative two-model session must expose its real detail tooltip');
    wrapper.scrollIntoView({ block: 'center', behavior: 'instant' });
    page.__sessionTooltipWrapper = wrapper;
  });
  await settleFrames();
  const anchor = await evaluatePage(page => {
    const rect = page.__sessionTooltipWrapper.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  const read = () => evaluatePage(page => {
    const wrapper = page.__sessionTooltipWrapper, tip = wrapper.querySelector('.limit-detail-tooltip');
    const rect = tip.getBoundingClientRect();
    return { connected: wrapper.isConnected, open: tip.matches(':popover-open'),
      closing: wrapper.classList.contains('is-closing') || tip.classList.contains('is-closing'),
      opacity: Number(page.getComputedStyle(tip).opacity), left: rect.left, top: rect.top,
      width: rect.width, height: rect.height };
  });
  const motion = audit.sessionPopover = { anchor };
  movePointer(anchor);
  await pause(280);
  motion.opened = await read();
  assert.equal(motion.opened.open, true);
  assert.equal(motion.opened.opacity, 1);
  await capture('session-tooltip-open.png');
  movePointer({ x: 8, y: 8 });
  await pause(60);
  motion.leaving = await read();
  assert.equal(motion.leaving.open, false);
  assert.equal(motion.leaving.closing, true);
  assert.ok(motion.leaving.opacity > 0 && motion.leaving.opacity < 1, 'real session popover retains its exit transition');
  assert.ok(Math.abs(motion.leaving.left - motion.opened.left) < 1);
  assert.ok(Math.abs(motion.leaving.top - motion.opened.top) <= 3);
  pushFixtureStats({ ...nextStats, snapshot: { ...nextStats.snapshot, id: 'session-tooltip-exit-poll' } });
  await settleFrames();
  assert.equal(await evaluate('window.__sessionTooltipWrapper.isConnected'), true, 'poll must hold the actual closing tooltip host');
  movePointer(anchor);
  await pause(300);
  motion.reentered = await read();
  assert.equal(motion.reentered.connected, true);
  assert.equal(motion.reentered.open, true);
  assert.equal(motion.reentered.opacity, 1);
  assert.equal(motion.reentered.closing, false);
  movePointer({ x: 8, y: 8 });
  await pause(300);
  motion.closed = await read();
  assert.equal(motion.closed.open, false);
  assert.equal(motion.closed.closing, false);
  assert.equal(motion.closed.opacity, 0);
  return motion;
}
async function verifyRunningSessionPreviews() {
  // Live session fixtures populate DAY; seven-day history has no session records.
  await selectPeriod('today');
  let latest;
  for (const count of [14, 24]) {
    latest = runningSessionStats(count);
    pushFixtureStats(latest);
    await waitFor('state.stats.snapshot.id === ' + JSON.stringify(latest.snapshot.id));
    await waitFor('document.querySelectorAll(".home-session-row").length === window.TokenMonitorHomeRowBudget.previewCount(5, ' + count + ')');
    // Capture the settled shared chart reveal, not an incidental mid-stroke frame.
    await pause(1000);
    for (const size of [[350, 1400], [350, 620]]) {
      await resizeContent(...size);
      await evaluate('document.getElementById("homePanel").scrollTop = 0');
      await settleFrames();
      const preview = await evaluatePage(page => {
        const module = page.document.querySelector('.home-module-session');
        const more = module.querySelector('.home-session-more');
        const rows = [...module.querySelectorAll('.home-session-row')];
        const visible = rows.filter(row => row.getClientRects().length);
        return { rows: rows.length, visibleRows: visible.length,
          previewCap: page.TokenMonitorHomeRowBudget.previewCount(5, Number.MAX_SAFE_INTEGER),
          runningRows: visible.filter(row => row.querySelector('.home-session-state[data-state="running"]')).length,
          meta: module.querySelector('.home-module-meta').textContent,
          more: Boolean(more && more.getClientRects().length),
          modules: [...page.document.querySelectorAll('#homePanel > .home-module')].map(item => item.className) };
      });
      const layout = await readLayout();
      const item = { count, size, preview, layout };
      audit.sessionPreviews.push(item);
      assert.equal(preview.rows, Math.min(count, preview.previewCap));
      assert.equal(preview.visibleRows, await evaluate('state.homeRowBudgetPlan.rows[[...document.getElementById("homePanel").children].indexOf(document.querySelector(".home-module-session"))]'));
      assert.ok(preview.visibleRows >= 1 && preview.visibleRows <= preview.rows);
      assert.equal(preview.runningRows, preview.visibleRows);
      assert.match(preview.meta, new RegExp('\\b' + count + '\\b'), 'Home must count all running sessions');
      assert.equal(preview.more, true);
      assertLayout(layout, size, 'running-' + count);
      assert.ok(layout.footer.top >= 0 && layout.footer.bottom <= size[1] + 1, 'footer stays within the viewport');
      await capture('home-running-' + count + '-' + size.join('x') + '.png');
      await evaluate('document.getElementById("homePanel").scrollTop = document.getElementById("homePanel").scrollHeight');
      await settleFrames();
      const bottom = await readLayout();
      item.bottom = bottom;
      assert.ok(bottom.lastModule.top < bottom.home.bottom && bottom.lastModule.bottom <= bottom.home.bottom + 1,
        'remaining Home modules stay reachable at the scroll end');
      await capture('home-running-' + count + '-' + size.join('x') + '-end.png');
    }
    await evaluate('document.querySelector(".home-session-more").click()');
    await waitFor('state.breakdown === "session"');
    assert.equal(await evaluate('rawSessionRowsForPeriod(state.stats.periods[state.period]).length'), count);
    assert.equal(await evaluate('document.getElementById("viewBackRow").classList.contains("hidden")'), false);
    await evaluate('document.getElementById("backHomeButton").click()');
    await waitFor('state.breakdown === "home"');
  }
  await verifySessionPopover(latest);
  pushFixtureStats(stats);
  await waitFor('document.querySelectorAll(".home-session-row").length === 0');
  await resizeContent(350, 920);
  await selectPeriod('last7');
  return { counts: [14, 24], sizes: [[350, 1400], [350, 620]], measuredRowAllocation: true, allSessionsReachable: true,
    actualPopoverExitAndReentry: true };
}
async function verifyScrollEdges() {
  await resizeContent(350, 620);
  const edges = {};
  for (const position of ['top', 'middle', 'end']) {
    await evaluatePage((page, location) => {
      const panel = page.document.getElementById('homePanel'), extent = panel.scrollHeight - panel.clientHeight;
      panel.scrollTop = location === 'top' ? 0 : location === 'middle' ? extent / 2 : extent;
    }, position);
    await settleFrames();
    const edge = await evaluatePage(page => {
      const panel = page.document.getElementById('homePanel'), style = page.getComputedStyle(panel);
      return { extent: panel.scrollHeight - panel.clientHeight, position: panel.scrollTop,
        top: parseFloat(style.getPropertyValue('--scroll-fade-top')),
        bottom: parseFloat(style.getPropertyValue('--scroll-fade-bottom')), mask: style.maskImage };
    });
    edges[position] = edge;
    audit.scrollEdges = edges;
    assert.ok(edge.extent > 36, 'representative Home must exercise scroll clipping');
    assert.match(edge.mask, /linear-gradient/);
    assert.equal(edge.top > 0, position !== 'top');
    assert.equal(edge.bottom > 0, position !== 'end');
    await capture('home-scroll-' + position + '.png');
  }
  return edges;
}
async function verifyModuleHover() {
  movePointer({ x: 8, y: 8 });
  await evaluate('document.querySelector(".home-module-trends").scrollIntoView({ block: "center", behavior: "instant" })');
  await settleFrames();
  const target = await evaluatePage(page => {
    const module = page.document.querySelector('.home-module-trends'), rect = module.getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + Math.min(60, rect.height / 2)) };
  });
  movePointer(target);
  await pause(180);
  const result = await evaluatePage(page => {
    const module = page.document.querySelector('.home-module-trends');
    return { hovered: module.matches(':hover'), background: page.getComputedStyle(module).backgroundColor,
      emphasis: page.getComputedStyle(module, '::before').content,
      sparkBackground: page.document.querySelector('.trends-spark')
        ? page.getComputedStyle(page.document.querySelector('.trends-spark')).backgroundColor : null };
  });
  assert.equal(result.hovered, true);
  assert.equal(result.background, 'rgba(0, 0, 0, 0)');
  assert.equal(result.emphasis, 'none');
  if (result.sparkBackground !== null) assert.equal(result.sparkBackground, 'rgba(0, 0, 0, 0)');
  await capture('home-column-without-emphasis.png');
  movePointer({ x: 8, y: 8 });
  return result;
}
async function readHeatMotion() {
  return evaluatePage(page => {
    const scroller = page.document.querySelector('.home-activity-scroll');
    const tooltip = page.document.querySelector('.home-activity-tooltip');
    const gradient = page.document.getElementById('homeActivitySpotlightGradient');
    return { glow: Number(page.getComputedStyle(scroller.querySelector('.heat-bright-layer')).opacity),
      text: Number(page.getComputedStyle(tooltip).opacity), tooltipVisible: tooltip.dataset.visible === 'true',
      spotlightVisible: scroller.classList.contains('is-spotlight-visible'),
      scrollerHovered: scroller.matches(':hover'), scrollerClass: scroller.className,
      pointerEvents: (page.__heatPointerEvents || []).slice(-12),
      cx: Number(gradient.getAttribute('cx')), cy: Number(gradient.getAttribute('cy')),
      transform: tooltip.style.transform };
  });
}
function movePointer(point) { win.webContents.sendInputEvent({ type: 'mouseMove', x: point.x, y: point.y }); }
async function verifyHeatmapMotion() {
  movePointer({ x: 8, y: 8 });
  await evaluate('document.querySelector(".home-activity-scroll").scrollIntoView({ block: "center", behavior: "instant" })');
  await settleFrames();
  const targets = await evaluatePage(page => {
    const scroller = page.document.querySelector('.home-activity-scroll'), panel = page.document.getElementById('homePanel');
    const clip = scroller.getBoundingClientRect(), panelRect = panel.getBoundingClientRect();
    const cells = [...scroller.querySelectorAll('.heat[data-d]')].map(cell => ({ cell, rect: cell.getBoundingClientRect() }));
    const outside = [...panel.querySelectorAll('.model-speed-row, .home-model-row, .home-module-head, .home-area-chart')].map(element => {
      const rect = element.getBoundingClientRect();
      return { element, x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
    }).find(item => item.y > panelRect.top + 20 && item.y < panelRect.bottom - 20
      && (item.y < clip.top - 5 || item.y > clip.bottom + 5)
      && item.element.contains(page.document.elementFromPoint(item.x, item.y)));
    if (!outside) throw new Error('No visible non-drag Home row outside the heatmap');
    page.__heatPointerEvents = [];
    for (const type of ['pointermove', 'pointerover', 'pointerout', 'pointerenter', 'pointerleave']) {
      page.document.addEventListener(type, event => {
        const target = event.target, related = event.relatedTarget;
        page.__heatPointerEvents.push({ type, x: event.clientX, y: event.clientY,
          target: target?.getAttribute?.('class') || target?.tagName,
          related: related?.getAttribute?.('class') || related?.tagName,
          currentHeatmap: target === page.document.querySelector('.home-activity-scroll') });
      }, true);
    }
    for (const item of cells) {
      const rect = item.rect;
      if (!(Number(item.cell.dataset.t) > 0) || rect.left < clip.left + 3 || rect.right > clip.right - 5
        || rect.top < Math.max(clip.top, panelRect.top) + 1 || rect.bottom > Math.min(clip.bottom, panelRect.bottom) - 1) continue;
      const next = cells.find(other => Math.abs(other.rect.top - rect.top) < 0.5 && other.rect.left > rect.right
        && other.rect.left - rect.right < 5);
      if (!next) continue;
      const gap = { x: Math.round((rect.right + next.rect.left) / 2), y: Math.round(rect.top + rect.height / 2) };
      const hit = page.document.elementFromPoint(gap.x, gap.y);
      if (!hit || !scroller.contains(hit) || hit.closest('.heat[data-d]')) continue;
      return { cell: { x: Math.round(rect.left + rect.width / 2), y: gap.y }, gap,
        outside: { x: outside.x, y: outside.y }, date: item.cell.dataset.d };
    }
    throw new Error('No visible real heatmap cell/gap pair found');
  });
  const motion = audit.heatmapMotion = { targets };
  movePointer(targets.cell);
  await pause(200);
  const entered = motion.entered = await readHeatMotion();
  assert.ok(entered.glow > 0.98 && entered.text > 0.98, 'heat cell should reveal both glow and label');
  await capture('heatmap-hover.png');
  movePointer(targets.outside);
  await pause(60);
  const leaving = motion.leaving = await readHeatMotion();
  assert.ok(leaving.glow > 0 && leaving.glow < 1, 'glow must fade rather than disappear on leave');
  assert.ok(leaving.text > 0 && leaving.text < 1, 'label must fade rather than disappear on leave');
  assert.equal(leaving.cx, entered.cx);
  assert.equal(leaving.cy, entered.cy);
  assert.equal(leaving.transform, entered.transform);
  await pause(260);
  const hidden = motion.hidden = await readHeatMotion();
  assert.ok(hidden.glow < 0.01 && hidden.text < 0.01);
  movePointer(targets.cell);
  await pause(180);
  movePointer(targets.gap);
  await pause(300);
  const gap = motion.gap = await readHeatMotion();
  assert.equal(gap.spotlightVisible, true);
  assert.equal(gap.tooltipVisible, false);
  assert.ok(gap.glow > 0.98 && gap.text < 0.01, 'a real cell gap keeps the spotlight but hides its label');
  await evaluate('window.__oldHeatmapScroller = document.querySelector(".home-activity-scroll"); undefined');
  pushFixtureStats({ ...stats, snapshot: { ...stats.snapshot, id: 'heatmap-gap-refresh' } });
  await waitFor('document.querySelector(".home-activity-scroll") !== window.__oldHeatmapScroller');
  await settleFrames();
  await pause(80);
  const afterGapPoll = motion.afterGapPoll = await readHeatMotion();
  assert.equal(afterGapPoll.spotlightVisible, true);
  assert.equal(afterGapPoll.tooltipVisible, false);
  assert.ok(afterGapPoll.glow > 0.98 && afterGapPoll.text < 0.01, 'a poll must preserve a stationary gap spotlight');
  assert.ok(Math.abs(afterGapPoll.cx - gap.cx) < 0.2 && Math.abs(afterGapPoll.cy - gap.cy) < 0.2);
  await capture('heatmap-gap-after-poll.png');
  movePointer({ x: 8, y: 8 });
  await pause(60);
  motion.gapLeavingDragCorner = await readHeatMotion();
  movePointer(targets.outside);
  await pause(60);
  const gapLeaving = motion.gapLeaving = await readHeatMotion();
  assert.ok(gapLeaving.glow > 0 && gapLeaving.glow < 1);
  assert.equal(gapLeaving.cx, afterGapPoll.cx);
  assert.equal(gapLeaving.cy, afterGapPoll.cy);
  movePointer(targets.gap);
  await pause(180);
  const reentered = motion.reentered = await readHeatMotion();
  assert.ok(reentered.glow > 0.98 && reentered.text < 0.01);
  movePointer(targets.outside);
  await pause(300);
  const final = motion.final = await readHeatMotion();
  assert.ok(final.glow < 0.01 && final.text < 0.01);
  return motion;
}

async function verifyCurveAppearance() {
  const curve = await evaluatePage(page => {
    const svg = page.document.querySelector('#modelSpeedPanel .model-speed-chart');
    const line = svg.querySelector('.model-speed-line'), area = svg.querySelector('.model-speed-area');
    const gradient = svg.querySelector('linearGradient'), style = page.getComputedStyle(line);
    const dates = [...page.document.querySelectorAll('#modelSpeedPanel .model-speed-dates > span')];
    const ids = [...page.document.querySelectorAll('[id^="model-speed-gradient-"]')].map(item => item.id);
    return { line: line.getAttribute('d'), area: area.getAttribute('d'), fill: area.getAttribute('fill'),
      gradient: gradient.id, strokeWidth: parseFloat(style.strokeWidth), vectorEffect: style.vectorEffect,
      stopOpacity: [...gradient.children].map(stop => Number(page.getComputedStyle(stop).stopOpacity)),
      dateLabels: dates.map(item => item.textContent), fullDateTitles: dates.every(item => item.title.length > 0),
      gradientCount: ids.length, uniqueGradients: new Set(ids).size };
  });
  assert.match(curve.line, /C/, 'detail uses the shared smooth curve');
  assert.equal((curve.line.match(/M/g) || []).length, 2, 'measured gaps remain separate stroke segments');
  assert.equal((curve.area.match(/M/g) || []).length, 2, 'area must not bridge a missing interval');
  assert.equal((curve.area.match(/Z/g) || []).length, 2);
  assert.equal(curve.fill, 'url(#' + curve.gradient + ')');
  assert.equal(curve.strokeWidth, 2);
  assert.equal(curve.vectorEffect, 'non-scaling-stroke');
  assert.deepEqual(curve.stopOpacity, [0.22, 0]);
  assert.equal(curve.dateLabels.length, 3);
  assert.ok(curve.dateLabels.every(label => /^\d{2}:\d{2}$/.test(label)), 'sub-day histories use distinct clock ticks');
  assert.equal(curve.fullDateTitles, true);
  assert.equal(curve.gradientCount, curve.uniqueGradients);
  audit.curveAppearance = curve;
  return curve;
}

async function verifySpeedChartHover(label = 'default') {
  await evaluate(`document.querySelector('#modelSpeedPanel .model-speed-chart').scrollIntoView({ block: 'center', behavior: 'instant' })`);
  await settleFrames();
  const geometry = await evaluatePage(page => {
    const svg = page.document.querySelector('#modelSpeedPanel .model-speed-chart');
    const rect = svg.getBoundingClientRect();
    return { x: rect.x, y: rect.y, width: rect.width, height: rect.height,
      role: svg.getAttribute('role'), label: svg.getAttribute('aria-label') };
  });
  assert.equal(geometry.role, 'img');
  assert.match(geometry.label, /悬停/);
  const firstAt = trend[0].at, lastAt = trend.at(-1).at;
  const pointFor = at => ({ x: Math.round(geometry.x + (2 + (at - firstAt) / (lastAt - firstAt) * 296) / 300 * geometry.width),
    y: Math.round(geometry.y + geometry.height / 2) });
  const visible = 'document.querySelector(".model-speed-chart-tooltip:not([hidden])") !== null';
  const snapshot = () => evaluatePage(page => {
    const tooltip = page.document.querySelector('.model-speed-chart-tooltip');
    const rect = tooltip.getBoundingClientRect();
    const chart = page.document.querySelector('#modelSpeedPanel .model-speed-chart');
    const marker = chart.querySelector('.model-speed-chart-marker');
    return { text: tooltip.textContent, at: Number(tooltip.dataset.sampleAt), hidden: tooltip.hidden,
      rates: [...tooltip.querySelectorAll('.model-speed-chart-tooltip-rate')].map(node => node.textContent),
      samples: tooltip.querySelector('.model-speed-chart-tooltip-samples').textContent,
      date: tooltip.querySelector('.model-speed-chart-tooltip-date').textContent,
      fits: rect.left >= 7 && rect.right <= page.innerWidth - 7 && rect.top >= 7 && rect.bottom <= page.innerHeight - 7,
      markerVisible: Number(page.getComputedStyle(marker).opacity) === 1,
      guideX: Number(chart.querySelector('.model-speed-chart-guide').getAttribute('x1')),
      tooltipCount: page.document.querySelectorAll('.model-speed-chart-tooltip').length };
  });
  const readings = [];
  for (const index of [0, 5, 15]) {
    movePointer(pointFor(trend[index].at));
    await waitFor(`(${visible}) && document.querySelector('.model-speed-chart-tooltip').dataset.sampleAt === '${trend[index].at}'`);
    const reading = await snapshot();
    assert.equal(reading.at, trend[index].at, 'hover uses the actual nearest bucket');
    assert.deepEqual(reading.rates, [trend[index].tps.toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' TPS',
      (trend[index].tps * 60).toLocaleString(undefined, { maximumFractionDigits: 1 }) + ' TPM']);
    assert.equal(reading.samples, `${trend[index].samples} 有效采样`);
    assert.match(reading.date, /\d{2}:\d{2}.*–.*\d{2}:\d{2}/);
    assert.ok(reading.fits && reading.markerVisible);
    assert.equal(reading.tooltipCount, 1);
    readings.push(reading);
  }
  await capture(`detail-hover-${label}.png`);
  movePointer(pointFor((trend[7].at + trend[8].at) / 2));
  await waitFor(`!(${visible})`);
  const midpoint = pointFor(trend[0].at + (trend[1].at - trend[0].at) * 0.3);
  const midpointHit = await evaluatePage((page, point) => {
    const target = page.document.elementFromPoint(Math.round(point.x), Math.round(point.y));
    return { chart: Boolean(target?.closest('.model-speed-chart')), tag: target?.tagName, className: target?.getAttribute('class') };
  }, midpoint);
  assert.equal(midpointHit.chart, true, 'the plot hit region: ' + JSON.stringify(midpointHit));
  movePointer(midpoint);
  await waitFor(visible);
  assert.equal((await snapshot()).at, trend[0].at, 'between samples uses a measured value');
  movePointer({ x: 8, y: 8 });
  await waitFor(`!(${visible})`);
  await evaluate(`document.querySelector('#modelSpeedPanel .model-speed-chart').focus()`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'HOME' });
  await waitFor(visible);
  assert.equal((await snapshot()).at, firstAt);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'RIGHT' });
  await waitFor(`document.querySelector('.model-speed-chart-tooltip').dataset.sampleAt === '${trend[1].at}'`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'END' });
  await waitFor(`document.querySelector('.model-speed-chart-tooltip').dataset.sampleAt === '${lastAt}'`);
  win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'ESCAPE' });
  await waitFor(`!(${visible})`);
  assert.equal(await evaluate(`document.getElementById('modelSpeedPanel').classList.contains('hidden')`), false, 'Escape first dismisses the sample tooltip');
  await evaluate(`document.querySelector('#backHomeButton').focus()`);
  audit.chartHover ||= [];
  const result = { label, geometry, readings, gapHidden: true, nearestBucket: true, keyboard: true, escapeKeepsDetail: true };
  audit.chartHover.push(result);
  return result;
}

async function verifyFooterWidths() {
  const layouts = [];
  const initialNative = await evaluate('document.documentElement.classList.contains("native-liquid-glass")');
  const menuVisible = '(() => { const menu = document.querySelector("#viewSwitcherMenu"); const style = menu && getComputedStyle(menu); return Boolean(menu && menu.getAttribute("aria-hidden") === "false" && style.visibility === "visible" && Number(style.opacity) > 0.99); })()';
  const menuHidden = '(() => { const menu = document.querySelector("#viewSwitcherMenu"); const style = menu && getComputedStyle(menu); return Boolean(menu && menu.getAttribute("aria-hidden") === "true" && style.visibility === "hidden" && Number(style.opacity) < 0.01); })()';
  for (const native of [false, true]) {
    await evaluatePage((page, enabled) => page.document.documentElement.classList.toggle('native-liquid-glass', enabled), native);
    for (const width of [240, 280, 300, 350, 680]) {
      await resizeContent(width, 620);
      const layout = await evaluatePage(page => {
        const rect = element => {
          if (!element) return { visible: false };
          const box = element.getBoundingClientRect(), style = page.getComputedStyle(element);
          return { visible: box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none' && Number(style.opacity) > 0.01,
            opacity: Number(style.opacity), left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width, height: box.height };
        };
        const current = page.document.querySelector('.view-switcher-current');
        const selectors = { current: '.view-switcher-current', disclosure: '.view-switcher-disclosure',
          rate: '#liveTokenRate', refresh: '#refreshButton', settings: '#settingsButton' };
        return { width: page.innerWidth, enabled: page.document.querySelector('.footer').classList.contains('live-token-rate-enabled'),
          native: page.document.documentElement.classList.contains('native-liquid-glass'),
          labelVisible: rect(current.querySelector('.view-switcher-label')).visible,
          currentName: current.getAttribute('aria-label') || current.title,
          controls: Object.fromEntries(Object.entries(selectors).map(([name, selector]) => [name, rect(page.document.querySelector(selector))])) };
      });
      layouts.push(layout);
      audit.footerWidths = layouts;
      assert.equal(layout.width, width);
      assert.equal(layout.enabled, true);
      assert.equal(layout.native, native);
      assert.equal(layout.controls.disclosure.visible, width > 300, 'dropdown follows the available-width rule');
      assert.equal(layout.labelVisible, width > 300);
      if (width <= 300) {
        assert.ok(Math.abs(layout.controls.current.width - 30) <= 1, 'narrow Home keeps a 30px icon button');
        assert.ok(layout.currentName && layout.currentName.length > 0);
      }
      const controls = Object.entries(layout.controls).filter(([, item]) => item.visible);
      for (const [name, item] of controls) {
        assert.ok(item.left >= -1 && item.right <= width + 1 && item.top >= -1 && item.bottom <= 621,
          name + ' leaves the viewport at ' + width);
      }
      for (let first = 0; first < controls.length; first++) {
        for (let second = first + 1; second < controls.length; second++) {
          const [aName, a] = controls[first], [bName, b] = controls[second];
          const overlapX = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const overlapY = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          assert.ok(overlapX <= 1 || overlapY <= 1, aName + ' collides with ' + bName + ' at ' + width + 'px');
        }
      }
      await capture('footer-' + width + 'x620-' + (native ? 'native' : 'standard') + '.png');
      if (native && width === 240) {
        const button = layout.controls.current;
        const point = { x: Math.round(button.left + button.width / 2), y: Math.round(button.top + button.height / 2) };
        movePointer(point);
        win.webContents.sendInputEvent({ type: 'mouseDown', ...point, button: 'right', clickCount: 1 });
        win.webContents.sendInputEvent({ type: 'mouseUp', ...point, button: 'right', clickCount: 1 });
        await waitFor(menuVisible);
        await waitFor('Boolean(document.activeElement.closest("#viewSwitcherMenu"))');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await waitFor(menuHidden);
        assert.equal(await evaluate('document.activeElement.classList.contains("view-switcher-current")'), true,
          'Escape restores focus to the visible narrow Home button');
        layout.escapeFocusRestored = true;
      }
      if (native && width === 350) {
        await evaluatePage(page => page.document.querySelector('.view-switcher-disclosure').click());
        await waitFor(menuVisible);
        await waitFor('Boolean(document.activeElement.closest("#viewSwitcherMenu"))');
        win.webContents.sendInputEvent({ type: 'keyDown', keyCode: 'Escape' });
        win.webContents.sendInputEvent({ type: 'keyUp', keyCode: 'Escape' });
        await waitFor(menuHidden);
        layout.wideDropdownOpened = true;
      }
    }
  }
  await evaluatePage((page, enabled) => page.document.documentElement.classList.toggle('native-liquid-glass', enabled), initialNative);
  movePointer({ x: 8, y: 8 });
  await resizeContent(350, 920);
  return layouts;
}

async function verifyUnmeasuredCandidate() {
  await resizeContent(350, 920);
  const names = ['Muse', ...Array.from({ length: 11 }, (_, index) => 'untimed-model-' + String(index + 2).padStart(2, '0'))];
  const modelTotals = Object.fromEntries(names.map(model => [model, 800]));
  const today = { ...period, totalTokens: 9600, outputTokens: 4800, timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0,
    models: modelTotals, modelOutputs: Object.fromEntries(names.map(model => [model, 400])), modelThroughput: {}, clients: { dsh: 9600 },
    clientModels: { dsh: modelTotals }, capabilities: { tokenComponents: true, throughput: true } };
  const next = { ...stats, snapshot: { ...stats.snapshot, id: 'unmeasured-candidate' },
    periods: { ...stats.periods, today },
    modelSpeed: { ...stats.modelSpeed, selection: 'active-then-today-usage', models: [unmeasuredModel, ...speedModels] } };
  settings.showLiveTokenRate = true;
  settings.tokenRateMode = 'speed';
  settings.clients = 'codex,dsh';
  win.webContents.send('settings:push', settings);
  pushFixtureStats(next);
  await waitFor('Boolean(document.querySelector("[data-speed-id=fixture-speed-unmeasured]"))');
  await evaluatePage(page => page.document.querySelector('[data-speed-id="fixture-speed-unmeasured"]')
    .scrollIntoView({ block: 'center', behavior: 'instant' }));
  const row = await evaluatePage(page => {
    const item = page.document.querySelector('[data-speed-id="fixture-speed-unmeasured"]');
    const head = page.document.querySelector('.home-module-modelspeed .home-module-head');
    return { metrics: item.querySelector('.model-speed-row-metrics').textContent,
      status: item.querySelector('.model-speed-status').textContent, hasGraph: Boolean(item.querySelector('.model-speed-row-spark svg')),
      label: head.querySelector('.home-module-label').textContent,
      metaPresent: Boolean(head.querySelector('.home-module-meta')), title: head.title };
  });
  assert.match(row.metrics, /—/);
  assert.doesNotMatch(row.metrics, /\d/);
  assert.equal(row.hasGraph, false);
  assert.equal(row.label, '模型速度');
  assert.equal(row.metaPresent, false);
  assert.doesNotMatch(row.title, /活跃优先|90|TPS/);
  await pause(1000);
  await capture('home-unmeasured-candidate.png');
  await waitFor('document.getElementById("liveTokenRate").getClientRects().length > 0');
  const footerWidths = process.env.TM_SPEED_SOURCE_FOCUS_ONLY === '1' ? [] : await verifyFooterWidths();
  await resizeContent(350, 300);
  const rateTarget = () => evaluatePage(page => {
    const rect = page.document.getElementById('liveTokenRate').getBoundingClientRect();
    return { x: Math.round(rect.left + rect.width / 2), y: Math.round(rect.top + rect.height / 2) };
  });
  const readRate = () => evaluatePage(page => {
    const host = page.document.getElementById('liveTokenRate'), tooltip = host.querySelector('.limit-detail-tooltip');
    const rect = tooltip.getBoundingClientRect(), style = page.getComputedStyle(tooltip);
    // The shared decorative arrow extends the scrollHeight, so inspect actual content and scrollability.
    const contentFits = [...tooltip.querySelectorAll('.limit-detail-tooltip-row > span, .limit-detail-tooltip-full')].every(item => {
      const box = item.getBoundingClientRect();
      return box.left >= rect.left && box.right <= rect.right && box.top >= rect.top && box.bottom <= rect.bottom;
    });
    tooltip.scrollTop = 1;
    const scrollTop = tooltip.scrollTop;
    tooltip.scrollTop = 0;
    const notes = [...tooltip.querySelectorAll('.limit-detail-tooltip-full')].map(item => ({
      text: item.textContent.trim(), height: item.getBoundingClientRect().height,
      lineHeight: parseFloat(page.getComputedStyle(item).lineHeight) || parseFloat(style.fontSize) * 1.5 }));
    return { coverage: host.dataset.coverage, value: page.document.getElementById('liveTokenRateValue').textContent,
      tooltip: tooltip.textContent, open: tooltip.matches(':popover-open'),
      rows: [...tooltip.querySelectorAll('.limit-detail-tooltip-row')].map(item => item.textContent.trim()),
      notes, contentFits, scrollTop, height: rect.height, scrollHeight: tooltip.scrollHeight, clientHeight: tooltip.clientHeight,
      overflow: style.overflowY, fits: rect.left >= -1 && rect.top >= -1 && rect.right <= page.innerWidth + 1 && rect.bottom <= page.innerHeight + 1 };
  });
  const assertCompact = (reading) => {
    assert.equal(reading.open, true);
    assert.ok(reading.rows.length <= 3, 'footer keeps at most three recent measured models');
    assert.ok(reading.notes.length <= 1);
    assert.ok(reading.notes.every(note => note.height <= note.lineHeight + 1), 'the coverage note stays on one line');
    assert.equal(reading.contentFits, true, 'all tooltip text stays inside its compact surface');
    assert.equal(reading.scrollTop, 0, 'compact tooltip must not scroll');
    assert.ok(!['auto', 'scroll'].includes(reading.overflow), 'tooltip keeps the original scrollbar-free style');
    assert.equal(reading.fits, true);
  };
  movePointer(await rateTarget());
  await pause(240);
  const rateCoverage = { unmeasured: await readRate() };
  audit.unmeasuredCandidate = { row, footerWidths, rateCoverage };
  assertCompact(rateCoverage.unmeasured);
  assert.match(rateCoverage.unmeasured.value, /—/);
  assert.deepEqual(rateCoverage.unmeasured.rows, []);
  assert.deepEqual(rateCoverage.unmeasured.notes.map(note => note.text), ['暂无速率数据']);
  assert.doesNotMatch(rateCoverage.unmeasured.tooltip, /Muse|untimed-model/);
  await capture('footer-unmeasured-350x300.png');
  movePointer({ x: 8, y: 8 });
  await pause(300);

  // Produce real tracker deltas for four timed models; the UI should keep the top three.
  const measured = ['timed-a', 'timed-b', 'timed-c', 'timed-d'].map((model, index) => ({
    model, total: 40 + index * 20, output: 20 + index * 10
  }));
  const timedToday = { ...today, totalTokens: 9880, outputTokens: 4940,
    timedTokens: 280, timedOutputTokens: 140, timedDurationMs: 4000,
    models: { ...modelTotals, ...Object.fromEntries(measured.map(item => [item.model, item.total])) },
    modelOutputs: { ...today.modelOutputs, ...Object.fromEntries(measured.map(item => [item.model, item.output])) },
    modelThroughput: Object.fromEntries(measured.map(item => [item.model,
      { timedTokens: item.total, timedOutputTokens: item.output, timedDurationMs: 1000 }])),
    clients: { dsh: 9600, codex: 280 },
    clientModels: { dsh: modelTotals, codex: Object.fromEntries(measured.map(item => [item.model, item.total])) } };
  pushFixtureStats({ ...next, snapshot: { ...next.snapshot, id: 'unmeasured-candidate-timed' },
    periods: { ...next.periods, today: timedToday } });
  await waitFor('document.querySelectorAll("#liveTokenRate .limit-detail-tooltip-row").length === 3');
  movePointer(await rateTarget());
  await pause(240);
  rateCoverage.measured = await readRate();
  assertCompact(rateCoverage.measured);
  assert.equal(rateCoverage.measured.rows.length, 3);
  for (const [index, model] of ['timed-d', 'timed-c', 'timed-b'].entries()) assert.ok(rateCoverage.measured.rows[index].includes(model));
  assert.doesNotMatch(rateCoverage.measured.tooltip, /timed-a|untimed-model|Muse/);
  assert.deepEqual(rateCoverage.measured.notes.map(note => note.text), ['部分模型暂无速率']);
  await capture('footer-measured-compact-350x300.png');
  movePointer({ x: 8, y: 8 });
  await pause(60);
  const leaving = rateCoverage.leaving = await evaluatePage(page => {
    const tooltip = page.document.querySelector('#liveTokenRate .limit-detail-tooltip');
    return { open: tooltip.matches(':popover-open'), opacity: Number(page.getComputedStyle(tooltip).opacity) };
  });
  assert.equal(leaving.open, false);
  assert.ok(leaving.opacity > 0 && leaving.opacity < 1, 'the compact tooltip still fades on leave');
  await pause(260);
  assert.equal(await evaluate('Number(getComputedStyle(document.querySelector("#liveTokenRate .limit-detail-tooltip")).opacity)'), 0);
  await resizeContent(350, 920);
  await evaluatePage(page => page.document.querySelector('[data-speed-id="fixture-speed-unmeasured"]').click());
  await waitFor('Boolean(document.querySelector("#modelSpeedPanel .model-speed-status.unmeasured"))');
  const detail = await evaluatePage(page => {
    const panel = page.document.getElementById('modelSpeedPanel');
    return { note: panel.querySelector('.model-speed-state.waiting')?.textContent,
      figures: Boolean(panel.querySelector('.model-speed-figures')), chart: Boolean(panel.querySelector('.model-speed-chart')),
      baseline: Boolean(panel.querySelector('.model-speed-stats')),
      source: panel.querySelector('.model-speed-sources')?.textContent,
      sourceRate: panel.querySelector('.model-speed-source-rate')?.textContent,
      sourceFits: panel.querySelector('.model-speed-sources').scrollWidth <= panel.querySelector('.model-speed-sources').clientWidth + 1 };
  });
  assert.ok(detail.note && detail.note.length > 10);
  assert.equal(detail.figures, false);
  assert.equal(detail.chart, false);
  assert.equal(detail.baseline, false);
  assert.match(detail.source, /opencode-go.*订阅/);
  assert.match(detail.source, /#eeeeeeee/);
  assert.match(detail.source, /已记录来源 · 无原生耗时/);
  assert.equal(detail.sourceRate, '—');
  assert.equal(detail.sourceFits, true);
  await capture('detail-unmeasured-candidate.png');
  await evaluatePage(page => page.document.getElementById('backHomeButton').click());
  audit.unmeasuredFocus = await evaluate(`(() => {
    const row = document.querySelector('[data-speed-id="fixture-speed-unmeasured"]');
    return { active: { tag: document.activeElement.tagName, id: document.activeElement.id,
      className: document.activeElement.className, speedId: document.activeElement.dataset.speedId },
      row: row && { display: getComputedStyle(row).display, rects: row.getClientRects().length },
      homeHidden: document.getElementById('homePanel').classList.contains('hidden'),
      pendingRender: homeSessionRenderPending, open: Boolean(state.openModelSpeed), plan: state.homeRowBudgetPlan };
  })()`);
  assert.equal(await evaluate('document.activeElement.dataset.speedId'), 'fixture-speed-unmeasured');
  assert.equal(await evaluate('window.__speedPolls.size'), 0);
  await evaluatePage(page => page.document.querySelector('[data-speed-id="fixture-speed-0"]').click());
  await waitFor('Boolean(document.querySelector("#modelSpeedPanel .model-speed-chart"))');
  await resizeContent(350, 300);
  await evaluatePage(page => page.document.getElementById('backHomeButton').click());
  assert.equal(await evaluate('document.querySelector("[data-speed-id=fixture-speed-0]").getClientRects().length'), 0);
  assert.equal(await evaluate('document.activeElement.classList.contains("model-speed-head")'), true,
    'a row excluded by the smaller viewport returns focus to its module heading');
  await resizeContent(350, 920);
  settings.showLiveTokenRate = false;
  settings.clients = 'codex';
  win.webContents.send('settings:push', settings);
  pushFixtureStats(stats);
  await waitFor('document.querySelectorAll(".model-speed-row").length === 4');
  const result = { row, detail, footerWidths, rateCoverage, returnedToSource: true };
  audit.unmeasuredCandidate = result;
  return result;
}

async function verifyCloudScopeDismissal() {
  await resizeContent(350, 620);
  // Live cloud rows support native DAY/MONTH/TOTAL windows, not derived history.
  await selectPeriod('today');
  const stamp = new Date().toISOString();
  // Keep the same cloud snapshot DTO exercised by cloudSessionRows.test.js.
  cloudSnapshot = { state: 'listening', observedAt: stamp, stale: false,
    service: { running: true, installed: true }, threads: [{
      threadId: '01900000-0000-7000-8000-000000000001', kind: 'aeon_child',
      status: 'observed', runtimeStatus: 'idle',
      total: { inputTokens: 900, cachedInputTokens: 800, outputTokens: 100, reasoningOutputTokens: 50, totalTokens: 1000 },
      lastActivityAt: stamp, createdAt: stamp, observedAt: stamp, gapCount: 0
    }] };
  settings.cloudSessionScopeDismissed = false;
  settings.reduceMotion = 'off';
  delete settings.themeColors;
  win.webContents.send('settings:push', settings);
  await waitFor('state.settings.cloudSessionScopeDismissed === false');
  const openSessions = async () => {
    await evaluatePage(page => {
      page.document.querySelector('.view-switcher-disclosure').click();
      page.document.querySelector('.view-switcher-menu-item[data-view="session"]').click();
    });
    await evaluate('cloudSessionsSource.refresh()');
    await waitFor('state.breakdown === "session" && rawSessionRowsForPeriod(state.stats.periods[state.period]).some(row => row.cloudThreadId)');
  };
  await openSessions();
  await waitFor('!document.getElementById("cloudSessionsScope").classList.contains("hidden")');
  const note = await evaluatePage(page => {
    const scope = page.document.getElementById('cloudSessionsScope'), button = page.document.getElementById('dismissCloudSessionsScope');
    const rect = scope.getBoundingClientRect(), close = button.getBoundingClientRect();
    return { text: scope.querySelector('#cloudSessionsScopeText').textContent, label: button.getAttribute('aria-label'),
      buttonFits: close.width > 0 && close.height > 0 && close.left >= rect.left && close.right <= rect.right
        && close.top >= rect.top && close.bottom <= rect.bottom && rect.bottom <= page.innerHeight };
  });
  assert.ok(note.text.length > 10 && note.label.length > 0);
  assert.equal(note.buttonFits, true);
  await pause(1000);
  await capture('cloud-session-scope-open.png');
  await evaluatePage(page => page.document.getElementById('dismissCloudSessionsScope').click());
  await waitFor('state.settings.cloudSessionScopeDismissed === true && document.getElementById("cloudSessionsScope").classList.contains("hidden")');
  assert.equal(settings.cloudSessionScopeDismissed, true, 'real settings:update must persist the preference');
  assert.ok(audit.settingsUpdates.some(patch => patch.cloudSessionScopeDismissed === true));
  pushFixtureStats({ ...stats, snapshot: { ...stats.snapshot, id: 'dismissed-cloud-scope-poll' } });
  await evaluate('cloudSessionsSource.refresh()');
  await settleFrames();
  assert.equal(await evaluate('document.getElementById("cloudSessionsScope").classList.contains("hidden")'), true);
  await capture('cloud-session-scope-dismissed.png');
  const loaded = new Promise(resolve => win.webContents.once('did-finish-load', resolve));
  win.reload();
  await loaded;
  await waitFor('state.settings?.cloudSessionScopeDismissed === true && Boolean(state.stats?.periods)');
  await openSessions();
  assert.equal(await evaluate('document.getElementById("cloudSessionsScope").classList.contains("hidden")'), true);
  await pause(1000);
  await capture('cloud-session-scope-after-reload.png');
  const result = { note, persistedBySettingsIpc: true, survivesStatsRefresh: true, survivesRendererReload: true };
  audit.cloudScopeDismissal = result;
  return result;
}

app.whenReady().then(async () => {
  const responses = {
    'settings:get': () => settings,
    'settings:update': patch => { audit.settingsUpdates.push({ ...patch }); return Object.assign(settings, patch); },
    'stats:get': () => activeStats, 'stats:allTimeSessions': () => activeStats.periods.allTime.sessions || {},
    'app:getInfo': () => ({ version: '0.66.0-cloud.8', platform: 'darwin', systemDarkUi: true, loginItemSupported: false }),
    'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
    'appUpdate:getState': () => ({ status: 'idle', supported: false, currentVersion: '0.66.0-cloud.8' }),
    'hub:getInfo': () => ({ mode: 'local' }), 'tokscale:getStatus': () => ({ installed: true, version: 'fixture' }),
    'stream:status': () => ({ connected: true, mode: 'local' }),
    'dashboard:getHistory': options => ({ ...fixtureHistory,
      ...(options?.includeDevices ? { deviceHistories: [fixtureDeviceHistory] } : {}),
      fixedPeriods: { source: 'local', historyTransportAvailable: true } }),
    'cloudUsage:get': () => cloudSnapshot,
    'modelSpeed:history': history
  };
  const preload = path.join(root, 'src/electron/preload.js');
  const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]));
  for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => responses[channel]?.(...args) ?? (channel.endsWith(':accounts') ? [] : null));
  win = new BrowserWindow({ width: 350, height: 920, useContentSize: true, show: false, enableLargerThanScreen: true,
    title: 'Token Monitor — UI verification', backgroundColor: '#15191d',
    webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload } });
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, callback) => callback({ cancel: true }));
  win.webContents.on('console-message', event => { if (event.level === 'error') audit.errors.push(String(event.message)); });
  await win.loadFile(path.join(root, 'src/electron/renderer/index.html'), { query: { period: 'allTime', breakdown: 'home', suppressInitialNumberAnimation: '1' } });
  win.showInactive();
  if (process.env.TM_HOME_REFERENCE_ONLY === '1') {
    await waitFor('document.querySelectorAll(".model-speed-row").length === 4');
    const reference = await verifyHomeReference();
    assert.deepEqual(audit.errors, []);
    fs.writeFileSync(path.join(output, 'reference-acceptance.json'), JSON.stringify(reference, null, 2), { mode: 0o600 });
    console.log('HOME_REFERENCE_PASS', JSON.stringify(reference));
    finish(); return;
  }
  if (process.env.TM_HOME_PACKING_ONLY === '1') {
    await waitFor('document.querySelectorAll(".model-speed-row").length === 4');
    settings.homeModuleOrder = 'limits,model,trends,session,modelspeed';
    win.webContents.send('settings:push', settings);
    pushFixtureStats(runningSessionStats(14));
    await waitFor('document.querySelectorAll(".home-session-row").length === window.TokenMonitorHomeRowBudget.previewCount(5, 14)');
    await pause(1000);
    const packing = await verifyHomePacking();
    assert.deepEqual(audit.errors, []);
    fs.writeFileSync(path.join(output, 'packing-acceptance.json'), JSON.stringify(packing, null, 2), { mode: 0o600 });
    console.log('HOME_PACKING_PASS', JSON.stringify({ cases: packing.layouts.length }));
    finish(); return;
  }

  await waitFor('document.querySelectorAll(".model-speed-row").length === 4');
  await evaluate(`window.__speedAnimations = []; window.__speedPolls = new Map();
    const originalAnimate = Element.prototype.animate;
    Element.prototype.animate = function(frames, options) {
      if (this.id === 'modelSpeedPanel' || this.closest('#modelSpeedPanel') || this.id === 'homePanel')
        window.__speedAnimations.push({ tag: this.tagName, id: this.id, duration: options.duration, frames });
      return originalAnimate.call(this, frames, options);
    };
    const originalInterval = window.setInterval, originalClear = window.clearInterval;
    window.setInterval = (callback, delay, ...args) => {
      const id = originalInterval(callback, delay, ...args);
      if (delay === 30000) window.__speedPolls.set(id, callback);
      return id;
    };
    window.clearInterval = id => { window.__speedPolls.delete(id); originalClear(id); };
    // The only range control is the window's DAY/MONTH/TOTAL selector, so the
    // harness drives the same tabs a user does. Derived windows live behind the
    // MONTH menu; plain ones are top-level tabs.
    window.__selectPeriod = period => {
      if (['week', 'last7', 'month', 'last30'].includes(period)) {
        document.getElementById('monthPeriodTab').click();
        document.querySelector('#monthPeriodMenu [data-fixed-period="' + period + '"]').click();
      } else {
        document.querySelector('[data-period-slot="' + period + '"]').click();
      }
    };
    window.__speedRangeCaption = () => {
      const node = document.querySelector('#modelSpeedPanel .model-speed-range');
      return node ? node.textContent.trim() : '';
    };
    document.getElementById('homePanel').scrollTop = 50;`);
  if (process.env.TM_SPEED_HOVER_FOCUS_ONLY === '1') {
    await selectPeriod('last7');
    await evaluate(`document.querySelector('[data-speed-id="fixture-speed-0"]').click()`);
    await waitFor(`document.querySelector('#modelSpeedPanel .model-speed-chart') !== null`);
    await evaluate('new Promise(resolve => setTimeout(resolve, 1000))');
    await verifySpeedChartHover('focused');
    await resizeContent(300, 620);
    await verifySpeedChartHover('focused-narrow');
    assert.deepEqual(audit.errors, []);
    console.log('MODEL_SPEED_HOVER_FOCUS_PASS');
    finish(); return;
  }
  if (process.env.TM_SPEED_SOURCE_FOCUS_ONLY === '1') {
    await verifyUnmeasuredCandidate();
    assert.deepEqual(audit.errors, []);
    console.log('MODEL_SPEED_SOURCE_FOCUS_PASS');
    finish(); return;
  }
  const home = await evaluate(`({
    font: getComputedStyle(document.querySelector('.model-speed-row')).fontFamily,
    referenceFont: getComputedStyle(document.querySelector('.home-model-row .home-list-name')).fontFamily,
    noDialog: !document.querySelector('#modelSpeedPanel dialog, dialog[open]'),
    noOverflow: [...document.querySelectorAll('.model-speed-row')].every(row => row.scrollWidth <= row.clientWidth + 1),
    text: document.querySelector('.home-module-modelspeed').textContent,
    topLabel: document.querySelector('.total-panel > .label-row > span').textContent,
    periodLabels: [...document.querySelectorAll('[data-period-slot]')].map(button => button.textContent.trim()),
    modelTitle: document.querySelector('.home-module-modelspeed .home-module-label').textContent,
    modelHeaderTitle: document.querySelector('.home-module-modelspeed .home-module-head').title,
    modelMetaPresent: Boolean(document.querySelector('.home-module-modelspeed .home-module-meta')),
    scroll: document.getElementById('homePanel').scrollTop
  })`);
  fs.writeFileSync(path.join(output, 'initial-home.json'), JSON.stringify(home, null, 2));
  assert.equal(home.font, home.referenceFont);
  assert.equal(home.noDialog, true);
  assert.equal(home.noOverflow, true);
  assert.equal(home.topLabel, 'TOTAL TOKENS');
  assert.deepEqual(home.periodLabels, ['DAY', '30D', 'TOTAL']);
  assert.equal(home.modelTitle, '模型速度');
  assert.equal(home.modelMetaPresent, false);
  assert.doesNotMatch(home.modelHeaderTitle, /活跃优先|90|TPS/);
  audit.compactLabels = { top: home.topLabel, periods: home.periodLabels, model: home.modelTitle, title: home.modelHeaderTitle };
  assert.match(home.text, /gemini-3\.8-flash-high/);
  await capture('home-dark.png');
  // The detail follows the window selection; put it on the 7-day window first so
  // the fixture's mean (27 TPS -> 1,620 TPM) is the one under test.
  await selectPeriod('last7');
  await evaluate(`document.querySelector('[data-speed-id="fixture-speed-0"]').click()`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('1,620')`);
  const opened = await evaluate(`({
    homeHidden: document.getElementById('homePanel').classList.contains('hidden'),
    panelVisible: !document.getElementById('modelSpeedPanel').classList.contains('hidden'),
    returnVisible: !document.getElementById('viewBackRow').classList.contains('hidden'),
    focused: document.activeElement.id,
    rangeCaption: window.__speedRangeCaption(),
    averageCaption: document.querySelector('#modelSpeedPanel .model-speed-body .model-speed-caption').textContent.trim(),
    rangeControls: document.querySelectorAll('#modelSpeedPanel [data-speed-days], #modelSpeedPanel .model-speed-days').length,
    animations: window.__speedAnimations
  })`);
  assert.equal(opened.homeHidden, true);
  assert.equal(opened.panelVisible, true);
  assert.equal(opened.returnVisible, true);
  assert.equal(opened.focused, 'backHomeButton');
  // No independent range control survives inside the detail, and the caption
  // names the same window the top tabs show.
  assert.equal(opened.rangeControls, 0);
  assert.equal(opened.rangeCaption, '近7天');
  assert.match(opened.averageCaption, /近7天/);
  audit.compactLabels.history = opened.rangeCaption;
  assert.ok(opened.animations.some(item => item.id === 'modelSpeedPanel' && item.duration === 240));
  assert.ok(opened.animations.some(item => item.tag.toLowerCase() === 'svg' && item.duration === 920));
  await capture('detail-entering.png');
  await evaluate('new Promise(resolve => setTimeout(resolve, 1000))');
  await capture('detail-dark.png');
  const curveAppearance = await verifyCurveAppearance();
  const chartHover = await verifySpeedChartHover('dark');
  // Faster second window wins even when the first response arrives last. The
  // today request is deliberately slow (180ms) and last30 fast (15ms).
  pendingDelay = 0;
  await evaluate(`document.querySelector('.model-speed-chart').focus(); document.querySelector('.model-speed-chart').dispatchEvent(new KeyboardEvent('keydown', {key:'Home', bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('.model-speed-chart-tooltip').hidden`), false);
  await evaluate(`window.__selectPeriod('today')`);
  assert.equal(await evaluate(`document.querySelectorAll('.model-speed-chart-tooltip').length`), 0, 'a pending range removes the old tooltip');
  await evaluate(`window.__selectPeriod('last30')`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('3,000')`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 400))');
  assert.equal(await evaluate('window.__speedRangeCaption()'), '近30天');
  assert.match(await evaluate(`document.querySelector('#modelSpeedPanel').textContent`), /3,000/);
  assert.doesNotMatch(await evaluate(`document.querySelector('#modelSpeedPanel').textContent`), /1,260/);
  // Main stats pushes and background polls preserve the mounted UI and focus.
  await evaluate(`window.__speedDetailNode = document.querySelector('.model-speed-detail');
    document.querySelector('#modelSpeedPanel details').open = true;
    document.querySelector('#backHomeButton').focus();
    window.__speedAnimationCount = window.__speedAnimations.length;`);
  win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', reason: 'presentation', mode: 'local', stats } });
  await evaluate('new Promise(resolve => setTimeout(resolve, 100))');
  assert.equal(await evaluate(`document.querySelector('.model-speed-detail') === window.__speedDetailNode`), true);
  await evaluate(`for (const poll of window.__speedPolls.values()) poll()`);
  assert.equal(await evaluate(`document.querySelector('.model-speed-body').classList.contains('is-refreshing')`), false);
  await evaluate('new Promise(resolve => setTimeout(resolve, 80))');
  assert.equal(await evaluate(`document.querySelector('#modelSpeedPanel details').open`), true);
  assert.equal(await evaluate(`document.activeElement.id`), 'backHomeButton');
  assert.equal(await evaluate(`window.__speedAnimations.length === window.__speedAnimationCount`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.model-speed-chart-tooltip').length`), 1, 'unchanged polls retain one tooltip');
  await evaluate(`document.querySelector('.model-speed-chart').focus(); document.querySelector('.model-speed-chart').dispatchEvent(new KeyboardEvent('keydown', {key:'End', bubbles:true}))`);
  assert.equal(await evaluate(`document.querySelector('.model-speed-chart-tooltip').hidden`), false, 'polls preserve chart inspection');
  await evaluate(`document.querySelector('#backHomeButton').focus()`);
  assert.match(await evaluate(`document.querySelector('#modelSpeedPanel').textContent`), /3,000/);
  // An automatic poll may supersede a pending range request. Its failure must
  // not retain the old range's results under the newly selected button.
  responseBehaviors.push({ delay: 200, fail: false }, { delay: 30, fail: true });
  await evaluate(`window.__selectPeriod('today'); for (const poll of window.__speedPolls.values()) poll()`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 400))');
  assert.equal(await evaluate(`document.querySelector('#modelSpeedPanel .model-speed-figures') === null`), true);
  assert.equal(await evaluate(`document.querySelectorAll('.model-speed-chart-tooltip').length`), 0, 'failed ranges remove chart inspection');
  assert.equal(await evaluate('window.__speedRangeCaption()'), '今天');
  // The selected DAY tab is a no-op; the next real poll retries its failed load.
  await evaluate(`for (const poll of window.__speedPolls.values()) poll()`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('1,260')`);
  // Escape returns to the actual source row and original scroll offset.
  await evaluate(`document.activeElement.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`);
  assert.equal(await evaluate(`document.activeElement.dataset.speedId`), 'fixture-speed-0');
  assert.equal(await evaluate(`document.getElementById('homePanel').scrollTop`), home.scroll);
  assert.equal(await evaluate(`window.__speedPolls.size`), 0);
  // An in-flight response cannot resurrect a disposed detail.
  pendingDelay = 250;
  await evaluate(`document.querySelector('[data-speed-id="fixture-speed-1"]').click(); document.getElementById('backHomeButton').click()`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 300))');
  assert.equal(await evaluate(`document.getElementById('modelSpeedPanel').children.length`), 0);
  assert.equal(await evaluate(`document.querySelectorAll('.model-speed-chart-tooltip').length`), 0, 'disposed detail leaves no tooltip');
  // This reopening scenario uses the seven-day fixture mean (27 TPS / 1,620 TPM).
  await selectPeriod('last7');
  await evaluate(`document.querySelector('[data-speed-id="fixture-speed-1"]').click()`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('1,620')`);
  await evaluate(`document.querySelector('.view-switcher-disclosure').click(); document.querySelector('.view-switcher-menu-item[data-view="home"]').click()`);
  assert.equal(await evaluate(`document.getElementById('modelSpeedPanel').classList.contains('hidden')`), true);
  assert.equal(await evaluate(`window.__speedPolls.size`), 0);
  console.log('MODEL_SPEED_UI_PHASE', 'responsive');
  const responsive = await verifyResponsiveLayouts();
  console.log('MODEL_SPEED_UI_PHASE', 'running-sessions');
  const runningSessions = await verifyRunningSessionPreviews();
  const moduleHover = await verifyModuleHover();
  console.log('MODEL_SPEED_UI_PHASE', 'scroll-and-hover');
  const scrollEdges = await verifyScrollEdges();
  const heatmapMotion = await verifyHeatmapMotion();
  console.log('MODEL_SPEED_UI_PHASE', 'unmeasured-candidate');
  const unmeasuredCandidate = await verifyUnmeasuredCandidate();
  // Explicit in-app reduced motion overrides the system; light theme inherits.
  settings.reduceMotion = 'on';
  const light = require(path.join(root, 'src/electron/renderer/themePresets.js')).THEME_PRESETS.find(item => item.id === 'porcelain');
  if (!light) throw new Error('Missing existing light theme');
  settings.themeColors = light.colors;
  win.webContents.send('settings:push', settings);
  await waitFor(`document.documentElement.dataset.reduceMotion === 'on'`);
  await evaluate('window.__speedAnimations.length = 0');
  await evaluate(`document.querySelector('[data-speed-id="fixture-speed-0"]').click()`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('1,620')`);
  assert.equal(await evaluate('window.__speedAnimations.length'), 0);
  const lightStyle = await evaluate(`({
    background: getComputedStyle(document.querySelector('.model-speed-detail')).backgroundColor,
    font: getComputedStyle(document.querySelector('.model-speed-detail')).fontFamily,
    bodyFont: getComputedStyle(document.body).fontFamily,
    noOverflow: document.getElementById('modelSpeedPanel').scrollWidth <= document.getElementById('modelSpeedPanel').clientWidth + 1
  })`);
  assert.equal(lightStyle.background, 'rgba(0, 0, 0, 0)');
  assert.equal(lightStyle.font, lightStyle.bodyFont);
  assert.equal(lightStyle.noOverflow, true);
  await capture('detail-light.png');
  win.setContentSize(300, 620);
  await evaluate(`new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Renderer frame did not arrive')), 5000);
    requestAnimationFrame(() => requestAnimationFrame(() => { clearTimeout(timer); resolve(); }));
  })`);
  assert.equal(await evaluate(`document.getElementById('modelSpeedPanel').scrollWidth <= document.getElementById('modelSpeedPanel').clientWidth + 1`), true);
  await capture('detail-narrow.png');
  await verifySpeedChartHover('narrow-light');
  const sourceAttribution = await evaluatePage(page => {
    const panel = page.document.getElementById('modelSpeedPanel');
    const section = panel.querySelector('.model-speed-sources');
    const rows = [...section.querySelectorAll('.model-speed-source')];
    return { title: section.querySelector('h3').textContent, text: section.textContent,
      order: section.compareDocumentPosition(panel.querySelector('.model-speed-stats')) & page.Node.DOCUMENT_POSITION_PRECEDING,
      rows: rows.map(row => ({ text: row.textContent,
        access: row.querySelector('.model-speed-source-access').textContent,
        rate: row.querySelector('.model-speed-source-rate').textContent,
        fits: row.scrollWidth <= row.clientWidth + 1 })),
      sectionFits: section.scrollWidth <= section.clientWidth + 1 };
  });
  assert.equal(sourceAttribution.title, '来源');
  assert.ok(sourceAttribution.order, 'sources follow the speed statistics');
  assert.equal(sourceAttribution.rows.length, 5);
  assert.deepEqual(sourceAttribution.rows.map(row => row.access), ['订阅', '订阅', 'API', '接入方式未识别', '接入方式未识别']);
  assert.match(sourceAttribution.text, /账号 A.*#aaaaaaaa/);
  assert.match(sourceAttribution.text, /账号 B.*#bbbbbbbb/);
  assert.match(sourceAttribution.text, /openai.*API/);
  assert.match(sourceAttribution.text, /平台未识别/);
  assert.match(sourceAttribution.text, /账号：未识别/);
  assert.match(sourceAttribution.rows[3].text, /已记录来源 · 无原生耗时/);
  assert.equal(sourceAttribution.rows[3].rate, '—');
  assert.ok(sourceAttribution.sectionFits && sourceAttribution.rows.every(row => row.fits), 'source rows fit a 300px window');
  await selectPeriod('today');
  await waitFor(`document.querySelectorAll('#modelSpeedPanel .model-speed-source').length === 1`);
  assert.doesNotMatch(await evaluate(`document.querySelector('.model-speed-sources').textContent`), /#bbbbbbbb|#cccccccc/);
  await selectPeriod('last7');
  await waitFor(`document.querySelectorAll('#modelSpeedPanel .model-speed-source').length === 5`);
  // A failed range is recoverable, and leaving by the footer disposes the poll.
  failNext = true;
  await evaluate(`window.__selectPeriod('allTime')`);
  await evaluate('new Promise(resolve => setTimeout(resolve, 120))');
  assert.equal(await evaluate(`document.querySelector('#modelSpeedPanel .model-speed-figures') === null`), true);
  await evaluate(`for (const poll of window.__speedPolls.values()) poll()`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('6,600')`);
  await evaluate(`window.__selectPeriod('last7')`);
  await waitFor(`document.querySelector('#modelSpeedPanel').textContent.includes('1,620')`);
  await evaluate(`document.querySelector('.view-switcher-current').click()`);
  assert.equal(await evaluate(`document.getElementById('modelSpeedPanel').classList.contains('hidden') && document.getElementById('modelSpeedPanel').inert`), true);
  assert.equal(await evaluate(`window.__speedPolls.size`), 0);
  console.log('MODEL_SPEED_UI_PHASE', 'cloud-scope-dismissal');
  const cloudScopeDismissal = await verifyCloudScopeDismissal();
  assert.deepEqual(audit.errors, []);
  const result = { actualRenderer: true, actualPreload: true, syntheticData: true,
    embeddedDetail: true, inheritedFonts: true, narrowLayout: true, darkAndLight: true,
    panelEntryMs: 240, chartEntryMs: 920, reducedMotion: true,
    staleRangeRejected: true, refreshPreservesFocusAndNotes: true,
    escapeRestoresFocusAndScroll: true, disposedRequestsIgnored: true,
    footerDisposesDetail: true, homeMenuReturns: true, pollRangeRaceSafe: true,
    rangeErrorRecoverable: true, requests: audit.requests.length,
    representativeHistoryDays: fixtureDaily.length, representativeLimitAccounts: fixtureLimits.providers.length,
    responsive, runningSessions, moduleHover, scrollEdges, heatmapMotion, sessionPopover: audit.sessionPopover,
    curveAppearance, chartHover, sourceAttribution, unmeasuredCandidate, cloudScopeDismissal, compactLabels: audit.compactLabels };
  fs.writeFileSync(path.join(output, 'acceptance.json'), JSON.stringify(result, null, 2), { mode: 0o600 });
  console.log('MODEL_SPEED_UI_PASS', JSON.stringify(result));
  finish();
}).catch(finish);
// Geometry checks run against the real renderer, not CSS text alone.
async function verifyHomePacking() {
  const original = { homeModuleOrder: settings.homeModuleOrder, hiddenHomeModules: settings.hiddenHomeModules };
  const results = [];
  async function inspect(width, height, name) {
    await resizeContent(width, height);
    await settleFrames();
    const layout = await evaluatePage(page => {
      const panel = page.document.getElementById('homePanel');
      const rect = panel.getBoundingClientRect();
      const modules = [...panel.children].filter(node => node.classList.contains('home-module')).map(node => {
        const box = node.getBoundingClientRect();
        return { name: node.className, left: box.left, top: box.top, right: box.right, bottom: box.bottom, width: box.width };
      });
      return { width: page.innerWidth, height: page.innerHeight, panelLeft: rect.left,
        panelRight: rect.right - parseFloat(page.getComputedStyle(panel).paddingRight || 0), modules,
        pageFits: page.document.documentElement.scrollWidth <= page.innerWidth + 1,
        panelFits: panel.scrollWidth <= panel.clientWidth + 1,
        footerFits: page.document.querySelector('.footer').getBoundingClientRect().bottom <= page.innerHeight + 1 };
    });
    results.push({ name, ...layout });
    assert.ok(layout.pageFits && layout.panelFits && layout.footerFits, name + ': outer layout overflows');
    const columns = new Set(layout.modules.map(node => Math.round(node.left)));
    const wide = width >= 816 && layout.modules.length > 1;
    assert.equal(columns.size, wide ? 2 : 1, name + ': narrow modules should move below, not squeeze');
    for (const node of layout.modules) {
      assert.ok(node.left >= layout.panelLeft - 1 && node.right <= layout.panelRight + 1, name + ': module outside panel');
      if (wide) assert.ok(node.width >= 379, name + ': desktop column too narrow');
    }
    const last = layout.modules.at(-1);
    if (last && layout.modules.length % 2 === 1) {
      assert.ok(Math.abs(last.left - layout.panelLeft) <= 1 && Math.abs(last.right - layout.panelRight) <= 1,
        name + ': orphan last module leaves half the row empty: ' + JSON.stringify(last));
    }
    for (let i = 1; i < layout.modules.length; i++) {
      const previous = layout.modules[i - 1], node = layout.modules[i];
      assert.ok(node.top >= previous.top - 1, name + ': saved reading order changed');
      if (Math.abs(node.top - previous.top) < 1) assert.ok(node.left >= previous.right + 10, name + ': overlapping row');
    }
    await capture('packing-' + name + '.png');
  }
  try {
    for (const width of [987, 240, 680, 815, 816, 1040, 1200]) await inspect(width, 924, 'five-' + width);
    for (const [name, order, hidden, count] of [
      ['four', 'limits,model,session,trends,modelspeed', 'tool,device,modelspeed', 4],
      ['three', 'model,modelspeed,session,limits,trends', 'tool,device,limits,trends', 3],
      ['one', 'modelspeed,limits,model,session,trends', 'tool,device,limits,model,session,trends', 1],
      ['seven', 'limits,model,trends,session,modelspeed,tool,device', '', 7]
    ]) {
      Object.assign(settings, { homeModuleOrder: order, hiddenHomeModules: hidden });
      win.webContents.send('settings:push', settings);
      await waitFor('document.querySelectorAll("#homePanel > .home-module").length === ' + count);
      await inspect(987, 924, name + '-987');
    }
    return { passed: true, layouts: results };
  } finally {
    Object.assign(settings, original);
    win.webContents.send('settings:push', settings);
    await waitFor('document.querySelectorAll("#homePanel > .home-module").length === 5');
    await resizeContent(350, 920);
  }
}

async function verifyHomeReference() {
  settings.homeModuleOrder = 'limits,model,trends,session,modelspeed';
  settings.showCompactTotalTokens = true;
  settings.heatmapMetric = 'tokens';
  settings.homeActivityMode = 'daily';
  const referenceStats = runningSessionStats(14);
  referenceStats.periods = Object.fromEntries(Object.entries(referenceStats.periods).map(([name, value]) => [name, { ...value, totalTokens: 1405888151 }]));
  pushFixtureStats(referenceStats);
  win.webContents.send('settings:push', settings);
  await waitFor('document.querySelectorAll(".home-session-row").length === window.TokenMonitorHomeRowBudget.previewCount(5, 14)');
  await pause(1100);
  const layouts = [];
  for (const size of [[240,140],[240,900],[350,920],[816,1034],[987,924],[1200,1034],[1200,1400]]) {
    await resizeContent(...size); await settleFrames();
    const layout = await evaluatePage(page => {
      const box = el => { const r = el.getBoundingClientRect(); return { x:r.x, y:r.y, right:r.right, bottom:r.bottom, width:r.width, height:r.height }; };
      const home = page.document.getElementById('homePanel');
      const main = page.document.getElementById('totalTokens'), compact = page.document.getElementById('totalTokensCompact');
      return { size:[page.innerWidth,page.innerHeight], home:box(home), number:box(main), compact:box(compact),
        font:parseFloat(page.getComputedStyle(main).fontSize), cost:box(page.document.getElementById('cost')),
        pageFits:page.document.documentElement.scrollWidth <= page.innerWidth + 1 && page.document.documentElement.scrollHeight <= page.innerHeight + 1,
        numberFits:main.scrollWidth <= main.clientWidth + 1,
        scrolls:home.scrollHeight > home.clientHeight + 1,
        modules:[...home.querySelectorAll(':scope > .home-module')].map(el => ({ name:el.className, ...box(el) })) };
    });
    assert.equal(layout.pageFits, true, JSON.stringify(layout));
    assert.equal(layout.numberFits, true, JSON.stringify(layout));
    assert.ok(layout.cost.bottom <= size[1] + 1, JSON.stringify(layout));
    if (size[0] <= 350) {
      assert.ok(layout.compact.y >= layout.number.bottom - 1, 'narrow compact label must move below instead of squeezing the number: '+JSON.stringify(layout));
      assert.ok(layout.font >= (size[0] === 240 ? 23 : 30), 'primary number must stay readable');
    }
    if (size[0] >= 816) {
      const [limits,models,trends,sessions,speed] = layout.modules;
      assert.ok(Math.abs(limits.y-models.y) <= 1 && Math.abs(limits.bottom-models.bottom) <= 1, 'top row boundaries align');
      assert.ok(Math.abs(trends.y-sessions.y) <= 1 && Math.abs(trends.bottom-sessions.bottom) <= 1, 'middle row boundaries align');
      assert.ok(speed.width >= layout.home.width-3 && speed.y >= trends.bottom, 'speed occupies the full bottom row');
      if (!layout.scrolls) assert.ok(Math.abs(speed.bottom-layout.home.bottom) <= 2, 'bottom module reaches the footer region');
      assert.ok(layout.compact.y < layout.number.bottom, 'wide header keeps compact label inline');
    }
    layouts.push(layout);
    if (size[1] > 240) { await evaluate('document.getElementById("homePanel").scrollTop = 0'); await capture('reference-'+size.join('x')+'.png'); }
  }
  await resizeContent(1200,1034);
  const target = fixtureDaily[30];
  const targetMs = Date.parse(target.date+'T00:00:00Z');
  const weekStart = targetMs - new Date(targetMs).getUTCDay()*86400000;
  const weeklyExpected = fixtureDaily.filter(row => {
    const at = Date.parse(row.date+'T00:00:00Z'); return at >= weekStart && at < weekStart+7*86400000;
  }).reduce((n,row) => n+row.tokens,0);
  const cumulativeExpected = fixtureDaily.filter(row => row.date <= target.date).reduce((n,row) => n+row.tokens,0);
  const expected = { daily:target.tokens, weekly:weeklyExpected, cumulative:cumulativeExpected };
  const modes = [];
  const periodBefore = await evaluate('state.period');
  for (const mode of ['daily','weekly','cumulative']) {
    await evaluate(`document.querySelector('[data-activity-mode="${mode}"]').click()`);
    await waitFor(`document.querySelector('.home-activity-scroll').dataset.activityMode === '${mode}'`);
    await pause(220);
    const data = await evaluatePage((page,date) => {
      const root = page.document.querySelector('.home-activity-canvas');
      const cells = [...root.querySelectorAll('.heat[data-d]')];
      const cell = cells.find(el=>el.dataset.d===date);
      const svg = root.querySelector('svg'), region=page.document.querySelector('.home-activity-scroll');
      const r=cell.getBoundingClientRect();
      return { value:Number(cell.dataset.activityValue), original:Number(cell.dataset.t), mode:cell.dataset.activityMode,
        range:[cell.dataset.rangeStart,cell.dataset.rangeEnd], months:root.querySelectorAll('.heat-month').length,
        fullYearFits:svg.getBoundingClientRect().width <= region.clientWidth+1,
        selected:[...page.document.querySelectorAll('[data-activity-mode][aria-pressed="true"]')].map(el=>el.dataset.activityMode),
        cells:cells.map(el=>[el.dataset.d,Number(el.dataset.activityValue)]), point:{x:r.x+r.width/2,y:r.y+r.height/2} };
    },target.date);
    assert.equal(data.value,expected[mode]); assert.equal(data.original,target.tokens,'original daily usage is never replaced by weekly/cumulative amounts');
    assert.equal(data.months,12); assert.equal(data.fullYearFits,true); assert.deepEqual(data.selected,[mode]);
    assert.equal(await evaluate('state.period'),periodBefore,'activity mode cannot change headline time selection');
    if (mode === 'cumulative') for (let i=1;i<data.cells.length;i++) assert.ok(data.cells[i][1] >= data.cells[i-1][1]);
    movePointer(data.point); await pause(170);
    const tooltip = await evaluate(`({ visible:document.querySelector('.home-activity-tooltip').dataset.visible, text:document.querySelector('.home-activity-tooltip').textContent })`);
    assert.equal(tooltip.visible,'true'); assert.ok(tooltip.text.includes(data.range[0]));
    movePointer({x:8,y:8});
    await capture('activity-'+mode+'-dark.png');
    modes.push({ mode,value:data.value,original:data.original,range:data.range,months:data.months,fullYearFits:data.fullYearFits,tooltip });
  }
  assert.equal(settings.homeActivityMode,'cumulative');
  await new Promise(resolve => { win.webContents.once('did-finish-load',resolve); win.reload(); });
  await waitFor(`document.querySelector('.home-activity-scroll')?.dataset.activityMode === 'cumulative'`);
  const light = require(path.join(root,'src/electron/renderer/themePresets.js')).THEME_PRESETS.find(p=>p.id==='porcelain');
  settings.themeColors = light.colors;
  win.webContents.send('settings:push',settings);
  await pause(200);
  for (const mode of ['daily','weekly','cumulative']) {
    await evaluate(`document.querySelector('[data-activity-mode="${mode}"]').click()`);
    await waitFor(`document.querySelector('.home-activity-scroll').dataset.activityMode === '${mode}'`);
    await pause(220); await capture('activity-'+mode+'-light.png');
  }
  return { passed:true, actualRenderer:true, syntheticData:true, layouts, modes, persistedAcrossRendererReload:true, themes:['dark','porcelain'], originalTotalsUnchanged:true };
}
