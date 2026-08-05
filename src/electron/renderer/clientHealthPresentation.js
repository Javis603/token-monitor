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

  function healthFor(health, clientId) {
    const clients = health?.clients;
    if (!clients || typeof clients !== 'object') return null;
    return clients[normalizeId(clientId)] || null;
  }

  // The wire carries check *ids*; the directories behind them exist only on the
  // machine that probed them, so the renderer passes them in separately. Merged
  // rather than swapped, in both directions: a record can carry checks the local
  // probe knows nothing about (`wsl-home` lives in a filesystem reached through
  // wsl.exe, antigravity's two source checks are not watch roots), while the
  // probe can list several directories sharing one check id — which the record
  // collapses into a single boolean.
  function mergeSourceChecks(checks, sources) {
    const merged = sources.map((source) => ({
      id: String(source?.id || ''),
      dir: String(source?.dir || ''),
      exists: source?.exists === true
    })).filter((source) => source.id);
    const known = new Set(merged.map((source) => source.id));
    for (const check of checks) {
      if (known.has(check.id)) continue;
      merged.push({ id: check.id, dir: '', exists: check.exists === true });
    }
    return merged;
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
    const wireChecks = (Array.isArray(entry.source?.checks) ? entry.source.checks : [])
      .map((check) => ({ id: check.id, dir: '', exists: check.exists === true }));
    const checks = sources ? mergeSourceChecks(wireChecks, sources) : wireChecks;
    // Counts follow whatever the row actually lists, so the ratio and the chips
    // under it can never disagree. Only the record's own counts survive a device
    // with no local probe — a remote row in a synced fleet.
    const detectedCount = sources ? checks.filter((check) => check.exists).length : (entry.source?.detectedCount || 0);
    const checkedCount = sources ? checks.length : (entry.source?.checkedCount || 0);
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
    hasClientHealth
  };
});
