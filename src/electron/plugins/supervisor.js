'use strict';

// Fault and resource policy for sandboxed plugin processes. Pure decisions,
// so the restart ladder, circuit breaker and budgets are testable without
// Electron; the sandbox applies them.

const DEFAULT_BUDGETS = Object.freeze({
  // Average CPU of one plugin process over the sampling window, in percent of
  // one core (Chromium's percentCPUUsage). A dashboard tick should be far below.
  cpuPercent: 25,
  cpuWindow: 3,
  memoryMB: 256,
  heartbeatMs: 10_000,
  // Restart ladder after an unexpected exit, then the circuit opens.
  backoffMs: Object.freeze([1_000, 5_000, 30_000]),
  failureWindowMs: 5 * 60 * 1000,
  maxFailures: 3
});

function createSupervisor({ now = () => Date.now(), budgets = DEFAULT_BUDGETS } = {}) {
  const records = new Map();

  function recordFor(id) {
    let record = records.get(id);
    if (!record) {
      record = { failures: [], cpu: [], lastHeartbeat: 0, open: false, lastReason: '' };
      records.set(id, record);
    }
    return record;
  }

  return {
    budgets,
    started(id) {
      const record = recordFor(id);
      record.cpu = [];
      record.lastHeartbeat = now();
    },
    heartbeat(id) {
      recordFor(id).lastHeartbeat = now();
    },
    // Ids whose host page stopped reporting; the sandbox kills them.
    staleHeartbeats(runningIds) {
      const cutoff = now() - budgets.heartbeatMs;
      return runningIds.filter((id) => (records.get(id)?.lastHeartbeat || 0) < cutoff);
    },
    // { cpuPercent, memoryMB } from app.getAppMetrics(). Returns a kill reason
    // when a budget is exceeded: memory immediately, CPU when sustained.
    checkMetrics(id, { cpuPercent = 0, memoryMB = 0 } = {}) {
      const record = recordFor(id);
      if (memoryMB > budgets.memoryMB) return 'over-memory-budget';
      record.cpu.push(cpuPercent);
      if (record.cpu.length > budgets.cpuWindow) record.cpu.shift();
      const average = record.cpu.reduce((sum, value) => sum + value, 0) / record.cpu.length;
      if (record.cpu.length >= budgets.cpuWindow && average > budgets.cpuPercent) return 'over-cpu-budget';
      return '';
    },
    // An unexpected exit (crash, hang, budget kill). Returns what to do next.
    exited(id, reason) {
      const record = recordFor(id);
      const at = now();
      record.lastReason = reason;
      record.failures = record.failures.filter((time) => at - time < budgets.failureWindowMs);
      record.failures.push(at);
      if (record.failures.length > budgets.maxFailures) {
        record.open = true;
        return { action: 'disable', reason };
      }
      const delayMs = budgets.backoffMs[Math.min(record.failures.length - 1, budgets.backoffMs.length - 1)];
      return { action: 'restart', delayMs, reason };
    },
    isOpen(id) {
      return records.get(id)?.open === true;
    },
    // The user re-enabling a plugin closes its circuit and clears history.
    reset(id) {
      records.delete(id);
    },
    failures(id) {
      return records.get(id)?.failures.length || 0;
    },
    lastReason(id) {
      return records.get(id)?.lastReason || '';
    }
  };
}

// Token bucket: `capacity` burst, refilled at `perSecond`.
function createRateLimiter({ capacity, perSecond, now = () => Date.now() }) {
  let tokens = capacity;
  let updatedAt = now();
  return {
    take(cost = 1) {
      const at = now();
      tokens = Math.min(capacity, tokens + ((at - updatedAt) / 1000) * perSecond);
      updatedAt = at;
      if (tokens < cost) return false;
      tokens -= cost;
      return true;
    }
  };
}

module.exports = { DEFAULT_BUDGETS, createRateLimiter, createSupervisor };
