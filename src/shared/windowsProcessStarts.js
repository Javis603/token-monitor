'use strict';

let api;
function processApi() {
  if (api !== undefined) return api;
  api = null;
  try {
    const koffi = require('koffi');
    const kernel32 = koffi.load('kernel32.dll');
    // Anonymous type avoids colliding with the credential reader's FILETIME.
    const fileTime = koffi.struct({ low: 'uint32_t', high: 'uint32_t' });
    const output = koffi.out(koffi.pointer(fileTime));
    api = {
      open: kernel32.func('void * __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)'),
      times: kernel32.func('__stdcall', 'GetProcessTimes', 'int', ['void *', output, output, output, output]),
      close: kernel32.func('int __stdcall CloseHandle(void *handle)')
    };
  } catch (_) { /* No native binding: leave identity unverified. */ }
  return api;
}

function readWindowsProcessStarts(pids, native = processApi()) {
  const starts = new Map();
  if (!native) return starts;
  for (const pid of pids) {
    if (!Number.isInteger(pid) || pid <= 0 || pid > 0xffffffff) continue;
    let handle;
    try {
      handle = native.open(0x1000, 0, pid); // PROCESS_QUERY_LIMITED_INFORMATION
      if (!handle) continue;
      const created = {};
      if (!native.times(handle, created, {}, {}, {})) continue;
      const ticks = (BigInt(created.high) << 32n) | BigInt(created.low);
      // FILETIME is 100 ns since 1601; match Date.parse's Unix milliseconds.
      const time = Number((ticks - 116444736000000000n) / 10000n);
      if (Number.isFinite(time) && time > 0) starts.set(pid, time);
    } catch (_) { /* Exited/inaccessible processes have no verified identity. */ }
    finally { if (handle) { try { native.close(handle); } catch (_) {} } }
  }
  return starts;
}

module.exports = { readWindowsProcessStarts };
