'use strict';

// Isolated synthetic benchmark: real SQLite/archive transform, snapshot and
// presentation code, preload and renderer. Collection is replaced by one live
// fixture on a worker thread; this does not measure native scans/watchers.
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const assert = require('node:assert/strict');
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');
const root = path.resolve(process.env.TM_TOTAL_VERIFY_ROOT || path.join(__dirname, '..'));
const output = process.env.TM_TOTAL_VERIFY_DIR;
if (!output || !path.isAbsolute(output)) throw Error('Set TM_TOTAL_VERIFY_DIR to a private absolute directory');
const load = name => require(path.join(root, 'src', name));
const fixtureDate = new Date();
fixtureDate.setHours(12, 0, 0, 0);
const clock = fixtureDate.getTime();
const iso = ms => new Date(ms).toISOString();
const id = n => '00000000-0000-7000-8000-' + String(n).padStart(12, '0');
const hash = value => crypto.createHash('sha256').update(value).digest('hex');

function session(n, sequence = 0) {
  const total = 2000 + n * 3 + sequence * 101;
  const model = 'fixture-model-' + (n % 8);
  return { client: 'codex', sessionId: id(n), title: 'Synthetic archive session ' + n,
    totalTokens: total, inputTokens: total - 400, outputTokens: 100, cacheReadTokens: 300,
    costUsd: total / 10000000, models: { [model]: total }, modelCosts: { [model]: total / 10000000 },
    lastUsedAt: iso(clock - n * 60000 + sequence * 1000), startedAt: iso(clock - n * 60000 - 900000),
    messageCount: 12, workspaceId: 'fixture-workspace', workspaceLabel: 'Synthetic workspace' };
}

// Keep only small fingerprints in the audit; retaining the full results here
// would mask the behavior under measurement.
function fingerprint(sessions) {
  // aggregateDevices has always published session money at six decimals.
  // Compare archive inputs at that existing presentation precision.
  const money = value => Number((value || 0).toFixed(6));
  const values = Object.entries(sessions || {}).sort(([a], [b]) => a.localeCompare(b)).map(([key, row]) =>
    [key, row.totalTokens, row.inputTokens, row.outputTokens, row.cacheReadTokens,
      money(row.costUsd), row.unpricedTokens || 0, row.models,
      Object.fromEntries(Object.entries(row.modelCosts || {}).map(([model, value]) => [model, money(value)])),
      row.lastUsedAt, row.messageCount]);
  return { rows: values.length, tokens: values.reduce((sum, row) => sum + row[1], 0),
    hash: hash(JSON.stringify(values)) };
}

function seed() {
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  const sessions = Object.fromEntries(Array.from({ length: 5000 }, (_, i) => ['codex:' + id(i + 1), session(i + 1)]));
  const store = load('shared/usage/sessionUsageArchiveStore').createSessionUsageArchiveStore({ directory: output,
    databasePath: path.join(output, 'session-usage-archive.sqlite'), path: path.join(output, 'legacy.json') });
  const result = store.capture({ updatedAt: iso(clock), allTime: { sessions } }, new Date(clock));
  assert.equal(result.error, null);
  store.close();
  const archive = path.join(output, 'session-usage-archive.sqlite');
  fs.writeFileSync(path.join(output, 'fixture.json'), JSON.stringify({ sessions: 5000, clock, fingerprint: fingerprint(sessions),
    databaseSha256: hash(fs.readFileSync(archive)) }, null, 2));
  console.log('TOTAL_FIXTURE_READY', archive);
}

function runWorker() {
  const { DatabaseSync } = require('node:sqlite');
  const samples = [];
  const started = performance.now();
  let rawRows = 0, parsedSteps = 0;
  const sample = phase => samples.push({ phase, rawRows, parsedSteps, atMs: performance.now() - started,
    ...process.memoryUsage() });
  class MeasuredDatabase extends DatabaseSync {
    prepare(sql) {
      const statement = super.prepare(sql);
      if (!/SELECT session_key, entry_json/.test(sql)) return statement;
      return new Proxy(statement, { get(target, property) {
        if (property === 'all') return (...parameters) => {
          const rows = target.all(...parameters); rawRows = rows.length; sample('raw-array'); return rows;
        };
        if (property === 'iterate') return (...parameters) => {
          const rows = target.iterate(...parameters);
          return { [Symbol.iterator]() { return this; }, next() {
            const result = rows.next();
            if (!result.done) { parsedSteps++; if (parsedSteps === 1 || parsedSteps % 1000 === 0) sample('cursor'); }
            return result;
          }, return() { return rows.return(); } };
        };
        const value = target[property]; return typeof value === 'function' ? value.bind(target) : value;
      } });
    }
  }
  const store = load('shared/usage/sessionUsageArchiveStore').createSessionUsageArchiveStore({
    databasePath: path.join(workerData.directory, 'session-usage-archive.sqlite'),
    path: path.join(workerData.directory, 'legacy.json'), DatabaseSync: MeasuredDatabase });
  sample('before-load');
  const archive = store.refresh();
  sample('after-load');
  assert.equal(Object.keys(archive.sessions).length, 5000);
  parentPort.postMessage({ type: 'loaded', samples, loadMs: performance.now() - started });
  const settings = { clients: 'codex', sessionUsageArchiveEnabled: true, projectsEnabled: false };
  const transform = load('shared/usage/usageTransform').createUsageTransform({ store, getSettings: () => settings });
  const { normalizePeriod } = load('shared/usage');
  parentPort.on('message', message => {
    if (message.type === 'stop') { store.close(); parentPort.close(); return; }
    try {
      const row = { ...session(5001, message.sequence), lastUsedAt: iso(clock + message.sequence * 1000), startedAt: iso(clock - 900000) };
      const period = normalizePeriod({ totalTokens: row.totalTokens, inputTokens: row.inputTokens, outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens, costUsd: row.costUsd, models: row.models, modelCosts: row.modelCosts,
        clients: { codex: row.totalTokens }, clientCosts: { codex: row.costUsd },
        clientOutputs: { codex: row.outputTokens }, clientCacheReads: { codex: row.cacheReadTokens },
        sessions: { ['codex:' + row.sessionId]: row } });
      const record = { deviceId: 'total-memory-fixture', hostname: 'fixture', updatedAt: iso(clock + message.sequence * 1000),
        today: structuredClone(period), month: structuredClone(period), allTime: structuredClone(period),
        nativeSessions: {}, history: { daily: [], monthly: [], summary: {} }, projectsEnabled: false };
      const result = transform.transform(record);
      parentPort.postMessage({ type: 'record', sequence: message.sequence, summary: result,
        fingerprint: fingerprint(result.allTime.sessions), archive: transform.getState() });
    } catch (error) { parentPort.postMessage({ type: 'error', error: error.stack }); }
  });
}

async function runElectron() {
  const { app, BrowserWindow, ipcMain } = require('electron');
  const vm = require('node:vm');
  const os = require('node:os');
  const { execFileSync } = require('node:child_process');
  const mode = process.env.TM_TOTAL_VERIFY_MODE || 'regression';
  assert.ok(['regression', 'memory', 'latency'].includes(mode));
  fs.mkdirSync(output, { recursive: true, mode: 0o700 });
  app.setPath('userData', path.join(output, 'profile'));
  app.setPath('logs', path.join(output, 'logs'));
  const directory = path.join(output, 'archive'); fs.mkdirSync(directory, { recursive: true });
  const template = process.env.TM_TOTAL_VERIFY_ARCHIVE;
  if (!template || !path.isAbsolute(template)) throw Error('Set TM_TOTAL_VERIFY_ARCHIVE to the seeded SQLite fixture');
  fs.copyFileSync(template, path.join(directory, 'session-usage-archive.sqlite'));
  const source = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
  const sourceHash = name => hash(fs.readFileSync(path.join(root, name)));
  const audit = { mode, passed: false, synthetic: true, collection: 'fixture worker, no native watcher',
    source: { head: execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim(),
      main: sourceHash('src/electron/main.js'), usage: sourceHash('src/shared/usage.js'),
      archiveStore: sourceHash('src/shared/usage/sessionUsageArchiveStore.js'),
      renderer: sourceHash('src/electron/renderer/app.js'), animation: sourceHash('src/electron/tokenNumberAnimation.js'),
      dependencyLock: sourceHash('package-lock.json'), harness: hash(fs.readFileSync(__filename)),
      archive: hash(fs.readFileSync(template)) },
    runtime: { versions: process.versions, platform: process.platform, arch: process.arch,
      osRelease: os.release(), cpu: os.cpus()[0]?.model, memoryGiB: os.totalmem() / 1024 ** 3 },
    fixture: { archiveSessions: 5000, liveSessions: 1, updates: 10, clock: iso(clock), window: [530, 820], forcedGC: false },
    scenes: {}, snapshots: [], ipc: [], errors: [] };
  let win, worker, latest, done = false, loaded, request;
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
  const evaluate = code => win.webContents.executeJavaScript(code, true);
  const settings = { language: 'en', locale: 'en-US', theme: 'dark', blurEnabled: false,
    hubMode: 'local', clients: 'codex', refreshMs: 60000, historyEnabled: true, projectsEnabled: false,
    reduceMotion: 'off', tokenNumberAnimation: 'roll', periodMonthMode: 'month', modelAliasGrouping: 'none',
    sessionTitlesEnabled: true, sessionUsageArchiveEnabled: true, showLiveTokenRate: false,
    homeModuleOrder: 'model,trends', hiddenHomeModules: 'limits,tool,device,session,modelspeed',
    cloudAccountingNoticeDismissed: true, cloudSessionScopeDismissed: true };
  const sync = load('electron/syncDisplayStats');
  const publisher = load('electron/statsPublisher');
  const cloud = load('electron/cloudPresentation');
  const cloudSummary = { version: 1, state: 'active', periods: Object.fromEntries(['today', 'month', 'allTime'].map(name =>
    [name, { totalTokens: name === 'allTime' ? 700 : 70, outputTokens: 10, threadCount: 1 }])), unknownCost: true };
  const context = vm.createContext({ Date, settings, ...sync, ...load('shared/usage'), ...load('shared/history'),
    ...load('electron/modelAliasPresentation'), ...load('electron/sessionTitleDisplay'),
    ...load('electron/limits/statsPresentation'), ...load('shared/sessionActivityProjection'),
    ...load('shared/localSessions'), ...cloud,
    localDevice: null, localStats: null, lastCollectedDevice: null, widgetProducerOwner: {},
    cloudLocalIdsCache: new WeakMap(), cloudOverlayCache: new WeakMap(), snapshotLocalDevices: new WeakMap(),
    presentationCache: publisher.createStatsPresentationCache(),
    allTimeSessionsCache: publisher.createStatsPresentationCache(source.includes('createStatsPresentationCache({ limit: 2 })') ? { limit: 2 } : {}),
    rendererSnapshots: publisher.createRendererSnapshots({ source: () => 1 }), syncProvenanceActive: () => false,
    cloudAccountingRuntime: { summary: () => cloudSummary, revision: () => 1 }, modelSpeedRuntime: null,
    localDayKey: date => [date.getFullYear(), date.getMonth() + 1, date.getDate()].join('-'),
    seedInitialLimitProviders() {}, updateDiscordRpcDisplay() {}, sendPush() {}, sendStatus() {} });
  function extract(name) {
    const start = source.indexOf('function ' + name + '('), end = source.indexOf('\n}', start) + 2;
    assert.ok(start >= 0 && end > start, 'Missing main function: ' + name); return source.slice(start, end);
  }
  const start = source.indexOf('      seedInitialLimitProviders(summary);', source.indexOf('function startLocalCollector('));
  const end = source.indexOf('\n    },\n    onDiagnosticEvent:', start);
  assert.ok(start > 0 && end > start);
  vm.runInContext(['withHistoryPreview', 'cloudLocalThreadIds', 'withCloudAccounting', 'electronPresentationStats',
    'rendererAllTimeSessions'].map(extract).join('\n') + '\nfunction onRecord(summary, meta) {' + source.slice(start, end) + '\n}', context);
  const deadline = setTimeout(() => finish(Error('TOTAL verification timed out')), 180000);
  async function finish(error) {
    if (done) return; done = true; clearTimeout(deadline);
    if (error) audit.failure = error.stack;
    try { if (worker) { worker.postMessage({ type: 'stop' }); await worker.terminate(); } }
    catch (cause) { audit.errors.push(cause.stack); }
    audit.sourceStable = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim() === audit.source.head
      && sourceHash('src/electron/main.js') === audit.source.main && sourceHash('src/shared/usage.js') === audit.source.usage
      && sourceHash('src/shared/usage/sessionUsageArchiveStore.js') === audit.source.archiveStore
      && sourceHash('src/electron/renderer/app.js') === audit.source.renderer
      && sourceHash('src/electron/tokenNumberAnimation.js') === audit.source.animation
      && sourceHash('package-lock.json') === audit.source.dependencyLock;
    if (!audit.sourceStable) audit.errors.push('Source identity changed during the benchmark');
    audit.passed = !error && audit.errors.length === 0;
    fs.writeFileSync(path.join(output, 'result.json'), JSON.stringify(audit, null, 2), { mode: 0o600 });
    console.log(audit.passed ? 'TOTAL_MEMORY_PASS' : 'TOTAL_MEMORY_FAIL', JSON.stringify({ mode, scenes: audit.scenes,
      ipc: audit.ipc, checks: audit.checks, failure: audit.failure, errors: audit.errors }));
    app.exit(audit.passed ? 0 : 1);
  }
  async function waitFor(code) {
    const until = Date.now() + 15000;
    while (Date.now() < until) { if (await evaluate(code)) return; await pause(40); }
    throw Error('Renderer condition timed out: ' + code);
  }
  function stamp() { return context.rendererSnapshots.stamp(latest, publisher.rendererStats(context.electronPresentationStats(latest))); }
  async function tick(sequence) {
    const message = await new Promise((resolve, reject) => { request = { resolve, reject }; worker.postMessage({ type: 'tick', sequence }); });
    context.onRecord(message.summary, { reason: 'fixture' }); latest = context.localStats;
    const snapshot = stamp();
    const liveTokens = 17003 + sequence * 101, archiveTokens = 47507500;
    assert.equal(snapshot.periods.today.totalTokens, liveTokens + 70);
    assert.equal(snapshot.periods.month.totalTokens, liveTokens + 70);
    assert.equal(snapshot.periods.allTime.totalTokens, archiveTokens + liveTokens + 700);
    assert.equal(Object.values(snapshot.periods.allTime.models).reduce((sum, value) => sum + value, 0), archiveTokens + liveTokens);
    assert.equal(snapshot.periods.allTime.costUsd, Number(message.summary.allTime.costUsd.toFixed(6)));
    assert.equal(message.fingerprint.tokens, archiveTokens + liveTokens);
    const expected = { id: snapshot.snapshot.id, sequence, fingerprint: message.fingerprint, periodFingerprint: hash(JSON.stringify(snapshot.periods)),
      totals: Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, snapshot.periods[name].totalTokens])) };
    audit.snapshots.push(expected);
    if (win) win.webContents.send('stats:push', { event: 'stats', data: { type: 'stats', mode: 'local', reason: 'fixture', stats: snapshot } });
    return expected;
  }
  async function select(period) {
    await evaluate('document.querySelector(\'.tab[data-period="' + period + '"]\').click()');
    await waitFor('state.period === ' + JSON.stringify(period)); await pause(700);
    const observed = await evaluate('({ total: state.currentTotal, page: state.sessionPage })');
    assert.equal(observed.total, audit.snapshots.at(-1).totals[period]);
    assert.equal(observed.page, 0); return observed;
  }
  async function memory(scene) {
    const samples = [];
    // Ten seconds of steady sampling. Sum resident working sets, which can
    // double-count shared pages; never call it private footprint or allocation.
    for (let i = 0; i < 20; i++) {
      const processes = app.getAppMetrics().map(row => ({ pid: row.pid, type: row.type,
        workingSetKiB: row.memory.workingSetSize }));
      samples.push({ atMs: performance.now(), processes,
        summedRssMiB: processes.reduce((sum, row) => sum + row.workingSetKiB, 0) / 1024 });
      await pause(500);
    }
    const sorted = samples.map(row => row.summedRssMiB).sort((a, b) => a - b);
    audit.scenes[scene] = { medianSummedRssMiB: (sorted[9] + sorted[10]) / 2, samples };
  }
  async function pull(snapshotId) {
    const result = await evaluate('(async () => { const began = performance.now(); const rows = await tokenMonitor.getAllTimeSessions(' + snapshotId +
      '); return { ms: performance.now() - began, count: Object.keys(rows || {}).length,' +
      'tokens: Object.values(rows || {}).reduce((sum, row) => sum + row.totalTokens, 0) }; })()');
    const expected = audit.snapshots.find(row => row.id === snapshotId);
    assert.equal(result.count, expected.fingerprint.rows); assert.equal(result.tokens, expected.fingerprint.tokens);
    const sessions = context.rendererAllTimeSessions(context.rendererSnapshots.get(snapshotId));
    const actualFingerprint = fingerprint(sessions);
    assert.deepEqual(actualFingerprint, expected.fingerprint,
      'Historical counters must match their published revision');
    return result;
  }
  async function interactions() {
    return evaluate('(' + function (totals, readTotal, page) {
      return new Promise(resolve => {
        const intervals = [], clicks = [], periods = ['month', 'allTime', 'today'];
        let previous, frame, index = 0;
        function sample(now) {
          if (previous !== undefined) intervals.push(now - previous);
          previous = now; frame = page.requestAnimationFrame(sample);
        }
        function click() {
          const period = periods[index % 3], began = page.performance.now();
          page.document.querySelector('.tab[data-period="' + period + '"]').click();
          clicks.push({ period, ms: page.performance.now() - began, total: readTotal(), expected: totals[period] });
          index++;
          if (index < 21) page.setTimeout(click, 150);
          else page.setTimeout(() => { page.cancelAnimationFrame(frame); resolve({ intervals, clicks }); }, 1100);
        }
        frame = page.requestAnimationFrame(sample); click();
      });
    }.toString() + ')(' + JSON.stringify(audit.snapshots.at(-1).totals) + ', () => state.currentTotal, window)');
  }
  try {
    await app.whenReady();
    loaded = new Promise((resolve, reject) => {
      worker = new Worker(__filename, { workerData: { directory } });
      worker.on('message', message => {
        if (message.type === 'loaded') { audit.archiveLoad = message; resolve(); }
        else if (message.type === 'record') { request?.resolve(message); request = null; }
        else if (message.type === 'error') { request?.reject(Error(message.error)); reject(Error(message.error)); }
      });
      worker.on('error', error => { reject(error); request?.reject(error); });
    });
    await loaded; await tick(0);
    const responses = { 'settings:get': () => settings, 'settings:update': patch => Object.assign(settings, patch),
      'stats:get': stamp, 'stats:allTimeSessions': snapshotId => {
        return context.rendererAllTimeSessions(context.rendererSnapshots.get(snapshotId));
      }, 'app:getInfo': () => ({ version: 'fixture', platform: process.platform, systemDarkUi: true }),
      'appearance:getNativeMaterial': () => ({ type: 'transparent', reducedTransparency: false, highContrast: false }),
      'appUpdate:getState': () => ({ status: 'idle', supported: false }), 'hub:getInfo': () => ({ mode: 'local' }),
      'tokscale:getStatus': () => ({ installed: true }), 'stream:status': () => ({ connected: true, mode: 'local' }),
      'dashboard:getHistory': () => ({ daily: [], monthly: [] }), 'cloudUsage:get': () => ({ version: 1, state: 'unavailable', threads: [] }) };
    const preload = path.join(root, 'src/electron/preload.js');
    const channels = new Set([...fs.readFileSync(preload, 'utf8').matchAll(/ipcRenderer\.invoke\('([^']+)'/g)].map(match => match[1]));
    for (const channel of channels) ipcMain.handle(channel, (_event, ...args) => responses[channel]?.(...args)
      ?? (channel.endsWith(':accounts') ? [] : null));
    win = new BrowserWindow({ width: 530, height: 820, useContentSize: true, show: false, backgroundColor: '#15191d',
      webPreferences: { contextIsolation: true, nodeIntegration: false, backgroundThrottling: false, preload } });
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    win.webContents.session.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (_details, cb) => cb({ cancel: true }));
    win.webContents.on('console-message', event => { if (event.level === 'error') audit.errors.push(String(event.message)); });
    await win.loadFile(path.join(root, 'src/electron/renderer/index.html'), { query: { period: 'today', suppressInitialNumberAnimation: '1' } });
    win.show(); await waitFor('state.currentTotal > 0'); await pause(1500);
    if (mode === 'memory') await memory('home');
    await evaluate('renderBreakdownChange("session")'); await select('allTime'); await pull(audit.snapshots.at(-1).id);
    for (let sequence = 1; sequence <= 10; sequence++) {
      const expected = await tick(sequence);
      await waitFor('state.currentTotal === ' + expected.totals.allTime);
      await pull(expected.id); await pause(250);
    }
    if (mode === 'memory') await memory('total-after-updates');
    await select('today'); if (mode === 'memory') await memory('left-total');
    // Before latency sampling, verify the eight retained historical IDs using
    // only fingerprints. Snapshot 0-2 have aged out by contract.
    assert.equal(context.rendererSnapshots.get(1), null);
    const retained = audit.snapshots.slice(-8);
    for (const expected of retained) await pull(expected.id);
    for (let i = 0; i < 12; i++) {
      const old = retained[i % 4];
      for (const newer of retained.slice(-3)) await pull(newer.id);
      audit.ipc.push({ id: old.id, ...await pull(old.id) });
    }
    audit.hotIpc = [];
    for (let i = 0; i < 12; i++) audit.hotIpc.push(await pull(retained.at(-1).id));
    if (mode === 'latency') {
      audit.interactions = await interactions();
      assert.ok(audit.interactions.clicks.every(row => row.total === row.expected));
    }
    if (mode === 'regression') {
      await select('month'); await select('allTime');
      await evaluate('document.querySelector(".session-page-next").click()');
      assert.equal(await evaluate('state.sessionPage'), 1, 'Sessions paging advances before the period resets it');
      await select('today'); await select('allTime');
      settings.sessionTitlesEnabled = false; win.webContents.send('settings:push', settings); await pause(800);
      const rows = context.rendererAllTimeSessions(latest);
      assert.ok(Object.values(rows).every(row => !row.title));
      for (const expected of retained) assert.deepEqual(fingerprint(context.rendererAllTimeSessions(context.rendererSnapshots.get(expected.id))), expected.fingerprint);
      settings.sessionTitlesEnabled = true; win.webContents.send('settings:push', settings); await pause(800);
      sync.clearLocalStatsCaches?.(); context.allTimeSessionsCache.clear?.();
      for (const expected of retained) await pull(expected.id);
      const image = await win.webContents.capturePage(); fs.writeFileSync(path.join(output, 'sessions.png'), image.toPNG());
    }
    audit.checks = { historicalSnapshots: 8, expiredIdsRejected: true, sessionCountersStable: true,
      cloudOverlayTotalsStable: true, modeCacheClear: mode === 'regression' && typeof sync.clearLocalStatsCaches === 'function'
        && typeof context.allTimeSessionsCache.clear === 'function', periodPageReset: true };
    await finish();
  } catch (error) { await finish(error); }
}

if (!isMainThread) runWorker();
else if (process.argv.includes('--seed')) seed();
else runElectron().catch(error => { console.error(error); process.exitCode = 1; });
