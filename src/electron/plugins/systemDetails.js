'use strict';
const os = require('node:os');
const { readBounded } = require('./package');
const { createMemorySampler } = require('./systemMetrics');
const ok = value => ({ status: 'ok', value });
const unavailable = status => ({ status, value: null });
const unsupported = () => unavailable('unsupported');
function cpuSnapshot(cpus) {
  return cpus.map(cpu => ({ total: Object.values(cpu.times).reduce((a, b) => a + b, 0), idle: cpu.times.idle }));
}
function cpuDelta(before, after) {
  if (!before || before.length !== after.length) return null;
  const perCore = after.map((v, i) => { const total = v.total - before[i].total; return total > 0 ? Math.max(0, Math.min(100, (1 - (v.idle - before[i].idle) / total) * 100)) : null; });
  const total = after.reduce((sum, v, i) => sum + v.total - before[i].total, 0);
  const idle = after.reduce((sum, v, i) => sum + v.idle - before[i].idle, 0);
  return total > 0 ? { percent: Math.max(0, Math.min(100, (1 - idle / total) * 100)), perCore } : null;
}
function parseMeminfo(text) {
  const fields = Object.fromEntries(text.split('\n').map(line => /^(\w+):\s+(\d+) kB/.exec(line)).filter(Boolean).map(m => [m[1], Number(m[2]) * 1024]));
  return { available: fields.MemAvailable ?? null, cached: fields.Cached ?? null, swapUsed: Number.isFinite(fields.SwapTotal) && Number.isFinite(fields.SwapFree) ? fields.SwapTotal - fields.SwapFree : null, swapTotal: fields.SwapTotal ?? null };
}
function parseNetwork(text) {
  let received = 0, sent = 0, count = 0;
  for (const line of text.split('\n')) { const parts = line.trim().split(/[:\s]+/); if (parts.length < 17 || parts[0] === 'lo') continue; const rx = Number(parts[1]), tx = Number(parts[9]); if (!Number.isFinite(rx) || !Number.isFinite(tx)) continue; received += rx; sent += tx; count++; }
  return count ? { received, sent } : null;
}
function parseDisk(text) {
  // Whole physical/block devices only: partition and virtual-layer counters
  // would double-count the same IO. No device paths or serials are exposed.
  let read = 0, written = 0, count = 0;
  for (const line of text.trim().split('\n')) { const p = line.trim().split(/\s+/); if (!/^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|mmcblk\d+)$/.test(p[2]) || p.length < 14) continue; read += Number(p[5]) * 512; written += Number(p[9]) * 512; count++; }
  return count && Number.isFinite(read + written) ? { read, written } : null;
}
function rate(previous, current, seconds) {
  if (!previous || !current || seconds <= 0) return unavailable('unavailable');
  const values = {};
  for (const key of Object.keys(current)) { if (current[key] < previous[key]) return unavailable('unavailable'); values[`${key}BytesPerSecond`] = (current[key] - previous[key]) / seconds; }
  return ok(values);
}
function createSystemSampler({ platform = process.platform, cpus = () => os.cpus(), memory = createMemorySampler({ detailed: true }), read = file => readBounded(file, 256 * 1024).toString('utf8'), powerMonitor, now = Date.now, detailedDemand = () => false, wanted = () => true } = {}) {
  let previous = null, previousIo = null;
  function reset() { previous = null; previousIo = null; }
  function sample() {
    const at = now();
    const current = wanted('cpu') ? cpuSnapshot(cpus()) : null;
    const cpu = current ? cpuDelta(previous, current) : null; previous = current;
    const mem = wanted('memory') ? memory() : null;
    const details = { version: 1, at, platform, cpu: cpu ? ok(cpu) : unavailable('unavailable'), memory: mem ? ok({ ...mem, pressure: unsupported(), swap: unsupported() }) : unavailable('unavailable'), network: unsupported(), disk: unsupported(), battery: unsupported(), gpu: unsupported(), temperature: unsupported() };
    if (detailedDemand()) {
      if (platform === 'linux') {
        if (mem) try { const fields = parseMeminfo(read('/proc/meminfo')); details.memory.value = { ...details.memory.value, available: fields.available, cached: fields.cached, swap: Number.isFinite(fields.swapTotal) ? ok({ used: fields.swapUsed, total: fields.swapTotal }) : unavailable('unavailable') }; } catch { details.memory.value.swap = unavailable('unavailable'); }
        let network = null, disk = null;
        if (wanted('network')) try { network = parseNetwork(read('/proc/net/dev')); } catch {}
        if (wanted('disk')) try { disk = parseDisk(read('/proc/diskstats')); } catch {}
        const seconds = previousIo ? (at - previousIo.at) / 1000 : 0;
        details.network = rate(previousIo?.network, network, seconds); details.disk = rate(previousIo?.disk, disk, seconds);
        previousIo = { at, network, disk };
      }
      if (wanted('battery') && (platform === 'darwin' || platform === 'win32')) {
        try { if (typeof powerMonitor?.isOnBatteryPower === 'function') details.battery = ok({ onBatteryPower: powerMonitor.isOnBatteryPower(), percent: null, secondsRemaining: null }); } catch { details.battery = unavailable('unavailable'); }
      }
    } else previousIo = null;
    return { cpu: cpu ? Math.round(cpu.percent * 10) / 10 : undefined, memory: mem, details };
  }
  return { sample, reset };
}
function registerSystemSources(bus, options = {}) {
  const demanded = source => bus.effectiveInterval(source) > 0;
  const wanted = family => demanded('sys.details') || demanded(`sys.${family}`) || demanded(`sys.${family}.details`);
  const sampler = createSystemSampler({ ...options, wanted, detailedDemand: () => ['sys.details', 'sys.memory.details', 'sys.network', 'sys.disk', 'sys.battery'].some(demanded) });
  bus.defineSource('sys.snapshot', { ...sampler, minIntervalMs: 1000 });
  bus.defineAlias('sys.cpu', 'sys.snapshot', value => value.cpu);
  bus.defineAlias('sys.memory', 'sys.snapshot', value => value.memory ? { used: value.memory.used, total: value.memory.total, percent: value.memory.percent } : undefined);
  bus.defineAlias('sys.details', 'sys.snapshot', value => value.details);
  for (const family of ['cpu', 'memory', 'network', 'disk', 'battery', 'gpu', 'temperature']) {
    const source = ['cpu', 'memory'].includes(family) ? `sys.${family}.details` : `sys.${family}`;
    bus.defineAlias(source, 'sys.snapshot', value => ({ version: 1, at: value.details.at, platform: value.details.platform, ...value.details[family] }));
  }
}
module.exports = { cpuSnapshot, cpuDelta, parseMeminfo, parseNetwork, parseDisk, rate, createSystemSampler, registerSystemSources };
