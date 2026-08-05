'use strict';

// Turns one client's health record into the rows its expanded panel shows.
//
// Kept apart from the DOM because the decisions here are the ones worth testing:
// which rows appear at all, and — more importantly — which ones stay quiet. The
// list shows every tracked tool, and on a normal machine most of them are simply
// not installed. A panel that reports "no source found" as a fault twenty times
// over teaches the user to ignore it, which costs exactly the signal the whole
// feature exists to deliver.
//
// Nothing here formats a date or reads a translation: it returns i18n keys and
// raw values, and the renderer owns both. That is also where severity lives —
// the same diagnostic code means different things on different clients, so it is
// deliberately not on the wire.

(function exposeClientHealthPresentation(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorClientHealthPresentation = api;
})(typeof window !== 'undefined' ? window : null, function createClientHealthPresentationApi() {
  const OVERALL_TONES = {
    healthy: 'ok',
    waiting: 'neutral',
    attention: 'warn',
    unavailable: 'muted',
    unknown: 'muted'
  };

  // How loud a diagnostic is. This is the judgement that cannot live on the
  // wire: `source-missing` on a tool the user never installed is the expected
  // answer, while a failed sync on a tool they use every day is not.
  const DIAGNOSTIC_TONES = {
    'source-missing': 'muted',
    'no-usage-observed': 'muted',
    'wsl-detected-no-data': 'neutral',
    'sync-failed': 'warn',
    'sync-timeout': 'warn',
    'sync-spawn-failed': 'warn',
    'sync-exit-error': 'warn'
  };

  // A client with no source on disk is not broken, it is absent. Saying so once,
  // in the headline, is the whole message — repeating it as a diagnostic line
  // underneath is the noise that would make twenty uninstalled tools shout.
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

  // Canonical checks and counts come from the device record. Local filesystem
  // paths only explain where those logical checks looked; several alternative
  // paths with one id remain one check, and pathless evidence such as wsl-home is
  // retained rather than being replaced by this machine's host roots.
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
      if (!groups.has(id)) groups.set(id, { id, exists, paths: [] });
      else if (!canonicalIds.has(id)) groups.get(id).exists ||= exists;
      if (dir) groups.get(id).paths.push({ dir, exists });
    }
    return [...groups.values()];
  }

  // The rows of the expanded panel, in the order they read best: what we found,
  // how it is fetched, when it last had data, how much. Each row is
  // `{ key, kind, … }` — the renderer maps `key` to a label and `kind` to how the
  // value is drawn.
  function clientHealthRows(entry, options = {}) {
    if (!entry) return [];
    const usage = options.usage;
    const sources = Array.isArray(options.sources) ? options.sources : null;
    const rows = [];
    // First, and always. This is the row that answers the question people
    // actually ask — "why is today zero when this month has tokens?" — and it
    // needs nothing the app was not already holding. Everything below only
    // explains what this row shows.
    if (usage) {
      rows.push({
        key: 'settings.tools.health.usage',
        kind: 'usage',
        periods: ['today', 'month', 'allTime'].map((period) => ({
          period,
          tokens: Number(usage[period]?.tokens || 0),
          cost: Number(usage[period]?.cost || 0)
        }))
      });
    }
    const wireChecks = Array.isArray(entry.source?.checks) ? entry.source.checks : [];
    const checks = mergeSourceChecks(wireChecks, sources || []);
    const detectedCount = Number(entry.source?.detectedCount || 0);
    const checkedCount = Number(entry.source?.checkedCount || 0);
    // A bare ratio with no checks behind it asks a question it cannot answer:
    // "2 of 3 found" reads as a problem, and the one that is missing has no
    // name. On this machine the paths themselves are the answer, so the row
    // always shows. Without them — another device's row — checks arrive only for
    // a client that is not healthy, which is the same client the ratio is worth
    // showing for; a healthy partial reads as alternative roots doing their job
    // and drops the row rather than leaving it hanging.
    if (checks.length > 0 || detectedCount === 0) {
      rows.push({
        key: 'settings.tools.health.source',
        kind: 'sources',
        detectedCount,
        checkedCount,
        checks
      });
    }
    // `direct` is the overwhelming majority — tokscale reads the client's own
    // files and there is no fetch step to report on. Showing "collection: direct"
    // on eighteen of twenty rows would be a column of noise.
    if (entry.collection?.state && entry.collection.state !== 'direct') {
      rows.push({
        key: 'settings.tools.health.sync',
        kind: 'sync',
        state: entry.collection.state,
        lastAttemptAt: entry.collection.lastAttemptAt || '',
        lastSuccessAt: entry.collection.lastSuccessAt || ''
      });
    }
    if (entry.data?.lastActivityDay) {
      rows.push({ key: 'settings.tools.health.lastActivity', kind: 'day', day: entry.data.lastActivityDay });
    }
    // Only without the usage row, which already carries the all-time figure and
    // two more besides.
    if (!usage) rows.push({ key: 'settings.tools.health.tokens', kind: 'tokens', tokens: entry.data?.liveTokens || 0 });
    return rows;
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
      notes.push({ code, tone: DIAGNOSTIC_TONES[code] });
    }
    return notes;
  }

  // The whole panel for one client, or null when there is nothing to show — an
  // untracked client, or a device whose agent is too old to send health at all.
  function clientHealthDetail(health, clientId, options = {}) {
    const entry = healthFor(health, clientId);
    if (!entry) return null;
    const overall = String(entry.overall || 'unknown');
    return {
      overall,
      tone: OVERALL_TONES[overall] || 'muted',
      rows: clientHealthRows(entry, options),
      notes: clientHealthNotes(entry)
    };
  }

  // Whether a row is worth a disclosure control at all. A device that never sent
  // health gets no chevron rather than one that opens onto nothing.
  function hasClientHealth(health, clientId) {
    return Boolean(healthFor(health, clientId));
  }

  return {
    DIAGNOSTIC_TONES,
    OVERALL_TONES,
    clientHealthDetail,
    clientHealthNotes,
    clientHealthRows,
    clientPeriodUsage,
    exactDevice,
    friendlyPath,
    hasClientHealth
  };
});
