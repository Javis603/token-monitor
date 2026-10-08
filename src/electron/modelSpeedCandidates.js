'use strict';

const { sessionActivityState } = require('../shared/sessionLive');

const validModel = (model) => typeof model === 'string' && model.length > 0 && model.length <= 200
  && !/[\x00-\x1f\x7f]/.test(model);
const tokensOf = (value) => {
  const tokens = Number(value && typeof value === 'object' ? value.totalTokens : value);
  return Number.isSafeInteger(tokens) && tokens > 0 ? tokens : 0;
};

// Candidate membership follows actual usage, independently of whether a client
// supplies matching output timing. These small, memory-only records never become
// speed observations or persisted history.
function captureCandidates(record, source, at) {
  const candidates = new Map();
  function candidate(model) {
    if (!validModel(model)) return null;
    const id = `${source}:${model}`;
    if (!candidates.has(id)) candidates.set(id, { id, model, todayTokens: 0, activeLastUsedAt: null });
    return candidates.get(id);
  }
  // Membership is the union of the same raw usage scopes used by the model
  // menu. Historical membership never marks a model active or today's usage.
  for (const period of [record?.allTime, record?.month]) {
    for (const [model, value] of Object.entries(period?.models || {})) {
      if (tokensOf(value)) candidate(model);
    }
  }
  for (const [model, value] of Object.entries(record?.today?.models || {})) {
    const tokens = tokensOf(value);
    if (tokens) {
      const row = candidate(model);
      if (row) row.todayTokens = tokens;
    }
  }
  // A watch update refreshes today's session metadata before a full monthly
  // scan. Its ended/multi-model state replaces an older snapshot of that session.
  const sessions = { ...(record?.month?.sessions || {}), ...(record?.today?.sessions || {}) };
  for (const session of Object.values(sessions)) {
    if (session?.sessionKind === 'background-review' || sessionActivityState(session, at) !== 'running') continue;
    // A multi-model session's timestamp does not say which historical model
    // is still active. Only an unambiguous single-model session lends its age.
    const models = Object.entries(session.models || {}).filter(([model, value]) => validModel(model) && tokensOf(value));
    if (models.length !== 1) continue;
    for (const [model] of models) {
      const row = candidate(model);
      if (row && Date.parse(session.lastUsedAt) > (Date.parse(row.activeLastUsedAt) || 0)) {
        row.activeLastUsedAt = session.lastUsedAt;
      }
    }
  }
  return candidates;
}

function unmeasuredAssessment() {
  return {
    status: 'unmeasured', lastTps: null, outputTpm: null, baselineTps: null,
    recentTps: null, changePercent: null, baselineSamples: 0, recentSamples: 0,
    lastAt: null, samples: 0, referenceOnly: false, gaps: 0, rejected: 0, trend: []
  };
}

function projectCandidates(measured, candidates, at) {
  const rows = new Map(measured.map((row) => [row.id, { ...row, todayTokens: 0, active: false }]));
  for (const [id, candidate] of candidates) {
    const row = rows.get(id) || { id, model: candidate.model, ...unmeasuredAssessment() };
    row.todayTokens = candidate.todayTokens;
    row.active = sessionActivityState({ lastUsedAt: candidate.activeLastUsedAt }, at) === 'running';
    rows.set(id, row);
  }
  return [...rows.values()].sort((a, b) => Number(b.active) - Number(a.active)
    || b.todayTokens - a.todayTokens || (b.lastAt || 0) - (a.lastAt || 0)
    || b.samples - a.samples || a.model.localeCompare(b.model));
}

module.exports = { captureCandidates, projectCandidates, unmeasuredAssessment };
