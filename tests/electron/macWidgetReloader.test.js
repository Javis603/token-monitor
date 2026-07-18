'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const {
  DEFAULT_WIDGET_KIND,
  requestMacWidgetReload,
  resetMacWidgetReloadThrottle,
  resolveWidgetReloaderPath
} = require('../../src/electron/macWidgetReloader');

test('resolves the packaged Widget reloader only on macOS', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    assert.equal(resolveWidgetReloaderPath({ platform: 'darwin', helperPath: helper }), helper);
    assert.equal(resolveWidgetReloaderPath({ platform: 'linux', helperPath: helper }), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('requests a throttled Widget timeline reload through the helper', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const calls = [];
    const first = requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      now: 1_000_000,
      execFile: (file, args, callback) => {
        calls.push([file, args]);
        callback(null);
      }
    });
    const second = requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      now: 1_000_500,
      execFile: () => { throw new Error('should be throttled'); }
    });

    assert.equal(first.ok, true);
    assert.equal(first.widgetKind, DEFAULT_WIDGET_KIND);
    assert.equal(second.reason, 'throttled');
    assert.deepEqual(calls, [[helper, [DEFAULT_WIDGET_KIND]]]);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
