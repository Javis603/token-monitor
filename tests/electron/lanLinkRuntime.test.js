'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createLanLinkRuntime } = require('../../src/electron/lanLinkRuntime');

const HUB_ID = '0123456789abcdef';

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  return false;
}
const SECRET = 'super-secret-value';

function fakeBrowserFactory() {
  const instances = [];
  const createBrowser = (handlers) => {
    const instance = {
      handlers,
      startCalls: 0,
      stopCalls: 0,
      refreshCalls: 0,
      start() { this.startCalls += 1; },
      stop() { this.stopCalls += 1; },
      refresh() { this.refreshCalls += 1; }
    };
    instances.push(instance);
    return instance;
  };
  return { createBrowser, instances };
}

function discoveredHub(overrides = {}) {
  return {
    hubId: HUB_ID,
    name: 'Studio Mac',
    port: 17321,
    addresses: ['192.168.1.5'],
    lastSeenAt: '2026-11-06T05:00:00.000Z',
    ...overrides
  };
}

function quietLogger() {
  return { warn: () => {} };
}

test('starts browsing only in client mode and publishes an empty discovery status', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const published = [];
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'local' }),
    onDiscoveryChange: (payload) => published.push(payload),
    logger: quietLogger()
  });
  assert.equal(runtime.start(), false);
  assert.equal(instances.length, 0);

  const clientRuntime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'client', hubUrl: 'http://saved.local:17321' }),
    onDiscoveryChange: (payload) => published.push(payload),
    logger: quietLogger()
  });
  assert.equal(clientRuntime.start(), true);
  assert.equal(instances.length, 1);
  assert.equal(instances[0].startCalls, 1);
  assert.equal(published.at(-1).hubs.length, 0);
  assert.equal(published.at(-1).resolvedUrl, 'http://saved.local:17321');
  assert.equal(clientRuntime.start(), false, 'already running');
});

test('a discovered hub matching the binding becomes the resolved address', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const changes = [];
  const settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', hubLink: { id: HUB_ID, name: 'Studio Mac' } };
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => settings,
    onBoundChange: (change) => changes.push(change),
    logger: quietLogger()
  });
  runtime.start();
  assert.deepEqual(changes, [], 'startup uses the saved URL, not discovery');

  instances[0].handlers.onHub(discoveredHub());
  assert.equal(runtime.hubs().length, 1);
  assert.deepEqual(changes, [{
    url: 'http://192.168.1.5:17321',
    previousUrl: 'http://saved.local:17321',
    source: 'discovery',
    hub: runtime.hubs()[0]
  }]);
  assert.equal(runtime.status().discovered, true);
  assert.equal(runtime.status().bound.id, HUB_ID);

  // Repeating the same advertisement is not an address change.
  instances[0].handlers.onHub(discoveredHub());
  assert.equal(changes.length, 1);

  // Expiry falls back to the saved URL, which is the local-network contract.
  instances[0].handlers.onExpire(HUB_ID);
  assert.equal(changes.at(-1).url, 'http://saved.local:17321');
  assert.equal(runtime.hubs().length, 0);
  assert.equal(runtime.status().discovered, false);
});

test('a binding learned after start does not move the address until discovery reports it', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const changes = [];
  const settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', hubLink: null };
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => settings,
    onBoundChange: (change) => changes.push(change),
    logger: quietLogger()
  });
  runtime.start();
  assert.equal(runtime.resolvedUrl(), 'http://saved.local:17321');

  // Main persists the learned hub id after a successful connect. Without a
  // discovery event the open stream's address must not move.
  settings.hubLink = { id: HUB_ID, name: 'Studio Mac' };
  assert.equal(runtime.resolvedUrl(), 'http://saved.local:17321');
  assert.deepEqual(changes, []);

  // The next announcement for the bound hub performs the switch.
  instances[0].handlers.onHub(discoveredHub());
  assert.equal(runtime.resolvedUrl(), 'http://192.168.1.5:17321');
  assert.equal(changes.length, 1);
  runtime.stop();
});

test('a silent recompute refreshes the confirmed address without notifying', () => {
  const { createBrowser } = fakeBrowserFactory();
  const changes = [];
  const settings = { hubMode: 'client', hubUrl: 'http://first.local:17321', hubLink: null };
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => settings,
    onBoundChange: (change) => changes.push(change),
    logger: quietLogger()
  });
  runtime.start();
  settings.hubUrl = 'http://second.local:17321';
  runtime.recompute({ notify: false });
  assert.equal(runtime.resolvedUrl(), 'http://second.local:17321');
  assert.deepEqual(changes, [], 'startMode already restarts the stream for a structural change');
  runtime.stop();
});

test('unbound client mode keeps the saved URL while nearby hubs are listed', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const changes = [];
  const published = [];
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'client', hubUrl: 'http://saved.local:17321', hubLink: null }),
    onBoundChange: (change) => changes.push(change),
    onDiscoveryChange: (payload) => published.push(payload),
    logger: quietLogger()
  });
  runtime.start();
  instances[0].handlers.onHub(discoveredHub({ name: 'Another Mac', addresses: ['192.168.1.7'] }));
  assert.deepEqual(changes, []);
  assert.equal(published.at(-1).hubs[0].url, 'http://192.168.1.7:17321');
  assert.equal(published.at(-1).resolvedUrl, 'http://saved.local:17321');
});

test('discovered payloads never carry the saved secret', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const published = [];
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'client', hubUrl: 'http://saved.local:17321', secret: SECRET, hubLink: { id: HUB_ID, name: 'Studio Mac' } }),
    onDiscoveryChange: (payload) => published.push(payload),
    logger: quietLogger()
  });
  runtime.start();
  instances[0].handlers.onHub(discoveredHub());
  assert.deepEqual(runtime.status().bound, { id: HUB_ID, name: 'Studio Mac' });
  assert.equal(JSON.stringify(published).includes(SECRET), false);
  assert.equal(JSON.stringify(runtime.hubs()).includes(SECRET), false);
});

test('recompute follows a settings edit that changes the saved URL', () => {
  const { createBrowser } = fakeBrowserFactory();
  const changes = [];
  const settings = { hubMode: 'client', hubUrl: 'http://first.local:17321', hubLink: null };
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => settings,
    onBoundChange: (change) => changes.push(change),
    logger: quietLogger()
  });
  runtime.start();
  settings.hubUrl = 'http://second.local:17321';
  runtime.recompute();
  assert.deepEqual(changes, [{
    url: 'http://second.local:17321',
    previousUrl: 'http://first.local:17321',
    source: 'saved',
    hub: null
  }]);
});

test('network-interface change restarts discovery and asks for an immediate retry', async () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  let signature = 'en0=192.168.1.5';
  const events = [];
  const settings = { hubMode: 'client', hubUrl: 'http://saved.local:17321', hubLink: { id: HUB_ID, name: 'Studio Mac' } };
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => settings,
    networkSignature: () => signature,
    pollMs: 5,
    onNetworkChange: () => events.push('network'),
    logger: quietLogger()
  });
  runtime.start();
  instances[0].handlers.onHub(discoveredHub());
  signature = 'en0=192.168.1.99';
  await waitFor(() => events.includes('network'));
  assert.equal(events.includes('network'), true);
  assert.equal(instances.length, 2, 'a new browser instance was created for the new interface set');
  assert.equal(instances[0].stopCalls, 1);
  assert.equal(instances[1].startCalls, 1);
  // The old advertisement is gone, so the saved URL is the interim address.
  assert.equal(runtime.status().resolvedUrl, 'http://saved.local:17321');
  runtime.stop();
});

test('stop closes the browser, clears hubs and the interface poll', async () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'client', hubUrl: '' }),
    pollMs: 5,
    logger: quietLogger()
  });
  runtime.start();
  instances[0].handlers.onHub(discoveredHub());
  assert.equal(runtime.hubs().length, 1);
  runtime.stop();
  assert.equal(instances[0].stopCalls, 1);
  assert.equal(runtime.hubs().length, 0);
  assert.equal(runtime.status().resolvedUrl, null);
  // Late browser callbacks cannot resurrect state after stop.
  instances[0].handlers.onHub(discoveredHub());
  assert.equal(runtime.hubs().length, 0);
  await new Promise((resolve) => setTimeout(resolve, 15));
  assert.equal(instances.length, 1, 'the poll is gone');
});

test('a missing discovery module degrades to unavailable browsing', () => {
  const published = [];
  const runtime = createLanLinkRuntime({
    createBrowser: () => null,
    getSettings: () => ({ hubMode: 'client' }),
    onDiscoveryChange: (payload) => published.push(payload),
    logger: quietLogger()
  });
  assert.equal(runtime.start(), true);
  assert.equal(runtime.isAvailable(), false);
  assert.equal(published.at(-1).available, false);
  assert.equal(runtime.hubs().length, 0);
  runtime.stop();
});

test('refresh asks the browser to re-query without an address change', () => {
  const { createBrowser, instances } = fakeBrowserFactory();
  const runtime = createLanLinkRuntime({
    createBrowser,
    getSettings: () => ({ hubMode: 'client', hubUrl: 'http://saved.local:17321' }),
    logger: quietLogger()
  });
  runtime.start();
  runtime.refresh();
  assert.equal(instances[0].refreshCalls, 1);
  runtime.stop();
});
