'use strict';

// A full tick asks tokscale for Today, Month and All Time in one windowed scan
// (`--window NAME:SINCE:UNTIL`, vendored fork) instead of three serial scans
// that each pay the same full load. Binaries without the flag keep the serial
// scans, and that answer is remembered per binary.

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const collectorPath = require.resolve('../../src/shared/collector');

function freshCollector() {
  delete require.cache[collectorPath];
  return require(collectorPath);
}

// Local noon, so the captured calendar cannot straddle a midnight.
const NOW = new Date(2026, 10, 24, 12, 0, 0);
const WINDOW_FLAGS = [
  '--window', 'today:2026-11-24:2026-11-24',
  '--window', 'month:2026-11-01:2026-11-24',
  '--window', 'allTime:2024-01-01:'
];

function report(input) {
  return {
    groupBy: 'client,session,model',
    entries: [{ client: 'claude', sessionId: `s-${input}`, model: 'claude-sonnet-4-5', input, output: 0, cost: 0 }]
  };
}

const WINDOWED = {
  schemaVersion: 1,
  windows: { today: report(1), month: report(20), allTime: report(300) }
};

function baseOptions(extra = {}) {
  return {
    clients: 'claude',
    allTimeSince: '2024-01-01',
    commandTimeoutMs: 1000,
    deviceId: 'windowed-scan-test',
    agentVersion: 'test',
    limitsEnabled: false,
    historyEnabled: false,
    now: NOW,
    collectWslUsage: async () => ({ bundle: { today: {}, month: {}, allTime: {} }, detected: [] }),
    ...extra
  };
}

function assertPeriods(result) {
  assert.equal(result.today.totalTokens, 1);
  assert.equal(result.month.totalTokens, 20);
  assert.equal(result.allTime.totalTokens, 300);
}

function child({ code = 0, stdout = '', stderr = '' }) {
  const proc = new EventEmitter();
  proc.stdout = new EventEmitter();
  proc.stderr = new EventEmitter();
  proc.stdin = { end: () => {} };
  proc.kill = () => {};
  setImmediate(() => {
    if (stdout) proc.stdout.emit('data', Buffer.from(stdout));
    if (stderr) proc.stderr.emit('data', Buffer.from(stderr));
    proc.emit('close', code);
  });
  return proc;
}

// What a pre-`--window` build prints. clap's usage line names `--client`, which
// must not read as an unknown-client rejection.
const OLD_BINARY_REJECTION = "error: unexpected argument '--window' found\n\n"
  + 'Usage: tokscale --json --client <CLIENTS>\n\n'
  + "For more information, try '--help'.\n";

function serialReport(args) {
  if (args.includes('--today')) return report(1);
  if (args.includes('--month')) return report(20);
  return report(300);
}

async function withSpawn(handler, run) {
  const childProcess = require('node:child_process');
  const originalSpawn = childProcess.spawn;
  const calls = [];
  childProcess.spawn = (_bin, args) => {
    calls.push(args);
    return child(handler(args));
  };
  try {
    await run(calls, freshCollector());
  } finally {
    childProcess.spawn = originalSpawn;
    delete require.cache[collectorPath];
  }
}

const scanCalls = (calls) => calls.filter((args) => !args.includes('--help'));

test('a full tick reads every period from one windowed scan in the captured calendar', async () => {
  const requests = [];
  const { collectUsageOnce } = freshCollector();
  const result = await collectUsageOnce(baseOptions({
    runTokscaleWindows: async (input) => {
      requests.push(input);
      return WINDOWED.windows;
    },
    runTokscale: async () => assert.fail('the serial scans must not run')
  }));

  assertPeriods(result);
  assert.equal(requests.length, 1);
  assert.deepEqual(requests[0].windows, [
    { name: 'today', since: '2026-11-24', until: '2026-11-24' },
    { name: 'month', since: '2026-11-01', until: '2026-11-24' },
    { name: 'allTime', since: '2024-01-01', until: '' }
  ]);
  assert.equal(requests[0].clients, 'claude');
});

test('a windowed result missing a window fails the tick instead of publishing the rest', async () => {
  // Absent, or present without the entries every report carries: neither may
  // publish as zero All Time usage.
  for (const allTime of [undefined, {}, []]) {
    const { collectUsageOnce } = freshCollector();
    await assert.rejects(collectUsageOnce(baseOptions({
      runTokscaleWindows: async () => ({ today: report(1), month: report(20), ...(allTime ? { allTime } : {}) }),
      runTokscale: async () => assert.fail('the serial scans must not run')
    })), /missing the allTime window/);
  }
});

test('a binary without windowed mode keeps the serial scans', async () => {
  const flags = [];
  const { collectUsageOnce } = freshCollector();
  const result = await collectUsageOnce(baseOptions({
    runTokscaleWindows: async () => null,
    runTokscale: async (input) => {
      flags.push(input.flags);
      return serialReport(input.flags);
    }
  }));

  assertPeriods(result);
  assert.deepEqual(flags, [['--today'], ['--month'], ['--since', '2024-01-01']]);
});

test('an All Time start that is not a calendar day keeps the serial scans', async () => {
  // `--window` rejects both; a plain `--since` compares them as strings.
  for (const allTimeSince of ['2024-01', '2026-02-30']) {
    const flags = [];
    const { collectUsageOnce } = freshCollector();
    await collectUsageOnce(baseOptions({
      allTimeSince,
      runTokscaleWindows: async () => assert.fail('the windowed scan needs calendar-day bounds'),
      runTokscale: async (input) => {
        flags.push(input.flags);
        return serialReport(input.flags);
      }
    }));
    assert.deepEqual(flags, [['--today'], ['--month'], ['--since', allTimeSince]], allTimeSince);
  }
});

test('the windowed binary is spawned once with the production grouping', () => withSpawn(
  () => ({ stdout: JSON.stringify(WINDOWED) }),
  async (calls, { collectUsageOnce }) => {
    assertPeriods(await collectUsageOnce(baseOptions()));
    const scans = scanCalls(calls);
    assert.equal(scans.length, 1);
    // Before `--client`, so an older binary reports the unknown flag rather
    // than a fork-only client it can only accept once the rest parses.
    const client = scans[0].indexOf('--client');
    assert.deepEqual(scans[0].slice(client - WINDOW_FLAGS.length, client), WINDOW_FLAGS);
    assert.equal(scans[0][scans[0].indexOf('--group-by') + 1], 'client,workspace,session,model');
    assert.ok(!scans[0].includes('--today'));
  }
));

// clap reports the first argument it cannot parse. The pinned fork accepts a
// fork-only client such as qodercn only when the rest of the command line
// parses, so an unknown flag placed after `--client` surfaces as a bad client.
function olderBinary(args) {
  const window = args.indexOf('--window');
  if (window < 0) return { stdout: JSON.stringify(serialReport(args)) };
  const client = args.indexOf('--client');
  if (client < window && args[client + 1].split(',').includes('qodercn')) {
    return { code: 2, stderr: "error: invalid value 'qodercn' for '--client <CLIENTS>'\n" };
  }
  return { code: 2, stderr: OLD_BINARY_REJECTION };
}

test('a binary that rejects --window falls back without a capability probe and is remembered', () => withSpawn(
  olderBinary,
  async (calls, { collectUsageOnce }) => {
    assertPeriods(await collectUsageOnce(baseOptions({ clients: 'claude,qodercn' })));
    assertPeriods(await collectUsageOnce(baseOptions({ clients: 'claude,qodercn' })));
    assert.ok(!calls.some((args) => args.includes('--help')), 'no --client capability probe');
    const windowed = calls.filter((args) => args.includes('--window'));
    assert.equal(windowed.length, 1, 'the rejection is cached per binary');
    assert.equal(scanCalls(calls).length, 1 + 3 + 3);
  }
));

test('a windowed report in another shape fails the tick', () => withSpawn(
  () => ({ stdout: JSON.stringify(report(1)) }),
  async (calls, { collectUsageOnce }) => {
    await assert.rejects(collectUsageOnce(baseOptions()), /unsupported shape/);
    assert.equal(scanCalls(calls).length, 1);
  }
));
