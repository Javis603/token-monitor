'use strict';

// Per-client diagnostics: why a tracked tool shows the number it shows.
//
// `clientStatus` answers "is this client active / waiting / missing" in three
// words, which is enough for a dot in the settings list and not enough for the
// question users actually ask — "why is today 0 when this month has tokens?".
// Answering that needs the signals the collector already computes and then
// throws away: which of a client's source roots exist, whether its self-sync
// last worked, and the most recent day any usage was recorded for it.
//
// Three rules shape the wire form:
//
//   * No paths, no stderr. A source root is identified by a stable id from
//     CLIENT_SOURCE_CHECK_IDS; the absolute path contains the user's home dir
//     and stays in the process that probed it. A failed subprocess reports a
//     code, never its output.
//   * Every tracked client sends the same fixed core, so the hub can recompute
//     `overall` and reject a producer that disagrees with its own inputs.
//     Detail beyond that core is sparse — a healthy client sends none of it.
//   * Everything is a closed enum. The hub downgrades a value it does not
//     recognise rather than storing it, so an older hub in front of a newer
//     agent degrades to `unknown` instead of passing junk through to renderers.
//
// Node-builtin-free: this module is vendored into worker/src/shared/ by
// `npm run sync:worker`.

const CLIENT_HEALTH_VERSION = 1;

// healthy      — usage was observed for this client
// waiting      — its sources are present but nothing has been counted yet
// attention    — something we do on the user's behalf is failing (a self-sync)
// unavailable  — no source root on disk; nothing to read
// unknown      — the producer could not tell, or sent a value this build
//                does not recognise
const CLIENT_HEALTH_OVERALL_STATES = Object.freeze([
  'healthy', 'waiting', 'attention', 'unavailable', 'unknown'
]);

const CLIENT_SOURCE_STATES = Object.freeze(['detected', 'missing', 'unknown']);

// `direct` is the common case: tokscale parses the client's own files and there
// is no fetch step to succeed or fail. Only the self-synced clients
// (cursor / antigravity) ever report the other four.
const CLIENT_COLLECTION_STATES = Object.freeze([
  'direct', 'idle', 'pending', 'ok', 'failed'
]);

// Stable ids for the source roots the collector probes. One id can stand for
// several paths of the same kind — Copilot's workspaceStorage has a variant per
// platform, Kiro's IDE globalStorage has four — because "the VS Code workspace
// storage is missing" is the useful statement, not which spelling was tried.
// clientSourceRoots() in collector.js is where they are assigned;
// tests/shared/clientHealth.test.js fails if the two lists drift apart.
const CLIENT_SOURCE_CHECK_IDS = Object.freeze([
  'antigravity-cli-data',
  'antigravity-ide-source',
  'claude-projects',
  'claude-transcripts',
  'cline-tasks',
  'codebuddy-extension-logs',
  'codebuddy-projects',
  'codex-sessions',
  'copilot-otel',
  'grok-sessions',
  'hermes-home',
  'hermes-profile',
  'kilocode-tasks',
  'kimi-code-sessions',
  'kimi-sessions',
  'kiro-cli-data',
  'kiro-ide-globalstorage',
  'kiro-sessions',
  'mimocode-data',
  'mimocode-orca-data',
  'omp-sessions',
  'opencode-data',
  'openclaw-agents',
  'pi-sessions',
  'proma-sessions',
  'qwen-projects',
  'tokscale-antigravity-cache',
  'tokscale-cursor-cache',
  'vscode-workspace-storage',
  'workbuddy-projects',
  'zcode-projects',
  'zed-threads'
]);

// Observations worth surfacing that the core three fields cannot state on their
// own. Sent only when they apply, capped, and closed: a renderer maps each to a
// translated sentence, so an unrecognised code has nothing to render.
const CLIENT_HEALTH_DIAGNOSTIC_CODES = Object.freeze([
  'source-missing',        // no source root found on disk
  'source-partial',        // some source roots found, others absent
  'sync-failed',           // self-sync failed for an unclassified reason
  'sync-timeout',          // self-sync was killed after its deadline
  'sync-spawn-failed',     // the self-sync subprocess could not be started
  'sync-exit-error',       // the self-sync subprocess exited non-zero
  'no-usage-observed',     // sources are present, all-time usage is zero
  'wsl-detected-no-data'   // a WSL marker was found but the scan returned nothing
]);

// Bounds. The record is per client per device and a hub keeps one per device, so
// every list here is capped rather than trusted — a malformed or hostile ingest
// must not be able to grow the stored document without limit.
const MAX_TRACKED_CLIENTS = 64;
const MAX_CHECKS_PER_CLIENT = 12;
const MAX_DIAGNOSTICS_PER_CLIENT = 4;
const MAX_TIMESTAMP_LENGTH = 32;

const OVERALL_SET = new Set(CLIENT_HEALTH_OVERALL_STATES);
const SOURCE_STATE_SET = new Set(CLIENT_SOURCE_STATES);
const COLLECTION_STATE_SET = new Set(CLIENT_COLLECTION_STATES);
const CHECK_ID_SET = new Set(CLIENT_SOURCE_CHECK_IDS);
const DIAGNOSTIC_CODE_SET = new Set(CLIENT_HEALTH_DIAGNOSTIC_CODES);

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function defaultClientId(value) {
  return String(value || '').trim().toLowerCase();
}

function boundedCount(value) {
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed <= 0) return 0;
  return Math.min(Math.floor(parsed), MAX_CHECKS_PER_CLIENT);
}

function boundedTokens(value) {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

function normalizeTimestamp(value) {
  const raw = String(value || '').trim().slice(0, MAX_TIMESTAMP_LENGTH);
  if (!raw) return '';
  const parsed = Date.parse(raw);
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : '';
}

function normalizeDay(value) {
  const raw = String(value || '').trim().slice(0, 10);
  return DAY_PATTERN.test(raw) ? raw : '';
}

// The one place `overall` is decided. The hub recomputes it from the core rather
// than storing what the producer claimed, so a mismatch between a client's
// inputs and its headline can only ever be a bug in this function.
//
// Order matters. A failing self-sync outranks a missing source because the two
// only coincide for a client whose sources exist (a sync is never attempted
// otherwise), so reaching that branch means there is something actionable to
// report. Usage is checked last: a client can have tokens from an earlier scan
// and still be broken right now.
function deriveClientOverall(health) {
  const sourceState = health?.source?.state;
  const collectionState = health?.collection?.state;
  if (!SOURCE_STATE_SET.has(sourceState) || sourceState === 'unknown') return 'unknown';
  if (collectionState === 'failed') return 'attention';
  if (sourceState === 'missing') return 'unavailable';
  if (boundedTokens(health?.data?.liveTokens) > 0) return 'healthy';
  return 'waiting';
}

// The legacy three-state view, for a consumer holding a health record but no
// `clientStatus`. Derived from the same two signals statusFromSignals() reads in
// the collector rather than from `overall`, because the collapse is lossy in the
// other direction: a client whose sync is failing but whose earlier tokens still
// count reads `attention` here and `active` there, and both are correct.
function deriveLegacyClientStatus(health) {
  if (boundedTokens(health?.data?.liveTokens) > 0) return 'active';
  return health?.source?.state === 'detected' ? 'waiting' : 'missing';
}

function normalizeChecks(value) {
  if (!Array.isArray(value)) return [];
  const checks = [];
  const seen = new Set();
  for (const entry of value) {
    if (checks.length >= MAX_CHECKS_PER_CLIENT) break;
    const id = String(entry?.id || '').trim();
    if (!CHECK_ID_SET.has(id) || seen.has(id)) continue;
    seen.add(id);
    checks.push({ id, exists: entry?.exists === true });
  }
  return checks;
}

function normalizeDiagnostics(value) {
  if (!Array.isArray(value)) return [];
  const codes = [];
  for (const entry of value) {
    if (codes.length >= MAX_DIAGNOSTICS_PER_CLIENT) break;
    const code = String(entry || '').trim();
    if (!DIAGNOSTIC_CODE_SET.has(code) || codes.includes(code)) continue;
    codes.push(code);
  }
  return codes;
}

// One client's record: the fixed core always, detail only where it was sent.
function normalizeClientHealthEntry(value) {
  const sourceState = String(value?.source?.state || '').trim();
  const collectionState = String(value?.collection?.state || '').trim();
  const entry = {
    source: {
      state: SOURCE_STATE_SET.has(sourceState) ? sourceState : 'unknown',
      detectedCount: boundedCount(value?.source?.detectedCount),
      checkedCount: boundedCount(value?.source?.checkedCount)
    },
    collection: {
      state: COLLECTION_STATE_SET.has(collectionState) ? collectionState : 'direct'
    },
    data: {
      liveTokens: boundedTokens(value?.data?.liveTokens)
    }
  };
  const checks = normalizeChecks(value?.source?.checks);
  if (checks.length > 0) entry.source.checks = checks;
  const lastAttemptAt = normalizeTimestamp(value?.collection?.lastAttemptAt);
  if (lastAttemptAt) entry.collection.lastAttemptAt = lastAttemptAt;
  const lastSuccessAt = normalizeTimestamp(value?.collection?.lastSuccessAt);
  if (lastSuccessAt) entry.collection.lastSuccessAt = lastSuccessAt;
  const lastActivityDay = normalizeDay(value?.data?.lastActivityDay);
  if (lastActivityDay) entry.data.lastActivityDay = lastActivityDay;
  const diagnostics = normalizeDiagnostics(value?.diagnostics);
  if (diagnostics.length > 0) entry.diagnostics = diagnostics;
  // Recomputed, never copied — see deriveClientOverall.
  entry.overall = deriveClientOverall(entry);
  return entry;
}

// Validates an inbound `clientHealth` field. Returns null for anything that is
// not a usable document, so a caller can leave the field off the record entirely
// rather than store an empty shell.
//
// `normalizeClientId` is injected because the canonical client-name normalizer
// lives in usage.js, which imports this module; taking it as an argument keeps
// the dependency pointing one way.
function normalizeClientHealth(value, normalizeClientId = defaultClientId) {
  if (!value || typeof value !== 'object') return null;
  const source = value.clients && typeof value.clients === 'object' ? value.clients : null;
  if (!source) return null;
  const clients = {};
  let count = 0;
  for (const [rawId, entry] of Object.entries(source)) {
    if (count >= MAX_TRACKED_CLIENTS) break;
    const id = normalizeClientId(rawId);
    if (!id || Object.prototype.hasOwnProperty.call(clients, id)) continue;
    if (!entry || typeof entry !== 'object') continue;
    clients[id] = normalizeClientHealthEntry(entry);
    count += 1;
  }
  if (count === 0) return null;
  return { version: CLIENT_HEALTH_VERSION, clients };
}

// Tally by headline state, for a one-line summary above the list.
function countOverall(health) {
  const counts = {};
  for (const state of CLIENT_HEALTH_OVERALL_STATES) counts[state] = 0;
  for (const entry of Object.values(health?.clients || {})) {
    const state = OVERALL_SET.has(entry?.overall) ? entry.overall : 'unknown';
    counts[state] += 1;
  }
  return counts;
}

module.exports = {
  CLIENT_HEALTH_DIAGNOSTIC_CODES,
  CLIENT_HEALTH_OVERALL_STATES,
  CLIENT_HEALTH_VERSION,
  CLIENT_COLLECTION_STATES,
  CLIENT_SOURCE_CHECK_IDS,
  CLIENT_SOURCE_STATES,
  MAX_CHECKS_PER_CLIENT,
  MAX_DIAGNOSTICS_PER_CLIENT,
  MAX_TRACKED_CLIENTS,
  countOverall,
  deriveClientOverall,
  deriveLegacyClientStatus,
  normalizeClientHealth
};
