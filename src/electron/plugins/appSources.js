'use strict';

// Token Monitor's own readings as Data Bus sources. Plugins see aggregates
// only: period totals, the live rate, the tightest quota window per provider
// and running-session counts. Account identity, session titles, devices and
// raw records never enter the bus, whatever a plugin is granted.

const LIMITS_PER_PROVIDER = 1;

function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function periodSource(period) {
  if (!period) return null;
  return {
    tokens: finite(period.totalTokens) ?? 0,
    cost: finite(period.costUsd) ?? 0,
    unpricedTokens: finite(period.unpricedTokens) ?? 0
  };
}

// The tightest metered window of each provider, across its accounts.
function limitsSource(stats) {
  const byProvider = new Map();
  for (const record of stats?.limits?.providers || []) {
    const provider = String(record?.provider || '');
    if (!provider) continue;
    for (const window of record.windows || []) {
      const remaining = finite(window?.remainingPercent);
      if (remaining === null || window.showMeter === false) continue;
      const current = byProvider.get(provider);
      if (current && current.remainingPercent <= remaining) continue;
      byProvider.set(provider, {
        provider,
        window: String(window.label || window.kind || '').slice(0, 48),
        kind: String(window.kind || ''),
        remainingPercent: Math.round(remaining * 10) / 10,
        usedPercent: Math.round((100 - remaining) * 10) / 10,
        resetsAt: window.resetsAt || null
      });
    }
  }
  return [...byProvider.values()].sort((a, b) => a.remainingPercent - b.remainingPercent).slice(0, 32 * LIMITS_PER_PROVIDER);
}

// Publishes push sources on each stats publication and owns the pull sources
// that move with the clock (rate decay, sessions leaving the running window).
function createAppSources({ bus, tokenRateApi, presentation, getContext, now = Date.now }) {
  let latestStats = null;
  let rateTracker = null;
  let rateContext = '';

  function observeRate(stats) {
    const context = getContext();
    const selection = tokenRateApi.selectLiveTokenRatePeriods(stats, context.deviceId, context.hubMode, 'all');
    const key = [context.mode, context.hubMode, context.hubUrl, context.deviceId, selection.source].join('|');
    if (!rateTracker || key !== rateContext) {
      rateContext = key;
      rateTracker = tokenRateApi.createLiveTokenRateGroupTracker({ now });
      rateTracker.reset(selection.entries);
    } else {
      rateTracker.observe(selection.entries);
    }
  }

  bus.defineSource('tm.rate', {
    minIntervalMs: 1000,
    sample() {
      const sample = rateTracker?.getSample();
      if (!sample) return { speed: 0, burn: 0, idle: true };
      return { speed: finite(sample.speed) ?? 0, burn: finite(sample.burn) ?? 0, idle: sample.idle === true };
    }
  });

  bus.defineSource('tm.sessions', {
    minIntervalMs: 1000,
    sample() {
      if (!latestStats) return undefined;
      const rows = presentation.recentSessionRows(latestStats, 8, { includeRunningBeyondCap: true });
      const running = presentation.runningSessionSummary(rows, now());
      const waiting = presentation.waitingSessionSummary(rows, now());
      return { running: running.count, waiting: waiting.count, clients: running.clients.slice(0, 16) };
    }
  });

  return {
    publish(stats) {
      if (!stats) return;
      latestStats = stats;
      try { observeRate(stats); } catch {}
      bus.publish('tm.today', periodSource(stats.periods?.today));
      bus.publish('tm.month', periodSource(stats.periods?.month));
      bus.publish('tm.limits', limitsSource(stats));
    }
  };
}

module.exports = { createAppSources, limitsSource, periodSource };
