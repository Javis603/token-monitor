'use strict';

// End-to-end coverage for the reactive tokscale --client capability fallback
// (src/shared/tokscaleCapabilities.js): a binary that supports every
// requested client must never pay for an extra --help spawn, and a binary
// that rejects an unsupported id (tokscale's real exit code 2 contract) must
// recover by probing once, then filtering proactively for the rest of the
// tick instead of failing and probing again on every scan.

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

async function waitFor(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt >= timeoutMs) throw new Error('Timed out waiting for capability probe state');
    await new Promise((resolve) => setImmediate(resolve));
  }
}

function jsonChild(payload) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(JSON.stringify(payload)));
    child.emit('close', 0);
  });
  return child;
}

function exitChild(code, stderr = '') {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.kill = () => {};
  setImmediate(() => {
    if (stderr) child.stderr.emit('data', Buffer.from(stderr));
    child.emit('close', code);
  });
  return child;
}

function helpChild(possibleValues) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  child.kill = () => {};
  setImmediate(() => {
    child.stdout.emit('data', Buffer.from(`--client [possible values: ${possibleValues.join(', ')}]`));
    child.emit('close', 0);
  });
  return child;
}

test('a binary that supports every requested client never spawns a capability probe', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    return jsonChild({ entries: [] });
  };

  try {
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce({
      clients: 'claude',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });
    assert.equal(calls.length, 3, 'today/month/allTime — no extra --help spawn');
    assert.ok(calls.every((args) => !args.includes('--help')));
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('an unknown-client rejection probes once, retries, then filters proactively for later scans', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  let helpProbes = 0;

  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    if (args.includes('--help')) {
      helpProbes += 1;
      return helpChild(['claude']);
    }
    const clientIndex = args.indexOf('--client');
    const requested = args[clientIndex + 1];
    if (requested.split(',').includes('dsh')) {
      return exitChild(2, 'error: invalid value \'dsh\' for --client');
    }
    return jsonChild({ entries: [] });
  };

  try {
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce({
      clients: 'claude,dsh',
      allTimeSince: '2024-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'test-device',
      agentVersion: 'test',
      limitsEnabled: false
    });
    // today: fail(1) + help(2) + retry-success(3); month/allTime: filtered up
    // front, one spawn each — 5 total, one probe.
    assert.equal(helpProbes, 1, 'the binary is probed exactly once for its whole identity');
    assert.equal(calls.length, 5);
    const clientArgsList = calls
      .filter((args) => !args.includes('--help'))
      .map((args) => args[args.indexOf('--client') + 1]);
    assert.equal(clientArgsList.filter((csv) => csv.includes('dsh')).length, 1, 'only the first scan ever asks for the unsupported id');
    // The first scan's own retry plus the two later scans (filtered proactively
    // once the identity's capability set is known) — three filtered spawns.
    assert.equal(clientArgsList.filter((csv) => csv === 'claude').length, 3);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('an exit-2 failure unrelated to --client never triggers a probe', async () => {
  // clap's exit code 2 is a generic argument-parsing failure, not specific to
  // --client — e.g. a malformed --since date would exit the same way. Only a
  // failure whose stderr actually names --client should spend a probe.
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  let helpProbes = 0;

  childProcess.spawn = (_bin, args) => {
    if (args.includes('--help')) { helpProbes += 1; return jsonChild({}); }
    return exitChild(2, 'error: invalid value for --since');
  };

  try {
    const { collectUsageOnce } = freshCollector();
    await assert.rejects(
      collectUsageOnce({
        clients: 'claude',
        allTimeSince: '2024-01-01',
        commandTimeoutMs: 1000,
        deviceId: 'test-device',
        agentVersion: 'test',
        limitsEnabled: false
      }),
      /tokscale exited with code 2/
    );
    assert.equal(helpProbes, 0, 'an unrelated usage error must not spend a capability probe');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('a probe that itself fails surfaces the original tokscale error, not a silent empty result', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;

  childProcess.spawn = (_bin, args) => {
    if (args.includes('--help')) return jsonChild({ not: 'a help payload' });
    return exitChild(2, 'error: invalid value \'dsh\' for --client');
  };

  try {
    const { collectUsageOnce } = freshCollector();
    await assert.rejects(
      collectUsageOnce({
        clients: 'claude,dsh',
        allTimeSince: '2024-01-01',
        commandTimeoutMs: 1000,
        deviceId: 'test-device',
        agentVersion: 'test',
        limitsEnabled: false
      }),
      /tokscale exited with code 2/
    );
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('a timed-out capability probe waits through forced termination until close', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  const signals = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  childProcess.spawn = () => child;

  try {
    const { spawnTokscaleHelp } = freshCollector();
    const pending = spawnTokscaleHelp(
      { bin: 'tokscale', prefixArgs: [], env: {}, identity: 'test' },
      { timeoutMs: 1, terminationOptions: { graceMs: 1 } }
    );
    let settled = false;
    pending.catch(() => { settled = true; });

    await waitFor(() => signals.includes('SIGKILL'));
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.equal(settled, false, 'probe remains in flight until physical close');
    child.stdout.emit('data', Buffer.alloc(1024 * 1024, 120));
    child.stderr.emit('data', Buffer.alloc(1024 * 1024, 121));
    child.emit('close', null, 'SIGKILL');

    await assert.rejects(pending, /capability probe timed out after 1ms/);
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});

test('a capability probe cannot hold the process-wide resolver forever after SIGKILL', async () => {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.stdin = { end: () => {} };
  const signals = [];
  const diagnostics = [];
  child.kill = (signal) => { signals.push(signal); return true; };
  childProcess.spawn = () => child;

  try {
    const { spawnTokscaleHelp } = freshCollector();
    const pending = spawnTokscaleHelp(
      { bin: 'tokscale', prefixArgs: [], env: {}, identity: 'unconfirmed-test' },
      {
        timeoutMs: 1,
        terminationOptions: { graceMs: 1, closeGraceMs: 1 },
        onTerminationUnconfirmed: (error) => diagnostics.push(error.code)
      }
    );

    await assert.rejects(pending, (error) => error.code === 'termination-unconfirmed');
    assert.deepEqual(signals, ['SIGTERM', 'SIGKILL']);
    assert.deepEqual(diagnostics, ['termination-unconfirmed']);

    child.emit('close', null, 'SIGKILL');
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
});
