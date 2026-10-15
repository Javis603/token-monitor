'use strict';

// Wire claims are contributions to already published counters, never another
// accounting authority. Native identities stay opaque and version-exact.
const { extractUsageFromTokscale, normalizePeriod, mergePeriods, canonicalProjectKey } = require('../usage');
const { parseGraphResult } = require('../history');
const { rebucketIdentityState, acceptedClaudeWindows } = require('./claudePeriodState');
const PERIODS = ['today', 'month', 'allTime'];
const TOKEN_FIELDS = ['input', 'output', 'cacheRead', 'cacheWrite', 'reasoning'];
const EVENT_ID = /^sha256:[0-9a-f]{64}$/;
const formatters = new Map();

function identityDayKey(timestamp, timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone) {
  let formatter = formatters.get(timeZone);
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
    formatters.set(timeZone, formatter);
  }
  const parts = Object.fromEntries(formatter.formatToParts(new Date(timestamp)).map(part => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day}`;
}

function validContribution(row) {
  return Number.isSafeInteger(row?.timestamp) && Number.isFinite(new Date(row.timestamp).getTime())
    && typeof row.modelId === 'string' && Boolean(row.modelId.trim()) && typeof row.providerId === 'string'
    && TOKEN_FIELDS.every(field => Number.isSafeInteger(row.tokens?.[field]) && row.tokens[field] >= 0)
    && Number.isFinite(row.cost) && row.cost >= 0 && Number.isSafeInteger(row.messages) && row.messages >= 0
    && (row.pricing === undefined || row.pricing && ['unpricedTokens', 'unpricedMessages'].every(field => Number.isSafeInteger(row.pricing[field]) && row.pricing[field] >= 0))
    && (row.performance === undefined || row.performance && Object.values(row.performance).every(value => Number.isFinite(value) && value >= 0));
}

function claimRow(value, sessionId) {
  return { client: 'claude', sessionId, model: value.modelId, provider: value.providerId,
    ...value.tokens, cost: value.cost, messages: value.messages,
    ...(value.performance ? { performance: value.performance } : {}),
    ...(value.pricing ? { unpricedTokens: value.pricing.unpricedTokens } : {}) };
}

function contributionPeriod(values, sessionId, metadata) {
  const period = normalizePeriod(extractUsageFromTokscale({ entries: values.map(value => claimRow(value, sessionId)) }));
  // Titles, prompts, source paths and native identities do not belong in proof.
  // Project attribution can only use the opaque identity already in the report.
  const session = period.sessions[`claude:${sessionId}`];
  if (session) {
    for (const field of ['title', 'projectLabel', 'startedAt', 'lastUsedAt', 'contextTokens', 'contextWindow']) delete session[field];
    if (typeof metadata?.projectId === 'string' && metadata.projectId && !/[/\\]/.test(metadata.projectId)) {
      session.projectId = metadata.projectId;
    } else delete session.projectId;
  }
  return period;
}

function validEvent(event, sessionId) {
  return EVENT_ID.test(event?.id) && typeof sessionId === 'string' && sessionId.length > 0
    && sessionId.length <= 1024 && !sessionId.includes('\0') && !['unknown', 'unknown-session'].includes(sessionId.toLowerCase())
    && ['native', 'mirror'].includes(event.observationKind) && Array.isArray(event.contributions)
    && event.contributions.length > 0 && event.contributions.every(validContribution);
}

function nativeIdentityEvents(source) {
  if (source?.version !== 2 || source.eventIdentityVersion !== 2 || source.accountingOwner === 'app'
    || !Number.isFinite(Date.parse(source.capturedAt)) || !Array.isArray(source.scopes) || !Array.isArray(source.sessions)) return null;
  const scopes = new Map();
  for (const scope of source.scopes) {
    if (scopes.has(scope?.id)) return null;
    scopes.set(scope?.id, scope);
  }
  const complete = source.scopes.some(scope => scope?.clients?.includes('claude')
    && scope.readStatus === 'complete' && scope.identityStatus === 'exact');
  if (!complete || source.scopes.some(scope => scope?.clients?.includes('claude')
    && (scope.readStatus !== 'complete' || scope.identityStatus !== 'exact'))
    || source.partialClients?.includes('claude') || Number(source.rowsWithoutIdentity?.claude || 0) !== 0) return null;
  const events = [];
  const seen = new Set();
  for (const row of source.sessions) {
    if (row?.client !== 'claude') continue;
    const scope = scopes.get(row.scopeId);
    if (!scope?.clients?.includes('claude') || scope.readStatus !== 'complete' || scope.identityStatus !== 'exact'
      || source.partialClients?.includes('claude') || Number(source.rowsWithoutIdentity?.claude || 0) !== 0) continue;
    for (const event of row.events || []) {
      if (!validEvent(event, row.sessionId)) continue;
      if (seen.has(event.id)) return null;
      seen.add(event.id);
      events.push({ id: event.id, sessionId: row.sessionId, observationKind: event.observationKind,
        contributions: event.contributions });
    }
  }
  return { capturedAt: new Date(source.capturedAt).toISOString(), events };
}

function periodIdentityFromSource(source, period) {
  const identity = nativeIdentityEvents(source);
  if (!identity) return null;
  const events = identity.events.map(event => ({ id: event.id, sessionId: event.sessionId, observationKind: event.observationKind,
    capturedAt: identity.capturedAt,
    usage: contributionPeriod(event.contributions, event.sessionId, period?.sessions?.[`claude:${event.sessionId}`]) }));
  return { capturedAt: identity.capturedAt, events };
}

// Persist this internal day split with the anchor. One event can have several
// timestamped fragments; removing today's fragments must preserve older ones.
function periodIdentityStateFromSource(source, period, options = {}) {
  const identity = nativeIdentityEvents(source);
  if (!identity) return null;
  return { capturedAt: identity.capturedAt, events: identity.events.map(event => {
    const days = new Map();
    for (const value of event.contributions) {
      const date = identityDayKey(value.timestamp, options.timeZone);
      if (options.periodName === 'today' && date !== options.todayKey
        || options.periodName === 'month' && date.slice(0, 7) !== options.todayKey?.slice(0, 7)
        || options.periodName === 'allTime' && options.allTimeSince && date < options.allTimeSince) continue;
      if (!days.has(date)) days.set(date, []);
      days.get(date).push(value);
    }
    return { id: event.id, sessionId: event.sessionId, observationKind: event.observationKind,
      capturedAt: identity.capturedAt,
      days: [...days].map(([date, values]) => ({ date, usage: contributionPeriod(values, event.sessionId, period?.sessions?.[`claude:${event.sessionId}`]) })) };
  }).filter(event => event.days.length) };
}

function stripClaimMetadata(period) {
  for (const session of Object.values(period.sessions || {})) {
    for (const field of ['title', 'projectLabel', 'startedAt', 'lastUsedAt', 'contextTokens', 'contextWindow',
      'nativeSessionId', 't3ThreadId', 'parentSessionId', 'parentClient', 'liveActivity', 'promptCache']) delete session[field];
  }
  return period;
}

function identityPeriodFromState(state) {
  if (!state) return null;
  return { capturedAt: state.capturedAt, events: state.events.map(({ days, ...event }) => ({ ...event, capturedAt: event.capturedAt || state.capturedAt,
    usage: stripClaimMetadata(mergePeriods(...days.map(day => day.usage))) })).filter(event => event.usage.totalTokens > 0 || event.usage.costUsd > 0) };
}

function replaceIdentityToday(base, fresh, todayKey) {
  if (!base || !fresh) return null;
  const events = new Map();
  const unproved = new Set(base.unprovedEventIds || []);
  for (const event of base.events) {
    const days = event.days.filter(day => day.date !== todayKey);
    if (days.length) events.set(event.id, { ...event, capturedAt: event.capturedAt || base.capturedAt, days });
  }
  for (const event of fresh.events) {
    const previous = events.get(event.id);
    // A changed owner is safe only for the replaced day, never older fragments.
    if (previous && (previous.sessionId !== event.sessionId || previous.observationKind !== event.observationKind)) return null;
    const days = [...(previous?.days || []), ...event.days.filter(day => day.date === todayKey)];
    const capturedAt = event.capturedAt || fresh.capturedAt;
    // Different captures of one event's past/Today fragments cannot be ranked
    // as one observation. Keep it unproved until a full capture reunites them.
    if (previous && previous.capturedAt !== capturedAt) unproved.add(event.id);
    if (unproved.has(event.id)) { events.delete(event.id); continue; }
    if (days.length) events.set(event.id, { ...event, capturedAt, days });
  }
  return { capturedAt: fresh.capturedAt, events: [...events.values()],
    ...(unproved.size ? { unprovedEventIds: [...unproved] } : {}) };
}

function nonnegativeCountersFit(claim, counter, terms = 1) {
  if (typeof claim === 'number') {
    const available = typeof counter === 'number' ? counter : 0;
    return Number.isFinite(claim) && claim >= 0 && Number.isFinite(available)
      && (claim <= available || claim - available <= 8 * Number.EPSILON * Math.max(1, terms) * Math.max(claim, available));
  }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)) return true;
  return Object.entries(claim).every(([key, value]) => nonnegativeCountersFit(value, counter?.[key], terms));
}

function validatedPeriodIdentity(identity, period) {
  if (!identity || !identity.events.length) return null;
  const total = mergePeriods(...identity.events.map(event => event.usage));
  // Retention intentionally disables optional model throughput, while accepted
  // root timing remains available. Match the sanitizer's available dimensions.
  if (!period?.modelThroughput) delete total.modelThroughput;
  return nonnegativeCountersFit(total, normalizePeriod(period), identity.events.length) ? identity : null;
}

function attributeIdentityProjects(identity, period) {
  if (!identity) return identity;
  return { ...identity, events: identity.events.map(event => {
    const usage = structuredClone(event.usage);
    const metadata = period?.sessions?.[`claude:${event.sessionId}`];
    const projectKey = canonicalProjectKey(metadata?.projectLabel);
    if (metadata?.projectId && projectKey && Object.hasOwn(period.projects || {}, projectKey)) {
      usage.projects = { [projectKey]: { tokens: usage.totalTokens, costUsd: usage.costUsd, clients: { claude: usage.totalTokens },
        ...(usage.unpricedTokens ? { unpricedTokens: usage.unpricedTokens } : {}) } };
      if (usage.sessions?.[`claude:${event.sessionId}`]) usage.sessions[`claude:${event.sessionId}`].projectId = metadata.projectId;
    }
    return { ...event, usage };
  }) };
}

function usageIdentityFromState(state, periods) {
  const result = { version: 1, eventIdentityVersion: 2, periods: {} };
  for (const name of PERIODS) {
    const identity = validatedPeriodIdentity(attributeIdentityProjects(identityPeriodFromState(state?.[name]), periods[name]), periods[name]);
    if (identity) result.periods[name] = identity;
  }
  return Object.keys(result.periods).length ? result : null;
}

// Accepted App accounting is the only source for retained History proof. This
// function takes a safe ledger getter's result; it never re-reads an archive or
// pairs a fresh graph export with an older accepted projection.
function identityStateFromLedger(ledger, periods, options = {}) {
  const result = {};
  if (ledger?.version !== 2 || !ledger.scopes) return result;
  for (const name of PERIODS) result[name] = { capturedAt: '', events: [] };
  for (const scope of Object.values(ledger.scopes)) {
    if (scope.mode !== 'ledger' || scope.eventIdentityVersion !== 2 || scope.proof?.readStatus !== 'complete'
      || scope.proof.identityStatus !== 'exact' || !Number.isFinite(Date.parse(scope.acceptedAt))) continue;
    for (const [id, event] of Object.entries(scope.events || {})) {
      const row = scope.sessions?.[event.ownerKey];
      if (row?.client !== 'claude' || !validEvent({ ...event, id }, row.sessionId)
        || !Number.isFinite(Date.parse(event.capturedAt))) continue;
      for (const name of PERIODS) {
        const values = event.contributions.filter(value => {
          const day = identityDayKey(value.timestamp, options.timeZone);
          return day <= options.todayKey && (name === 'today' ? day === options.todayKey : name === 'month' ? day.slice(0, 7) === options.todayKey?.slice(0, 7)
            : !options.allTimeSince || day >= options.allTimeSince);
        });
        if (!values.length) continue;
        const state = periodIdentityStateFromSource({ version: 2, eventIdentityVersion: 2, capturedAt: event.capturedAt,
          scopes: [{ id: 'accepted', clients: ['claude'], readStatus: 'complete', identityStatus: 'exact' }],
          sessions: [{ client: 'claude', sessionId: row.sessionId, scopeId: 'accepted', events: [{ ...event, id, contributions: values }] }] }, periods[name], options);
        result[name].events.push(...state.events);
        if (scope.acceptedAt > result[name].capturedAt) result[name].capturedAt = scope.acceptedAt;
      }
    }
  }
  return result;
}

// Mirrors cached source projection selection: live sessions use the native
// capture, absent sessions use retained ledger accounting. This is inventory
// selection, never a comparison of totals or a new ledger acceptance decision.
function supplementNativeIdentityState(native, retained, periods, rawPresence) {
  const result = {};
  for (const name of PERIODS) {
    const live = new Set(rawPresence?.[name] || Object.keys(periods[name]?.sessions || {}));
    const prior = retained[name];
    const fresh = native[name];
    const events = [...(fresh?.events || []).filter(event => live.has(`claude:${event.sessionId}`))
      .map(event => ({ ...event, capturedAt: event.capturedAt || fresh.capturedAt })),
    ...(prior?.events || []).filter(event => !live.has(`claude:${event.sessionId}`))
      .map(event => ({ ...event, capturedAt: event.capturedAt || prior.capturedAt }))];
    const counts = new Map();
    for (const event of events) counts.set(event.id, (counts.get(event.id) || 0) + 1);
    // An event represented by multiple selected owners is not a unique claim.
    // Preserve ordinary usage, but omit that ambiguous optional evidence.
    result[name] = { capturedAt: [fresh?.capturedAt, prior?.capturedAt].filter(Boolean).sort().at(-1) || '',
      events: events.filter(event => counts.get(event.id) === 1) };
  }
  return result;
}

function historyIdentityFromLedger(ledger, options = {}) {
  if (ledger?.version !== 2 || !ledger.scopes) return null;
  const result = { capturedAt: '', events: [] };
  for (const scope of Object.values(ledger.scopes)) {
    if (scope.mode !== 'ledger' || scope.eventIdentityVersion !== 2 || scope.proof?.readStatus !== 'complete'
      || scope.proof.identityStatus !== 'exact' || !Number.isFinite(Date.parse(scope.acceptedAt))) continue;
    for (const [id, event] of Object.entries(scope.events || {})) {
      const row = scope.sessions?.[event.ownerKey];
      if (row?.client !== 'claude' || !validEvent({ ...event, id }, row.sessionId)
        || !Number.isFinite(Date.parse(event.capturedAt))) continue;
      const dates = new Map();
      for (const value of event.contributions) {
        const date = identityDayKey(value.timestamp, options.timeZone);
        if (options.history && !options.history.daily.some(day => day.date === date)
          && !options.history.monthly.some(month => month.month === date.slice(0, 7))) continue;
        if (!dates.has(date)) dates.set(date, []);
        dates.get(date).push({ client: 'claude', modelId: value.modelId, providerId: value.providerId,
          tokens: value.tokens, cost: value.cost, messages: value.messages,
          ...(value.pricing ? { unpricedTokens: value.pricing.unpricedTokens } : {}) });
      }
      const days = [...dates].map(([date, clients]) => ({ date,
        usage: parseGraphResult({ contributions: [{ date, clients }] }).contributions[0] }));
      if (days.length) result.events.push({ id, sessionId: row.sessionId, observationKind: event.observationKind,
        capturedAt: new Date(event.capturedAt).toISOString(), days });
      if (scope.acceptedAt > result.capturedAt) result.capturedAt = scope.acceptedAt;
    }
  }
  return result.events.length ? result : null;
}

module.exports = { periodIdentityFromSource, periodIdentityStateFromSource, identityPeriodFromState,
  replaceIdentityToday, usageIdentityFromState, identityStateFromLedger, supplementNativeIdentityState, historyIdentityFromLedger,
  nonnegativeCountersFit, identityDayKey, rebucketIdentityState, acceptedClaudeWindows };
