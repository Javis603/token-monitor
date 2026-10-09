'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

function loadWithProbe(t, probe) {
  const file = require.resolve('../../src/shared/processStarts');
  const saved = require.cache[file];
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved; });
  t.mock.method(childProcess, 'execFile', probe);
  delete require.cache[file];
  return require(file).processStarts;
}

test('Windows process-start output parses fractional UTC timestamps and batches PIDs', async t => {
  const starts = loadWithProbe(t, (command, args, options, done) => {
    assert.equal(command, 'powershell.exe');
    assert.ok(args.at(-1).includes("ProcessId=123 OR ProcessId=456"));
    assert.equal(options.timeout, 2000);
    done(null, '123 2026-10-09T12:34:56.1234567Z\r\n456 2026-10-09T12:34:57.0000000Z\r\n');
  });
  assert.deepEqual(await starts([123, 456], 'win32'), new Map([
    [123, Date.parse('2026-10-09T12:34:56.123Z')], [456, Date.parse('2026-10-09T12:34:57Z')]
  ]));
});

test('a killed process-start probe returns no identity instead of rejecting collection', async t => {
  const starts = loadWithProbe(t, (_command, _args, _options, done) => {
    done(Object.assign(new Error('deadline'), { killed: true, signal: 'SIGTERM' }), '');
  });
  assert.equal((await starts([123], 'win32')).size, 0);
});

// Keep the production deadline, but do not make runner cold-start latency a
// correctness assertion. Always print diagnostics, even on timeout. A separate
// bounded measurement can distinguish startup, CIM and output parsing costs.
test('Windows live PID probe reports measured PowerShell cost', { skip: process.platform !== 'win32' }, async t => {
  const execFile = childProcess.execFile;
  const samples = [];
  let measurementTimeout = null;
  const costScript = "; $probe = [Diagnostics.Process]::GetCurrentProcess(); Write-Output ('probe-cost ' + $probe.TotalProcessorTime.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture) + ' ' + $probe.PeakWorkingSet64)";
  const run = (command, args, options, done, label) => {
    const started = performance.now();
    return execFile(command, args, options, (error, stdout, stderr) => {
      const cost = String(stdout).match(/probe-cost ([\d.]+) (\d+)/);
      const query = String(stdout).match(/probe-query-ms ([\d.]+)/);
      const reading = String(stdout).split('\n').find(line => line.trim().startsWith(process.pid + ' '));
      const sample = { label, timeoutMs: options.timeout,
        wallMs: +(performance.now() - started).toFixed(1),
        queryMs: query ? Number(query[1]) : null,
        cpuMs: cost ? Number(cost[1]) : null,
        peakWorkingSetMiB: cost ? +(Number(cost[2]) / 1048576).toFixed(1) : null,
        killed: Boolean(error?.killed), code: error?.code ?? null, signal: error?.signal ?? null,
        reading: reading?.trim() ?? null, stderr: String(stderr || '').trim().slice(0, 400) };
      samples.push(sample);
      t.diagnostic('PowerShell probe: ' + JSON.stringify(sample));
      done(error, stdout, stderr);
    });
  };
  const starts = loadWithProbe(t, (command, args, options, done) => {
    const instrumented = [...args];
    instrumented[instrumented.length - 1] = '$queryWatch = [Diagnostics.Stopwatch]::StartNew(); '
      + args.at(-1) + "; $queryWatch.Stop(); Write-Output ('probe-query-ms ' + $queryWatch.Elapsed.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture))"
      + costScript;
    return run(command, instrumented, { ...options, timeout: measurementTimeout ?? options.timeout }, done,
      measurementTimeout ? 'extended-measurement' : 'production-deadline');
  });
  let succeeded = false;
  for (let i = 0; i < 5; i++) {
    const result = await starts([process.pid], 'win32');
    const reading = samples.at(-1).reading;
    const expected = reading ? Date.parse(reading.slice(reading.indexOf(' ') + 1)) : undefined;
    assert.equal(result.get(process.pid), Number.isFinite(expected) ? expected : undefined,
      'the reader returns exactly the identity emitted before the deadline');
    succeeded ||= Number.isFinite(result.get(process.pid));
  }
  // No CIM call: this fresh process measures PowerShell startup/shutdown alone.
  await new Promise(resolve => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    costScript.slice(2)], { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true }, resolve, 'startup-only'));
  if (!succeeded) {
    measurementTimeout = 15_000; // Test instrumentation only; production stays 2 s.
    const result = await starts([process.pid], 'win32');
    assert.ok(Number.isFinite(result.get(process.pid)), 'bounded diagnostic probe must obtain the current PID identity; see probe diagnostics');
  }
  t.diagnostic('Production-deadline successes: ' + samples.filter(sample =>
    sample.label === 'production-deadline' && sample.reading && !sample.killed).length + '/5');
});
