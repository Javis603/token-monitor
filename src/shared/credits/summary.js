'use strict';

// Wire block for per-tool credit ledgers (design spec §3.4/§6). The collector
// produces the raw ledger; this module shapes it into the bounded summary that
// travels on the device record, and normalizes whatever arrives at the hub so
// a hostile or buggy agent cannot bloat `devices.json`.

const MAX_RECENT_EVENTS = 200;
const MAX_MODEL_ENTRIES = 50;
const MAX_CALIBRATION_ENTRIES = 20;
const MAX_REASON_LENGTH = 200;
const CONFIDENCE_LEVELS = new Set(['exact', 'vendor', 'estimated']);

function clampNumber(value) {
  // Number(null)/Number('') are 0 and Number(true) is 1 — reject these up front
  // so they cannot masquerade as zero/one credit values.
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  if (!Number.isFinite(n)) return null;
  return Math.round(n * 1e6) / 1e6;
}

function normalizeEvent(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const credits = clampNumber(raw.credits);
  if (credits === null) return null;
  const event = { credits };
  if (raw.dedupKey != null) event.dedupKey = String(raw.dedupKey).slice(0, 128);
  if (raw.sessionId != null) event.sessionId = String(raw.sessionId).slice(0, 128);
  if (raw.model != null) event.model = String(raw.model).slice(0, 128);
  if (raw.requestHash != null) event.requestHash = String(raw.requestHash).slice(0, 128);
  if (raw.updatedAt != null && Number.isFinite(Number(raw.updatedAt))) {
    event.updatedAt = Number(raw.updatedAt);
  }
  return event;
}

function normalizeTotals(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const credits = clampNumber(raw.credits);
  if (credits === null) return null;
  const totals = { credits, requests: Math.max(0, Math.trunc(Number(raw.requests) || 0)) };
  // Today's spend is computed once at attach time over the *full* event list.
  // Deriving it from the 200-event window instead loses the start of a busy day
  // once the ledger outgrows the window — silently, with no error anywhere.
  const todayCredits = clampNumber(raw.todayCredits);
  if (todayCredits !== null && todayCredits >= 0) totals.todayCredits = todayCredits;
  if (raw.byModel && typeof raw.byModel === 'object') {
    const byModel = {};
    for (const [model, value] of Object.entries(raw.byModel).slice(0, MAX_MODEL_ENTRIES)) {
      const creditsForModel = clampNumber(value);
      if (creditsForModel === null) continue;
      byModel[String(model).slice(0, 128)] = creditsForModel;
    }
    totals.byModel = byModel;
  }
  return totals;
}

// Regression calibration rides the credits block (summary.js must stay
// self-contained: it is vendored into the Cloudflare worker closure, so it
// cannot import calibration.js). Unknown/malformed entries drop out rather
// than failing the whole block.
function normalizeCalibrationEntry(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const samples = Math.trunc(Number(raw.samples));
  if (!Number.isFinite(samples) || samples < 0) return null;
  const entry = {
    model: String(raw.model || 'unknown').slice(0, 128),
    samples
  };
  const creditsPerMTok = clampNumber(raw.creditsPerMTok);
  if (creditsPerMTok !== null && creditsPerMTok > 0) entry.creditsPerMTok = creditsPerMTok;
  const r2 = clampNumber(raw.r2);
  if (r2 !== null) entry.r2 = r2;
  if (raw.reason) entry.reason = String(raw.reason).slice(0, 64);
  return entry;
}

function normalizeCalibration(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const out = { profiles: [], pending: [] };
  for (const list of ['profiles', 'pending']) {
    if (!Array.isArray(raw[list])) continue;
    for (const candidate of raw[list].slice(0, MAX_CALIBRATION_ENTRIES)) {
      const entry = normalizeCalibrationEntry(candidate);
      if (entry) out[list].push(entry);
    }
  }
  if (out.profiles.length === 0 && out.pending.length === 0) return null;
  return out;
}

function normalizeCreditsSummary(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.available !== true) {
    const reason = raw.reason ? String(raw.reason).slice(0, MAX_REASON_LENGTH) : 'unavailable';
    return { available: false, reason };
  }
  const totals = normalizeTotals(raw.totals);
  if (!totals) return { available: false, reason: 'invalid totals' };
  const summary = {
    available: true,
    tool: raw.tool ? String(raw.tool).slice(0, 64) : 'workbuddy',
    updatedAt: raw.updatedAt ? String(raw.updatedAt).slice(0, 40) : '',
    totals
  };
  // Confidence travels with the data instead of being re-derived by each
  // surface: `exact` (local file), `vendor` (quoted by the tool), `estimated`.
  if (CONFIDENCE_LEVELS.has(raw.confidence)) summary.confidence = raw.confidence;
  if (Array.isArray(raw.recentEvents)) {
    const events = [];
    for (const candidate of raw.recentEvents.slice(-MAX_RECENT_EVENTS)) {
      const event = normalizeEvent(candidate);
      if (event) events.push(event);
    }
    summary.recentEvents = events;
  }
  if (Number.isFinite(Number(raw.warnings))) {
    summary.warnings = Math.max(0, Math.trunc(Number(raw.warnings)));
  }
  const calibration = normalizeCalibration(raw.calibration);
  if (calibration) summary.calibration = calibration;
  return summary;
}

function buildCreditsSummary(collectResult, { now = new Date(), tool = 'workbuddy' } = {}) {
  if (!collectResult || collectResult.available !== true) {
    return {
      available: false,
      reason: collectResult?.reason || 'unavailable'
    };
  }
  const events = collectResult.events || [];
  const dayStart = new Date(now);
  dayStart.setHours(0, 0, 0, 0);
  const dayStartMs = dayStart.getTime();
  let todayCredits = 0;
  for (const event of events) {
    const at = Number(event?.updatedAt);
    const amount = Number(event?.credits);
    if (!Number.isFinite(at) || at < dayStartMs) continue;
    if (!Number.isFinite(amount) || amount >= 0) continue;
    todayCredits += -amount;
  }
  return {
    available: true,
    tool,
    // Every figure in this block comes from a local file read, never from a
    // vendor quote — the badge says so and the data says so.
    confidence: 'exact',
    updatedAt: now.toISOString(),
    totals: {
      ...collectResult.totals,
      todayCredits: Math.round(todayCredits * 1e6) / 1e6
    },
    recentEvents: events.slice(-MAX_RECENT_EVENTS),
    warnings: (collectResult.warnings || []).length
  };
}

module.exports = { buildCreditsSummary, normalizeCreditsSummary };
