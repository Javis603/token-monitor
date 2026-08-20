'use strict';

// Turns one client's health record into the groups its expanded panel shows.
// It returns raw values and i18n keys; formatting and DOM stay in app.js.
(function exposeClientHealthPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientHealthPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createClientHealthPresentationApi() {
  const SUMMARY_OVERALLS = ['healthy', 'waiting', 'attention', 'unavailable'];
  const OVERALL_TONES = {
    healthy: 'ok', waiting: 'neutral', attention: 'warn', unavailable: 'muted', unknown: 'muted'
  };
  const DIAGNOSTIC_TONES = {
    'source-missing': 'muted',
    'no-usage-observed': 'muted',
    'wsl-detected-no-data': 'neutral',
    'sync-failed': 'warn',
    'sync-timeout': 'warn',
    'sync-spawn-failed': 'warn',
    'sync-exit-error': 'warn'
  };
  const DIAGNOSTIC_GROUPS = {
    'source-missing': 'source',
    'sync-failed': 'collection',
    'sync-timeout': 'collection',
    'sync-spawn-failed': 'collection',
    'sync-exit-error': 'collection',
    'no-usage-observed': 'data',
    'wsl-detected-no-data': 'data'
  };
  const QUIET_WHEN_UNAVAILABLE = new Set(['source-missing', 'no-usage-observed']);

  function normalizeId(value) {
    return String(value || '').trim().toLowerCase();
  }

  function exactDevice(stats, deviceId) {
    const id = String(deviceId || '');
    if (!id) return null;
    const devices = Array.isArray(stats?.devices) ? stats.devices : [];
    return devices.find((device) => device?.deviceId === id) || null;
  }

  function clientPeriodUsage(device, clientId) {
    const usage = {};
    for (const period of ['today', 'month', 'allTime']) {
      const values = device?.periods?.[period] || device?.[period];
      usage[period] = {
        tokens: Number(values?.clients?.[clientId] || 0),
        cost: Number(values?.clientCosts?.[clientId] || 0)
      };
    }
    return usage;
  }

  function friendlyPath(dir, home, platform = '') {
    const candidate = String(dir || '');
    const rawHome = String(home || '');
    const windows = platform === 'win32';
    const isRoot = windows ? /^[A-Za-z]:[\\/]$/.test(rawHome) : rawHome === '/';
    const root = isRoot ? rawHome : rawHome.replace(/[\\/]+$/, '');
    if (!candidate || !root) return candidate;
    const comparedCandidate = windows ? candidate.toLowerCase() : candidate;
    const comparedRoot = windows ? root.toLowerCase() : root;
    if (comparedCandidate === comparedRoot) return '~';
    if (!comparedCandidate.startsWith(comparedRoot)) return candidate;
    if (isRoot) return `~${candidate.slice(root.length - 1)}`;
    const boundary = candidate.charAt(root.length);
    return boundary === '/' || boundary === '\\' ? `~${candidate.slice(root.length)}` : candidate;
  }

  function healthFor(health, clientId) {
    const clients = health?.clients;
    if (!clients || typeof clients !== 'object') return null;
    return clients[normalizeId(clientId)] || null;
  }

  // The three visible counts are useful only when they partition every tracked
  // tool. `waiting` and `attention` share a compact "needs review" bucket: the
  // detail panel still distinguishes a quiet tool from a failed collection.
  // Missing or unknown entries fall back to the settings summary instead of
  // silently making the total smaller.
  function clientHealthCountsForTracked(health, trackedClientIds) {
    if (!health?.clients || typeof health.clients !== 'object') return null;
    const tracked = new Set([...trackedClientIds].map(normalizeId).filter(Boolean));
    const counts = Object.fromEntries(SUMMARY_OVERALLS.map((overall) => [overall, 0]));
    for (const clientId of tracked) {
      const overall = String(healthFor(health, clientId)?.overall || '');
      if (!SUMMARY_OVERALLS.includes(overall)) return null;
      counts[overall] += 1;
    }
    return {
      healthy: counts.healthy,
      review: counts.waiting + counts.attention,
      unavailable: counts.unavailable
    };
  }

  // Local paths explain canonical logical checks; they never change their state
  // or denominator. Pathless evidence such as wsl-home survives the merge.
  function mergeSourceChecks(checks, sources) {
    const groups = new Map();
    const canonicalIds = new Set();
    for (const check of checks) {
      const id = String(check?.id || '');
      if (!id || groups.has(id)) continue;
      canonicalIds.add(id);
      groups.set(id, { id, exists: check?.exists === true, paths: [] });
    }
    for (const source of sources) {
      const id = String(source?.id || '');
      const dir = String(source?.dir || '');
      if (!id) continue;
      const exists = source?.exists === true;
      const pending = source?.pending === true;
      if (!groups.has(id)) groups.set(id, { id, exists, paths: [] });
      else if (!canonicalIds.has(id)) groups.get(id).exists ||= exists;
      if (dir) groups.get(id).paths.push({ dir, exists, pending });
    }
    return [...groups.values()];
  }

  function clientHealthGroups(entry, options = {}) {
    if (!entry) return [];
    const usage = options.usage;
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const wireChecks = Array.isArray(entry.source?.checks) ? entry.source.checks : [];
    return [
      {
        id: 'source',
        key: 'settings.tools.health.source',
        state: String(entry.source?.state || 'unknown'),
        detectedCount: Number(entry.source?.detectedCount || 0),
        checkedCount: Number(entry.source?.checkedCount || 0),
        checks: mergeSourceChecks(wireChecks, sources)
      },
      {
        id: 'collection',
        key: 'settings.tools.health.sync',
        state: String(entry.collection?.state || 'unknown'),
        lastAttemptAt: entry.collection?.lastAttemptAt || '',
        lastSuccessAt: entry.collection?.lastSuccessAt || ''
      },
      {
        id: 'data',
        key: 'settings.tools.health.usage',
        periods: usage ? ['today', 'month', 'allTime'].map((period) => ({
          period,
          tokens: Number(usage[period]?.tokens || 0),
          cost: Number(usage[period]?.cost || 0)
        })) : null,
        tokens: Number(entry.data?.liveTokens || 0),
        lastActivityDay: entry.data?.lastActivityDay || ''
      }
    ];
  }

  function clientHealthNotes(entry) {
    if (!entry) return [];
    const diagnostics = Array.isArray(entry.diagnostics) ? entry.diagnostics : [];
    const quiet = entry.overall === 'unavailable';
    const notes = [];
    for (const diagnostic of diagnostics) {
      const code = String(diagnostic?.code || '');
      if (!DIAGNOSTIC_TONES[code]) continue;
      if (quiet && QUIET_WHEN_UNAVAILABLE.has(code)) continue;
      notes.push({ code, group: DIAGNOSTIC_GROUPS[code], tone: DIAGNOSTIC_TONES[code] });
    }
    return notes;
  }

  function clientHealthDetailFromEntry(entry, options = {}) {
    if (!entry) return null;
    const overall = String(entry.overall || 'unknown');
    return {
      overall,
      tone: OVERALL_TONES[overall] || 'muted',
      groups: clientHealthGroups(entry, options),
      notes: clientHealthNotes(entry)
    };
  }

  function clientHealthDetail(health, clientId, options = {}) {
    return clientHealthDetailFromEntry(healthFor(health, clientId), options);
  }

  // Tools without a health entry have no collector snapshot yet. They can
  // still expose their local source roots on demand, so the disclosure can
  // show useful context without pretending that the tool is being collected.
  function clientHealthPlaceholderDetail(options = {}) {
    const sources = Array.isArray(options.sources) ? options.sources : [];
    const checks = new Map();
    for (const source of sources) {
      const id = String(source?.id || '').trim();
      if (!id) continue;
      const current = checks.get(id);
      if (current) current.exists ||= source.exists === true;
      else checks.set(id, { id, exists: source.exists === true });
    }
    const sourceChecks = [...checks.values()];
    const detectedCount = sourceChecks.filter((check) => check.exists).length;
    const entry = {
      source: {
        state: sourceChecks.length === 0 ? 'unknown' : detectedCount > 0 ? 'detected' : 'missing',
        detectedCount,
        checkedCount: sourceChecks.length,
        ...(sourceChecks.length > 0 ? { checks: sourceChecks } : {})
      },
      collection: { state: options.collectionState || 'notTracked' },
      data: { liveTokens: 0 },
      overall: 'unknown'
    };
    return clientHealthDetailFromEntry(entry, options);
  }

  function hasClientHealth(health, clientId) {
    return Boolean(healthFor(health, clientId));
  }

  return {
    DIAGNOSTIC_TONES,
    OVERALL_TONES,
    clientHealthCountsForTracked,
    clientHealthDetail,
    clientHealthPlaceholderDetail,
    clientHealthGroups,
    clientHealthNotes,
    clientPeriodUsage,
    exactDevice,
    friendlyPath,
    hasClientHealth
  };
});
