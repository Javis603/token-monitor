'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const core = require('./modelSpeedHistory');
const sourceHistory = require('./modelSpeedSources');
const { captureCandidates, projectCandidates, unmeasuredAssessment } = require('./modelSpeedCandidates');
const { localDayKey } = require('../shared/history');
const { rangeForPeriod, normalizePeriod } = require('../shared/modelSpeedRange');
const { readFileLimited, writeJsonAtomic } = require('./cloudLedgerRuntime');
const MAX_BYTES = 32 * 1024 * 1024;
let lastSource = null;
function opaqueSource(source) {
  const identity = String(source);
  if (lastSource?.identity !== identity) {
    lastSource = { identity, fingerprint: crypto.pbkdf2Sync(identity, 'token-monitor/model-speed-source/v2', 600000, 32, 'sha256').toString('hex') };
  }
  return lastSource.fingerprint;
}
function createModelSpeedRuntime({ directory, now = Date.now, io = fs } = {}) {
  const file = path.join(directory, 'model-output-speed.json');
  let state = core.fresh(), sources = sourceHistory.fresh(), fault = null, revision = 0, dirty = false;
  let candidates = new Map(), candidateSignature = null;
  try {
    const stored = readFileLimited(file, MAX_BYTES, io);
    const normalized = core.normalize(stored);
    if (!normalized.valid) fault = 'CORRUPT_HISTORY';
    else {
      state = normalized.state;
      // Attribution is additive. A legacy history, or a broken attribution
      // extension, cannot discard the existing model measurements.
      const attribution = sourceHistory.normalize(stored.sources);
      if (attribution.valid) sources = attribution.state;
    }
  } catch (e) { if (e.code !== 'ENOENT') fault = 'CORRUPT_HISTORY'; }
  function observe(record, { preview = false, source = '' } = {}) {
    if (preview || fault === 'CORRUPT_HISTORY' || !record) return false;
    const sourceHash = opaqueSource(source);
    try {
      const at = now();
      const observation = { source: sourceHash, day: localDayKey(new Date(at)),
        allTime: record.allTime, today: record.today, month: record.month, at };
      const result = core.ingest(state, observation);
      const attribution = sourceHistory.ingest(sources, { ...observation, nativeHistory: state });
      sources = attribution.state;
      // Equal observations still refresh memory-only last-read anchors. They
      // never add output/duration or force a filesystem write.
      state = result.state;
      const nextCandidates = captureCandidates(record, sourceHash, now());
      const nextSignature = JSON.stringify([...nextCandidates.values()].sort((a, b) => a.id.localeCompare(b.id)));
      const candidatesChanged = candidateSignature !== nextSignature;
      candidates = nextCandidates;
      candidateSignature = nextSignature;
      if (result.changed || attribution.changed) dirty = true;
      if (!dirty) {
        if (candidatesChanged) revision++;
        return candidatesChanged;
      }
      const persisted = { ...state, sources };
      if (Buffer.byteLength(JSON.stringify(persisted)) > MAX_BYTES) throw new Error('HISTORY_CAPACITY');
      writeJsonAtomic(file, persisted, io);
      dirty = false; fault = null; revision++;
      return true;
    } catch (e) { fault = e.message === 'SPEED_HISTORY_CAPACITY' ? 'HISTORY_CAPACITY' : 'PERSISTENCE_FAILED'; revision++; return true; }
  }
  // Every surface resolves its window from the one top-level DAY/MONTH/TOTAL
  // selection, so the Home summary, the full list and the detail can never
  // disagree about which samples an average or a curve covers. The renderer
  // passes the selection through; it never picks a range of its own.
  function rangeFor(options = {}) {
    const period = normalizePeriod(options.period);
    const range = rangeForPeriod(period, { now: now(), weekStartsOn: options.weekStartsOn });
    return { period: range.period, start: range.start, end: range.end, labelKey: range.labelKey };
  }
  function list(options = {}) {
    const at = now();
    const range = rangeFor(options);
    const models = projectCandidates(core.projectRange(state, at, range), candidates, at)
      .map((row) => ({ ...row, weightedTps: core.rateOverRange(state.series[row.id]?.points || [], range) }));
    return { version: 1, retentionDays: 90, state: fault ? 'paused' : 'recording', reason: fault,
      revision, sampledAt: at, models, candidateCount: models.length, range,
      selection: 'active-then-today-usage',
      basis: 'client-reported-output-duration', actualUpstream: 'unknown' };
  }
  function summary(options = {}) {
    const all = list(options);
    return { ...all, models: all.models.slice(0, 5) };
  }
  function detail(id, options = {}) {
    if (typeof id !== 'string' || id.length > 270) return null;
    const range = rangeFor(options);
    const row = state.series[id];
    const at = now();
    const assessment = row && row.source === state.activeSource ? core.assess(row, at) : null;
    // Match project() availability, including an expired reference with no
    // measured samples. Opening an untimed Home row must keep the same state.
    if (!assessment || (assessment.lastTps === null && assessment.samples === 0)) {
      const candidate = candidates.get(id);
      if (!candidate || !id.startsWith(`${state.activeSource}:`)) return null;
      return { model: candidate.model, retentionDays: 90, ...unmeasuredAssessment(), weightedTps: null,
        state: fault ? 'paused' : 'recording', basis: 'client-reported-output-duration', actualUpstream: 'unknown',
        sources: sourceHistory.project(sources, { source: state.activeSource, model: candidate.model, range }), range };
    }
    return { model: row.model, retentionDays: 90, ...assessment,
      trend: core.chartRange(row.points, range), weightedTps: core.rateOverRange(row.points, range),
      state: fault ? 'paused' : 'recording', basis: 'client-reported-output-duration', actualUpstream: 'unknown',
      sources: sourceHistory.project(sources, { source: state.activeSource, model: row.model, range, points: row.points }), range };
  }
  return { observe, summary, list, detail, rangeFor, revision: () => revision, file };
}
module.exports = { createModelSpeedRuntime };
