'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { num, sumTokens } = require('./history');
const { REASONIX_CLIENT } = require('./reasonixPaths');

const ARCHIVE_VERSION = 1;
const DAY_KEY_RE = /^\d{4}-\d{2}-\d{2}$/;

function observationKey(value) {
  return JSON.stringify([
    String(value?.client || 'unknown'),
    String(value?.modelId || value?.model || value?.model_id || 'unknown')
  ]);
}

function normalizeObservation(value) {
  if (!value || typeof value !== 'object') return null;
  const client = String(value.client || 'unknown');
  const modelId = String(value.modelId || value.model || value.model_id || 'unknown');
  const tokens = Math.max(0, Math.round(num(value.tokens)));
  const cost = Math.max(0, num(value.cost));
  const messages = Math.max(0, Math.round(num(value.messages)));
  const reasoningTokens = Math.max(0, Math.round(num(value.reasoningTokens ?? value.reasoning_tokens)));
  const rawCacheReadTokens = Math.max(0, Math.round(num(value.cacheReadTokens ?? value.cache_read_tokens)));
  const rawCacheWriteTokens = Math.max(0, Math.round(num(value.cacheWriteTokens ?? value.cache_write_tokens)));
  const rawOutputTokens = Math.max(0, Math.round(num(value.outputTokens ?? value.output_tokens)));
  const rawComponentTokens = rawCacheReadTokens + rawCacheWriteTokens + rawOutputTokens;
  const componentsFit = rawComponentTokens <= tokens;
  const cacheReadTokens = componentsFit ? rawCacheReadTokens : 0;
  const cacheWriteTokens = componentsFit ? rawCacheWriteTokens : 0;
  const outputTokens = componentsFit ? rawOutputTokens : 0;
  const componentTokens = cacheReadTokens + cacheWriteTokens + outputTokens;
  const hasExplicitUnclassified = Object.prototype.hasOwnProperty.call(value, 'unclassifiedTokens')
    || Object.prototype.hasOwnProperty.call(value, 'unclassified_tokens');
  const unclassifiedTokens = Math.min(Math.max(0, tokens - componentTokens), Math.max(0, Math.round(
    hasExplicitUnclassified
      ? num(value.unclassifiedTokens ?? value.unclassified_tokens)
      : (value.tokenComponentsAvailable === true && componentsFit ? 0 : tokens)
  )));
  // A zero-token synthetic observation has an exact zero component breakdown
  // even when it predates the provenance field. Do not let bookkeeping-only
  // rows make an otherwise exact fixed-range breakdown unavailable.
  const tokenComponentsAvailable = componentsFit
    && componentTokens + unclassifiedTokens <= tokens
    && unclassifiedTokens === 0
    && (tokens === 0 || value.tokenComponentsAvailable === true);
  if (tokens === 0 && cost === 0 && messages === 0) return null;
  return {
    client,
    modelId,
    ...(String(value.providerId || value.provider_id || '').trim()
      ? { providerId: String(value.providerId || value.provider_id).trim() }
      : {}),
    tokens,
    cost,
    messages,
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {}),
    ...(tokenComponentsAvailable ? {
      tokenComponentsAvailable: true,
      ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
      ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
      ...(outputTokens > 0 ? { outputTokens } : {})
    } : {}),
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
  };
}

function normalizeComponentValues(value, totalTokens, exact) {
  const cacheReadTokens = Math.max(0, Math.round(num(value?.cacheReadTokens)));
  const cacheWriteTokens = Math.max(0, Math.round(num(value?.cacheWriteTokens)));
  const outputTokens = Math.max(0, Math.round(num(value?.outputTokens)));
  if (cacheReadTokens + cacheWriteTokens + outputTokens > totalTokens) return null;
  const unclassifiedTokens = Math.min(
    totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens,
    Math.max(0, Math.round(num(value?.unclassifiedTokens
      ?? (exact ? 0 : totalTokens - cacheReadTokens - cacheWriteTokens - outputTokens))))
  );
  return {
    ...(cacheReadTokens > 0 ? { cacheReadTokens } : {}),
    ...(cacheWriteTokens > 0 ? { cacheWriteTokens } : {}),
    ...(outputTokens > 0 ? { outputTokens } : {}),
    ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {})
  };
}

function observationTokenMaps(observations) {
  const perClient = {};
  const perModel = {};
  let totalTokens = 0;
  for (const observation of Object.values(observations || {})) {
    const tokens = Math.max(0, Math.round(num(observation?.tokens)));
    totalTokens += tokens;
    perClient[observation.client] = num(perClient[observation.client]) + tokens;
    perModel[observation.modelId] = num(perModel[observation.modelId]) + tokens;
  }
  return { totalTokens, perClient, perModel };
}

function normalizeComponentSummary(value, observations) {
  if (!value || typeof value !== 'object') return null;
  const exact = value.tokenComponentsAvailable === true;
  const tokenMaps = observationTokenMaps(observations);
  const totals = normalizeComponentValues(value, tokenMaps.totalTokens, exact);
  if (!totals) return null;

  const normalizeMap = (source, tokensByKey) => {
    const result = {};
    for (const [key, tokens] of Object.entries(tokensByKey)) {
      const normalized = normalizeComponentValues(source?.[key], tokens, exact);
      if (!normalized) return null;
      if (Object.keys(normalized).length > 0) result[key] = normalized;
    }
    return result;
  };
  const perClient = normalizeMap(value.perClient, tokenMaps.perClient);
  const perModel = normalizeMap(value.perModel, tokenMaps.perModel);
  if (!perClient || !perModel) return null;
  return {
    tokenComponentsAvailable: exact
      && num(totals.unclassifiedTokens) === 0
      && Object.values(perClient).every((entry) => num(entry.unclassifiedTokens) === 0)
      && Object.values(perModel).every((entry) => num(entry.unclassifiedTokens) === 0),
    ...totals,
    perClient,
    perModel
  };
}

function normalizeDay(value, fallbackDate = '') {
  const date = String(value?.date || fallbackDate).slice(0, 10);
  if (!DAY_KEY_RE.test(date)) return null;
  const observations = {};
  const source = Array.isArray(value?.observations)
    ? value.observations
    : Object.values(value?.observations || {});
  for (const raw of source) {
    const observation = normalizeObservation(raw);
    if (!observation) continue;
    observations[observationKey(observation)] = observation;
  }
  if (Object.keys(observations).length === 0 && num(value?.activeTimeMs) <= 0) return null;
  const componentSummary = normalizeComponentSummary(value?.componentSummary, observations);
  return {
    date,
    activeTimeMs: Math.max(0, Math.round(num(value?.activeTimeMs))),
    observations,
    ...(componentSummary ? { componentSummary } : {})
  };
}

function normalizeDailyHistoryArchive(value) {
  const normalized = { version: ARCHIVE_VERSION, days: {} };
  const source = value?.days && typeof value.days === 'object' ? value.days : {};
  for (const [date, rawDay] of Object.entries(source)) {
    const day = normalizeDay(rawDay, date);
    if (day) normalized.days[day.date] = day;
  }
  const liveSource = value?.liveDays && typeof value.liveDays === 'object' ? value.liveDays : {};
  const liveDays = {};
  for (const [date, rawDay] of Object.entries(liveSource)) {
    const day = normalizeDay(rawDay, date);
    if (day) liveDays[day.date] = day;
  }
  if (Object.keys(liveDays).length > 0) normalized.liveDays = liveDays;
  return normalized;
}

function graphsArray(graphs) {
  return (Array.isArray(graphs) ? graphs : [graphs]).filter((graph) => graph && typeof graph === 'object');
}

function observationsFromGraphs(graphs) {
  const days = new Map();
  for (const graph of graphsArray(graphs)) {
    for (const row of (Array.isArray(graph.contributions) ? graph.contributions : [])) {
      const date = String(row?.date || '').slice(0, 10);
      if (!DAY_KEY_RE.test(date)) continue;
      const day = days.get(date) || { date, activeTimeMs: 0, observations: {} };
      day.activeTimeMs += Math.max(0, Math.round(num(row.activeTimeMs ?? row.active_time_ms)));
      for (const raw of (Array.isArray(row?.clients) ? row.clients : [])) {
        const candidate = normalizeObservation({
          ...raw,
          tokens: sumTokens(raw?.tokens, raw?.client),
          reasoningTokens: raw?.tokens?.reasoning,
          tokenComponentsAvailable: raw?.tokenComponentsAvailable !== false,
          cacheReadTokens: raw?.tokens?.cacheRead ?? raw?.tokens?.cache_read,
          cacheWriteTokens: raw?.tokens?.cacheWrite ?? raw?.tokens?.cache_write,
          outputTokens: num(raw?.tokens?.output)
            + (String(raw?.client || '').trim().toLowerCase() === REASONIX_CLIENT
              ? num(raw?.tokens?.reasoning)
              : 0)
        });
        if (!candidate) continue;
        const key = observationKey(candidate);
        const previous = day.observations[key];
        if (!previous) {
          day.observations[key] = candidate;
          continue;
        }
        day.observations[key] = normalizeObservation({
          ...candidate,
          providerId: candidate.providerId || previous.providerId,
          tokens: previous.tokens + candidate.tokens,
          cost: previous.cost + candidate.cost,
          messages: previous.messages + candidate.messages,
          reasoningTokens: num(previous.reasoningTokens) + num(candidate.reasoningTokens),
          tokenComponentsAvailable: previous.tokenComponentsAvailable === true
            && candidate.tokenComponentsAvailable === true,
          cacheReadTokens: num(previous.cacheReadTokens) + num(candidate.cacheReadTokens),
          cacheWriteTokens: num(previous.cacheWriteTokens) + num(candidate.cacheWriteTokens),
          outputTokens: num(previous.outputTokens) + num(candidate.outputTokens),
          unclassifiedTokens: num(previous.unclassifiedTokens) + num(candidate.unclassifiedTokens)
        });
      }
      days.set(date, day);
    }
  }
  return days;
}

function shouldReplaceObservation(previous, incoming) {
  if (!previous) return true;
  if (incoming.tokens !== previous.tokens) return incoming.tokens > previous.tokens;
  if (incoming.messages !== previous.messages) return incoming.messages > previous.messages;
  // Equal usage can legitimately receive corrected pricing or richer metadata.
  // Replace the whole observation so token and cost values always share a source.
  return true;
}

function captureDailyHistoryArchive(existingArchive, graphs, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);
  const incomingDays = observationsFromGraphs(graphs);

  for (const [date, incoming] of incomingDays) {
    if (hasTodayKey && date > todayKey) continue;
    const previous = archive.days[date] || { date, activeTimeMs: 0, observations: {} };
    const next = {
      date,
      activeTimeMs: Math.max(previous.activeTimeMs, incoming.activeTimeMs),
      observations: { ...previous.observations }
    };
    for (const [key, observation] of Object.entries(incoming.observations)) {
      if (shouldReplaceObservation(previous.observations[key], observation)) {
        next.observations[key] = observation;
      }
    }
    const normalized = normalizeDay(next, date);
    if (normalized) archive.days[date] = normalized;
  }

  // Presentation and sync windows are intentionally applied later by
  // normalizeHistory(). The local archive keeps every observed past day so a
  // future year selector can read it without depending on source transcripts.
  if (hasTodayKey) {
    for (const date of Object.keys(archive.days)) {
      if (date > todayKey) delete archive.days[date];
    }
  }
  return archive;
}

function periodLiveDay(period, date) {
  if (!period || typeof period !== 'object' || !DAY_KEY_RE.test(date)) return null;
  const observations = new Map();
  const addObservation = (client, modelId, tokens, cost) => {
    const observation = {
      client,
      modelId,
      tokens: Math.max(0, Math.round(num(tokens))),
      cost: Math.max(0, num(cost)),
      messages: 0
    };
    const key = observationKey(observation);
    const previous = observations.get(key);
    if (!previous) {
      observations.set(key, observation);
      return;
    }
    previous.tokens += observation.tokens;
    previous.cost += observation.cost;
  };
  const clientModels = period.clientModels && typeof period.clientModels === 'object'
    ? period.clientModels
    : {};
  const clientModelCosts = period.clientModelCosts && typeof period.clientModelCosts === 'object'
    ? period.clientModelCosts
    : {};
  const clients = period.clients && typeof period.clients === 'object' ? period.clients : {};
  const clientCosts = period.clientCosts && typeof period.clientCosts === 'object' ? period.clientCosts : {};
  const clientIds = new Set([...Object.keys(clientModels), ...Object.keys(clients), ...Object.keys(clientCosts)]);

  for (const client of clientIds) {
    const models = clientModels[client] && typeof clientModels[client] === 'object'
      ? clientModels[client]
      : {};
    const modelIds = Object.keys(models);
    let modeledTokens = 0;
    let modeledCost = 0;
    for (const modelId of modelIds) {
      const modelTokens = Math.max(0, Math.round(num(models[modelId])));
      const modelCost = Math.max(0, num(clientModelCosts[client]?.[modelId]));
      addObservation(client, modelId, modelTokens, modelCost);
      modeledTokens += modelTokens;
      modeledCost += modelCost;
    }
    const clientTokens = Math.max(0, Math.round(num(clients[client])));
    const clientCost = Math.max(0, num(clientCosts[client]));
    const remainderTokens = Math.max(0, clientTokens - modeledTokens);
    const remainderCost = Math.max(0, clientCost - modeledCost);
    if (modelIds.length === 0 || remainderTokens > 0 || remainderCost > 0) {
      addObservation(client, 'unknown', remainderTokens, remainderCost);
    }
  }

  const totalTokens = Math.max(0, Math.round(num(period.totalTokens)));
  const totalCost = Math.max(0, num(period.costUsd));
  const observed = [...observations.values()];
  const observedTokens = observed.reduce((sum, observation) => sum + observation.tokens, 0);
  const observedCost = observed.reduce((sum, observation) => sum + observation.cost, 0);
  if (totalTokens > observedTokens || totalCost > observedCost) {
    addObservation(
      'unknown',
      'unknown',
      Math.max(0, totalTokens - observedTokens),
      Math.max(0, totalCost - observedCost)
    );
  }

  const hasKnownComponents = num(period.cacheReadTokens)
    + num(period.cacheWriteTokens)
    + num(period.outputTokens) > 0;
  const componentSummary = totalTokens > 0
    && (period.capabilities?.tokenComponents === true || hasKnownComponents)
    ? {
        tokenComponentsAvailable: period.capabilities?.tokenComponents === true,
        cacheReadTokens: num(period.cacheReadTokens),
        cacheWriteTokens: num(period.cacheWriteTokens),
        outputTokens: num(period.outputTokens),
        unclassifiedTokens: num(period.unclassifiedTokens),
        perClient: Object.fromEntries([...clientIds].map((client) => [client, {
          cacheReadTokens: num(period.clientCacheReads?.[client]),
          cacheWriteTokens: num(period.clientCacheWrites?.[client]),
          outputTokens: num(period.clientOutputs?.[client]),
          unclassifiedTokens: num(period.clientUnclassifiedTokens?.[client])
        }])),
        perModel: Object.fromEntries(Object.keys(period.models || {}).map((model) => [model, {
          cacheReadTokens: num(period.modelCacheReads?.[model]),
          cacheWriteTokens: num(period.modelCacheWrites?.[model]),
          outputTokens: num(period.modelOutputs?.[model]),
          unclassifiedTokens: num(period.modelUnclassifiedTokens?.[model])
        }]))
      }
    : null;
  const day = normalizeDay({
    date,
    activeTimeMs: 0,
    observations: [...observations.values()],
    ...(componentSummary ? { componentSummary } : {})
  }, date);
  return day && Object.keys(day.observations).length > 0 ? day : null;
}

function dayTokens(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.tokens), 0);
}

function dayCost(day) {
  return Object.values(day?.observations || {}).reduce((sum, observation) => sum + num(observation.cost), 0);
}

function dayComponentQuality(day) {
  if (day?.componentSummary?.tokenComponentsAvailable === true) return 2;
  if (day?.componentSummary) return 1;
  const usage = Object.values(day?.observations || {}).filter((observation) => num(observation.tokens) > 0);
  if (usage.length === 0 || usage.every((observation) => observation.tokenComponentsAvailable === true)) return 2;
  return usage.some((observation) => (
    num(observation.cacheReadTokens) > 0
    || num(observation.cacheWriteTokens) > 0
    || num(observation.outputTokens) > 0
  )) ? 1 : 0;
}

function liveDayIsGreater(incoming, previous) {
  const incomingTokens = dayTokens(incoming);
  const previousTokens = dayTokens(previous);
  if (incomingTokens !== previousTokens) return incomingTokens > previousTokens;
  const qualityDifference = dayComponentQuality(incoming) - dayComponentQuality(previous);
  if (qualityDifference !== 0) return qualityDifference > 0;
  // Equal usage can receive a corrected price in either direction. The later
  // live observation is authoritative once its provenance quality is equal.
  return dayCost(incoming) !== dayCost(previous);
}

function mergeLiveDayMetadata(liveDay, previousDay) {
  if (!previousDay) return liveDay;
  const observations = Object.fromEntries(Object.entries(liveDay.observations).map(([key, observation]) => {
    const previous = previousDay.observations[key];
    if (!previous) return [key, observation];
    if (liveDay.componentSummary) {
      return [key, {
        ...observation,
        messages: Math.max(observation.messages, previous.messages),
        ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
          ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
          : {})
      }];
    }
    const incomingTokens = num(observation.tokens);
    const previousTokens = num(previous.tokens);
    const canRetainPreviousComponents = incomingTokens >= previousTokens;
    const previousUnclassified = Math.min(previousTokens, num(previous.unclassifiedTokens));
    const unclassifiedTokens = canRetainPreviousComponents
      ? previousUnclassified + (incomingTokens - previousTokens)
      : incomingTokens;
    return [key, {
      ...observation,
      messages: Math.max(observation.messages, previous.messages),
      ...(canRetainPreviousComponents && previousTokens - previousUnclassified > 0 ? {
        cacheReadTokens: num(previous.cacheReadTokens),
        cacheWriteTokens: num(previous.cacheWriteTokens),
        outputTokens: num(previous.outputTokens)
      } : {}),
      ...(unclassifiedTokens > 0 ? { unclassifiedTokens } : {}),
      ...(unclassifiedTokens === 0 ? { tokenComponentsAvailable: true } : {}),
      ...(Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) > 0
        ? { reasoningTokens: Math.max(num(observation.reasoningTokens), num(previous.reasoningTokens)) }
        : {})
    }];
  }));
  return {
    ...liveDay,
    activeTimeMs: Math.max(liveDay.activeTimeMs, previousDay.activeTimeMs),
    observations
  };
}

function captureLiveDailyHistory(existingArchive, period, options = {}) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const date = String(options.todayKey || '').slice(0, 10);
  if (DAY_KEY_RE.test(date) && archive.liveDays) {
    for (const liveDate of Object.keys(archive.liveDays)) {
      if (liveDate > date) delete archive.liveDays[liveDate];
    }
  }
  const incoming = periodLiveDay(period, date);
  if (!incoming) return archive;
  const previous = archive.liveDays?.[date];
  if (!previous || liveDayIsGreater(incoming, previous)) {
    archive.liveDays = { ...(archive.liveDays || {}), [date]: incoming };
  }
  return archive;
}

function graphTimeMetrics(graphs, activeTimeMs) {
  const source = graphsArray(graphs)
    .map((graph) => graph.timeMetrics ?? graph.time_metrics)
    .find((value) => value && typeof value === 'object');
  if (!source) return null;
  return {
    ...source,
    totalActiveTimeMs: Math.max(
      num(source.totalActiveTimeMs ?? source.total_active_time_ms),
      activeTimeMs
    )
  };
}

function graphFromDailyHistoryArchive(graphs, archive, options = {}) {
  const currentDays = observationsFromGraphs(graphs);
  const normalizedArchive = normalizeDailyHistoryArchive(archive);
  const todayKey = String(options.todayKey || '').slice(0, 10);
  const hasTodayKey = DAY_KEY_RE.test(todayKey);

  for (const [date, day] of Object.entries(normalizedArchive.days)) {
    if (hasTodayKey && date > todayKey) continue;
    currentDays.set(date, day);
  }
  for (const [date, liveDay] of Object.entries(normalizedArchive.liveDays || {})) {
    if (hasTodayKey && date > todayKey) continue;
    const previous = currentDays.get(date);
    if (!previous || liveDayIsGreater(liveDay, previous)) {
      currentDays.set(date, mergeLiveDayMetadata(liveDay, previous));
    }
  }

  const contributions = [...currentDays.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      date: day.date,
      activeTimeMs: day.activeTimeMs,
      ...(day.componentSummary ? { tokenComponentSummary: day.componentSummary } : {}),
      clients: Object.values(day.observations)
        .sort((left, right) => observationKey(left).localeCompare(observationKey(right)))
        .map((observation) => ({
          client: observation.client,
          modelId: observation.modelId,
          ...(observation.providerId ? { providerId: observation.providerId } : {}),
          tokens: {
            input: Math.max(0, observation.tokens
              - num(observation.outputTokens)
              - num(observation.cacheReadTokens)
              - num(observation.cacheWriteTokens)),
            output: num(observation.outputTokens),
            cacheRead: num(observation.cacheReadTokens),
            cacheWrite: num(observation.cacheWriteTokens),
            // Archive observations store one already-aggregated output family.
            // Re-emitting reasoning separately would count it twice.
            reasoning: 0
          },
          tokenComponentsAvailable: observation.tokenComponentsAvailable === true,
          ...(num(observation.unclassifiedTokens) > 0
            ? { unclassifiedTokens: num(observation.unclassifiedTokens) }
            : {}),
          cost: observation.cost,
          messages: observation.messages
        }))
    }));
  const activeTimeMs = contributions.reduce((sum, day) => sum + num(day.activeTimeMs), 0);
  const timeMetrics = graphTimeMetrics(graphs, activeTimeMs);
  return { contributions, ...(timeMetrics ? { timeMetrics } : {}) };
}

function dailyHistoryArchivePath(options = {}) {
  return options.path || path.join(sharedDataDir(options), 'daily-history-archive.json');
}

function readDailyHistoryArchive(options = {}) {
  const read = options.readJson || readJson;
  return normalizeDailyHistoryArchive(read(dailyHistoryArchivePath(options), {}));
}

function writeDailyHistoryArchive(archive, options = {}) {
  const write = options.writeJsonAtomic || writeJsonAtomic;
  write(dailyHistoryArchivePath(options), normalizeDailyHistoryArchive(archive));
}

function clearDailyHistoryArchive(options = {}) {
  const unlink = options.unlinkSync || fs.unlinkSync;
  try {
    unlink(dailyHistoryArchivePath(options));
    return true;
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
}

function mergeLiveDaysIntoArchive(existingArchive, liveDays) {
  const archive = normalizeDailyHistoryArchive(existingArchive);
  const incoming = normalizeDailyHistoryArchive({ liveDays }).liveDays || {};
  for (const [date, liveDay] of Object.entries(incoming)) {
    const previous = archive.liveDays?.[date];
    if (!previous || liveDayIsGreater(liveDay, previous)) {
      archive.liveDays = { ...(archive.liveDays || {}), [date]: liveDay };
    }
  }
  return archive;
}

function archiveWriteEnabled(options = {}) {
  return typeof options.writeEnabled === 'function'
    ? options.writeEnabled() !== false
    : options.writeEnabled !== false;
}

function retainDailyHistory(graphs, options = {}) {
  const previous = readDailyHistoryArchive(options);
  const capture = (archive) => captureDailyHistoryArchive(
    mergeLiveDaysIntoArchive(archive, options.liveDays),
    graphs,
    options
  );
  let next = capture(previous);
  // Ownership can change while a graph scan is running (for example, a
  // headless agent starts after Electron's collector tick begins). Resolve a
  // lazy guard immediately before the write instead of freezing it at startup.
  if (archiveWriteEnabled(options) && !isDeepStrictEqual(previous, next)) {
    // The graph scan can take long enough for the other collector to update the
    // shared archive. Rebase on the latest file immediately before writing so
    // this scan cannot put that newer observation back on disk.
    const latest = readDailyHistoryArchive(options);
    next = capture(latest);
    if (archiveWriteEnabled(options) && !isDeepStrictEqual(latest, next)) {
      writeDailyHistoryArchive(next, options);
    }
  }
  return graphFromDailyHistoryArchive(graphs, next, options);
}

function retainLiveDailyHistory(period, options = {}) {
  const previous = readDailyHistoryArchive(options);
  const capture = (archive) => captureLiveDailyHistory(
    mergeLiveDaysIntoArchive(archive, options.liveDays),
    period,
    options
  );
  let next = capture(previous);
  if (archiveWriteEnabled(options) && !isDeepStrictEqual(previous, next)) {
    const latest = readDailyHistoryArchive(options);
    next = capture(latest);
    if (archiveWriteEnabled(options) && !isDeepStrictEqual(latest, next)) {
      writeDailyHistoryArchive(next, options);
    }
  }
  return next;
}

module.exports = {
  captureDailyHistoryArchive,
  clearDailyHistoryArchive,
  dailyHistoryArchivePath,
  graphFromDailyHistoryArchive,
  captureLiveDailyHistory,
  normalizeDailyHistoryArchive,
  observationKey,
  readDailyHistoryArchive,
  retainDailyHistory,
  retainLiveDailyHistory,
  shouldReplaceObservation,
  writeDailyHistoryArchive
};
