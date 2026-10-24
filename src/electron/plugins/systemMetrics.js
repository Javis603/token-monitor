'use strict';

// Built-in system sources for the Data Bus. Each sampler is cheap enough to
// run every second and holds no timers of its own: the bus calls it only while
// some surface or background rule demands the reading.

const os = require('node:os');

// Busy share of all logical CPUs since the previous call, 0–100. The first
// call only primes the baseline (a reading since boot would be meaningless).
function createCpuSampler({ cpus = () => os.cpus() } = {}) {
  let previous = null;
  function totals() {
    let idle = 0;
    let total = 0;
    for (const cpu of cpus() || []) {
      const times = cpu.times || {};
      idle += times.idle || 0;
      total += (times.user || 0) + (times.nice || 0) + (times.sys || 0) + (times.idle || 0) + (times.irq || 0);
    }
    return { idle, total };
  }
  return function sampleCpu() {
    const current = totals();
    const last = previous;
    previous = current;
    if (!last) return undefined;
    const total = current.total - last.total;
    const idle = current.idle - last.idle;
    if (total <= 0) return undefined;
    return Math.max(0, Math.min(100, Math.round((1 - idle / total) * 1000) / 10));
  };
}

// macOS "Memory Used" as Activity Monitor reports it: app memory (anonymous
// pages that are not purgeable) + wired + compressed. total - os.freemem()
// would count the file cache macOS keeps in otherwise-free pages and read
// near 100% on a healthy machine.
// koffi registers struct names globally, so the binding is created once per
// process and shared by every reader.
let macApi = null;
function createMacMemoryReader({ detailed = false } = {}) {
  return function readMacMemory() {
    if (!macApi) {
      const koffi = require('koffi');
      const libc = koffi.load('/usr/lib/libSystem.B.dylib');
      const stats = koffi.struct('TMVmStatistics64', {
        free_count: 'uint32', active_count: 'uint32', inactive_count: 'uint32', wire_count: 'uint32',
        zero_fill_count: 'uint64', reactivations: 'uint64', pageins: 'uint64', pageouts: 'uint64',
        faults: 'uint64', cow_faults: 'uint64', lookups: 'uint64', hits: 'uint64', purges: 'uint64',
        purgeable_count: 'uint32', speculative_count: 'uint32',
        decompressions: 'uint64', compressions: 'uint64', swapins: 'uint64', swapouts: 'uint64',
        compressor_page_count: 'uint32', throttled_count: 'uint32', external_page_count: 'uint32',
        internal_page_count: 'uint32', total_uncompressed_pages_in_compressor: 'uint64'
      });
      const hostSelf = libc.func('mach_host_self', 'uint32', []);
      const hostStatistics64 = libc.func('host_statistics64', 'int', ['uint32', 'int', koffi.out(koffi.pointer(stats)), koffi.inout(koffi.pointer('uint32'))]);
      const hostPageSize = libc.func('host_page_size', 'int', ['uint32', koffi.out(koffi.pointer('uintptr_t'))]);
      const host = hostSelf();
      const pageOut = [0];
      const pageSize = hostPageSize(host, pageOut) === 0 && pageOut[0] ? Number(pageOut[0]) : 16384;
      // HOST_VM_INFO64 = 4; the count is the struct size in 32-bit words.
      const count = Math.floor(koffi.sizeof(stats) / 4);
      macApi = { host, pageSize, count, hostStatistics64 };
    }
    const info = {};
    const count = [macApi.count];
    if (macApi.hostStatistics64(macApi.host, 4, info, count) !== 0) throw new Error('host_statistics64 failed');
    const appPages = Math.max(0, Number(info.internal_page_count) - Number(info.purgeable_count));
    const used = (appPages + Number(info.wire_count) + Number(info.compressor_page_count)) * macApi.pageSize;
    return detailed ? { used, app: appPages * macApi.pageSize, wired: Number(info.wire_count) * macApi.pageSize, compressed: Number(info.compressor_page_count) * macApi.pageSize, fileBacked: Number(info.external_page_count) * macApi.pageSize, swapInBytes: Number(info.swapins) * macApi.pageSize, swapOutBytes: Number(info.swapouts) * macApi.pageSize } : used;
  };
}

function createMemorySampler({ platform = process.platform, totalmem = () => os.totalmem(), freemem = () => os.freemem(), macReader = null, detailed = false } = {}) {
  let readMac = platform === 'darwin' ? macReader || createMacMemoryReader({ detailed }) : null;
  return function sampleMemory() {
    const total = totalmem();
    let used = null, fields = {};
    if (readMac) {
      try {
        const reading = readMac();
        used = typeof reading === 'number' ? reading : reading.used;
        if (detailed && typeof reading === 'object') fields = reading;
      } catch {
        // Keep sampling with the portable figure rather than failing the source.
        readMac = null;
      }
    }
    // libuv reports available memory on Linux and Windows, so total - free is
    // the in-use figure there; on macOS it is only the fallback above.
    if (used === null) used = total - freemem();
    const clamped = Math.max(0, Math.min(total, used));
    return { ...fields, used: clamped, total, percent: total ? Math.round((clamped / total) * 1000) / 10 : null };
  };
}

module.exports = { createCpuSampler, createMacMemoryReader, createMemorySampler };
