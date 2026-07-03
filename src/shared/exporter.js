'use strict';

// Pure serialization for the data-export feature. NO fs, NO electron — so it is
// node:test-able and its signatures physically exclude devices/limits (privacy).

const BOM = '﻿';
const PERIODS = ['today', 'month', 'allTime'];
const SNAPSHOT_COLUMNS = ['period', 'dimension', 'name', 'tokens', 'cost_usd'];
const DAILY_COLUMNS = ['date', 'tool', 'tokens', 'cost_usd'];
// The complete set of generated filenames — the single source of truth the
// writer uses to clean up orphans (e.g. a stale daily.csv once history empties).
const EXPORT_FILENAMES = ['token-monitor-export.json', 'token-monitor-snapshot.csv', 'token-monitor-daily.csv'];

function num(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function csvEscape(value) {
  const s = value === null || value === undefined ? '' : String(value);
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// RFC 4180: CRLF line endings, header row, optional leading UTF-8 BOM (for Excel).
function toCsv(rows, columns, options = {}) {
  const bom = options.bom !== false;
  const header = columns.map(csvEscape).join(',');
  const body = rows.map((row) => columns.map((col) => csvEscape(row[col])).join(','));
  return (bom ? BOM : '') + [header, ...body].join('\r\n') + '\r\n';
}

function buildSnapshotRows(periods) {
  const src = periods && typeof periods === 'object' ? periods : {};
  const rows = [];
  for (const period of PERIODS) {
    const p = src[period];
    if (!p || typeof p !== 'object') continue;
    const clients = p.clients || {};
    const clientCosts = p.clientCosts || {};
    for (const name of Object.keys(clients)) {
      rows.push({ period, dimension: 'tool', name, tokens: num(clients[name]), cost_usd: num(clientCosts[name]) });
    }
    const models = p.models || {};
    const modelCosts = p.modelCosts || {};
    for (const name of Object.keys(models)) {
      rows.push({ period, dimension: 'model', name, tokens: num(models[name]), cost_usd: num(modelCosts[name]) });
    }
  }
  return rows;
}

function buildDailyRows(history) {
  const daily = history && Array.isArray(history.daily) ? history.daily : [];
  const rows = [];
  for (const day of daily) {
    const date = String(day.date || '').slice(0, 10);
    if (!date) continue;
    const perClient = day.perClient && typeof day.perClient === 'object' ? day.perClient : {};
    for (const tool of Object.keys(perClient)) {
      const v = perClient[tool] || {};
      rows.push({ date, tool, tokens: num(v.tokens), cost_usd: num(v.cost) });
    }
  }
  return rows;
}

function periodSnapshot(periods, key) {
  const p = periods && typeof periods === 'object' ? periods[key] : null;
  // Lossless: a whole period is usage data (cache/output/session breakdowns
  // included) — pass it through untouched to honor the "lossless JSON" contract.
  // The privacy boundary is the function signature: devices/limits are siblings
  // of `periods` in the aggregate and never reach this module.
  return p && typeof p === 'object' ? p : {};
}

function renderSnapshotCsv(periods) {
  return toCsv(buildSnapshotRows(periods), SNAPSHOT_COLUMNS);
}

function renderTimeseriesCsv(history) {
  return toCsv(buildDailyRows(history), DAILY_COLUMNS);
}

function renderExportJson({ periods, history, meta } = {}) {
  const h = history && typeof history === 'object' ? history : {};
  const payload = {
    generatedAt: (meta && meta.generatedAt) || new Date().toISOString(),
    app: (meta && meta.app) || { name: 'token-monitor' },
    snapshot: {
      today: periodSnapshot(periods, 'today'),
      month: periodSnapshot(periods, 'month'),
      allTime: periodSnapshot(periods, 'allTime')
    },
    daily: Array.isArray(h.daily) ? h.daily : [],
    monthly: Array.isArray(h.monthly) ? h.monthly : []
  };
  return `${JSON.stringify(payload, null, 2)}\n`;
}

// Deterministic serialization (sorted keys) so equal data yields an equal string
// regardless of key insertion order.
function stableStringify(value) {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`;
  }
  return JSON.stringify(value === undefined ? null : value);
}

// A signature of the *meaningful* export payload (snapshot + history), excluding
// the volatile `generatedAt`/version in the rendered files. Callers compare it to
// the last written signature to skip re-writing unchanged data into a synced folder.
function exportSignature(periods, history) {
  const h = history && typeof history === 'object' ? history : {};
  return stableStringify({
    snapshot: {
      today: periodSnapshot(periods, 'today'),
      month: periodSnapshot(periods, 'month'),
      allTime: periodSnapshot(periods, 'allTime')
    },
    daily: Array.isArray(h.daily) ? h.daily : [],
    monthly: Array.isArray(h.monthly) ? h.monthly : []
  });
}

function exportFileSet({ periods, history, meta } = {}) {
  const [jsonName, snapshotName, dailyName] = EXPORT_FILENAMES;
  const files = [
    { name: jsonName, contents: renderExportJson({ periods, history, meta }) },
    { name: snapshotName, contents: renderSnapshotCsv(periods) }
  ];
  const dailyRows = buildDailyRows(history);
  if (dailyRows.length > 0) {
    files.push({ name: dailyName, contents: toCsv(dailyRows, DAILY_COLUMNS) });
  }
  return files;
}

module.exports = {
  csvEscape, toCsv, buildSnapshotRows, buildDailyRows,
  renderSnapshotCsv, renderTimeseriesCsv, renderExportJson, exportFileSet, exportSignature,
  EXPORT_FILENAMES
};
