'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { EventEmitter, once } = require('node:events');
const { spawn } = require('node:child_process');

const {
  createLiveSubprocessTable,
  createSubprocessTermination,
  signalLiveSubprocesses,
  trackLiveSubprocesses
} = require('../../src/shared/subprocessTermination');

function fakeTimers() {
  const timers = [];
  return {
    timers,
    setTimeout(fn, ms) {
      const timer = { fn, ms, cleared: false, unrefCalled: false, unref() { timer.unrefCalled = true; } };
      timers.push(timer);
      return timer;
    },
    clearTimeout(timer) { timer.cleared = true; }
  };
}

test('subprocess termination waits for close and escalates after the grace period', () => {
  const clock = fakeTimers();
  const signals = [];
  const child = { kill: (signal) => { signals.push(signal); return true; } };
  const termination = createSubprocessTermination(child, {
    graceMs: 250,
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout
  });

  assert.equal(termination.request(), true);
  assert.equal(termination.request(), false, 'repeated aborts must not send duplicate signals');
  assert.deepEqual(signals, ['SIGTERM']);
  assert.equal(clock.timers[0].ms, 250);
  assert.equal(clock.timers[0].unrefCalled, true);

  clock.timers[0].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(clock.timers[1].ms, 5000);
  assert.equal(clock.timers[1].unrefCalled, true);
  termination.confirmClosed();
  assert.equal(clock.timers[1].cleared, true);
});

test('confirmed close disarms forced termination', () => {
  const clock = fakeTimers();
  const signals = [];
  const termination = createSubprocessTermination(
    { kill: (signal) => { signals.push(signal); return true; } },
    { setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout }
  );

  termination.request();
  termination.confirmClosed();
  assert.equal(clock.timers[0].cleared, true);
  clock.timers[0].fn();
  assert.deepEqual(signals, ['SIGTERM']);
});

test('forced termination reports an unconfirmed close after a bounded second grace', () => {
  const clock = fakeTimers();
  const signals = [];
  let unconfirmed = 0;
  const termination = createSubprocessTermination(
    { kill: (signal) => { signals.push(signal); return true; } },
    {
      graceMs: 10,
      closeGraceMs: 20,
      setTimeout: clock.setTimeout,
      clearTimeout: clock.clearTimeout,
      onUnconfirmed: () => { unconfirmed += 1; }
    }
  );

  termination.request();
  clock.timers[0].fn();
  assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
  assert.equal(clock.timers[1].ms, 20);
  assert.equal(unconfirmed, 0);

  clock.timers[1].fn();
  clock.timers[1].fn();
  assert.equal(unconfirmed, 1, 'the terminal fallback is reported once');

  termination.confirmClosed();
});

test('a tracked subprocess is listed from its spawn until it exits', (t) => {
  const table = createLiveSubprocessTable();
  trackLiveSubprocesses(table);
  t.after(() => trackLiveSubprocesses(null));
  const child = Object.assign(new EventEmitter(), { pid: 4201, kill() { return true; } });
  const closedBeforeExit = Object.assign(new EventEmitter(), { pid: 4202, kill() { return true; } });

  createSubprocessTermination(child);
  const second = createSubprocessTermination(closedBeforeExit);
  const killed = [];
  signalLiveSubprocesses(table, 'SIGTERM', (pid, signal) => killed.push([pid, signal]));
  assert.deepEqual(killed, [[4201, 'SIGTERM'], [4202, 'SIGTERM']]);

  // Its PID can be reused as soon as it has exited, before stdio closes.
  child.emit('exit', 0, null);
  second.confirmClosed();
  killed.length = 0;
  signalLiveSubprocesses(table, 'SIGTERM', (pid) => killed.push(pid));
  assert.deepEqual(killed, []);
});

test('a full table leaves the extra subprocess untracked, and no table tracks nothing', (t) => {
  const table = createLiveSubprocessTable();
  trackLiveSubprocesses(table);
  t.after(() => trackLiveSubprocesses(null));
  const spawnFake = (pid) => createSubprocessTermination(Object.assign(new EventEmitter(), { pid, kill() { return true; } }));

  for (let index = 0; index <= table.length; index += 1) spawnFake(5000 + index);
  assert.equal(table.at(-1), 5000 + table.length - 1);
  assert.ok(!table.includes(5000 + table.length));

  trackLiveSubprocesses(null);
  const before = Array.from(table);
  spawnFake(6000);
  assert.deepEqual(Array.from(table), before);
});

test('the host shutdown fallback recognizes subprocess trees', (t) => {
  const table = createLiveSubprocessTable();
  trackLiveSubprocesses(table);
  t.after(() => trackLiveSubprocesses(null));
  const child = Object.assign(new EventEmitter(), { pid: 4203 });
  const termination = createSubprocessTermination(child, { killTree: true });
  const trees = [];
  signalLiveSubprocesses(table, 'SIGTERM', () => assert.fail('must not signal only the parent'), pid => trees.push(pid));
  child.emit('exit', 0, null);
  signalLiveSubprocesses(table, 'SIGTERM', () => assert.fail('must not signal only the parent'), pid => trees.push(pid));
  termination.confirmClosed();
  signalLiveSubprocesses(table, 'SIGTERM', () => assert.fail('must not signal a closed process'), pid => trees.push(pid));
  assert.deepEqual(trees, process.platform === 'win32' ? [4203] : [4203, 4203]);
});

test('POSIX cleanup kills a detached group after its leader exits', { skip: process.platform === 'win32' }, async t => {
  for (const mode of ['worker cancellation', 'host shutdown']) {
    await t.test(mode, { timeout: 10_000 }, async t => {
      const table = createLiveSubprocessTable();
      trackLiveSubprocesses(table);
      const child = spawn(process.execPath, ['-e', `
        const { spawn } = require('node:child_process');
        const descendant = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => console.log('term')); setTimeout(() => {}, 60000); process.send('ready')"], {
          stdio: ['ignore', 'inherit', 'inherit', 'ipc']
        });
        descendant.once('message', () => process.exit(0));
      `], { detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      const clock = fakeTimers();
      const termination = createSubprocessTermination(child, { ...clock, killTree: true });
      const closed = once(child, 'close');
      let groupClosed = false;
      child.once('close', () => {
        groupClosed = true;
        termination.confirmClosed();
      });
      t.after(() => {
        trackLiveSubprocesses(null);
        termination.confirmClosed();
        if (!groupClosed) {
          try { process.kill(-child.pid, 'SIGKILL'); } catch (_) {}
        }
      });
      assert.deepEqual(await once(child, 'exit'), [0, null]);
      assert.ok(table.includes(-child.pid));
      if (mode === 'worker cancellation') {
        const stdout = once(child.stdout, 'data');
        termination.request();
        assert.equal(String((await stdout)[0]).trim(), 'term');
        clock.timers[0].fn();
      } else signalLiveSubprocesses(table);
      await closed;
      assert.ok(!table.includes(-child.pid));
    });
  }
});
