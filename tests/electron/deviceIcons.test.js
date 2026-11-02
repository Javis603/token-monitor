'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { normalizeDeviceIconOverrides, deviceIconKind, deviceIconPatch } = require('../../src/electron/renderer/deviceIcons');

test('manual icon wins over detection, choosing the detected kind restores it, and choices stay scoped to the connection and device', () => {
  const device = { deviceId: 'same-name', deviceKind: 'laptop' };
  let settings = { deviceIconScope: 'hub-a', deviceIconOverrides: {} };
  assert.equal(deviceIconKind(settings, device), 'laptop');
  settings = { ...settings, ...deviceIconPatch(settings, device.deviceId, 'cloud') };
  assert.equal(deviceIconKind(settings, device), 'cloud');
  assert.equal(deviceIconKind({ ...settings, deviceIconScope: 'hub-b' }, device), 'laptop');
  assert.equal(deviceIconKind(settings, { ...device, deviceId: 'another' }), 'laptop');
  settings = { ...settings, ...deviceIconPatch(settings, device.deviceId, 'laptop', 'laptop') };
  assert.equal(deviceIconKind(settings, device), 'laptop');
  assert.deepEqual(settings.deviceIconOverrides['hub-a'], {});
  assert.equal(deviceIconKind(settings, { deviceId: 'legacy' }), 'desktop');
  assert.equal(deviceIconKind(settings, { deviceId: 'toString', deviceKind: 'laptop' }), 'laptop');
});

test('unknown hardware uses a desktop default while Linux/WSL remains a distinct choice', () => {
  const settings = { deviceIconScope: 'hub', deviceIconOverrides: {} };
  assert.equal(deviceIconKind(settings, { deviceId: 'unknown', deviceKind: 'computer' }), 'desktop');
  assert.equal(deviceIconKind(settings, { deviceId: 'wsl', deviceKind: 'linux' }), 'linux');
  const changed = { ...settings, ...deviceIconPatch(settings, 'unknown', 'server', 'computer') };
  const restored = { ...changed, ...deviceIconPatch(changed, 'unknown', 'desktop', 'computer') };
  assert.equal(Object.hasOwn(restored.deviceIconOverrides.hub, 'unknown'), false);
});

test('persisted overrides accept only icon choices and keep device identity keys as data', () => {
  const input = JSON.parse('{"hub":{"__proto__":"server","valid":"laptop","bad":"url(evil)","auto":"auto"}}');
  const normalized = normalizeDeviceIconOverrides(input);
  assert.equal(normalized.hub.__proto__, 'server');
  assert.equal(normalized.hub.valid, 'laptop');
  assert.equal(Object.hasOwn(normalized.hub, 'bad'), false);
  assert.equal(Object.hasOwn(normalized.hub, 'auto'), false);
  assert.deepEqual(normalizeDeviceIconOverrides([]), {});
});

test('manual icon patches preserve special device IDs as own properties', () => {
  const device = { deviceId: '__proto__', deviceKind: 'laptop' };
  const settings = { deviceIconScope: 'hub', deviceIconOverrides: {} };
  const changed = { ...settings, ...deviceIconPatch(settings, device.deviceId, 'server', 'laptop') };
  assert.equal(Object.hasOwn(changed.deviceIconOverrides.hub, device.deviceId), true);
  assert.equal(deviceIconKind(changed, device), 'server');
  const restored = { ...changed, ...deviceIconPatch(changed, device.deviceId, 'laptop', 'laptop') };
  assert.equal(Object.hasOwn(restored.deviceIconOverrides.hub, device.deviceId), false);
  assert.equal(deviceIconKind(restored, device), 'laptop');
});

function iconSaveHarness() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const pending = [];
  const state = { settings: { deviceIconScope: 'hub', deviceIconOverrides: {} } };
  const context = vm.createContext({ state, deviceIconsApi: { deviceIconPatch }, saveSettings(patch) {
    return new Promise((resolve, reject) => pending.push({ patch, reject, resolve() {
      Object.assign(state.settings, patch);
      resolve(true);
    } }));
  } });
  vm.runInContext(source.slice(source.indexOf('let deviceIconSave ='), source.indexOf('function updateSyncDeviceRow(')), context);
  return { state, pending, save: (...args) => context.saveDeviceIcon(...args) };
}

test('overlapping device icon saves merge from the completed write without losing earlier choices', async () => {
  const h = iconSaveHarness();
  const first = h.save('laptop', 'server', 'laptop');
  const second = h.save('desktop', 'cloud', 'desktop');
  await Promise.resolve();
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve();
  await first;
  await Promise.resolve();
  assert.equal(h.pending.length, 1);
  h.pending.shift().resolve();
  await second;
  assert.deepEqual(h.state.settings.deviceIconOverrides.hub, { laptop: 'server', desktop: 'cloud' });
});

test('a failed icon save does not block the next choice or move it to a new connection', async () => {
  const h = iconSaveHarness();
  const first = h.save('laptop', 'server', 'laptop');
  const second = h.save('desktop', 'cloud', 'desktop');
  const rejected = assert.rejects(first, /failed/);
  h.state.settings.deviceIconScope = 'other';
  await Promise.resolve();
  h.pending.shift().reject(new Error('failed'));
  await rejected;
  await Promise.resolve();
  h.pending.shift().resolve();
  await second;
  assert.deepEqual(h.state.settings.deviceIconOverrides.hub, { desktop: 'cloud' });
  assert.equal(h.state.settings.deviceIconOverrides.other, undefined);
});
