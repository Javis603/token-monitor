'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { detectDeviceKind } = require('../../src/shared/deviceHardware');
const { normalizeDeviceRecord, aggregateDevices, mergeDeviceRecord } = require('../../src/shared/usage');
const { syncPayload } = require('../../src/shared/syncPayload');

test('Mac hardware names distinguish portable, desktop, mini and workstation without guessing model identifiers', () => {
  for (const [name, kind] of [['MacBook Pro', 'laptop'], ['MacBook Air', 'laptop'], ['iMac', 'desktop'],
    ['Mac mini', 'mini'], ['Mac Studio', 'workstation'], ['Mac Pro', 'workstation'], ['Mac16,1', 'computer']]) {
    assert.equal(detectDeviceKind({ platform: 'darwin', run(command, args, options) {
      assert.equal(command, '/usr/sbin/system_profiler');
      assert.deepEqual(args, ['SPHardwareDataType', '-json']);
      assert.ok(options.timeout > 0);
      return JSON.stringify({ SPHardwareDataType: [{ machine_name: name }] });
    } }), kind);
  }
});

test('Windows CIM and Linux DMI classify known chassis types; unsupported probes stay generic', () => {
  for (const [type, kind] of [[9, 'laptop'], [31, 'laptop'], [3, 'desktop'], [23, 'server'], [1, 'computer']]) {
    assert.equal(detectDeviceKind({ platform: 'win32', run: () => `${type}\r\n` }), kind);
    assert.equal(detectDeviceKind({ platform: 'linux', read: () => `${type}\n` }), kind);
  }
  for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
    assert.equal(detectDeviceKind({ platform, run() { throw new Error('unavailable'); }, read() { throw new Error('unavailable'); } }), 'computer');
  }
  assert.equal(detectDeviceKind({ platform: 'darwin', run: () => 'bad JSON' }), 'computer');
});

test('device kind survives wire reduction, normalization, aggregation and legacy partial updates', () => {
  const input = { deviceId: 'macbook', deviceKind: 'laptop', today: { totalTokens: 10 } };
  assert.equal(syncPayload(input).deviceKind, 'laptop');
  assert.equal(normalizeDeviceRecord(input).deviceKind, 'laptop');
  assert.equal(aggregateDevices([input], 0).devices[0].deviceKind, 'laptop');
  assert.equal(mergeDeviceRecord(input, { deviceId: 'macbook', limitsOnly: true }).deviceKind, 'laptop');
  assert.equal(mergeDeviceRecord(input, { deviceId: 'macbook', today: { totalTokens: 20 } }).deviceKind, 'laptop');
  assert.equal(mergeDeviceRecord(input, { deviceId: 'macbook', deviceKind: 'computer' }).deviceKind, 'computer');
  assert.equal(normalizeDeviceRecord({ ...input, deviceKind: '../../invalid' }).deviceKind, 'computer');
  assert.equal(Object.hasOwn(normalizeDeviceRecord({ deviceId: 'old' }), 'deviceKind'), false);
});
