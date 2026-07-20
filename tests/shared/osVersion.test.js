'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { detectOsVersion, normalizeOsVersion } = require('../../src/shared/osVersion');

test('detectOsVersion prefers Electron system version on macOS', () => {
  let spawned = false;
  const version = detectOsVersion({
    platform: 'darwin',
    getSystemVersion: () => ' 26.0.1 ',
    execFileSync: () => { spawned = true; }
  });

  assert.equal(version, '26.0.1');
  assert.equal(spawned, false);
});

test('detectOsVersion uses sw_vers for a headless macOS agent', () => {
  let invocation;
  const version = detectOsVersion({
    platform: 'darwin',
    getSystemVersion: () => '',
    execFileSync: (...args) => {
      invocation = args;
      return '15.6\n';
    }
  });

  assert.equal(version, '15.6');
  assert.equal(invocation[0], '/usr/bin/sw_vers');
  assert.deepEqual(invocation[1], ['-productVersion']);
});

test('detectOsVersion uses the system release outside macOS', () => {
  assert.equal(detectOsVersion({ platform: 'win32', release: () => '10.0.26100' }), '10.0.26100');
  assert.equal(detectOsVersion({ platform: 'linux', release: () => '6.8.0-60-generic' }), '6.8.0-60-generic');
});

test('detectOsVersion omits a macOS version when product detection fails', () => {
  assert.equal(detectOsVersion({
    platform: 'darwin',
    getSystemVersion: () => { throw new Error('unavailable'); },
    execFileSync: () => { throw new Error('unavailable'); }
  }), '');
});

test('normalizeOsVersion trims and bounds external values', () => {
  assert.equal(normalizeOsVersion(`  ${'1'.repeat(200)}  `).length, 128);
});
