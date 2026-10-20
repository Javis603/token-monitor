'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');

function loadWithProbe(t, probe) {
  const file = require.resolve('../../src/shared/processStarts');
  const saved = require.cache[file];
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved; });
  t.mock.method(childProcess, 'execFile', probe);
  delete require.cache[file];
  return require(file).processStarts;
}

test('POSIX process-start output parses UTC timestamps and batches PIDs', async t => {
  const starts = loadWithProbe(t, (command, args, options, done) => {
    assert.equal(command, 'ps');
    assert.equal(args[1], '123,456');
    assert.ok(args.includes('stat='));
    assert.equal(options.timeout, 2000);
    done(null, '123 S Fri Oct  9 12:34:56 2026\n456 R+ Fri Oct  9 12:34:57 2026\n');
  });
  assert.deepEqual(await starts([123, 456], 'darwin'), new Map([
    [123, Date.parse('2026-10-09T12:34:56Z')], [456, Date.parse('2026-10-09T12:34:57Z')]
  ]));
});

test('POSIX process-start probes exclude zombie and dead states without excluding stopped processes', async t => {
  const starts = loadWithProbe(t, (_command, _args, _options, done) => {
    done(null, ['Z', 'Z+', 'X', 'x', 'T', 'S'].map((state, i) =>
      `${i + 100} ${state} Fri Oct  9 12:34:56 2026`).join('\n'));
  });
  for (const platform of ['darwin', 'linux']) {
    assert.deepEqual([...await starts([100, 101, 102, 103, 104, 105], platform)].map(([pid]) => pid), [104, 105]);
  }
});

test('a killed process-start probe returns no identity instead of rejecting collection', async t => {
  const starts = loadWithProbe(t, (_command, _args, _options, done) => {
    done(Object.assign(new Error('deadline'), { killed: true, signal: 'SIGTERM' }), '');
  });
  assert.equal((await starts([123], 'darwin')).size, 0);
});

test('native POSIX process-start and state columns still recognize a live PID', {
  skip: !['darwin', 'linux'].includes(process.platform)
}, async () => {
  const { processStarts } = require('../../src/shared/processStarts');
  assert.ok(Number.isFinite((await processStarts([process.pid], process.platform)).get(process.pid)));
});

test('Windows native reads validate fresh creation times and release each handle', () => {
  const { readWindowsProcessStarts } = require('../../src/shared/windowsProcessStarts');
  let time = Date.parse('2026-10-09T12:34:56.123Z');
  const opened = []; const closed = [];
  const api = {
    open(access, inherit, pid) { assert.equal(access, 0x101000); assert.equal(inherit, 0); opened.push(pid); return pid; },
    times(handle, created) {
      if (handle === 456) return 0;
      if (handle === 789) throw new Error('process exited');
      const ticks = BigInt(time) * 10000n + 116444736000000000n + 9999n;
      created.low = Number(ticks & 0xffffffffn); created.high = Number(ticks >> 32n);
      return 1;
    },
    wait(_handle, milliseconds) { assert.equal(milliseconds, 0); return 0x102; },
    close(handle) { closed.push(handle); }
  };
  assert.deepEqual(readWindowsProcessStarts([123, 456, 789, -1, 2 ** 32, 1.5], api), new Map([[123, time]]));
  assert.deepEqual(opened, [123, 456, 789]);
  assert.deepEqual(closed, opened);
  time += 10_000;
  assert.equal(readWindowsProcessStarts([123], api).get(123), time, 'no PID result is cached across reads');
  assert.equal(readWindowsProcessStarts([123], null).size, 0, 'a missing binding leaves identity unverified');
  assert.equal(readWindowsProcessStarts([123], { open: () => null }).size, 0, 'inaccessible PID');
});

test('Windows retained terminated process and failed liveness check yield no identity', () => {
  const { readWindowsProcessStarts } = require('../../src/shared/windowsProcessStarts');
  const ticks = BigInt(Date.parse('2026-10-09T12:34:56Z')) * 10000n + 116444736000000000n;
  const closed = [];
  const api = {
    open: (_access, _inherit, pid) => pid,
    times(_handle, created) { created.low = Number(ticks & 0xffffffffn); created.high = Number(ticks >> 32n); return 1; },
    wait(handle, milliseconds) { assert.equal(milliseconds, 0); return handle === 123 ? 0 : 0xffffffff; },
    close(handle) { closed.push(handle); }
  };
  assert.equal(readWindowsProcessStarts([123, 456], api).size, 0,
    'birth time is valid, but terminated/unverified processes cannot renew activity');
  assert.deepEqual(closed, [123, 456]);
});

// Correctness stays in CI; the PowerShell/CIM cost comparison runs separately:
// node scripts/benchmark-windows-process-starts.js (Windows only).
test('Windows native PID probe reads the live process and its parent without a shell', {
  skip: process.platform !== 'win32'
}, async t => {
  const starts = loadWithProbe(t, () => { throw new Error('native Windows identity must not spawn a shell'); });
  const result = await starts([process.pid, process.ppid], 'win32');
  const ownStart = result.get(process.pid);
  const parentStart = result.get(process.ppid);
  assert.ok(Number.isFinite(ownStart), 'native probe has a live PID reading');
  assert.ok(Number.isFinite(parentStart), 'native probe can read another process');
  assert.ok(parentStart <= ownStart, 'the parent started before its child');
  assert.ok(ownStart > 0 && ownStart <= Date.now(), 'native creation time is a past Unix timestamp');
});

test('Windows terminated child with a retained native handle cannot renew activity', {
  skip: process.platform !== 'win32', timeout: 15_000
}, async t => {
  const { once } = require('node:events');
  const koffi = require('koffi');
  const kernel32 = koffi.load('kernel32.dll');
  const open = kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
  const close = kernel32.func('int __stdcall CloseHandle(void *handle)');
  const wait = kernel32.func('uint32_t __stdcall WaitForSingleObject(void *handle, uint32_t milliseconds)');
  const fileTime = koffi.struct({ low: 'uint32_t', high: 'uint32_t' });
  const output = koffi.out(koffi.pointer(fileTime));
  const times = kernel32.func('__stdcall', 'GetProcessTimes', 'int', ['void *', output, output, output, output]);
  const { processStarts } = require('../../src/shared/processStarts');
  const child = childProcess.spawn(process.execPath, ['-e',
    "process.on('message', () => process.exit(259)); process.send('ready');"], {
    stdio: ['ignore', 'ignore', 'ignore', 'ipc'], windowsHide: true
  });
  let retained;
  t.after(() => { child.kill(); if (retained) close(retained); });
  await once(child, 'message');
  retained = open(0x101000, 0, child.pid);
  assert.ok(retained);
  assert.equal(wait(retained, 0), 0x102);
  assert.ok(Number.isFinite((await processStarts([child.pid], 'win32')).get(child.pid)));
  const exited = once(child, 'exit');
  child.send('exit');
  await exited;
  assert.equal(wait(retained, 0), 0);
  const created = {};
  assert.equal(times(retained, created, {}, {}, {}), 1,
    'GetProcessTimes alone still succeeds on the retained terminated object');
  const reopened = open(0x101000, 0, child.pid);
  if (reopened) close(reopened);
  t.diagnostic('Terminated child retained-handle probe: reopenByPid=' + Boolean(reopened));
  assert.equal((await processStarts([child.pid], 'win32')).size, 0);
});
