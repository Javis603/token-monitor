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
  for (const [type, kind] of [[9, 'laptop'], [31, 'laptop'], [3, 'desktop'], [23, 'server'], [28, 'server'], [29, 'server'], [17, 'computer'], [1, 'computer']]) {
    assert.equal(detectDeviceKind({ platform: 'win32', run: () => `${type}\r\n` }), kind);
    assert.equal(detectDeviceKind({ platform: 'linux', release: () => '6.8.0', read: () => `${type}\n` }), kind === 'computer' ? 'linux' : kind);
  }
  for (const platform of ['darwin', 'win32', 'linux', 'freebsd']) {
    assert.equal(detectDeviceKind({ platform, release: () => '6.8.0', run() { throw new Error('unavailable'); }, read() { throw new Error('unavailable'); } }), platform === 'linux' ? 'linux' : 'computer');
  }
  assert.equal(detectDeviceKind({ platform: 'darwin', run: () => 'bad JSON' }), 'computer');
});

test('WSL uses the Linux/WSL kind before host chassis classification', () => {
  for (const kernel of ['5.15.167.4-microsoft-standard-WSL2', '4.4.0-19041-Microsoft']) {
    let readCalls = 0;
    assert.equal(detectDeviceKind({ platform: 'linux', release: () => kernel,
      read() { readCalls += 1; return '9\n'; } }), 'linux');
    assert.equal(readCalls, 0);
  }
  const record = { deviceId: 'wsl', deviceKind: 'linux', today: { totalTokens: 10 } };
  assert.equal(syncPayload(record).deviceKind, 'linux');
  assert.equal(aggregateDevices([record], 0).devices[0].deviceKind, 'linux');
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
