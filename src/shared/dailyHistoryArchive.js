'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { isDeepStrictEqual } = require('node:util');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');
const { num, sumTokens } = require('./history');

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
    ...(reasoningTokens > 0 ? { reasoningTokens } : {})
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
  return {
    date,
    activeTimeMs: Math.max(0, Math.round(num(value?.activeTimeMs))),
    observations
  };
}

function normalizeDailyHistoryArchive(value) {
  const normalized = { version: ARCHIVE_VERSION, days: {} };
  const source = value?.days && typeof value.days === 'object' ? value.days : {};
  for (const [date, rawDay] of Object.entries(source)) {
    const day = normalizeDay(rawDay, date);
    if (day) normalized.days[day.date] = day;
  }
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
          tokens: sumTokens(raw?.tokens),
          reasoningTokens: raw?.tokens?.reasoning
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
          reasoningTokens: num(previous.reasoningTokens) + num(candidate.reasoningTokens)
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

  const contributions = [...currentDays.values()]
    .sort((left, right) => left.date.localeCompare(right.date))
    .map((day) => ({
      date: day.date,
      activeTimeMs: day.activeTimeMs,
      clients: Object.values(day.observations)
        .sort((left, right) => observationKey(left).localeCompare(observationKey(right)))
        .map((observation) => ({
          client: observation.client,
          modelId: observation.modelId,
          ...(observation.providerId ? { providerId: observation.providerId } : {}),
          tokens: {
            input: observation.tokens,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            reasoning: num(observation.reasoningTokens)
          },
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

function retainDailyHistory(graphs, options = {}) {
  const previous = readDailyHistoryArchive(options);
  const next = captureDailyHistoryArchive(previous, graphs, options);
  // Ownership can change while a graph scan is running (for example, a
  // headless agent starts after Electron's collector tick begins). Resolve a
  // lazy guard immediately before the write instead of freezing it at startup.
  const writeEnabled = typeof options.writeEnabled === 'function'
    ? options.writeEnabled() !== false
    : options.writeEnabled !== false;
  if (writeEnabled && !isDeepStrictEqual(previous, next)) {
    writeDailyHistoryArchive(next, options);
  }
  return graphFromDailyHistoryArchive(graphs, next, options);
}

module.exports = {
  captureDailyHistoryArchive,
  clearDailyHistoryArchive,
  dailyHistoryArchivePath,
  graphFromDailyHistoryArchive,
  normalizeDailyHistoryArchive,
  observationKey,
  readDailyHistoryArchive,
  retainDailyHistory,
  shouldReplaceObservation,
  writeDailyHistoryArchive
};
