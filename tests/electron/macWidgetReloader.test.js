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

test('does not resolve or launch the reloader on an unsupported macOS version', () => {
  let launches = 0;
  assert.deepEqual(requestMacWidgetReload({
    platform: 'darwin',
    runtimeSupported: false,
    execFile: () => { launches += 1; }
  }), {
    ok: false,
    reason: 'unsupported-os'
  });
  assert.equal(launches, 0);
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

test('a Widget kind matching the legacy registration flag still uses timeline reload mode', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const calls = [];

    const result = requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      widgetKind: '--register-host',
      now: 1_000_000,
      execFile: (file, args, callback) => {
        calls.push([file, args]);
        callback(null);
      }
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls, [[helper, ['--register-host']]]);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

function fakeScheduler(start = 1_000_000) {
  let now = start;
  let nextId = 1;
  const timers = new Map();
  return {
    now: () => now,
    setTimeout(callback, delay) {
      const id = nextId++;
      timers.set(id, { at: now + delay, callback });
      return id;
    },
    clearTimeout(id) {
      timers.delete(id);
    },
    advance(milliseconds) {
      now += milliseconds;
      for (const [id, timer] of [...timers.entries()]) {
        if (timer.at <= now) {
          timers.delete(id);
          timer.callback();
        }
      }
    },
    pendingCount() { return timers.size; }
  };
}

test('drops a throttled reload when its owner expires before the timer fires', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const scheduler = fakeScheduler();
    const calls = [];
    let current = true;
    const request = (widgetKind, isCurrent) => requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      widgetKind,
      now: scheduler.now(),
      scheduler,
      isCurrent,
      execFile: (file, args, callback) => {
        calls.push([file, args]);
        callback(null);
      }
    });

    assert.equal(request('leading').ok, true);
    assert.equal(request('stale-trailing', () => current).reason, 'throttled');
    current = false;
    scheduler.advance(30_000);

    assert.deepEqual(calls, [[helper, ['leading']]]);
    assert.equal(scheduler.pendingCount(), 0);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('coalesces throttled changes into one trailing reload using the latest kind', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const scheduler = fakeScheduler();
    const calls = [];
    const request = (widgetKind) => requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      widgetKind,
      now: scheduler.now(),
      scheduler,
      execFile: (file, args, callback) => {
        calls.push([file, args]);
        callback(null);
      }
    });

    assert.equal(request('kind-one').ok, true);
    assert.equal(request('kind-two').reason, 'throttled');
    assert.equal(request('kind-three').reason, 'throttled');
    assert.equal(calls.length, 1);
    assert.equal(scheduler.pendingCount(), 1);

    scheduler.advance(29_999);
    assert.equal(calls.length, 1);
    scheduler.advance(1);
    assert.deepEqual(calls, [
      [helper, ['kind-one']],
      [helper, ['kind-three']]
    ]);
    assert.equal(scheduler.pendingCount(), 0);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('ten rapid changes produce only leading and trailing reloads', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const scheduler = fakeScheduler();
    let calls = 0;
    for (let index = 0; index < 10; index += 1) {
      requestMacWidgetReload({
        platform: 'darwin',
        helperPath: helper,
        widgetKind: `kind-${index}`,
        now: scheduler.now(),
        scheduler,
        execFile: (_file, _args, callback) => {
          calls += 1;
          callback(null);
        }
      });
    }
    assert.equal(calls, 1);
    scheduler.advance(30_000);
    assert.equal(calls, 2);
    scheduler.advance(30_000);
    assert.equal(calls, 2);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('reload helper errors are contained and do not poison the trailing state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-reloader-'));
  try {
    resetMacWidgetReloadThrottle();
    const helper = path.join(root, 'TokenMonitorWidgetReloader');
    fs.writeFileSync(helper, '');
    const scheduler = fakeScheduler();
    const messages = [];
    assert.doesNotThrow(() => requestMacWidgetReload({
      platform: 'darwin',
      helperPath: helper,
      now: scheduler.now(),
      scheduler,
      logger: (message) => messages.push(message),
      execFile: () => { throw new Error('launch failed'); }
    }));
    assert.equal(messages.length, 1);
    assert.equal(scheduler.pendingCount(), 0);
  } finally {
    resetMacWidgetReloadThrottle();
    fs.rmSync(root, { recursive: true, force: true });
  }
});
