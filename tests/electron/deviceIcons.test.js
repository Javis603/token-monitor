'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
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
  assert.equal(deviceIconKind(settings, { deviceId: 'legacy' }), 'computer');
  assert.equal(deviceIconKind(settings, { deviceId: 'toString', deviceKind: 'laptop' }), 'laptop');
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
