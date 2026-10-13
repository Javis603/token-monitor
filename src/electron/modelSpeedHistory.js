'use strict';

// Output throughput measured against matching client-reported duration.
// Buckets are observations, not request counts or proof of provider throttling.
const VERSION = 1;
const KIND = 'model-output-speed-history';
const RETENTION_DAYS = 90;
const FIVE_MINUTES = 300000;
const HOUR = 3600000;
const MAX_SERIES = 128;
const safe = (v) => Number.isSafeInteger(v) && v >= 0;
const nameValid = (v) => typeof v === 'string' && v.length > 0 && v.length <= 200 && !/[\x00-\x1f\x7f]/.test(v);
const pair = (v) => v && safe(v.timedOutputTokens) && safe(v.timedDurationMs)
  ? { out: v.timedOutputTokens, ms: v.timedDurationMs } : null;
const rate = (p) => p && p.out > 0 && p.ms > 0 ? p.out * 1000 / p.ms : null;
const fresh = () => ({ version: VERSION, kind: KIND, retentionDays: RETENTION_DAYS, activeSource: null, series: {} });
const median = (values) => {
  const a = values.filter(Number.isFinite).sort((x, y) => x - y);
  const n = a.length;
  return n ? n % 2 ? a[(n - 1) / 2] : (a[n / 2 - 1] + a[n / 2]) / 2 : null;
};
function sum(points) {
  const result = { out: 0, ms: 0, n: 0 };
  for (const p of points) for (const f of ['out', 'ms', 'n']) {
    const v = result[f] + p[f];
    if (!safe(v)) return null;
    result[f] = v;
  }
  return result;
}
function normalize(value) {
  const state = fresh();
  if (!value || value.version !== VERSION || value.kind !== KIND || value.retentionDays !== RETENTION_DAYS
    || !value.series || typeof value.series !== 'object' || Array.isArray(value.series)
    || Object.keys(value.series).length > MAX_SERIES) return { valid: false, state };
  if (value.activeSource !== null && !/^[a-f0-9]{64}$/.test(value.activeSource || '')) return { valid: false, state };
  state.activeSource = value.activeSource;
  for (const [id, row] of Object.entries(value.series)) {
    if (typeof row !== 'object' || !nameValid(row?.model) || !/^[a-f0-9]{64}$/.test(row.source || '')
      || id !== `${row.source}:${row.model}` || !row.anchor || !safe(row.anchor.out) || !safe(row.anchor.ms)
      || !safe(row.anchor.todayOut) || !safe(row.anchor.todayMs) || !safe(row.anchor.at) || row.anchor.at > 8640000000000000
      || !/^\d{4}-\d{2}-\d{2}$/.test(row.anchor.day || '') || !Array.isArray(row.points)
      || row.points.length > 2600 || !safe(row.gaps) || !safe(row.rejected)
      || !row.pending || !safe(row.pending.out) || !safe(row.pending.ms) || !safe(row.referenceAt) || !safe(row.lastSampleAt)
      || row.referenceAt > row.anchor.at || row.lastSampleAt > row.anchor.at) return { valid: false, state };
    let previousEnd = 0;
    for (const p of row.points) {
      if (!p || !safe(p.at) || ![FIVE_MINUTES, HOUR].includes(p.span) || !safe(p.out) || p.out < 1
        || !safe(p.ms) || p.ms < 1 || !safe(p.n) || p.n < 1 || p.at < previousEnd
        || p.at % p.span !== 0 || p.at > row.anchor.at) return { valid: false, state };
      previousEnd = p.at + p.span;
    }
    if (row.reference !== null && (!pair({ timedOutputTokens: row.reference?.out, timedDurationMs: row.reference?.ms }))) return { valid: false, state };
    state.series[id] = { model: row.model, source: row.source,
      anchor: { out: row.anchor.out, ms: row.anchor.ms, todayOut: row.anchor.todayOut, todayMs: row.anchor.todayMs, day: row.anchor.day, at: row.anchor.at },
      reference: row.reference ? { out: row.reference.out, ms: row.reference.ms } : null,
      referenceAt: row.referenceAt, lastSampleAt: row.lastSampleAt,
      pending: { out: row.pending.out, ms: row.pending.ms },
      points: row.points.map(({ at, span, out, ms, n }) => ({ at, span, out, ms, n })),
      gaps: row.gaps, rejected: row.rejected,
      ...(['counter-reset', 'observation-gap', 'incomparable-counters', 'unsafe-aggregate', 'unpaired-counters', 'clock-regression'].includes(row.problem) ? { problem: row.problem } : {}) };
  }
  return { valid: true, state };
}
function prune(row, at) {
  const cutoff = at - RETENTION_DAYS * 86400000;
  const oldCutoff = Math.floor((at - 86400000) / HOUR) * HOUR;
  const old = new Map(), recent = [];
  for (const p of row.points) {
    if (p.at + p.span <= cutoff) continue;
    if (p.at + p.span <= oldCutoff) {
      const key = Math.floor(p.at / HOUR) * HOUR;
      const existing = old.get(key) || { at: key, span: HOUR, out: 0, ms: 0, n: 0 };
      const aggregate = sum([existing, p]);
      if (!aggregate) throw new Error('UNSAFE_SPEED_AGGREGATE');
      old.set(key, { at: key, span: HOUR, ...aggregate });
    } else recent.push(p);
  }
  row.points = [...old.values(), ...recent].sort((a, b) => a.at - b.at);
}
function ingest(state, { source, day, allTime, today, at }) {
  if (!/^[a-f0-9]{64}$/.test(source || '') || !safe(at) || !/^\d{4}-\d{2}-\d{2}$/.test(day || '')) return { state, changed: false };
  const next = JSON.parse(JSON.stringify(state));
  let changed = next.activeSource !== source;
  for (const row of Object.values(next.series)) {
    const count = row.points.length;
    prune(row, at);
    if (count !== row.points.length) changed = true;
  }
  next.activeSource = source;
  const models = allTime?.modelThroughput;
  if (!models || typeof models !== 'object' || Array.isArray(models)) return { state: next, changed };
  for (const [model, counters] of Object.entries(models)) {
    if (!nameValid(model)) continue;
    const current = pair(counters), currentDay = pair(today?.modelThroughput?.[model]);
    const id = `${source}:${model}`;
    if (!current || !currentDay) {
      if (next.series[id]?.reference) { next.series[id].reference = null; changed = true; }
      continue;
    }
    let row = next.series[id];
    const reference = rate(currentDay) !== null ? currentDay : null;
    if (!row) {
      if (Object.keys(next.series).length >= MAX_SERIES) throw new Error('SPEED_HISTORY_CAPACITY');
      next.series[id] = { model, source, anchor: { ...current, todayOut: currentDay.out, todayMs: currentDay.ms, day, at },
        reference, referenceAt: at, lastSampleAt: 0, pending: { out: 0, ms: 0 }, points: [], gaps: 0, rejected: 0 };
      changed = true;
      continue;
    }
    const previous = row.anchor;
    row.reference = reference; row.referenceAt = at;
    if (at < previous.at) { row.problem = 'clock-regression'; row.rejected++; changed = true; continue; }
    const delta = { out: current.out - previous.out, ms: current.ms - previous.ms };
    if (delta.out < 0 || delta.ms < 0) {
      // Do not lower the high-water anchor: replaying an old counter is not a new sample.
      // A corrected timing numerator cannot carry an unfinished old-basis
      // sample into a later delta, even after the high-water mark is recovered.
      if (row.pending.out || row.pending.ms) { row.pending = { out: 0, ms: 0 }; changed = true; }
      if (row.problem !== 'counter-reset') { row.problem = 'counter-reset'; row.rejected++; changed = true; }
      previous.at = at;
      continue;
    }
    if (previous.day !== day || at - previous.at > 15 * 60000) {
      row.anchor = { ...current, todayOut: currentDay.out, todayMs: currentDay.ms, day, at };
      row.pending = { out: 0, ms: 0 };
      row.gaps++; row.problem = 'observation-gap'; changed = true;
      continue;
    }
    const todayDelta = { out: currentDay.out - previous.todayOut, ms: currentDay.ms - previous.todayMs };
    previous.at = at; // memory-only last successful read; duplicates never create a sample
    if (!delta.out && !delta.ms && !todayDelta.out && !todayDelta.ms) continue;
    row.anchor = { ...current, todayOut: currentDay.out, todayMs: currentDay.ms, day, at };
    changed = true;
    if (delta.out !== todayDelta.out || delta.ms !== todayDelta.ms || todayDelta.out < 0 || todayDelta.ms < 0) {
      row.pending = { out: 0, ms: 0 };
      row.problem = 'incomparable-counters'; row.rejected++; continue;
    }
    if (!delta.out || !delta.ms) { row.problem = 'unpaired-counters'; row.rejected++; continue; }
    const pending = sum([{ ...row.pending, n: 0 }, { ...delta, n: 0 }]);
    if (!pending) { row.problem = 'unsafe-aggregate'; row.rejected++; continue; }
    row.pending = { out: pending.out, ms: pending.ms };
    if (pending.out < 64 || pending.ms < 1000) continue;
    const start = Math.floor(at / FIVE_MINUTES) * FIVE_MINUTES;
    const last = row.points.at(-1);
    const point = last && last.at === start && last.span === FIVE_MINUTES ? last : { at: start, span: FIVE_MINUTES, out: 0, ms: 0, n: 0 };
    const aggregate = sum([point, { ...pending, n: 1 }]);
    if (!aggregate) { row.problem = 'unsafe-aggregate'; row.rejected++; continue; }
    Object.assign(point, aggregate);
    if (point !== last) row.points.push(point);
    row.pending = { out: 0, ms: 0 }; row.lastSampleAt = at;
    delete row.problem;
    prune(row, at);
  }
  return { state: next, changed };
}
function assess(row, at) {
  const recent = row.points.filter((p) => p.span === FIVE_MINUTES && p.at >= at - 30 * 60000 && p.n >= 2 && p.ms >= 2000);
  const baseline = row.points.filter((p) => p.at >= at - 7 * 86400000 && p.at + p.span <= at - 30 * 60000);
  const base = sum(baseline), latest = recent.slice(-3);
  const baselineTps = median(baseline.map(rate));
  const last = row.points.at(-1);
  const lastTps = (row.lastSampleAt <= at ? rate(last) : null) ?? (at - row.referenceAt <= 86400000 ? rate(row.reference) : null);
  const current = sum(latest);
  const recentTps = latest.length === 3 ? rate(current) : null;
  let status = 'learning';
  const adjacent = latest.length === 3 && latest[2].at - latest[0].at === FIVE_MINUTES * 2
    && at - (latest[2].at + FIVE_MINUTES) <= 15 * 60000;
  const enough = baseline.length >= 6 && base?.n >= 12 && base.ms >= 30000 && adjacent;
  if (row.problem) status = 'insufficient';
  else if (!last || at - (last.at + last.span) > HOUR) status = last ? 'insufficient' : 'learning';
  else if (enough && baselineTps > 0) {
    status = latest.every((p) => rate(p) <= baselineTps * 0.7) ? 'slower' : 'stable';
  }
  return { status, baselineTps, recentTps, lastTps, outputTpm: lastTps === null ? null : lastTps * 60,
    changePercent: enough && recentTps !== null && baselineTps > 0 ? (recentTps / baselineTps - 1) * 100 : null,
    baselineSamples: base?.n || 0, recentSamples: current?.n || 0, lastAt: row.lastSampleAt || null,
    samples: row.points.reduce((n, p) => n + p.n, 0), referenceOnly: !last, gaps: row.gaps, rejected: row.rejected };
}
function chart(points, at, days, maxPoints = 96) {
  return chartRange(points, { start: at - days * 86400000, end: at }, maxPoints);
}
// Buckets are clipped to the caller's window, so the DAY curve starts at local
// midnight rather than at a rolling 24-hour mark, and TOTAL cannot show a
// sample that the retention floor already dropped.
function chartRange(points, range, maxPoints = 96) {
  const start = Number(range?.start), end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return [];
  const selected = points.filter((p) => p.at + p.span > start && p.at <= end);
  const spanDays = Math.max(0, (end - start) / 86400000);
  const step = spanDays <= 1 ? 15 * 60000 : Math.max(HOUR, Math.ceil(spanDays * 24 / maxPoints) * HOUR);
  const groups = new Map();
  for (const p of selected) {
    const key = Math.floor(p.at / step) * step;
    const old = groups.get(key) || { at: key, span: step, out: 0, ms: 0, n: 0 };
    const counters = sum([old, p]);
    if (counters) groups.set(key, { at: key, span: step, ...counters });
  }
  return [...groups.values()].sort((a, b) => a.at - b.at).map((p) => ({ at: p.at, span: p.span, tps: rate(p), samples: p.n }));
}
// The range average is the same measurement the curve draws: output over the
// matching duration for every sample whose interval overlaps the window.
function rateOverRange(points, range) {
  const start = Number(range?.start), end = Number(range?.end);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return rate(sum(points.filter((p) => p.at + p.span > start && p.at <= end)));
}
function project(state, at, days = 7) {
  return projectRange(state, at, { start: at - days * 86400000, end: at });
}
function projectRange(state, at, range) {
  return Object.entries(state.series).filter(([, r]) => r.source === state.activeSource)
    .map(([id, row]) => ({ id, model: row.model, ...assess(row, at), trend: chartRange(row.points, range) }))
    .filter((r) => r.lastTps !== null || r.samples > 0)
    .sort((a, b) => (b.lastAt || 0) - (a.lastAt || 0) || b.samples - a.samples || a.model.localeCompare(b.model));
}
module.exports = { VERSION, KIND, RETENTION_DAYS, FIVE_MINUTES, HOUR, fresh, normalize, ingest, project, projectRange, assess, chart, chartRange, rateOverRange, sum, rate };
