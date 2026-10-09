'use strict';

const { execFile } = require('node:child_process');

function processStarts(pids, platform) {
  if (!pids.length) return Promise.resolve(new Map());
  let command;
  let args;
  if (platform === 'darwin' || platform === 'linux') {
    command = 'ps';
    args = ['-p', pids.join(','), '-o', 'pid=', '-o', 'lstart='];
  } else if (platform === 'win32') {
    command = 'powershell.exe';
    // All interpolated values have already been validated as positive integers.
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(' OR ');
    args = ['-NoProfile', '-NonInteractive', '-Command',
      `Get-CimInstance Win32_Process -Filter '${filter}' | ForEach-Object { Write-Output ($_.ProcessId.ToString() + ' ' + $_.CreationDate.ToUniversalTime().ToString('o')) }`];
  } else return Promise.resolve(new Map());
  return new Promise((resolve) => {
    execFile(command, args, {
      timeout: 2000, maxBuffer: 128 * 1024, windowsHide: true,
      env: { ...process.env, LC_ALL: 'C', TZ: 'UTC' }
    }, (_error, stdout) => {
      const result = new Map();
      for (const line of String(stdout || '').split('\n')) {
        const match = line.trim().match(/^(\d+)\s+(.+)$/);
        if (!match) continue;
        const time = Date.parse(platform === 'win32' ? match[2] : `${match[2]} UTC`);
        if (Number.isFinite(time)) result.set(Number(match[1]), time);
      }
      resolve(result);
    });
  });
}

// A single collection/poll owns this batch. Concurrent registry and T3 readers
// validate their PIDs together; no result survives into the next poll, so PID
// reuse cannot inherit a minute-old cached start time.
function createProcessStartBatch(read = processStarts) {
  let pending = [];
  let scheduled = false;
  const observed = new Map();
  return (pids, platform) => {
    if (!pids.length) return Promise.resolve(new Map());
    if (pids.every((pid) => observed.has(`${platform}:${pid}`))) {
      return Promise.resolve(new Map(pids.map((pid) => [pid, observed.get(`${platform}:${pid}`)])));
    }
    return new Promise((resolve, reject) => {
      pending.push({ pids, platform, resolve, reject });
      if (scheduled) return;
      scheduled = true;
      setImmediate(async () => {
        const group = pending;
        pending = [];
        scheduled = false;
        for (const platformName of new Set(group.map((entry) => entry.platform))) {
          const callers = group.filter((entry) => entry.platform === platformName);
          const ids = [...new Set(callers.flatMap((entry) => entry.pids))];
          try {
            const starts = await read(ids, platformName);
            for (const id of ids) observed.set(`${platformName}:${id}`, starts.get(id));
            for (const entry of callers) entry.resolve(new Map(entry.pids.map((pid) => [pid, starts.get(pid)])));
          } catch (error) { for (const entry of callers) entry.reject(error); }
        }
      });
    });
  };
}

module.exports = { processStarts, createProcessStartBatch };
