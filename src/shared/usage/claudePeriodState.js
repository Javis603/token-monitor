'use strict';

// Period reports certify only their selected windows. This runtime snapshot
// preserves that coverage without claiming the fullHistory ledger's authority
// or performing archive I/O when retention is disabled.
const { emptyPeriod, mergePeriods, applyPeriodDelta, applyProjectRollups, normalizeClientName } = require('../usage');
const { parseGraphResult, normalizeHistory, mergeHistories } = require('../history');
const PERIODS = ['today', 'month', 'allTime'];

function claudeGraph(graph) {
  return graph && { contributions: (graph.contributions || []).map(day => ({ date: day.date,
    clients: (day.clients || []).filter(row => normalizeClientName(row.client) === 'claude') })) };
}

// Re-evaluate accepted event days at rollover. Aggregate-only counters cannot
// establish a new Today/Month window, so those windows use only dated evidence.
function rebucketIdentityState(state, { todayKey, allTimeSince = '' }) {
  return Object.fromEntries(PERIODS.map(name => [name, state && {
    capturedAt: state.capturedAt,
    events: state.events.map(event => ({ ...event, days: event.days.filter(day => day.date <= todayKey
      && (name === 'today' ? day.date === todayKey : name === 'month' ? day.date.slice(0, 7) === todayKey.slice(0, 7)
        : day.date >= allTimeSince)) })).filter(event => event.days.length)
  }]));
}

function acceptedClaudeWindows(snapshot, options) {
  const states = rebucketIdentityState(snapshot.identityState?.allTime, options);
  const periods = {};
  for (const name of PERIODS) {
    const sameWindow = name === 'allTime' || (name === 'today' ? snapshot.dateKey === options.todayKey
      : snapshot.dateKey.slice(0, 7) === options.todayKey.slice(0, 7));
    if (sameWindow) {
      periods[name] = structuredClone(snapshot.periods[name]);
      states[name] = structuredClone(snapshot.identityState?.[name]);
    } else {
      periods[name] = mergePeriods(...(states[name]?.events || []).flatMap(event => event.days.map(day => day.usage)));
      // Reattach only metadata of sessions that actually contributed in-window.
      for (const [key, session] of Object.entries(periods[name].sessions || {})) {
        const metadata = snapshot.periods.allTime.sessions?.[key];
        for (const field of ['projectId', 'projectLabel', 'title']) if (metadata?.[field]) session[field] = metadata[field];
      }
    }
  }
  return { periods, identityState: states };
}

// `native` contains the collector's native partitions and their scan evidence.
// Completeness is supplied by the collector, which owns root acknowledgement.
// A rejected capture changes only Claude's projection, so other clients remain
// fresh. Published counters may include valid usage without identity claims;
// therefore the snapshot retains both counters and their accepted claim state.
function reconcileClaudePeriodState(summary, native, options) {
  const { previous, retained, enabled, complete, includeHistory, todayKey, timeZone,
    identityFingerprint, projectsEnabled, historyCapDays, supplementalPeriods } = options;
  const { periods, partitions, todayPartitions, sources, identityState, historyGraph } = native;
  let acceptedIdentityState = identityState;
  let snapshot = previous;
  const readFailed = Boolean(retained && (Object.values(sources).some(source => !complete(source))
    || includeHistory && (!historyGraph?.sourceUsage?.fullHistory || !complete(historyGraph.sourceUsage))));
  if (!enabled) return { identityState, snapshot, readFailed: false };
  if (readFailed) {
    for (const name of PERIODS) {
      const partition = name === 'today' ? todayPartitions : partitions[name];
      if (partition) {
        partition.claude = retained.periods[name];
        periods[name] = mergePeriods(...Object.values(partition));
        summary[name] = mergePeriods(periods[name], supplementalPeriods(name));
      } else {
        const fresh = applyPeriodDelta(previous.periods[name], todayPartitions?.claude || emptyPeriod(), previous.periods.today);
        summary[name] = applyPeriodDelta(summary[name], retained.periods[name], fresh);
        periods[name] = applyPeriodDelta(periods[name], retained.periods[name], fresh);
      }
    }
    acceptedIdentityState = retained.identityState;
    if (includeHistory && historyGraph && previous.historyGraph) {
      const otherGraph = { contributions: (historyGraph.contributions || []).map(day => ({ date: day.date,
        clients: (day.clients || []).filter(row => normalizeClientName(row.client) !== 'claude') })) };
      const historyOptions = { capDays: historyCapDays, todayKey };
      summary.history = mergeHistories([normalizeHistory(parseGraphResult(otherGraph), historyOptions),
        normalizeHistory(parseGraphResult(previous.historyGraph), historyOptions)], historyOptions);
    }
  } else if (Object.values(sources).every(complete) && Object.keys(sources).every(name => identityState[name])
    && (!previous || !includeHistory || historyGraph?.sourceUsage?.fullHistory && complete(historyGraph.sourceUsage))) {
    const accepted = Object.fromEntries(PERIODS.map(name => [name, partitions[name]?.claude
      || (previous && name !== 'today' ? applyPeriodDelta(previous.periods[name], todayPartitions?.claude || emptyPeriod(), previous.periods.today)
        : todayPartitions?.claude || emptyPeriod())]));
    for (const period of Object.values(accepted)) for (const [key, session] of Object.entries(period.sessions || {})) {
      const metadata = summary.allTime.sessions?.[key];
      for (const field of ['projectId', 'projectLabel', 'title']) if (metadata?.[field]) session[field] = metadata[field];
    }
    if (projectsEnabled) applyProjectRollups(accepted);
    snapshot = { identityFingerprint, dateKey: todayKey, timeZone, periods: structuredClone(accepted),
      identityState: structuredClone(identityState),
      historyGraph: historyGraph?.sourceUsage?.fullHistory && complete(historyGraph.sourceUsage)
        ? claudeGraph(historyGraph) : previous?.historyGraph,
      historyIdentity: previous?.historyIdentity };
  }
  return { identityState: acceptedIdentityState, snapshot, readFailed };
}

module.exports = { rebucketIdentityState, acceptedClaudeWindows, reconcileClaudePeriodState };
