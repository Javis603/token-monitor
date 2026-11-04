'use strict';

// System vitals sampler for the edge dock. The host provides no system
// monitoring (see docs/plugins/README.md), so the plugin owns its own
// sampling: CPU as a delta between os.cpus() readings, memory from macOS
// vm_stat (which names the pages that are truly available) with a portable
// fallback elsewhere, and a three-minute ring buffer that the card draws as
// the recent-load curve. One cadence tick publishes one snapshot; every mount
// of both views reads the same series.

const os = require('node:os');
const { execFile } = require('node:child_process');

// CPU is a delta between os.cpus() samples; shorter than this and the window
// is noise, so the previous reading is kept instead of publishing a spike.
const CPU_MIN_SAMPLE_MS = 400;
// vm_stat is a subprocess per reading; 3s is fresh enough for a glance meter.
const MEMORY_TTL_MS = 3000;
// The publish cadence the dock refreshes at; the vitals just keep pace.
const TICK_MS = 2000;
// The card's load curve window: 90 points at the 2s cadence is three minutes.
const HISTORY_LIMIT = 90;

function createSampler({ now = Date.now } = {}) {
  let previousCpu = sampleCpuTimes();
  let lastCpuPercent = null;
  let history = [];
  let memoryCache = { at: 0, value: null, inFlight: null };

  function sampleCpuTimes() {
    const cpus = os.cpus();
    let idle = 0;
    let total = 0;
    for (const cpu of cpus) {
      const times = cpu && cpu.times;
      if (!times) continue;
      idle += times.idle;
      total += times.user + times.nice + times.sys + times.idle + times.irq;
    }
    return { idle, total, at: now(), cores: cpus.length };
  }

  function round(value, digits) {
    const factor = 10 ** digits;
    return Math.round(value * factor) / factor;
  }

  function refreshCpu() {
    try {
      const next = sampleCpuTimes();
      if (next.at - previousCpu.at >= CPU_MIN_SAMPLE_MS && next.total > previousCpu.total) {
        const totalDelta = next.total - previousCpu.total;
        const idleDelta = next.idle - previousCpu.idle;
        lastCpuPercent = Math.max(0, Math.min(100, 100 * (1 - idleDelta / totalDelta)));
        previousCpu = next;
      }
    } catch {
      /* keep the previous reading */
    }
  }

  // macOS's os.freemem() counts only truly-free pages, so a "used" of
  // total - free would report cached and purgeable memory as pressure. vm_stat
  // names the pages that are actually available; other platforms fall back to
  // the portable reading.
  function readDarwinMemory() {
    return new Promise((resolve, reject) => {
      execFile('vm_stat', [], { timeout: 1500, maxBuffer: 1 << 20 }, (error, stdout) => {
        if (error) reject(error);
        else resolve(stdout);
      });
    });
  }

  function refreshMemory() {
    if (memoryCache.inFlight) return memoryCache.inFlight;
    if (memoryCache.value && now() - memoryCache.at < MEMORY_TTL_MS) return Promise.resolve(memoryCache.value);
    const read = process.platform === 'darwin'
      ? readDarwinMemory().catch(() => null)
      : Promise.resolve(null);
    memoryCache.inFlight = read
      .then((stdout) => {
        memoryCache.inFlight = null;
        let reading = null;
        if (stdout) {
          const pageMatch = /page size of (\d+) bytes/.exec(stdout);
          const pageSize = pageMatch ? Number(pageMatch[1]) : 4096;
          const pages = (label) => {
            const match = new RegExp(`${label}:\\s+(\\d+)\\.?`).exec(stdout);
            return match ? Number(match[1]) : 0;
          };
          const total = os.totalmem();
          const available = Math.min(
            total,
            (pages('Pages free') + pages('Pages inactive') + pages('Pages speculative') + pages('Pages purgeable')) * pageSize
          );
          reading = { total, available, used: Math.max(0, total - available), source: 'vm_stat' };
        }
        const value = reading || (() => {
          const total = os.totalmem();
          const free = os.freemem();
          return { total, available: free, used: Math.max(0, total - free), source: 'os' };
        })();
        memoryCache = { at: now(), value, inFlight: null };
        return value;
      })
      .catch(() => {
        memoryCache.inFlight = null;
      });
    return memoryCache.inFlight;
  }

  function memoryPercent() {
    const memory = memoryCache.value;
    return memory ? Math.round((memory.used / Math.max(1, memory.total)) * 1000) / 10 : null;
  }

  function tick() {
    refreshCpu();
    void refreshMemory();
    // One point per cadence tick, even while a reading is still null: the
    // curve keeps its time axis during the first seconds instead of stretching.
    history.push({ at: now(), cpu: lastCpuPercent, mem: memoryPercent() });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
  }

  function snapshot() {
    const cpuPercent = lastCpuPercent === null ? null : round(lastCpuPercent, 1);
    const memory = memoryCache.value;
    const load = os.loadavg();
    return {
      cpu: cpuPercent,
      cores: previousCpu.cores,
      loadAvg: [round(load[0], 2), round(load[1], 2), round(load[2], 2)],
      mem: memory ? round((memory.used / Math.max(1, memory.total)) * 100, 1) : null,
      memUsedBytes: memory ? memory.used : null,
      memTotalBytes: memory ? memory.total : null,
      memSource: memory ? memory.source : null,
      // Oldest first, so the card draws left-to-right without reversing.
      history: history.slice(),
      historyStepMs: TICK_MS,
      at: now()
    };
  }

  return { tick, snapshot };
}

exports.activate = async ({ publish }) => {
  const sampler = createSampler();
  let timer = null;

  function start() {
    if (timer) return;
    sampler.tick();
    timer = setInterval(() => {
      try {
        sampler.tick();
        publish(sampler.snapshot());
      } catch {
        /* a failed tick keeps the previous published snapshot */
      }
    }, TICK_MS);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  // Sampling starts with activation, not with the first `call('snapshot')`:
  // the dock views only subscribe, so a backend that waited for a call would
  // never publish, and an idle utility process exits (code 0) once its event
  // loop drains. The ref'd interval is therefore also what keeps the process
  // alive; the host stops it explicitly through `dispose` on `stop`.
  start();

  return {
    async call(method) {
      if (method === 'snapshot') {
        start();
        return sampler.snapshot();
      }
      throw new Error('Unknown operation');
    },
    // The sampler keeps running while the plugin is enabled (background is a
    // confirmed first-use choice), so a re-shown dock has fresh rings instead
    // of a cold start.
    update() {},
    dispose() {
      stop();
    }
  };
};
