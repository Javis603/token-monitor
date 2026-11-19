#!/usr/bin/env node
'use strict';

// Manual comparison, outside CI: PowerShell startup/CIM latency depends on the host.
// Run on Windows: node scripts/benchmark-windows-process-starts.js
const assert = require('node:assert/strict');
const childProcess = require('node:child_process');
const { performance } = require('node:perf_hooks');

async function main() {
  if (process.platform !== 'win32') throw new Error('This benchmark requires Windows');
  const execFile = childProcess.execFile;
  const samples = [];
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
        succeeded: !error && Number.isFinite(Date.parse(reading?.trim().split(' ')[1])),
        reading: reading?.trim() ?? null, stderr: String(stderr || '').trim().slice(0, 400) };
      samples.push(sample);
      console.log('PowerShell probe: ' + JSON.stringify(sample));
      done(error, stdout, stderr);
    });
  };
  const { processStarts: starts } = require('../src/shared/processStarts');
  let nativeTime;
  for (const iterations of [1, 1000, 1000, 1000, 1000]) {
    const before = process.memoryUsage().rss;
    const cpu = process.cpuUsage(); const begun = performance.now();
    for (let i = 0; i < iterations; i++) {
      const result = await starts([process.pid, process.ppid], 'win32');
      assert.ok(Number.isFinite(result.get(process.pid)), 'native probe has a live PID reading');
      assert.ok(Number.isFinite(result.get(process.ppid)), 'native probe can read another process');
      nativeTime = result.get(process.pid);
    }
    const usage = process.cpuUsage(cpu);
    console.log('Native Windows probe: ' + JSON.stringify({ iterations, pidsPerRead: 2,
      wallMs: +(performance.now() - begun).toFixed(3), cpuMs: (usage.user + usage.system) / 1000,
      rssDeltaMiB: +((process.memoryUsage().rss - before) / 1048576).toFixed(3) }));
  }
  const legacyProbe = timeout => new Promise(resolve => {
    const query = `Get-CimInstance Win32_Process -Filter 'ProcessId=${process.pid}' | ForEach-Object { Write-Output ($_.ProcessId.ToString() + ' ' + $_.CreationDate.ToUniversalTime().ToString('o')) }`;
    const instrumented = '$queryWatch = [Diagnostics.Stopwatch]::StartNew(); ' + query
      + "; $queryWatch.Stop(); Write-Output ('probe-query-ms ' + $queryWatch.Elapsed.TotalMilliseconds.ToString([Globalization.CultureInfo]::InvariantCulture))" + costScript;
    run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', instrumented],
      { timeout, maxBuffer: 128 * 1024, windowsHide: true }, (error, stdout) => {
        const reading = String(stdout).split('\n').find(line => line.trim().startsWith(process.pid + ' '));
        const time = !error && reading ? Date.parse(reading.trim().split(' ')[1]) : NaN;
        resolve(time);
      }, timeout === 2000 ? 'legacy-2s' : 'extended-measurement');
  }).then(time => {
    if (Number.isFinite(time)) assert.ok(Math.abs(time - nativeTime) <= 1, 'native and CIM creation times agree');
    return Number.isFinite(time);
  });
  let succeeded = false;
  for (let i = 0; i < 5; i++) succeeded = (await legacyProbe(2000)) || succeeded;
  // No CIM call: this fresh process measures PowerShell startup/shutdown alone.
  await new Promise(resolve => run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    costScript.slice(2)], { timeout: 15_000, maxBuffer: 128 * 1024, windowsHide: true }, resolve, 'startup-only'));
  if (!succeeded) {
    assert.ok(await legacyProbe(15_000), 'bounded CIM reference probe has a live PID reading; see diagnostics');
  }
  console.log('Legacy 2-second successes: ' + samples.filter(sample =>
    sample.label === 'legacy-2s' && sample.succeeded).length + '/5');
}

main().catch(error => { console.error(error); process.exitCode = 1; });
