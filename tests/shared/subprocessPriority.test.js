'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const childProcess = require('node:child_process');
const { EventEmitter } = require('node:events');
const os = require('node:os');
const {
  RESTORE_NORMAL_PRIORITY_AFTER_MS,
  lowerSubprocessPriority
} = require('../../src/shared/subprocessPriority');

const BELOW_NORMAL = os.constants.priority.PRIORITY_BELOW_NORMAL;
const NORMAL = os.constants.priority.PRIORITY_NORMAL;

async function spawnIdleChild(t) {
  const child = childProcess.spawn(process.execPath, ['-e', 'setTimeout(() => {}, 30000)'], { stdio: 'ignore', windowsHide: true });
  const exited = new Promise((resolve) => child.once('exit', resolve));
  t.after(async () => { child.kill(); await exited; });
  await new Promise((resolve, reject) => { child.once('spawn', resolve); child.once('error', reject); });
  return child;
}

function fakeChild(pid = 4242) {
  return Object.assign(new EventEmitter(), { pid });
}

test('lowerSubprocessPriority moves a running child below normal priority', async (t) => {
  const child = await spawnIdleChild(t);

  assert.equal(lowerSubprocessPriority(child), true);
  assert.equal(os.getPriority(child.pid), BELOW_NORMAL);
});

test('a lowered child is raised back to normal on Windows', { skip: process.platform !== 'win32' }, async (t) => {
  // POSIX lets an unprivileged process lower a child's priority but not raise it again.
  const child = await spawnIdleChild(t);

  assert.equal(lowerSubprocessPriority(child, { restoreAfterMs: 20 }), true);
  assert.equal(os.getPriority(child.pid), BELOW_NORMAL);
  await new Promise((resolve) => setTimeout(resolve, 200));
  assert.equal(os.getPriority(child.pid), NORMAL);
});

test('a scan still running after the restore delay returns to normal priority', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const child = fakeChild();

  assert.equal(lowerSubprocessPriority(child, { setPriority: (...args) => calls.push(args) }), true);
  t.mock.timers.tick(RESTORE_NORMAL_PRIORITY_AFTER_MS - 1);
  assert.deepEqual(calls, [[4242, BELOW_NORMAL]]);
  t.mock.timers.tick(1);
  assert.deepEqual(calls, [[4242, BELOW_NORMAL], [4242, NORMAL]]);
});

test('a scan that exits before the restore delay is not touched again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const calls = [];
  const child = fakeChild();

  lowerSubprocessPriority(child, { setPriority: (...args) => calls.push(args) });
  child.emit('exit', 0);
  t.mock.timers.tick(RESTORE_NORMAL_PRIORITY_AFTER_MS);
  assert.deepEqual(calls, [[4242, BELOW_NORMAL]], 'the pid may already belong to another process');
});

test('a refused restore is ignored', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const setPriority = (_pid, priority) => {
    if (priority === NORMAL) throw Object.assign(new Error('permission denied'), { code: 'EACCES' });
  };

  assert.equal(lowerSubprocessPriority(fakeChild(), { setPriority }), true);
  assert.doesNotThrow(() => t.mock.timers.tick(RESTORE_NORMAL_PRIORITY_AFTER_MS));
});

test('lowerSubprocessPriority skips a child without a pid', () => {
  const calls = [];
  const setPriority = (...args) => calls.push(args);
  assert.equal(lowerSubprocessPriority({}, { setPriority }), false);
  assert.equal(lowerSubprocessPriority({ pid: 0 }, { setPriority }), false);
  assert.equal(lowerSubprocessPriority(null, { setPriority }), false);
  assert.deepEqual(calls, []);
});

test('lowerSubprocessPriority leaves the child running when the change is refused', () => {
  const setPriority = () => { throw Object.assign(new Error('no such process'), { code: 'ESRCH' }); };
  assert.equal(lowerSubprocessPriority({ pid: 4242 }, { setPriority }), false);
});

test('tokscale scans start below normal priority', async (t) => {
  const originalSpawn = childProcess.spawn;
  const originalSetPriority = os.setPriority;
  const collectorPath = require.resolve('../../src/shared/collector');
  const calls = [];
  childProcess.spawn = () => {
    const child = new EventEmitter();
    child.pid = 4242;
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => true;
    setImmediate(() => {
      child.stdout.emit('data', Buffer.from(JSON.stringify({ pricing: {} })));
      child.emit('close', 0);
    });
    return child;
  };
  os.setPriority = (...args) => calls.push(args);
  t.after(() => {
    childProcess.spawn = originalSpawn;
    os.setPriority = originalSetPriority;
    delete require.cache[collectorPath];
  });
  delete require.cache[collectorPath];
  const { lookupModelPricing } = require(collectorPath);

  await lookupModelPricing('sample-model');

  assert.deepEqual(calls, [[4242, BELOW_NORMAL]]);
});
