'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');
const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

function functionSource(source, name, nextName) {
  const start = source.indexOf(`function ${name}(`);
  const next = source.indexOf(`${nextName}(`, start + 1);
  const end = next < 0 ? -1 : source.lastIndexOf('\n', next) + 1;
  assert.ok(start >= 0 && end > start, `${name} source should be present`);
  return source.slice(start, end);
}

class FakeNode {
  constructor(tagName) {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.listeners = new Map();
    this.style = {};
    this.disabled = false;
    this._textContent = '';
  }

  set textContent(value) { this._textContent = String(value ?? ''); }
  get textContent() { return this._textContent; }

  append(...children) {
    for (const child of children) {
      child.parentNode = this;
      this.children.push(child);
    }
  }

  replaceChildren(...children) {
    this.children = [];
    this.append(...children);
  }

  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) || [];
    listeners.push(listener);
    this.listeners.set(type, listeners);
  }

  dispatch(type, init = {}) {
    const event = { target: this, ...init };
    const results = (this.listeners.get(type) || []).map((listener) => listener(event));
    return results.at(-1);
  }

  contains(target) {
    return target === this || this.children.some((child) => child.contains?.(target));
  }

  querySelector(selector) {
    if (selector !== '.device-delete-button') return null;
    for (const child of this.children) {
      if (child.className === 'device-delete-button') return child;
      const nested = child.querySelector?.(selector);
      if (nested) return nested;
    }
    return null;
  }
}

function createHarness() {
  const documentListeners = new Map();
  const createdNodes = [];
  const document = {
    createElement: (tagName) => {
      const node = new FakeNode(tagName);
      createdNodes.push(node);
      return node;
    },
    querySelectorAll: () => createdNodes.filter((node) => node.className === 'device-delete-button'),
    addEventListener(type, listener) {
      const listeners = documentListeners.get(type) || [];
      listeners.push(listener);
      documentListeners.set(type, listeners);
    },
    dispatch(type, init = {}) {
      const event = { target: this, ...init };
      return (documentListeners.get(type) || []).map((listener) => listener(event)).at(-1);
    }
  };
  const timers = new Map();
  let nextTimer = 1;
  let deleteImplementation = async () => {};
  let deleteCalls = 0;
  let refreshCalls = 0;
  const context = {
    document,
    state: { settings: { showToolIcons: false } },
    toolIconsEnabled: () => false,
    clientsWithIcon: new Set(),
    formatNumber: (value) => String(value),
    formatCompact: (value) => String(value),
    t: (key) => ({
      'settings.sync.icloudDelete': 'Delete',
      'settings.sync.icloudDeleteConfirm': 'Click again'
    }[key] || key),
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    window: {
      tokenMonitor: {
        deleteDevice: async (...args) => {
          deleteCalls += 1;
          return deleteImplementation(...args);
        }
      }
    },
    refreshStats: async () => { refreshCalls += 1; }
  };
  const start = app.indexOf('const DEVICE_DELETE_CONFIRMATION_MS');
  const end = app.indexOf('\nfunction appendAccordionMetricRow', start);
  assert.ok(start >= 0 && end > start, 'delete confirmation implementation should be present');
  vm.runInNewContext(
    `${app.slice(start, end)}\nglobalThis.renderDeviceAccordionForTest = renderDeviceAccordion;`,
    context
  );
  return {
    context,
    document,
    timers,
    render: context.renderDeviceAccordionForTest,
    createNode: (tagName) => new FakeNode(tagName),
    getDeleteCalls: () => deleteCalls,
    getRefreshCalls: () => refreshCalls,
    setDeleteImplementation: (implementation) => { deleteImplementation = implementation; }
  };
}

function deviceDetail(deviceId = 'remote-a', tools = []) {
  return {
    deviceId,
    tools,
    emptyText: 'No tools',
    metaParts: [],
    canDelete: true
  };
}

test('only stale remote iCloud devices offer removal, including historical views', () => {
  const source = functionSource(app, 'deviceRowsForPeriod', 'attributionComponent');
  const active = { deviceId: 'active', stale: false, periods: { today: {} } };
  const stale = { deviceId: 'stale', stale: true, periods: { today: {} } };
  const local = { deviceId: 'local', stale: true, periods: { today: {} } };
  const context = vm.createContext({
    state: { settings: { hubMode: 'icloud', deviceId: 'local' }, period: 'today', stats: { devices: [active, stale, local] } },
    fixedPeriodDevices: () => [active, stale, local],
    deviceBreakdownApi: {
      deviceBreakdownForPeriod: () => ({ totalTokens: 0, tools: [] }),
      devicePlatformLabel: () => ''
    },
    clientLabels: {},
    clientColors: { default: '#fff' },
    deviceColor: () => '#fff',
    deviceLabel: (device) => device.deviceId,
    deviceRuntimeLabel: () => '',
    deviceSyncedLabel: () => '',
    t: () => '',
    Boolean,
    Number,
    String
  });
  vm.runInContext(`${source}\nglobalThis.rows = deviceRowsForPeriod;`, context);
  const eligibility = () => Object.fromEntries(context.rows().map((row) => [row.key, row.deviceDetail.canDelete]));

  assert.deepEqual(eligibility(), { active: false, stale: true, local: false });
  context.state.period = 'last30Days';
  context.fixedPeriodDevices = () => [
    { deviceId: 'active', stale: true, periods: { last30Days: {} } },
    { deviceId: 'stale', stale: false, periods: { last30Days: {} } }
  ];
  assert.deepEqual(eligibility(), { active: false, stale: true });
  context.state.settings.hubMode = 'client';
  assert.deepEqual(eligibility(), { active: false, stale: false });
});

test('device deletion confirmation cancels on blur, outside interaction, timeout, and changed redraw', async () => {
  const harness = createHarness();
  const accordion = harness.createNode('div');
  harness.render(accordion, deviceDetail());
  const remove = accordion.querySelector('.device-delete-button');

  await remove.dispatch('click');
  assert.equal(remove.dataset.confirm, 'true');
  assert.equal(remove.textContent, 'Click again');
  remove.dispatch('blur');
  assert.equal(remove.dataset.confirm, '');
  assert.equal(remove.textContent, 'Delete');

  await remove.dispatch('click');
  harness.document.dispatch('pointerdown', { target: harness.createNode('button') });
  assert.equal(remove.dataset.confirm, '');

  await remove.dispatch('click');
  const timer = harness.timers.values().next().value;
  timer();
  assert.equal(remove.dataset.confirm, '');

  await remove.dispatch('click');
  harness.render(accordion, deviceDetail());
  assert.equal(remove.dataset.confirm, 'true');
  assert.equal(remove.textContent, 'Click again');
  assert.equal(harness.timers.size, 1);

  harness.render(accordion, deviceDetail('remote-b', [{
    key: 'codex', client: 'codex', value: 1, percent: 100, color: '#fff', models: []
  }]));
  assert.equal(remove.dataset.confirm, '');
  assert.equal(harness.timers.size, 0);
});

test('device deletion requires the second click and resets after failure', async () => {
  const harness = createHarness();
  const accordion = harness.createNode('div');
  harness.render(accordion, deviceDetail());
  const remove = accordion.querySelector('.device-delete-button');

  await remove.dispatch('click');
  assert.equal(harness.getDeleteCalls(), 0);
  await remove.dispatch('click');
  assert.equal(harness.getDeleteCalls(), 1);
  assert.equal(harness.getRefreshCalls(), 1);
  assert.equal(remove.dataset.confirm, '');

  harness.setDeleteImplementation(async () => { throw new Error('delete failed'); });
  harness.render(accordion, deviceDetail('remote-c'));
  const failedRemove = accordion.querySelector('.device-delete-button');
  await failedRemove.dispatch('click');
  await failedRemove.dispatch('click');
  assert.equal(failedRemove.dataset.confirm, '');
  assert.equal(failedRemove.textContent, 'Delete');
  assert.equal(failedRemove.disabled, false);
});

test('device deletion rejects a blank id before calling the sync backend', () => {
  const source = functionSource(main, 'normalizeDeviceIdForDeletion', 'deleteDeviceFromCurrentSync');
  const context = vm.createContext({ String, Error, Object });
  vm.runInContext(`${source}\nglobalThis.normalizeDeviceIdForDeletion = normalizeDeviceIdForDeletion;`, context);

  assert.equal(context.normalizeDeviceIdForDeletion(' remote-a '), 'remote-a');
  assert.throws(() => context.normalizeDeviceIdForDeletion('   '), (error) => error.code === 'invalid_device_id');
  assert.throws(() => context.normalizeDeviceIdForDeletion(null), (error) => error.code === 'invalid_device_id');
  assert.match(main, /ipcMain\.handle\('devices:delete',[\s\S]*?deleteDeviceFromCurrentSync\(normalizeDeviceIdForDeletion\(deviceId\)\)/);
});

test('main process deletion accepts only a known remote device in the current sync runtime', async () => {
  const source = functionSource(main, 'deleteDeviceFromCurrentSync', 'postToHub');
  const context = vm.createContext({
    settings: { hubMode: 'icloud', deviceId: 'local' },
    icloudRuntimeHandle: { deleteDevice: async (id) => { context.deleted = id; } },
    currentHubIdentity: () => 'icloud',
    fetchStats: async () => ({ devices: [
      { deviceId: 'local' },
      { deviceId: 'remote', stale: true },
      { deviceId: 'active', stale: false },
      { deviceId: 'unknown-status' }
    ] }),
    deleteDeviceFromHub: async (id) => { context.deleted = id; },
    defaultDeviceId: () => 'fallback-device',
    Promise,
    String,
    Object
  });
  vm.runInContext(`async ${source}\nglobalThis.deleteDeviceFromCurrentSync = deleteDeviceFromCurrentSync;`, context);

  await assert.rejects(
    () => context.deleteDeviceFromCurrentSync('local'),
    (error) => error.code === 'local_device_delete_not_allowed'
  );
  await assert.rejects(
    () => context.deleteDeviceFromCurrentSync('unknown'),
    (error) => error.code === 'device_not_found'
  );
  for (const id of ['active', 'unknown-status']) {
    await assert.rejects(
      () => context.deleteDeviceFromCurrentSync(id),
      (error) => error.code === 'device_not_stale'
    );
  }
  assert.equal(context.deleted, undefined);

  await context.deleteDeviceFromCurrentSync('remote');
  assert.equal(context.deleted, 'remote');
});

test('Hub deletion still accepts a known active remote device', async () => {
  const source = functionSource(main, 'deleteDeviceFromCurrentSync', 'postToHub');
  const context = vm.createContext({
    settings: { hubMode: 'client', deviceId: 'local' },
    icloudRuntimeHandle: null,
    currentHubIdentity: () => 'https://example.test',
    fetchStats: async () => ({ devices: [{ deviceId: 'active', stale: false }] }),
    deleteDeviceFromHub: async (id) => { context.deleted = id; },
    defaultDeviceId: () => 'fallback-device',
    Promise,
    String,
    Object
  });
  vm.runInNewContext(`async ${source}\nglobalThis.deleteDeviceFromCurrentSync = deleteDeviceFromCurrentSync;`, context);

  await context.deleteDeviceFromCurrentSync('active');
  assert.equal(context.deleted, 'active');
});

test('main process deletion abandons eligibility checks after a mode switch', async () => {
  const source = functionSource(main, 'deleteDeviceFromCurrentSync', 'postToHub');
  let finishStats;
  const context = vm.createContext({
    settings: { hubMode: 'icloud', deviceId: 'local' },
    icloudRuntimeHandle: { deleteDevice: async () => { context.deleted = true; } },
    currentHubIdentity: () => context.settings.hubMode === 'icloud' ? 'icloud' : '',
    fetchStats: () => new Promise((resolve) => { finishStats = resolve; }),
    deleteDeviceFromHub: async () => { context.deleted = true; },
    defaultDeviceId: () => 'fallback-device',
    Promise,
    String,
    Object
  });
  vm.runInContext(`async ${source}\nglobalThis.deleteDeviceFromCurrentSync = deleteDeviceFromCurrentSync;`, context);

  const deleting = context.deleteDeviceFromCurrentSync('remote');
  await new Promise((resolve) => setImmediate(resolve));
  context.settings.hubMode = 'local';
  finishStats({ devices: [{ deviceId: 'remote' }] });

  await assert.rejects(deleting, (error) => error.code === 'hub_changed');
  assert.equal(context.deleted, undefined);
});

test('pending deletion survives a stats redraw and releases the replacement button on completion', async () => {
  for (const failure of [false, true]) {
    const harness = createHarness();
    let finish;
    harness.setDeleteImplementation(() => new Promise((resolve, reject) => {
      finish = () => failure ? reject(new Error('delete failed')) : resolve();
    }));
    const accordion = harness.createNode('div');
    const detail = deviceDetail();
    harness.render(accordion, detail);
    const original = accordion.querySelector('.device-delete-button');
    await original.dispatch('click');
    const pending = original.dispatch('click');
    assert.equal(original.disabled, true);
    harness.render(accordion, { ...detail, metaParts: ['new timestamp'] });
    const replacement = accordion.querySelector('.device-delete-button');
    assert.notEqual(replacement, original);
    assert.equal(replacement.disabled, true);
    await replacement.dispatch('click');
    await replacement.dispatch('click');
    assert.equal(harness.getDeleteCalls(), 1);
    const recreatedAccordion = harness.createNode('div');
    harness.render(recreatedAccordion, detail);
    const recreated = recreatedAccordion.querySelector('.device-delete-button');
    assert.equal(recreated.disabled, true);
    finish();
    await pending;
    assert.equal(recreated.disabled, false);
    assert.equal(replacement.disabled, false);
    assert.equal(replacement.dataset.confirm, '');
    assert.equal(harness.getRefreshCalls(), failure ? 0 : 1);
  }
});
