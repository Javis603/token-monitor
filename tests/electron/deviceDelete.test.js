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
  const next = source.indexOf(`function ${nextName}(`, start + 1);
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

  set textContent(value) { this._textContent = String(value ?? ''); this.children = []; }
  get textContent() { return this._textContent + this.children.map(child => child.textContent).join(''); }
  get parentElement() { return this.parentNode; }
  remove() {
    if (!this.parentNode) return;
    this.parentNode.children.splice(this.parentNode.children.indexOf(this), 1);
    this.parentNode = null;
  }
  insertBefore(child, before) {
    child.remove();
    child.parentNode = this;
    this.children.splice(before ? this.children.indexOf(before) : this.children.length, 0, child);
  }
  moveBefore(child, before) { this.insertBefore(child, before); }

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

  setAttribute(name, value) { this[name] = value; }

  querySelectorAll(selector) {
    return this.children.flatMap(child => [
      ...(child.className === selector.slice(1) ? [child] : []),
      ...child.querySelectorAll(selector)
    ]);
  }

  querySelector(selector) {
    for (const child of this.children) {
      if (child.className?.split(' ').includes(selector.slice(1))) return child;
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
    state: { mode: 'sync', settings: { showToolIcons: false, hubMode: 'client' } },
    els: { syncPanelCount: {}, syncPanelOpenDevices: {} },
    syncDevicePanelApi: require('../../src/electron/renderer/syncDevicePanel'),
    currentLocale: () => 'en',
    availableBreakdownIds: () => ['device'],
    osIconFor: () => '',
    deviceRuntimeLabel: () => '',
    deviceBreakdownApi: { devicePlatformLabel: () => '' },
    prefersReducedMotion: () => false,
    toolIconsEnabled: () => false,
    clientsWithIcon: new Set(),
    formatNumber: (value) => String(value),
    formatCompact: (value) => String(value),
    t: (key) => ({
      'devices.remove': 'Delete',
      'devices.removeConfirm': 'Confirm removal'
    }[key] || key),
    setTimeout(callback) {
      const id = nextTimer++;
      timers.set(id, callback);
      return id;
    },
    clearTimeout(id) { timers.delete(id); },
    window: {
      TokenMonitorOverflowText: { create: () => ({ bind() {} }) },
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
    `${app.slice(start, end)}\nlet syncPanelListScope = '';\n${functionSource(app, 'renderSyncPanelDevices', 'syncDeviceRow')}\n${functionSource(app, 'syncDeviceRow', 'renderHubBuildStatus')}\nglobalThis.renderDeviceAccordionForTest = renderDeviceAccordion;`,
    context
  );
  return {
    context,
    document,
    timers,
    render: (list, detail) => {
      context.els.syncDeviceList = list;
      context.renderSyncPanelDevices([{
        key: detail.deviceId, name: detail.deviceId, hostname: '',
        platform: '', agentVersion: detail.metaParts.join(' '),
        stale: true, canRemove: true
      }]);
    },
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

test('the device usage view has no removal actions in any sync mode', () => {
  const harness = createHarness();
  for (const mode of ['local', 'client', 'host', 'icloud']) {
    harness.context.state.settings.hubMode = mode;
    const accordion = harness.createNode('div');
    harness.context.renderDeviceAccordionForTest(accordion, deviceDetail());
    assert.equal(accordion.querySelector('.device-delete-button'), null);
  }
  const source = functionSource(app, 'deviceRowsForPeriod', 'attributionComponent');
  assert.doesNotMatch(source, /canDelete/);
});

test('device deletion confirmation cancels on blur, outside interaction, timeout, and changed redraw', async () => {
  const harness = createHarness();
  const accordion = harness.createNode('div');
  harness.render(accordion, deviceDetail());
  const remove = accordion.querySelector('.device-delete-button');

  await remove.dispatch('click');
  assert.equal(remove.dataset.confirm, 'true');
  assert.equal(remove.textContent, 'Confirm removal');
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
  assert.equal(remove.textContent, 'Confirm removal');
  assert.equal(harness.timers.size, 1);

  harness.render(accordion, deviceDetail('remote-b', [{
    key: 'codex', client: 'codex', value: 1, percent: 100, color: '#fff', models: []
  }]));
  assert.equal(remove.dataset.confirm, '');
  assert.equal(harness.timers.size, 0);
});

test('device controls retain confirmation and its original deadline across updates, insertion and sorting', async () => {
  const harness = createHarness();
  const list = harness.createNode('div');
  harness.context.els.syncDeviceList = list;
  const row = key => ({ key, name: key, stale: true, canRemove: true });
  const render = rows => harness.context.renderSyncPanelDevices(rows);
  render([row('a'), row('b')]);
  const original = list.children[1];
  const remove = original.querySelector('.device-delete-button');
  await remove.dispatch('click');
  const [timerId, deadline] = harness.timers.entries().next().value;
  render([row('new'), { ...row('b'), name: 'renamed', agentVersion: '0.65.1' }, row('a')]);
  assert.equal(list.children[1], original);
  assert.equal(original.querySelector('.device-delete-button'), remove);
  assert.equal(remove.dataset.confirm, 'true');
  assert.equal(remove.textContent, 'Confirm removal');
  assert.equal(original.querySelector('.sync-device-name').textContent, 'renamed');
  assert.equal(harness.timers.size, 1);
  assert.equal(harness.timers.get(timerId), deadline, 'a push must not extend the confirmation deadline');
  render([row('b'), row('a')]);
  assert.equal(list.children[0], original);
  assert.equal(remove.dataset.confirm, 'true');
  deadline();
  assert.equal(remove.dataset.confirm, '');
  assert.equal(harness.timers.size, 0);
});

test('confirmation cancels when the target disappears, becomes ineligible or the connection changes', async () => {
  for (const change of ['removed', 'online', 'local', 'backend', 'secret', 'mode']) {
    const harness = createHarness();
    const list = harness.createNode('div');
    harness.context.els.syncDeviceList = list;
    const row = { key: 'remote', name: 'remote', stale: true, canRemove: true };
    harness.context.renderSyncPanelDevices([row]);
    const remove = list.querySelector('.device-delete-button');
    await remove.dispatch('click');
    if (change === 'backend') harness.context.state.settings.hubUrl = 'https://new.example';
    if (change === 'secret') harness.context.state.settings.secret = 'new-secret';
    if (change === 'mode') harness.context.state.settings.hubMode = 'icloud';
    const next = change === 'removed' ? [] : [{
      ...row,
      stale: change !== 'online',
      isLocal: change === 'local',
      canRemove: change !== 'online' && change !== 'local'
    }];
    harness.context.renderSyncPanelDevices(next);
    assert.equal(remove.dataset.confirm, '', change);
    assert.equal(harness.timers.size, 0, change);
    if (['online', 'local', 'removed'].includes(change)) {
      assert.equal(list.querySelector('.device-delete-button'), null, change);
    } else {
      const nextRemove = list.querySelector('.device-delete-button');
      assert.notEqual(nextRemove, remove, change);
      assert.notEqual(nextRemove.dataset.confirm, 'true', change);
    }
  }
});

test('language updates keep confirmation and use current labels when its deadline expires', async () => {
  const harness = createHarness();
  const list = harness.createNode('div');
  harness.render(list, deviceDetail());
  const remove = list.querySelector('.device-delete-button');
  await remove.dispatch('click');
  harness.context.currentLocale = () => 'zh-TW';
  harness.context.t = key => ({ 'devices.remove': '移除', 'devices.removeConfirm': '確認移除' }[key] || key);
  harness.render(list, deviceDetail());
  assert.equal(list.querySelector('.device-delete-button'), remove);
  assert.equal(remove.textContent, '確認移除');
  harness.timers.values().next().value();
  assert.equal(remove.textContent, '移除');
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
    assert.equal(replacement, original, 'metadata updates retain the live button');
    assert.equal(replacement.disabled, true);
    await replacement.dispatch('click');
    await replacement.dispatch('click');
    assert.equal(harness.getDeleteCalls(), 1);
    const recreatedAccordion = harness.createNode('div');
    harness.render(recreatedAccordion, { ...detail, metaParts: ['recreated'] });
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
