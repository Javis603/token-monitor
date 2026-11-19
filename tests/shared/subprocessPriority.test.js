'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  RESTORE_PRIORITY_AFTER_MS,
  lowerSubprocessPriority
} = require('../../src/shared/subprocessPriority');

const { PRIORITY_ABOVE_NORMAL, PRIORITY_BELOW_NORMAL: BELOW_NORMAL, PRIORITY_LOW, PRIORITY_NORMAL: NORMAL } = os.constants.priority;

// A child inherits the test runner's priority, and CI runners may already run
// below normal, so each real-process test pins the child's starting priority.
// POSIX refuses to raise it for an unprivileged runner; such a test is skipped.
async function spawnIdleChild(t, priority) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  if (priority === undefined) return child;
  try {
    os.setPriority(child.pid, priority);
  } catch (error) {
    t.skip(`cannot start a child at priority ${priority}: ${error.code || error.message}`);
    return null;
  }
  return child;
}

function fakeChild(pid = 4242) {
  return Object.assign(new EventEmitter(), { pid });
}

// A fake process table: getPriority reads what setPriority last wrote.
function fakePriorities(initial = NORMAL) {
  let current = initial;
  const calls = [];
  return {
    platform: 'win32',
    calls,
    getPriority: () => current,
    setPriority: (pid, priority) => { calls.push([pid, priority]); current = priority; }
  };
}

test('lowerSubprocessPriority moves a running Windows child below normal priority', { skip: process.platform !== 'win32' }, async (t) => {
  const child = await spawnIdleChild(t, NORMAL);
  if (!child) return;

  assert.equal(lowerSubprocessPriority(child), true);
  assert.equal(os.getPriority(child.pid), BELOW_NORMAL);
});

for (const platform of ['darwin', 'linux']) {
  test(`${platform} leaves subprocess priority untouched without a restore timer`, (t) => {
    const child = fakeChild();
    const getPriority = t.mock.fn(() => NORMAL);
    const setPriority = t.mock.fn();
    const timer = t.mock.method(globalThis, 'setTimeout', () => ({ unref() {} }));

    assert.equal(lowerSubprocessPriority(child, { platform, getPriority, setPriority }), false);
    assert.equal(getPriority.mock.callCount(), 0);
    assert.equal(setPriority.mock.callCount(), 0);
    assert.equal(timer.mock.callCount(), 0);
    assert.equal(child.listenerCount('exit'), 0);
  });
}

test('a real POSIX child keeps its starting priority', { skip: process.platform === 'win32' }, async (t) => {
  const child = await spawnIdleChild(t);
  const initial = os.getPriority(child.pid);

  assert.equal(lowerSubprocessPriority(child), false);
  assert.equal(os.getPriority(child.pid), initial);
});

test('a running child that already starts below normal keeps its priority', async (t) => {
  const child = await spawnIdleChild(t, PRIORITY_LOW);
  if (!child) return;

  assert.equal(lowerSubprocessPriority(child, { restoreAfterMs: 20 }), false);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(os.getPriority(child.pid), PRIORITY_LOW);
});

test('a lowered child is raised back to normal on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  // POSIX lets an unprivileged process lower a child's priority but not raise it again.
  const child = await spawnIdleChild(t, NORMAL);
  if (!child) return;

  assert.equal(lowerSubprocessPriority(child, { restoreAfterMs: 20 }), true);
  assert.equal(os.getPriority(child.pid), BELOW_NORMAL);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(os.getPriority(child.pid), NORMAL);
});

test('a scan still running after the restore delay returns to its starting priority', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const initial of [NORMAL, PRIORITY_ABOVE_NORMAL]) {
    const priorities = fakePriorities(initial);

    assert.equal(lowerSubprocessPriority(fakeChild(), priorities), true);
    t.mock.timers.tick(RESTORE_PRIORITY_AFTER_MS - 1);
    assert.deepEqual(priorities.calls, [[4242, BELOW_NORMAL]]);
    t.mock.timers.tick(1);
    assert.deepEqual(priorities.calls, [[4242, BELOW_NORMAL], [4242, initial]]);
  }
});

test('a scan that inherits below-normal or lower priority is left alone', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const initial of [BELOW_NORMAL, PRIORITY_LOW]) {
    const priorities = fakePriorities(initial);

    assert.equal(lowerSubprocessPriority(fakeChild(), priorities), false);
    t.mock.timers.tick(RESTORE_PRIORITY_AFTER_MS);
    assert.deepEqual(priorities.calls, [], 'the app was started at a lower priority on purpose');
  }
});

test('a scan that exits before the restore delay is not touched again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const priorities = fakePriorities();
  const child = fakeChild();

  lowerSubprocessPriority(child, priorities);
  child.emit('exit', 0);
  t.mock.timers.tick(RESTORE_PRIORITY_AFTER_MS);
  assert.deepEqual(priorities.calls, [[4242, BELOW_NORMAL]], 'the pid may already belong to another process');
});

test('a refused restore is ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setPriority = (_pid, priority) => {
    if (priority === NORMAL) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };

  assert.equal(lowerSubprocessPriority(fakeChild(), { platform: 'win32', getPriority: () => NORMAL, setPriority }), true);
  assert.doesNotThrow(() => t.mock.timers.tick(RESTORE_PRIORITY_AFTER_MS));
});

test('lowerSubprocessPriority skips a child without a pid', () => {
  const priorities = fakePriorities();
  assert.equal(lowerSubprocessPriority({}, priorities), false);
  assert.equal(lowerSubprocessPriority({ pid: 0 }, priorities), false);
  assert.equal(lowerSubprocessPriority(null, priorities), false);
  assert.deepEqual(priorities.calls, []);
});

test('lowerSubprocessPriority leaves the child running when the change is refused', () => {
  const refuse = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.equal(lowerSubprocessPriority({ pid: 4242 }, { platform: 'win32', getPriority: refuse, setPriority: refuse }), false);
  assert.equal(lowerSubprocessPriority({ pid: 4242 }, { platform: 'win32', getPriority: () => NORMAL, setPriority: refuse }), false);
});

test('tokscale scans and Antigravity syncs apply the host platform priority policy', async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalGetPriority = os.getPriority;
  const originalSetPriority = os.setPriority;
  const collectorPath = require.resolve('../../src/shared/collector');
  const priorities = fakePriorities();
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ pricing: {} })));
      child.emit('exit', 0);
      child.emit('close', 0);
    });
    return child;
  };
  os.getPriority = priorities.getPriority;
  os.setPriority = priorities.setPriority;
  t.after(() => {
    childProcess.spawn = originalSpawn;
    os.getPriority = originalGetPriority;
    os.setPriority = originalSetPriority;
    delete require.cache[collectorPath];
  });
  delete require.cache[collectorPath];
  const { lookupModelPricing } = require(collectorPath);

  await lookupModelPricing('sample-model');

  assert.deepEqual(priorities.calls, process.platform === 'win32' ? [[4242, BELOW_NORMAL]] : []);

  const syncPriorities = fakePriorities();
  os.getPriority = syncPriorities.getPriority;
  os.setPriority = syncPriorities.setPriority;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-priority-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.gemini', 'antigravity'), { recursive: true });
  const { createAntigravitySelfSync } = require('../../src/shared/providers/antigravity/selfSync');
  const { createSelfSyncThrottle } = require('../../src/shared/selfSyncThrottle');
  const { maybeSyncAntigravity } = createAntigravitySelfSync({
    selfSyncThrottle: createSelfSyncThrottle(),
    tokscaleCommand: () => ({ bin: 'tokscale', prefixArgs: [], env: {} })
  });

  await maybeSyncAntigravity('antigravity', null, home);

  assert.deepEqual(syncPriorities.calls, process.platform === 'win32' ? [[4242, BELOW_NORMAL]] : []);
});
