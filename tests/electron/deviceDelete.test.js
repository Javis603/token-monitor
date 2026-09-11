'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const app = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');

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
  const document = {
    createElement: (tagName) => new FakeNode(tagName),
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

test('device deletion confirmation cancels on blur, outside interaction, timeout, and redraw', async () => {
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
  assert.equal(remove.dataset.confirm, '');

  await remove.dispatch('click');
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
