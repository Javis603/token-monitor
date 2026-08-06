'use strict';

const DEFAULT_DIAGNOSTIC_JOURNAL_CAPACITY = 20;
const MAX_EVENT_SCOPE_LENGTH = 64;

const VALID_SUBSYSTEMS = new Set([
  'agent',
  'client',
  'collector',
  'limits',
  'storage',
  'stream',
  'watcher'
]);

const VALID_CODES = new Set([
  'collector-recovered',
  'collector-tick-failed',
  'limits-retry-scheduled',
  'storage-archive-update-failed',
  'stream-disconnected',
  'stream-reconnected',
  'watcher-polling-fallback',
  'watcher-rebuild-failed'
]);

const VALID_DETAIL_CODES = new Set([
  'EMFILE',
  'ENFILE',
  'ENOSPC',
  'connection-refused',
  'connection-reset',
  'dns-failed',
  'eof',
  'http-error',
  'timeout',
  'unreachable',
  'unauthorized',
  'unknown'
]);

const VALID_SCOPES = new Set(['full', 'history', 'targeted', 'today', 'unknown']);
const VALID_MODES = new Set(['local', 'client', 'host', 'unknown']);

function clone(value) {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(clone);
  return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, clone(entry)]));
}

function isoTimestamp(value, fallbackNow) {
  const parsed = value instanceof Date ? value.getTime() : Date.parse(String(value || ''));
  const timestamp = Number.isFinite(parsed) ? parsed : fallbackNow();
  return new Date(timestamp).toISOString();
}

function boundedInteger(value, fallback = 0, max = Number.MAX_SAFE_INTEGER) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return fallback;
  return Math.max(0, Math.min(max, Math.round(numeric)));
}

function safeScope(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (VALID_SCOPES.has(normalized)) return normalized;
  return 'unknown';
}

function safeMode(value) {
  const normalized = String(value || '').trim().toLowerCase();
  return VALID_MODES.has(normalized) ? normalized : 'unknown';
}

function safeIdentifier(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (!normalized || normalized.length > MAX_EVENT_SCOPE_LENGTH) return null;
  if (!/^[a-z0-9][a-z0-9_-]*$/.test(normalized)) return null;
  return normalized;
}

function normalizeDiagnosticEvent(event = {}, now = Date.now) {
  const subsystem = String(event.subsystem || '').trim().toLowerCase();
  const code = String(event.code || '').trim().toLowerCase();
  if (!VALID_SUBSYSTEMS.has(subsystem) || !VALID_CODES.has(code)) return null;
  if (!code.startsWith(`${subsystem}-`)) return null;

  const normalized = {
    at: isoTimestamp(event.at, now),
    subsystem,
    code
  };
  const detailCode = String(event.detailCode || '').trim();
  if (VALID_DETAIL_CODES.has(detailCode)) normalized.detailCode = detailCode;
  const scope = safeScope(event.scope);
  if (scope !== 'unknown') normalized.scope = scope;
  const client = safeIdentifier(event.client);
  if (client) normalized.client = client;
  const provider = safeIdentifier(event.provider);
  if (provider) normalized.provider = provider;
  const modeAtEvent = safeMode(event.modeAtEvent);
  if (modeAtEvent !== 'unknown') normalized.modeAtEvent = modeAtEvent;
  if (event.durationMs !== undefined) {
    normalized.durationMs = boundedInteger(event.durationMs, 0, 24 * 60 * 60 * 1000);
  }
  return normalized;
}

function createDiagnosticJournal(options = {}) {
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const capacity = Math.max(
    1,
    Math.min(
      64,
      boundedInteger(options.capacity, DEFAULT_DIAGNOSTIC_JOURNAL_CAPACITY, 64)
    )
  );
  const startedAt = isoTimestamp(options.startedAt, now);
  const events = [];
  let omittedCount = 0;

  function record(event) {
    const normalized = normalizeDiagnosticEvent(event, now);
    if (!normalized) return false;
    events.push(normalized);
    if (events.length > capacity) {
      events.shift();
      omittedCount += 1;
    }
    return true;
  }

  function getSnapshot() {
    return {
      capacity,
      startedAt,
      omittedCount,
      events: clone(events)
    };
  }

  function clear() {
    events.length = 0;
    omittedCount = 0;
  }

  return { clear, getSnapshot, record };
}

module.exports = {
  DEFAULT_DIAGNOSTIC_JOURNAL_CAPACITY,
  createDiagnosticJournal,
  normalizeDiagnosticEvent
};
