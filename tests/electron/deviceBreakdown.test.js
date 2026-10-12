'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { deviceBreakdownForPeriod, deviceLabel, devicePlatformLabel } = require('../../src/electron/renderer/deviceBreakdown');

test('device labels use the first nonblank display name, device ID or hostname', () => {
  assert.equal(deviceLabel({ displayName: ' Studio ', deviceId: 'remote', hostname: 'remote.local' }), 'Studio');
  assert.equal(deviceLabel({ displayName: ' \t ', deviceId: ' remote ', hostname: 'remote.local' }), 'remote');
  assert.equal(deviceLabel({ displayName: '', deviceId: ' ', hostname: ' Legacy.local ' }), 'Legacy.local');
  assert.equal(deviceLabel({}), 'device');
  assert.equal(deviceLabel(null), 'device');
});

test('Devices, sync settings and TPS agree on labels in Node and browser entrypoints', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  const rowsSource = app.slice(app.indexOf('function deviceRowsForPeriod('), app.indexOf('function attributionComponent('));
  const period = { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000, modelThroughput: {
    alpha: { timedTokens: 100, timedOutputTokens: 40, timedDurationMs: 1000 }
  } };
  const devices = [
    { deviceId: 'remote', displayName: ' Studio ', hostname: 'remote.local', periods: { today: period } },
    { deviceId: 'desktop', displayName: ' \t ', hostname: 'desktop.local', periods: { today: period } },
    { hostname: ' Legacy.local ', periods: { today: period } },
    { periods: { today: period } }
  ];
  const expectedNames = ['Studio', 'desktop', 'Legacy.local', 'device'];
  const settingsNames = expectedNames.slice(0, 2);
  const nodeApi = {
    TokenMonitorDeviceBreakdown: require('../../src/electron/renderer/deviceBreakdown'),
    TokenMonitorSyncDevicePanel: require('../../src/electron/renderer/syncDevicePanel'),
    TokenMonitorTokenRate: require('../../src/electron/renderer/tokenRatePresentation')
  };
  const contexts = [nodeApi];
  for (const entrypoint of ['index.html', 'edgeDock/index.html']) {
    const html = fs.readFileSync(path.join(rendererDir, entrypoint), 'utf8');
    const window = {};
    const context = vm.createContext({ window });
    const scripts = [...html.matchAll(/<script src="([^"]+)"/g)]
      .map((match) => path.resolve(rendererDir, path.dirname(entrypoint), match[1]))
      .filter((file) => ['deviceBreakdown.js', 'syncDevicePanel.js', 'tokenRatePresentation.js'].includes(path.basename(file)));
    for (const file of scripts) vm.runInContext(fs.readFileSync(file, 'utf8'), context, { filename: file });
    assert.ok(window.TokenMonitorDeviceBreakdown);
    assert.ok(window.TokenMonitorTokenRate);
    contexts.push(window);
  }
  for (const api of contexts) {
    if (api.TokenMonitorSyncDevicePanel) {
      const settings = api.TokenMonitorSyncDevicePanel.deviceRows(devices, { localDeviceId: 'remote' });
      assert.equal(JSON.stringify(settings.map((row) => row.name)), JSON.stringify(settingsNames));
      assert.equal(JSON.stringify(settings.map((row) => row.key)), JSON.stringify(['remote', 'desktop']));
    }
    const context = vm.createContext({
      state: { settings: { deviceId: 'remote' }, period: 'today' },
      fixedPeriodDevices: () => devices,
      deviceBreakdownApi: api.TokenMonitorDeviceBreakdown,
      clientLabels: {}, clientColors: {},
      deviceRuntimeLabel: () => '', deviceSyncedLabel: () => '', deviceColor: () => '', t: (key) => key
    });
    const rows = vm.runInContext(`${rowsSource}\ndeviceRowsForPeriod()`, context);
    assert.equal(JSON.stringify(rows.map((row) => row.name)), JSON.stringify(expectedNames));
    for (const hubMode of ['client', 'host', 'icloud']) {
      const selection = api.TokenMonitorTokenRate.selectLiveTokenRatePeriods({ devices }, 'remote', hubMode, 'all');
      assert.equal(JSON.stringify(selection.entries.map((entry) => entry.name)), JSON.stringify(expectedNames));
      // Display names never become partition keys.
      assert.equal(selection.entries[0].id, 'device:remote');
    }
    for (const hubMode of ['local', 'client', 'host', 'icloud']) {
      const selection = api.TokenMonitorTokenRate.selectLiveTokenRatePeriods({ devices }, 'remote', hubMode, 'device');
      assert.equal(selection.entries[0].name, 'Studio');
    }
    const tracker = api.TokenMonitorTokenRate.createLiveTokenRateGroupTracker({ now: () => 100 });
    const twoDevices = devices.slice(0, 2);
    const base = twoDevices.map((device) => ({ ...device, periods: { today: {
      timedTokens: 0, timedOutputTokens: 0, timedDurationMs: 0, modelThroughput: {}
    } } }));
    tracker.reset(api.TokenMonitorTokenRate.selectLiveTokenRatePeriods({ devices: base }, 'remote', 'client', 'all').entries);
    tracker.observe(api.TokenMonitorTokenRate.selectLiveTokenRatePeriods({ devices: twoDevices }, 'remote', 'client', 'all').entries);
    assert.equal(tracker.getSample().speed, 80);
    const headings = api.TokenMonitorTokenRate.liveTokenRateTooltipEntries(tracker.getSample(), 'speed', String)
      .filter((entry) => !Array.isArray(entry)).map((entry) => entry.full);
    assert.equal(JSON.stringify(headings), JSON.stringify(settingsNames));
  }
});

test('deviceBreakdownForPeriod nests sorted models under each tool', () => {
  const result = deviceBreakdownForPeriod({ periods: { month: {
    totalTokens: 1000,
    clients: { claude: 300, codex: 700 },
    clientCosts: { claude: 1.5, codex: 4 },
    clientModels: {
      claude: { 'claude-opus': 100, 'claude-sonnet': 200 },
      codex: { 'gpt-5.4': 500, 'gpt-5.3-codex': 200 }
    },
    clientModelCosts: {
      claude: { 'claude-opus': 1, 'claude-sonnet': 0.5 },
      codex: { 'gpt-5.4': 3, 'gpt-5.3-codex': 1 }
    }
  } } }, 'month', {
    clientLabels: { claude: 'Claude Code', codex: 'Codex' },
    clientColors: { claude: '#cc7755', codex: '#00aabb' }
  });

  assert.equal(result.totalTokens, 1000);
  assert.deepEqual(result.tools.map(({ key, value, percent, color }) => ({ key, value, percent, color })), [
    { key: 'codex', value: 700, percent: 70, color: '#00aabb' },
    { key: 'claude', value: 300, percent: 30, color: '#cc7755' }
  ]);
  assert.deepEqual(result.tools[0].models, [
    { key: 'gpt-5.4', name: 'gpt-5.4', value: 500 },
    { key: 'gpt-5.3-codex', name: 'gpt-5.3-codex', value: 200 }
  ]);
});

test('deviceBreakdownForPeriod tolerates shared models and legacy device records', () => {
  const result = deviceBreakdownForPeriod({ periods: { today: {
    totalTokens: 75,
    clients: { codex: 50, opencode: 25 },
    clientModels: { codex: { shared: 50 }, opencode: { shared: 25 } }
  } } }, 'today');

  assert.equal(result.tools.length, 2);
  assert.equal(result.tools[0].color, '#73bdf5');
  assert.deepEqual(deviceBreakdownForPeriod({ periods: { today: { totalTokens: 20 } } }, 'today', {
    unattributedLabel: '未分類'
  }), {
    totalTokens: 20,
    tools: [{
      key: '__unattributed',
      client: '__unattributed',
      name: '未分類',
      value: 20,
      percent: 100,
      color: '#73bdf5',
      models: []
    }]
  });
});

test('devicePlatformLabel appends OS versions without exposing architecture', () => {
  assert.equal(devicePlatformLabel('darwin-arm64', 'macOS', '26.0'), 'macOS 26.0');
  assert.equal(devicePlatformLabel('win32-x64', 'Windows 11', '24H2'), 'Windows 11 24H2');
  assert.equal(devicePlatformLabel('linux-x64', 'Ubuntu', '24.04.2 LTS'), 'Ubuntu 24.04.2 LTS');
  assert.equal(devicePlatformLabel('linux-x64', '', ''), 'Linux');
});

test('device breakdown browser helper loads before app.js and keeps reduced-motion coverage', () => {
  const rendererDir = path.join(__dirname, '..', '..', 'src', 'electron', 'renderer');
  const html = fs.readFileSync(path.join(rendererDir, 'index.html'), 'utf8');
  const css = fs.readFileSync(path.join(rendererDir, 'styles.css'), 'utf8');
  const app = fs.readFileSync(path.join(rendererDir, 'app.js'), 'utf8');
  assert.ok(html.indexOf('<script src="deviceBreakdown.js"></script>') < html.indexOf('<script src="app.js"></script>'));
  assert.match(css, /\.device-model-list \{/);
  assert.match(css, /\.device-model-row \{[\s\S]*justify-content: space-between;/);
  assert.match(css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.row-accordion/);
  assert.match(app, /const signature = JSON\.stringify\(\[\s*toolIconsEnabled\(state\.settings\?\.showToolIcons\),/);
  assert.match(app, /deviceDetail: \{[\s\S]*emptyText: breakdown\.totalTokens > 0 \? t\('devices\.detailsUnavailable'\) : t\('home\.noTools'\)/);
  assert.doesNotMatch(app, /deviceDetail: breakdown\.totalTokens > 0 \?/);
});
