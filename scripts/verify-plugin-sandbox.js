'use strict';

// Real-Electron verification of the plugin platform: isolation, permission
// enforcement, fault containment and the cost of sampling. Unit tests cover the
// decisions; this runs the actual Chromium sandbox, CSP and process lifecycle.
//
//   npm run verify:plugins            (or: electron scripts/verify-plugin-sandbox.js --out report.json)
//
// It never touches the user's settings or data: userData is a temp directory
// and every plugin comes from tests/fixtures or the shipped examples.

const fs = require('node:fs');
const http = require('node:http');
const os = require('node:os');
const path = require('node:path');
const { app, BrowserWindow, protocol, session } = require('electron');
const { createDataBus } = require('../src/shared/plugins/dataBus');
const { createCpuSampler, createMemorySampler } = require('../src/electron/plugins/systemMetrics');
const { createPluginSandbox, registerPluginScheme } = require('../src/electron/plugins/sandbox');
const { createPluginManager } = require('../src/electron/plugins/manager');
const { createElectronNetFetch } = require('../src/electron/limits/fetch');

const ROOT = path.join(__dirname, '..');
const outIndex = process.argv.indexOf('--out');
const OUT = outIndex > 0 ? process.argv[outIndex + 1] : '';
const QUICK = process.argv.includes('--quick');

registerPluginScheme(protocol);
const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugin-verify-'));
app.setPath('userData', path.join(tempRoot, 'userData'));
app.on('window-all-closed', () => {});

const results = { checks: [], measurements: {}, exits: [], startedAt: new Date().toISOString(), electron: process.versions.electron, platform: `${process.platform}-${process.arch}` };
function check(name, ok, detail = '') {
  results.checks.push({ name, ok: Boolean(ok), detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? `  (${detail})` : ''}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function waitFor(predicate, timeoutMs, stepMs = 100) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(stepMs);
  }
  return predicate();
}

function copyDir(from, to, transform = (text) => text) {
  fs.mkdirSync(to, { recursive: true });
  for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
    const source = path.join(from, entry.name);
    const target = path.join(to, entry.name);
    if (entry.isDirectory()) copyDir(source, target, transform);
    else fs.writeFileSync(target, transform(fs.readFileSync(source, 'utf8')));
  }
}

function startCanary() {
  const hits = [];
  const server = http.createServer((request, response) => {
    hits.push(`${request.method} ${request.url}`);
    response.writeHead(200, { 'content-type': 'text/plain', 'access-control-allow-origin': '*' });
    response.end('leaked');
  });
  server.on('upgrade', (request, socket) => { hits.push(`UPGRADE ${request.url}`); socket.destroy(); });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, hits, port: server.address().port })));
}

function mainCpuPercent(startUsage, startTime) {
  const usage = process.cpuUsage(startUsage);
  const wallMicros = (Date.now() - startTime) * 1000;
  return Math.round(((usage.user + usage.system) / wallMicros) * 1000) / 10;
}

async function measureMainCpu(ms) {
  const usage = process.cpuUsage();
  const start = Date.now();
  await sleep(ms);
  return mainCpuPercent(usage, start);
}

async function run() {
  app.dock?.hide();
  const canary = await startCanary();
  const userDir = path.join(tempRoot, 'plugins');
  for (const name of ['hostile', 'busy', 'memory', 'flood']) {
    copyDir(path.join(ROOT, 'tests/fixtures/plugins', name), path.join(userDir, name), (text) => text.replaceAll('__PORT__', String(canary.port)));
  }
  copyDir(path.join(ROOT, 'docs/plugins/examples/token-pulse'), path.join(userDir, 'token-pulse'));

  const sampleCounts = { 'sys.cpu': 0, 'sys.memory': 0 };
  const cpu = createCpuSampler();
  const memory = createMemorySampler();
  const bus = createDataBus({ onError: (error) => console.log(`[bus] ${error.message}`) });
  bus.defineSource('sys.cpu', { minIntervalMs: 1000, sample: () => { sampleCounts['sys.cpu'] += 1; return cpu(); } });
  bus.defineSource('sys.memory', { minIntervalMs: 1000, sample: () => { sampleCounts['sys.memory'] += 1; return memory(); } });

  let settings = { pluginStates: {} };
  const notifications = [];
  const blocked = [];
  let manager = null;
  const sandbox = createPluginSandbox({
    electron: { BrowserWindow, session, app },
    onMessage: (id, message) => manager.handleMessage(id, message),
    onExit: (id, reason) => {
      results.exits.push({ id, reason, at: Date.now() });
      manager.handleExit(id, reason);
    },
    log: (line) => { if (line.includes('blocked request')) blocked.push(line); }
  });
  manager = createPluginManager({
    builtinDir: path.join(ROOT, 'src/electron/plugins/builtin'),
    userDir,
    dataDir: path.join(tempRoot, 'plugin-data'),
    bus,
    sandbox,
    notify: (note) => notifications.push(note),
    netFetch: createElectronNetFetch({ fetch: (input, init) => session.fromPartition('tm-plugin-net-verify', { cache: false }).fetch(input, init) }),
    getSettings: () => settings,
    saveStates: (next) => { settings = { ...settings, pluginStates: next }; },
    log: (line) => console.log(line)
  });
  manager.reload();
  const listed = manager.list().plugins.map((plugin) => `${plugin.id}:${plugin.status}`);
  check('fixtures and examples load', listed.length >= 6, listed.join(' '));

  // Simulated usage so tm.* sources move like a live session.
  let tokens = 0;
  const usageTimer = setInterval(() => {
    tokens += 1500 + Math.round(Math.random() * 4000);
    bus.publish('tm.today', { tokens, cost: tokens / 1e6, unpricedTokens: 0 });
    bus.publish('tm.rate', { speed: 40, burn: 3000, idle: false });
  }, 1000);

  // ---- 1. Isolation and permissions -------------------------------------
  manager.setEnabled('hostile', true);
  manager.setSurfaceDemand('home', ['hostile/report']);
  const reported = await waitFor(() => bus.read('plugin.hostile.report')?.value?.done === 'done', 30_000);
  check('hostile plugin ran its probes inside the sandbox', reported);
  const report = bus.read('plugin.hostile.report')?.value || {};
  results.hostileReport = report;
  for (const name of ['require', 'process', 'window', 'document', 'hostBridge', 'sendBeacon', 'rtc']) {
    check(`no ${name} in the plugin Worker`, report[name] === 'undefined', report[name]);
  }
  for (const name of ['fetchCanary', 'fetchRemote', 'fetchFile', 'fetchHost', 'fetchHub', 'xhr', 'websocket', 'eventSource', 'importScripts', 'importBlob', 'eval', 'newFunction', 'nestedWorkerNetwork',
    'brokerHttp', 'brokerRemote', 'notifyWithoutPermission', 'unknownOp']) {
    check(`${name} is blocked`, String(report[name] || '').startsWith('blocked'), report[name]);
  }
  await sleep(1500);
  check('the canary server received no request from any plugin', canary.hits.length === 0, canary.hits.join(', '));
  check('no notification was shown without the permission', notifications.length === 0);
  const hostileLogs = manager.list().plugins.find((plugin) => plugin.id === 'hostile').logs.map((entry) => entry.text).join('\n');
  check('forged publish to an undeclared metric was rejected', /undeclared metric "secret"/.test(hostileLogs));
  check('subscribe outside the grant was rejected', /subscribe sys\.cpu denied/.test(hostileLogs));
  await sleep(1500);
  const dataFiles = fs.existsSync(path.join(tempRoot, 'plugin-data')) ? fs.readdirSync(path.join(tempRoot, 'plugin-data')) : [];
  const stored = dataFiles.includes('hostile.json') ? JSON.parse(fs.readFileSync(path.join(tempRoot, 'plugin-data', 'hostile.json'), 'utf8')) : {};
  check('a path-like storage key stays a key in the plugin\'s own file', dataFiles.join(',') === 'hostile.json'
    && Object.hasOwn(stored, '../../settings') && !fs.existsSync(path.join(tempRoot, 'settings')) && !fs.existsSync(path.join(tempRoot, 'settings.json')),
  `${report.storageTraversalKey}; files: ${dataFiles.join(',')}`);
  manager.setSurfaceDemand('home', []);
  manager.setEnabled('hostile', false);

  // ---- 2. Demand-driven sampling and cost --------------------------------
  const before = { ...sampleCounts };
  const idleMainCpu = await measureMainCpu(QUICK ? 4000 : 10_000);
  check('nothing samples while no view or rule asks', sampleCounts['sys.cpu'] === before['sys.cpu'] && sampleCounts['sys.memory'] === before['sys.memory'],
    JSON.stringify(sampleCounts));
  results.measurements.mainCpuIdlePercent = idleMainCpu;

  const cpuCost = (() => {
    const sampler = createCpuSampler();
    sampler();
    const start = process.hrtime.bigint();
    for (let index = 0; index < 1000; index += 1) sampler();
    return Number(process.hrtime.bigint() - start) / 1000 / 1000;
  })();
  const memoryCost = (() => {
    const sampler = createMemorySampler();
    const start = process.hrtime.bigint();
    for (let index = 0; index < 1000; index += 1) sampler();
    return Number(process.hrtime.bigint() - start) / 1000 / 1000;
  })();
  results.measurements.cpuSampleMicros = Math.round(cpuCost * 10) / 10;
  results.measurements.memorySampleMicros = Math.round(memoryCost * 10) / 10;
  check('one CPU sample costs well under a millisecond', cpuCost < 1000, `${results.measurements.cpuSampleMicros} µs`);
  check('one memory sample costs well under a millisecond', memoryCost < 1000, `${results.measurements.memorySampleMicros} µs`);

  manager.setEnabled('system-monitor', true);
  manager.setBackground('system-monitor', false);
  const visibleStart = { ...sampleCounts };
  manager.setSurfaceDemand('home', ['system-monitor/overview']);
  const visibleWindow = QUICK ? 6000 : 20_000;
  const visibleMainCpu = await measureMainCpu(visibleWindow);
  const visibleSamples = sampleCounts['sys.cpu'] - visibleStart['sys.cpu'];
  results.measurements.mainCpuSystemMonitorVisiblePercent = visibleMainCpu;
  results.measurements.systemMonitorSamplesPerMinute = Math.round(visibleSamples / (visibleWindow / 60_000));
  check('a declarative plugin samples at its visible interval (2 s)', Math.abs(visibleSamples - visibleWindow / 2000) <= 2, `${visibleSamples} samples in ${visibleWindow / 1000} s`);
  check('a declarative plugin starts no process', !sandbox.isRunning('system-monitor'));
  const overview = manager.payload('home').views['system-monitor/overview'];
  check('system monitor resolves a live view', overview?.status === 'ok' && JSON.stringify(overview.tree).includes('%'));

  manager.setSurfaceDemand('home', []);
  manager.setBackground('system-monitor', true);
  const backgroundStart = sampleCounts['sys.cpu'];
  await sleep(QUICK ? 16_000 : 31_000);
  const backgroundSamples = sampleCounts['sys.cpu'] - backgroundStart;
  check('with every view hidden, alerts keep sampling at the 15 s background cadence', backgroundSamples >= 1 && backgroundSamples <= (QUICK ? 2 : 3), `${backgroundSamples} samples`);
  manager.setBackground('system-monitor', false);
  const stoppedAt = { ...sampleCounts };
  await sleep(5000);
  check('turning background off stops sampling entirely', sampleCounts['sys.cpu'] === stoppedAt['sys.cpu'] && sampleCounts['sys.memory'] === stoppedAt['sys.memory']);

  // A code plugin: one sandboxed process, measured by Chromium.
  manager.setEnabled('token-pulse', true);
  manager.setBackground('token-pulse', false);
  manager.setSurfaceDemand('notch', ['token-pulse/pulse']);
  const pulseUp = await waitFor(() => bus.read('plugin.token-pulse.pulse')?.value?.length > 0, 20_000);
  check('a code plugin publishes a free-drawn display list', pulseUp);
  const metrics = [];
  for (let index = 0; index < (QUICK ? 3 : 8); index += 1) {
    await sleep(2000);
    const entry = sandbox.metrics()['token-pulse'];
    if (entry) metrics.push(entry);
  }
  const memoryMB = Math.max(...metrics.map((entry) => entry.memoryMB));
  const cpuPercent = Math.round((metrics.reduce((sum, entry) => sum + entry.cpuPercent, 0) / Math.max(1, metrics.length)) * 10) / 10;
  results.measurements.codePluginProcess = { memoryMB, cpuPercentAvg: cpuPercent, samples: metrics.length };
  check('a visible code plugin stays within its CPU budget', cpuPercent < 5, `${cpuPercent}% avg`);
  check('a code plugin process stays within its memory budget', memoryMB > 0 && memoryMB < 256, `${memoryMB} MB`);
  const pulseView = manager.payload('notch').views['token-pulse/pulse'];
  check('the code plugin view resolves on the Notch surface', pulseView?.status === 'ok' && Array.isArray(pulseView.tree.children?.[1]?.list));
  manager.setSurfaceDemand('notch', []);
  await sleep(32_000);
  check('an idle code plugin process is released after the grace period', !sandbox.isRunning('token-pulse'));

  // ---- 3. Fault containment ----------------------------------------------
  manager.setSurfaceDemand('notch', ['token-pulse/pulse']);
  await waitFor(() => sandbox.isRunning('token-pulse'), 10_000);
  for (const id of ['busy', 'memory', 'flood']) manager.setEnabled(id, true);
  manager.setSurfaceDemand('home', ['busy/alive', 'memory/held', 'flood/sent']);
  const faults = await waitFor(() => ['busy', 'memory', 'flood'].every((id) => results.exits.some((exit) => exit.id === id)), 60_000, 250);
  const reasons = Object.fromEntries(['busy', 'memory', 'flood'].map((id) => [id, results.exits.filter((exit) => exit.id === id).map((exit) => exit.reason)]));
  results.measurements.faultReasons = reasons;
  check('a busy-looping plugin is detected and stopped', reasons.busy.includes('hung'), reasons.busy.join(','));
  check('a memory bomb is stopped by the memory budget or the renderer', reasons.memory.some((reason) => reason === 'over-memory-budget' || reason.startsWith('crashed:')), reasons.memory.join(','));
  check('a message flood is cut off', reasons.flood.includes('flooding'), reasons.flood.join(','));
  check('all three faults were contained', faults);
  const pulseValue = bus.read('plugin.token-pulse.tpm');
  await sleep(5000);
  const pulseLater = bus.read('plugin.token-pulse.tpm');
  check('a well-behaved plugin keeps running while others fail', sandbox.isRunning('token-pulse') && pulseLater && pulseValue && pulseLater.at > pulseValue.at);
  const restarted = await waitFor(() => results.exits.filter((exit) => exit.id === 'busy').length >= 2, 30_000, 250);
  check('a failed plugin restarts with backoff', restarted);

  clearInterval(usageTimer);
  manager.dispose();
  canary.server.close();
  results.finishedAt = new Date().toISOString();
  results.blockedRequests = blocked.length;
  const failed = results.checks.filter((entry) => !entry.ok);
  console.log(`\n${results.checks.length - failed.length}/${results.checks.length} checks passed`);
  console.log(JSON.stringify(results.measurements, null, 2));
  if (OUT) fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch {}
  app.exit(failed.length ? 1 : 0);
}

app.whenReady().then(run).catch((error) => {
  console.error(error);
  app.exit(2);
});
