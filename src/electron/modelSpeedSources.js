'use strict';

const crypto = require('node:crypto');
const core = require('./modelSpeedHistory');
const HASH = /^[a-f0-9]{64}$/;
const MAX_IDENTITIES = 128;
const text = (value, max = 200) => typeof value === 'string' && value.length <= max
  && !/[\x00-\x1f\x7f]/.test(value) ? value.trim() : '';
const safe = value => Number.isSafeInteger(value) && value >= 0;
const digest = value => crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
const fresh = () => ({ version: 1, history: core.fresh(), identities: {}, ready: false, references: null, totals: null });

// No account identifiers or credentials cross this boundary. A short account
// fingerprint disambiguates equal display names; the full identity is only a
// digest. Missing evidence remains missing, including the access method.
function identity(row) {
  const model = text(row?.model), client = text(row?.client, 80), platform = text(row?.platform, 120);
  if (!model) return null;
  const accountId = text(row.accountId, 200);
  let accountLabel = text(row.accountLabel, 160);
  if (/\b(?:bearer|sk-|eyJ)[\w.-]{8,}|(?:token|secret|api[_-]?key)\s*[:=]/i.test(accountLabel)) accountLabel = '';
  const accessType = ['subscription', 'api'].includes(row.accessType) ? row.accessType : 'unknown';
  const account = accountId || accountLabel;
  return { id: digest([model, client, platform, account, accessType]),
    value: { model, client, platform, accountLabel,
      accountTag: account ? digest([platform, account]).slice(0, 8) : '', accessType } };
}
function normalize(value) {
  if (value === undefined) return { valid: true, state: fresh() };
  const history = core.normalize(value?.history);
  if (value?.version !== 1 || !history.valid || !value.identities || typeof value.identities !== 'object'
    || Array.isArray(value.identities) || Object.keys(value.identities).length > MAX_IDENTITIES) return { valid: false, state: fresh() };
  const state = { version: 1, history: history.state, identities: {}, ready: value.ready === true, references: null, totals: null };
  if (value.totals != null) {
    const totals = value.totals;
    if (!HASH.test(totals.source) || !safe(totals.at) || !/^\d{4}-\d{2}-\d{2}$/.test(totals.day)
      || !totals.models || typeof totals.models !== 'object' || Array.isArray(totals.models)
      || Object.keys(totals.models).length > MAX_IDENTITIES) return { valid: false, state: fresh() };
    const models = Object.create(null);
    for (const [model, row] of Object.entries(totals.models)) {
      if (!text(model) || !['out', 'ms', 'todayOut', 'todayMs'].every(key => safe(row?.[key]))
        || (row.owner !== null && !HASH.test(row.owner))) return { valid: false, state: fresh() };
      models[model] = { out: row.out, ms: row.ms, todayOut: row.todayOut, todayMs: row.todayMs, owner: row.owner };
    }
    state.totals = { source: totals.source, day: totals.day, at: totals.at, models };
  }
  for (const [id, row] of Object.entries(value.identities)) {
    if (!HASH.test(id) || !text(row?.model) || !['subscription', 'api', 'unknown'].includes(row.accessType)
      || typeof row.accountTag !== 'string' || (row.accountTag && !/^[a-f0-9]{8}$/.test(row.accountTag))) return { valid: false, state: fresh() };
    state.identities[id] = { model: text(row.model), client: text(row.client, 80), platform: text(row.platform, 120),
      accountLabel: identity(row).value.accountLabel, accountTag: row.accountTag, accessType: row.accessType };
  }
  for (const row of Object.values(state.history.series)) if (!state.identities[row.model]) return { valid: false, state: fresh() };
  if (state.totals) for (const [model, row] of Object.entries(state.totals.models)) {
    if (row.owner && state.identities[row.owner]?.model !== model) return { valid: false, state: fresh() };
  }
  const refs = value.references;
  if (refs != null) {
    if (!HASH.test(refs.source) || !safe(refs.at) || !/^\d{4}-\d{2}-\d{2}$/.test(refs.day)
      || !/^\d{4}-\d{2}$/.test(refs.month) || !refs.periods || typeof refs.periods !== 'object') return { valid: false, state: fresh() };
    const periods = {};
    for (const name of ['today', 'month', 'allTime']) {
      const rows = refs.periods[name];
      if (!rows || typeof rows !== 'object' || Array.isArray(rows) || Object.keys(rows).length > MAX_IDENTITIES) return { valid: false, state: fresh() };
      periods[name] = {};
      for (const [id, row] of Object.entries(rows)) {
        if (!state.identities[id] || (row?.lastUsedAt !== null && !safe(row?.lastUsedAt))) return { valid: false, state: fresh() };
        periods[name][id] = { lastUsedAt: row.lastUsedAt };
      }
    }
    state.references = { source: refs.source, at: refs.at, day: refs.day, month: refs.month, periods };
  }
  return { valid: true, state };
}
function counters(period, identities) {
  const result = Object.create(null), entries = period?.modelSourceThroughput;
  if (!entries || typeof entries !== 'object' || Array.isArray(entries)) return undefined;
  for (const row of Object.values(entries)) {
    const source = identity(row);
    if (!source || !safe(row.timedOutputTokens) || !safe(row.timedDurationMs)) return undefined;
    if (!identities[source.id] && Object.keys(identities).length >= MAX_IDENTITIES) continue;
    identities[source.id] = source.value;
    const old = result[source.id] || { timedOutputTokens: 0, timedDurationMs: 0 };
    const out = old.timedOutputTokens + row.timedOutputTokens, ms = old.timedDurationMs + row.timedDurationMs;
    if (safe(out) && safe(ms)) result[source.id] = { timedOutputTokens: out, timedDurationMs: ms };
  }
  return result;
}
function referenceCatalog(period, identities) {
  const result = {};
  for (const row of Object.values(period?.modelUsageSources || {})) {
    const source = identity(row);
    if (!source || !safe(row.outputTokens)) continue;
    if (!identities[source.id] && Object.keys(identities).length >= MAX_IDENTITIES) continue;
    identities[source.id] = source.value;
    const lastUsedAt = Date.parse(row.lastUsedAt);
    const previous = result[source.id]?.lastUsedAt;
    result[source.id] = { lastUsedAt: safe(lastUsedAt) ? Math.max(lastUsedAt, previous || 0) : previous ?? null };
  }
  return result;
}
function modelTotals(options, allTime, today, identities) {
  const models = Object.create(null);
  const entries = options.allTime?.modelThroughput || {};
  for (const model of Object.keys(entries).sort().slice(0, MAX_IDENTITIES)) {
    const current = entries[model], currentDay = options.today?.modelThroughput?.[model];
    if (!text(model) || !current || !currentDay
      || !safe(current.timedOutputTokens) || !safe(current.timedDurationMs)
      || !safe(currentDay.timedOutputTokens) || !safe(currentDay.timedDurationMs)) continue;
    const candidates = Object.keys(allTime || {}).filter(id => identities[id]?.model === model
      && (allTime[id].timedOutputTokens || allTime[id].timedDurationMs));
    const owner = candidates.length === 1 ? candidates[0] : null;
    const source = owner && allTime[owner], sourceDay = owner && today?.[owner];
    const closes = source && sourceDay && source.timedOutputTokens === current.timedOutputTokens
      && source.timedDurationMs === current.timedDurationMs
      && sourceDay.timedOutputTokens === currentDay.timedOutputTokens && sourceDay.timedDurationMs === currentDay.timedDurationMs
      && !Object.keys(today || {}).some(id => id !== owner && identities[id]?.model === model
        && (today[id].timedOutputTokens || today[id].timedDurationMs));
    models[model] = { out: current.timedOutputTokens, ms: current.timedDurationMs,
      todayOut: currentDay.timedOutputTokens, todayMs: currentDay.timedDurationMs, owner: closes ? owner : null };
  }
  return { source: options.source, day: options.day, at: options.at, models };
}
function stableOwner(previous, current, model, nativeHistory) {
  const before = previous?.models[model], after = current.models[model];
  if (!before?.owner || before.owner !== after?.owner || previous.source !== current.source
    || previous.day !== current.day || current.at < previous.at || current.at - previous.at > 15 * 60000) return false;
  const native = nativeHistory?.series[`${current.source}:${model}`]?.anchor;
  if (nativeHistory && (!native || native.day !== previous.day
    || ['out', 'ms', 'todayOut', 'todayMs'].some(key => native[key] !== before[key]))) return false;
  const out = after.out - before.out, ms = after.ms - before.ms;
  return out >= 0 && ms >= 0 && out === after.todayOut - before.todayOut && ms === after.todayMs - before.todayMs;
}
function ingest(state, options) {
  const identities = { ...state.identities };
  const allTime = counters(options.allTime, identities), today = counters(options.today, identities);
  const periods = Object.fromEntries(['today', 'month', 'allTime'].map(name => [name, referenceCatalog(options[name], identities)]));
  const references = { source: options.source, day: options.day, month: options.day.slice(0, 7), periods };
  const previousReferences = state.references && { ...state.references };
  if (previousReferences) delete previousReferences.at;
  const referencesChanged = JSON.stringify(references) !== JSON.stringify(previousReferences);
  references.at = referencesChanged ? options.at : state.references.at;
  // Net account deltas cannot distinguish old requests gaining proof from new
  // output. Attribute speed only while a sole identity owns the complete native
  // model counters in both snapshots. Mixed/partial ownership remains a source
  // reference; the model's measured rate stays in the unknown residual.
  const ready = Boolean(allTime && today);
  const totals = modelTotals(options, allTime, today, identities);
  const accepted = Object.create(null), acceptedToday = Object.create(null);
  for (const [id, current] of Object.entries(allTime || {})) {
    const model = identities[id]?.model;
    if (totals.models[model]?.owner !== id || !today?.[id]) continue;
    accepted[id] = current; acceptedToday[id] = today[id];
  }
  const history = JSON.parse(JSON.stringify(state.history));
  let rebased = false;
  for (const row of Object.values(history.series)) {
    const model = identities[row.model]?.model;
    if (row.source !== options.source || stableOwner(state.totals, totals, model, options.nativeHistory)) continue;
    const current = allTime?.[row.model], currentDay = today?.[row.model];
    if (current && currentDay) {
      const anchor = { out: current.timedOutputTokens, ms: current.timedDurationMs,
        todayOut: currentDay.timedOutputTokens, todayMs: currentDay.timedDurationMs, day: options.day, at: options.at };
      if (JSON.stringify(row.anchor) !== JSON.stringify(anchor)) rebased = true;
      row.anchor = anchor;
    }
    if (row.pending.out || row.pending.ms || row.reference !== null) rebased = true;
    row.pending = { out: 0, ms: 0 }; row.reference = null;
  }
  const result = core.ingest(history, { ...options,
    allTime: { modelThroughput: accepted }, today: { modelThroughput: acceptedToday } });
  const previousTotals = state.totals && { ...state.totals, at: options.at };
  return { state: { version: 1, history: result.state, identities, ready, references, totals },
    changed: referencesChanged || state.ready !== ready || result.changed || rebased
      || JSON.stringify(totals) !== JSON.stringify(previousTotals)
      || JSON.stringify(identities) !== JSON.stringify(state.identities) };
}
function pointsInRange(points, range) {
  return points.filter(point => point.at + point.span > range.start && point.at <= range.end);
}
function project(state, { source, model, range, points = [] }) {
  const result = [];
  let measured = { out: 0, ms: 0, n: 0 };
  for (const row of Object.values(state.history.series)) {
    const metadata = state.identities[row.model];
    if (row.source !== source || metadata?.model !== model) continue;
    const selected = pointsInRange(row.points, range), totals = core.sum(selected);
    const referenceInRange = row.reference && row.referenceAt >= range.start && row.referenceAt <= range.end;
    if (!totals?.n && !referenceInRange) continue;
    const lastSampleAt = selected.length ? Math.min(range.end, selected.at(-1).at + selected.at(-1).span, row.lastSampleAt) : null;
    measured = core.sum([measured, totals]) || measured;
    result.push({ id: row.model, client: metadata.client, platform: metadata.platform,
      accountLabel: metadata.accountLabel, accountTag: metadata.accountTag, accessType: metadata.accessType,
      weightedTps: core.rate(totals), samples: totals.n, timedOutputTokens: totals.out,
      timedDurationMs: totals.ms, lastSampleAt, referenceOnly: !totals.n });
  }
  const refs = state.references;
  if (refs?.source === source) {
    const at = new Date(range.end), day = [at.getFullYear(), String(at.getMonth() + 1).padStart(2, '0'), String(at.getDate()).padStart(2, '0')].join('-');
    const name = range.period === 'today' ? 'today' : range.period === 'month' ? 'month' : 'allTime';
    const currentWindow = name === 'today' ? refs.day === day : name === 'month' ? refs.month === day.slice(0, 7) : true;
    if (currentWindow) for (const [id, ref] of Object.entries(refs.periods[name])) {
      const metadata = state.identities[id];
      const inRange = ref.lastUsedAt === null ? ['today', 'month'].includes(name)
        : ref.lastUsedAt >= range.start && ref.lastUsedAt <= range.end;
      if (metadata?.model !== model || !inRange || result.some(row => row.id === id)) continue;
      result.push({ id, client: metadata.client, platform: metadata.platform, accountLabel: metadata.accountLabel,
        accountTag: metadata.accountTag, accessType: metadata.accessType, weightedTps: null, samples: 0,
        timedOutputTokens: 0, timedDurationMs: 0, lastSampleAt: null, referenceOnly: true });
    }
  }
  // Pre-feature samples and any unmatched deltas retain explicit unknown
  // attribution. Only genuinely paired residual counters can report a rate.
  const total = core.sum(pointsInRange(points, range));
  const remainder = total && { out: total.out - measured.out, ms: total.ms - measured.ms };
  if (remainder && remainder.out > 0 && remainder.ms > 0) {
    result.push({ id: 'unattributed', client: '', platform: '', accountLabel: '', accountTag: '', accessType: 'unknown',
      weightedTps: core.rate(remainder), samples: null, timedOutputTokens: remainder.out, timedDurationMs: remainder.ms,
      lastSampleAt: null, referenceOnly: false });
  }
  return result.sort((a, b) => (b.lastSampleAt || 0) - (a.lastSampleAt || 0)
    || b.timedOutputTokens - a.timedOutputTokens || a.id.localeCompare(b.id));
}
module.exports = { fresh, normalize, ingest, project, identity };
