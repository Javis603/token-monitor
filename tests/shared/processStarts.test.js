'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

// Measure the existing command on the real Windows runner before deciding
// whether a different probe is warranted. No latency/CPU threshold is asserted.
test('Windows live PID probe reports measured PowerShell cost', { skip: process.platform !== 'win32' }, async t => {
  const file = require.resolve('../../src/shared/processStarts');
  const saved = require.cache[file];
  const execFile = childProcess.execFile;
  const samples = [];
  t.after(() => { delete require.cache[file]; if (saved) require.cache[file] = saved; });
  t.mock.method(childProcess, 'execFile', (command, args, options, done) => {
    const instrumented = [...args];
    instrumented[instrumented.length - 1] += "; $probe = [Diagnostics.Process]::GetCurrentProcess(); Write-Output ('probe-cost ' + $probe.TotalProcessorTime.TotalMilliseconds + ' ' + $probe.PeakWorkingSet64)";
    const started = performance.now();
    return execFile(command, instrumented, options, (error, stdout, stderr) => {
      const match = String(stdout).match(/probe-cost ([\d.]+) (\d+)/);
      samples.push({ wallMs: +(performance.now() - started).toFixed(1),
        cpuMs: match ? Number(match[1]) : null,
        peakWorkingSetMiB: match ? +(Number(match[2]) / 1048576).toFixed(1) : null,
        timedOut: Boolean(error?.killed) });
      done(error, stdout, stderr);
    });
  });
  delete require.cache[file];
  const { processStarts } = require(file);
  for (let i = 0; i < 5; i++) {
    const starts = await processStarts([process.pid], 'win32');
    assert.ok(Number.isFinite(starts.get(process.pid)), 'current Node PID has a process-start reading');
  }
  t.diagnostic('PowerShell process probe (cold first, then four fresh processes): ' + JSON.stringify(samples));
});
