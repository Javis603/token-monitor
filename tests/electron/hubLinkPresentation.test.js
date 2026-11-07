'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const i18n = require('../../src/electron/renderer/i18n');

const HUB_ID = '0123456789abcdef';
const pairingLink = `tokenmonitor://pair?v=1&id=${HUB_ID}&name=Studio%20Mac&code=123456&host=192.168.1.5&port=17321`;
const rendered = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const block = rendered.slice(
  rendered.indexOf('function hubLinkPanelMode()'),
  rendered.indexOf('async function copyToClipboard(')
);
assert.ok(block.includes('function renderHubPairing()'));
// Module state that lives above the extracted functions in app.js.
const blockState = `const HUB_PAIRING_POLL_MS = 2000;
const hubRevokeBusy = new Set();
let hubPairingTimer = 0;
let hubPairingPollAt = 0;
let hubPairingBusy = false;
let hubPairingStatusPending = false;
let hubPairingErrorCode = '';
`;
assert.ok(block.includes('function renderHubDiscovery()'));

class Element {
  constructor(tagName = 'div') {
    this.tagName = tagName;
    this.children = [];
    this.dataset = {};
    this.className = '';
    this.textContent = '';
    this.hidden = false;
    this.disabled = false;
    this.value = '';
    this.listeners = new Map();
    this.parentElement = null;
  }
  append(...children) { children.forEach((child) => { child.parentElement = this; this.children.push(child); }); }
  replaceChildren(...children) { this.children = []; this.append(...children); }
  addEventListener(type, listener) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(listener);
  }
  async click() {
    for (const listener of this.listeners.get('click') || []) await listener({ target: this });
  }
  focus() {}
  blur() {}
}

function harness({ settings = {}, hubDiscovery = {}, hubPairing = {}, tokenMonitor = {}, intervals = [] } = {}) {
  const elements = {};
  for (const id of [
    'hubPairingSection', 'hubPairingStart', 'hubPairingCard', 'hubPairingCode',
    'hubPairingCountdown', 'hubPairingState', 'hubPairingCopyLink', 'hubPairingCancel',
    'hubPairingError', 'hubLinkedDevices', 'hubLinkedDeviceList',
    'syncLinkedStatus', 'syncLinkedStatusText', 'syncLinkedResolvedUrl',
    'syncDiscoverySection', 'syncDiscoveryRefresh', 'syncDiscoveryList', 'hubUrlInput'
  ]) elements[id] = new Element(id === 'hubUrlInput' ? 'input' : 'div');
  const dirty = [];
  const copied = [];
  const ipc = [];
  const timers = new Map();
  const sandbox = {
    els: elements,
    state: {
      settings,
      hubInfo: { listening: true },
      hubDiscovery: { hubs: [], bound: null, resolvedUrl: null, discovered: false, available: true, ...hubDiscovery },
      hubPairing: {
        mode: settings.hubMode === 'host' || settings.hubMode === 'client' ? settings.hubMode : '',
        pairing: null,
        links: [],
        loaded: true,
        ...hubPairing
      }
    },
    t: (key, params) => i18n.translate('en', key, params),
    currentLocale: () => 'en',
    isSettingsSurfaceVisible: () => true,
    document: { createElement: (tagName) => new Element(tagName) },
    window: {
      tokenMonitor: {
        getHubPairingStatus: async () => ({ ok: true, pairing: { active: false }, links: [], hub: null }),
        startHubPairing: async () => ({ ok: false, error: 'not_supported' }),
        cancelHubPairing: async () => ({ ok: true }),
        revokeHubLink: async (id) => { ipc.push(['revoke', id]); return { ok: true, id }; },
        ...tokenMonitor
      }
    },
    markHubDraftDirty: (field) => dirty.push(field),
    copyToClipboard: (text, button) => { copied.push(text); if (button) button.textContent = '✓'; },
    renderHubBuildStatus: () => {},
    setInterval: (callback, ms) => {
      const id = { callback, ms };
      intervals.push(id);
      timers.set(id, true);
      return id;
    },
    clearInterval: (id) => { timers.delete(id); },
    Date,
    JSON,
    Math,
    console
  };
  vm.runInNewContext(`${blockState}${block}
    globalThis.renderHubPairing = renderHubPairing;
    globalThis.renderHubDiscovery = renderHubDiscovery;
    globalThis.renderSyncLinkedStatus = renderSyncLinkedStatus;
    globalThis.renderHubLinkPanels = renderHubLinkPanels;
    globalThis.applyHubDiscoveryPayload = applyHubDiscoveryPayload;
    globalThis.applyHubBuildStatusPayload = applyHubBuildStatusPayload;
    globalThis.startHubPairing = startHubPairing;
    globalThis.cancelHubPairing = cancelHubPairing;
    globalThis.stopHubPairingPoll = stopHubPairingPoll;
    globalThis.copyHubPairingLink = copyHubPairingLink;
  `, sandbox);
  return { sandbox, els: elements, dirty, copied, ipc, intervals, timers };
}

test('nearby hubs render from the discovery push and fill the Hub URL field', () => {
  const { sandbox, els, dirty } = harness({
    settings: { hubMode: 'client', hubUrl: '' },
    hubDiscovery: {
      hubs: [
        { hubId: HUB_ID, name: 'Studio Mac', port: 17321, address: '192.168.1.5', url: 'http://192.168.1.5:17321', lastSeenAt: null },
        { hubId: 'fedcba9876543210', name: 'Office PC', port: 17321, address: '192.168.1.9', url: 'http://192.168.1.9:17321', lastSeenAt: null }
      ],
      available: true
    }
  });
  sandbox.renderHubDiscovery();
  assert.equal(els.syncDiscoverySection.hidden, false);
  assert.equal(els.syncDiscoveryList.children.length, 2);
  const row = els.syncDiscoveryList.children[0];
  assert.equal(row.children[0].children[0].textContent, 'Studio Mac');
  assert.equal(row.children[0].children[1].textContent, 'http://192.168.1.5:17321');
  assert.equal(row.children[1].textContent, 'Use');
  row.children[1].click();
  assert.equal(els.hubUrlInput.value, 'http://192.168.1.5:17321');
  assert.deepEqual(dirty, ['hubUrl']);
});

test('nearby hubs explain an empty or unavailable discovery result', () => {
  const empty = harness({ settings: { hubMode: 'client' } });
  empty.sandbox.renderHubDiscovery();
  assert.equal(empty.els.syncDiscoveryList.children[0].textContent, 'No hubs found on this network');

  const unavailable = harness({
    settings: { hubMode: 'client' },
    hubDiscovery: { available: false }
  });
  unavailable.sandbox.renderHubDiscovery();
  assert.match(unavailable.els.syncDiscoveryList.children[0].textContent, /unavailable/i);

  const local = harness({ settings: { hubMode: 'local' } });
  local.sandbox.renderHubDiscovery();
  assert.equal(local.els.syncDiscoverySection.hidden, true);
});

test('the bound identity shows the linked-to status and the resolved address only', () => {
  const { sandbox, els } = harness({
    settings: { hubMode: 'client', hubLink: { id: HUB_ID, name: 'Studio Mac' } },
    hubDiscovery: { resolvedUrl: 'http://192.168.1.5:17321', discovered: true }
  });
  sandbox.renderSyncLinkedStatus();
  assert.equal(els.syncLinkedStatus.hidden, false);
  assert.equal(els.syncLinkedStatusText.textContent, 'Linked to Studio Mac · auto-connect');
  assert.equal(els.syncLinkedResolvedUrl.textContent, 'Address http://192.168.1.5:17321');
  assert.equal(els.syncLinkedResolvedUrl.hidden, false);

  const unbound = harness({ settings: { hubMode: 'client', hubLink: null } });
  unbound.sandbox.renderSyncLinkedStatus();
  assert.equal(unbound.els.syncLinkedStatus.hidden, true);

  const host = harness({ settings: { hubMode: 'host', hubLink: { id: HUB_ID, name: 'Studio Mac' } } });
  host.sandbox.renderSyncLinkedStatus();
  assert.equal(host.els.syncLinkedStatus.hidden, true, 'the binding status belongs to the client panel');
});

test('an active pairing session renders code, countdown and copy link', () => {
  const expiresAt = new Date(Date.now() + 300000).toISOString();
  const { sandbox, els, copied, intervals } = harness({
    settings: { hubMode: 'host' },
    hubPairing: { pairing: { code: '123456', expiresAt, ttlMs: 300000, link: pairingLink } }
  });
  sandbox.renderHubPairing();
  assert.equal(els.hubPairingSection.hidden, false);
  assert.equal(els.hubPairingCard.hidden, false);
  assert.equal(els.hubPairingStart.hidden, true, 'the start action is replaced by the card');
  assert.equal(els.hubPairingCode.textContent, '123456');
  assert.match(els.hubPairingCountdown.textContent, /^Expires in \d+:\d{2}$/);
  assert.equal(els.hubPairingState.textContent, 'Waiting for a phone…');
  assert.equal(els.hubPairingCopyLink.disabled, false);
  sandbox.copyHubPairingLink();
  assert.deepEqual(copied, [pairingLink]);
  // The countdown polls only while a card is open.
  assert.equal(intervals.length, 1);
  sandbox.stopHubPairingPoll();
});

test('no pairing timer exists when the card is closed', () => {
  const { sandbox, els, intervals } = harness({ settings: { hubMode: 'host' } });
  sandbox.renderHubPairing();
  assert.equal(els.hubPairingSection.hidden, false);
  assert.equal(els.hubPairingCard.hidden, true);
  assert.equal(els.hubPairingStart.hidden, false);
  assert.equal(intervals.length, 0);
  sandbox.stopHubPairingPoll();
});

test('the pairing card closes and the timer stops when the session expires', () => {
  const expiresAt = new Date(Date.now() + 60000).toISOString();
  const { sandbox, els, intervals } = harness({
    settings: { hubMode: 'client' },
    hubPairing: { pairing: { code: '654321', expiresAt, ttlMs: 60000, link: pairingLink } }
  });
  sandbox.renderHubPairing();
  assert.equal(intervals.length, 1);
  // Age the session past its expiry, then let the poll tick.
  sandbox.state.hubPairing.pairing.expiresAt = new Date(Date.now() - 1000).toISOString();
  intervals[0].callback();
  assert.equal(els.hubPairingCard.hidden, true);
  assert.equal(els.hubPairingStart.hidden, false);
  sandbox.stopHubPairingPoll();
});

test('pairing start/refresh/cancel drive the card from main results', async () => {
  const pairing = { code: '111222', expiresAt: new Date(Date.now() + 300000).toISOString(), ttlMs: 300000, link: pairingLink };
  const { sandbox, els } = harness({
    settings: { hubMode: 'client' },
    tokenMonitor: {
      startHubPairing: async () => ({ ok: true, pairing, links: [], hub: null }),
      cancelHubPairing: async () => ({ ok: true })
    }
  });
  await sandbox.startHubPairing();
  assert.equal(els.hubPairingCode.textContent, '111222');
  assert.equal(els.hubPairingCard.hidden, false);
  await sandbox.cancelHubPairing();
  assert.equal(els.hubPairingCard.hidden, true);
  assert.equal(els.hubPairingStart.hidden, false);
  sandbox.stopHubPairingPoll();

  const unsupported = harness({
    settings: { hubMode: 'client' },
    hubPairing: { loaded: false },
    tokenMonitor: {
      startHubPairing: async () => ({ ok: false, error: 'not_supported' })
    }
  });
  unsupported.sandbox.state.hubPairing.loaded = true;
  await unsupported.sandbox.startHubPairing();
  assert.equal(unsupported.els.hubPairingError.hidden, false);
  assert.match(unsupported.els.hubPairingError.textContent, /does not support phone pairing/);
});

test('linked devices list a phone and revoke needs a confirmation click', async () => {
  const { sandbox, els, ipc } = harness({
    settings: { hubMode: 'host' },
    hubPairing: {
      links: [{ id: 'android-1', name: 'Pixel 9', platform: 'android', createdAt: new Date().toISOString(), lastSeenAt: null }]
    }
  });
  sandbox.renderHubPairing();
  assert.equal(els.hubLinkedDevices.hidden, false);
  const row = els.hubLinkedDeviceList.children[0];
  assert.equal(row.children[0].children[0].textContent, 'Pixel 9');
  assert.match(row.children[0].children[1].textContent, /^android · Linked /);
  const revoke = row.children[1];
  assert.equal(revoke.textContent, 'Revoke');
  await revoke.click();
  assert.equal(ipc.length, 0, 'first click only arms the confirmation');
  assert.equal(revoke.textContent, 'Revoke access?');
  await revoke.click();
  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(ipc, [['revoke', 'android-1']]);
  assert.equal(els.hubLinkedDeviceList.children[0].textContent, 'No phones linked yet');
  sandbox.stopHubPairingPoll();
});

test('discovery pushes update state and re-render the visible panels', () => {
  const { sandbox, els } = harness({ settings: { hubMode: 'client' } });
  sandbox.applyHubDiscoveryPayload({
    hubs: [{ hubId: HUB_ID, name: 'Studio Mac', port: 17321, address: '192.168.1.5', url: 'http://192.168.1.5:17321', lastSeenAt: null }],
    bound: { id: HUB_ID, name: 'Studio Mac' },
    resolvedUrl: 'http://192.168.1.5:17321',
    discovered: true,
    available: true
  });
  assert.equal(sandbox.state.hubDiscovery.hubs.length, 1);
  assert.equal(sandbox.state.hubDiscovery.discovered, true);
  assert.equal(els.syncLinkedStatusText.textContent, 'Linked to Studio Mac · auto-connect');
  assert.equal(els.syncDiscoveryList.children.length, 1);
  sandbox.applyHubBuildStatusPayload({ status: { status: 'current', runtime: 'node-hub', hubUrl: 'http://192.168.1.5:17321' } });
  assert.equal(sandbox.state.hubBuildStatus.runtime, 'node-hub');
});
