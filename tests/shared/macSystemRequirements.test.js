'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  MAC_APP_MIN_DARWIN_VERSION,
  MAC_APP_MIN_VERSION,
  MAC_WIDGET_MIN_DARWIN_VERSION,
  MAC_WIDGET_MIN_VERSION,
  macWidgetRuntimeSupport
} = require('../../src/shared/macSystemRequirements');

test('keeps host, updater and Widget minimum versions explicit and aligned', () => {
  assert.equal(MAC_APP_MIN_VERSION, '12.0');
  assert.equal(MAC_APP_MIN_DARWIN_VERSION, '21.0.0');
  assert.equal(MAC_WIDGET_MIN_VERSION, '14.0');
  assert.equal(MAC_WIDGET_MIN_DARWIN_VERSION, '23.0.0');
});

test('enables the native Widget only on macOS 14 and later', () => {
  assert.deepEqual(macWidgetRuntimeSupport({ platform: 'linux', osRelease: '23.0.0' }), {
    supported: false,
    reason: 'unsupported-platform'
  });
  for (const osRelease of ['', 'invalid', '21.6.0', '22.6.0']) {
    assert.deepEqual(macWidgetRuntimeSupport({ platform: 'darwin', osRelease }), {
      supported: false,
      reason: 'unsupported-os'
    });
  }
  for (const osRelease of ['23.0.0', '23.6.0', '24.0.0']) {
    assert.deepEqual(macWidgetRuntimeSupport({ platform: 'darwin', osRelease }), {
      supported: true,
      reason: null
    });
  }
});
