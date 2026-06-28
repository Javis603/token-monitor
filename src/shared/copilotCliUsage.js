'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { addPeriodInto, emptyPeriod } = require('./usage');

function asNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function tokenDetailCount(details, name) {
  return Math.max(0, Math.round(asNumber(details?.[name]?.tokenCount ?? details?.[name]?.token_count)));
}

function usageNumber(usage, camel, snake) {
  return Math.max(0, Math.round(asNumber(usage?.[camel] ?? usage?.[snake])));
}

function isoFromMs(value) {
  const ms = asNumber(value);
  if (ms <= 0) return '';
  const date = new Date(ms);
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function isoFromValue(value) {
  const date = new Date(value || '');
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function localDayKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function localMonthKey(date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

function startOfLocalDayMs(value) {
  const match = String(value || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!match) return 0;
  const [, year, month, day] = match;
  return new Date(Number(year), Number(month) - 1, Number(day), 0, 0, 0, 0).getTime();
}

function sessionFromShutdown(event, fallbackSessionId) {
  const data = event?.data;
  if (!data || typeof data !== 'object') return null;
  const sessionId = String(data.sessionId || data.sessionID || fallbackSessionId || '').trim();
  if (!sessionId) return null;
  const lastUsedAt = isoFromValue(event.timestamp);
  if (!lastUsedAt) return null;

  const session = {
    client: 'copilot',
    sessionId,
    totalTokens: 0,
    costUsd: 0,
    messageCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    startedAt: isoFromMs(data.sessionStartTime) || lastUsedAt,
    lastUsedAt,
    models: {},
    modelCosts: {},
    providers: { github: 0 }
  };

  const metrics = data.modelMetrics && typeof data.modelMetrics === 'object' ? data.modelMetrics : {};
  for (const [model, metric] of Object.entries(metrics)) {
    const usage = metric?.usage || {};
    const inputTokens = usageNumber(usage, 'inputTokens', 'input_tokens');
    const outputTokens = usageNumber(usage, 'outputTokens', 'output_tokens');
    const cacheReadTokens = usageNumber(usage, 'cacheReadTokens', 'cache_read_tokens');
    const cacheWriteTokens = usageNumber(usage, 'cacheWriteTokens', 'cache_write_tokens');
    const reasoningTokens = usageNumber(usage, 'reasoningTokens', 'reasoning_tokens');
    const totalTokens = inputTokens + outputTokens + cacheReadTokens + cacheWriteTokens;
    if (totalTokens <= 0) continue;
    session.inputTokens += inputTokens;
    session.outputTokens += outputTokens;
    session.cacheReadTokens += cacheReadTokens;
    session.cacheWriteTokens += cacheWriteTokens;
    session.reasoningTokens += reasoningTokens;
    session.totalTokens += totalTokens;
    session.messageCount += Math.max(0, Math.round(asNumber(metric?.requests?.count)));
    session.models[model] = (session.models[model] || 0) + totalTokens;
  }

  if (session.totalTokens === 0) {
    const details = data.tokenDetails || {};
    session.inputTokens = tokenDetailCount(details, 'input');
    session.outputTokens = tokenDetailCount(details, 'output');
    session.cacheReadTokens = tokenDetailCount(details, 'cache_read') || tokenDetailCount(details, 'cacheRead');
    session.cacheWriteTokens = tokenDetailCount(details, 'cache_write') || tokenDetailCount(details, 'cacheWrite');
    session.totalTokens = session.inputTokens + session.outputTokens + session.cacheReadTokens + session.cacheWriteTokens;
    const model = String(data.currentModel || 'github-copilot').trim();
    if (session.totalTokens > 0) session.models[model] = session.totalTokens;
  }

  if (session.totalTokens <= 0) return null;
  session.providers.github = session.totalTokens;
  return session;
}

function readLastShutdownSession(filePath, fallbackSessionId) {
  let last = null;
  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const event = JSON.parse(line);
      if (event?.type === 'session.shutdown') last = sessionFromShutdown(event, fallbackSessionId) || last;
    } catch (_) {}
  }
  return last;
}

function copilotCliEventFiles(homeDir = os.homedir()) {
  const root = path.join(homeDir, '.copilot', 'session-state');
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => ({ sessionId: entry.name, filePath: path.join(root, entry.name, 'events.jsonl') }))
    .filter((entry) => {
      try { return fs.statSync(entry.filePath).isFile(); } catch (_) { return false; }
    });
}

function periodFromSession(session) {
  const period = emptyPeriod();
  period.totalTokens = session.totalTokens;
  period.costUsd = session.costUsd;
  period.cacheReadTokens = session.cacheReadTokens;
  period.cacheWriteTokens = session.cacheWriteTokens;
  period.outputTokens = session.outputTokens;
  period.clients.copilot = session.totalTokens;
  if (session.cacheReadTokens > 0) period.clientCacheReads.copilot = session.cacheReadTokens;
  if (session.cacheWriteTokens > 0) period.clientCacheWrites.copilot = session.cacheWriteTokens;
  if (session.outputTokens > 0) period.clientOutputs.copilot = session.outputTokens;
  period.clientModels.copilot = { ...session.models };
  period.sessions[`copilot:${session.sessionId}`] = session;
  for (const [model, tokens] of Object.entries(session.models)) {
    period.models[model] = (period.models[model] || 0) + tokens;
    if (session.cacheReadTokens > 0) period.modelCacheReads[model] = (period.modelCacheReads[model] || 0) + session.cacheReadTokens;
    if (session.cacheWriteTokens > 0) period.modelCacheWrites[model] = (period.modelCacheWrites[model] || 0) + session.cacheWriteTokens;
    if (session.outputTokens > 0) period.modelOutputs[model] = (period.modelOutputs[model] || 0) + session.outputTokens;
  }
  return period;
}

function collectCopilotCliPeriods(options = {}) {
  const now = options.now != null ? new Date(options.now) : new Date();
  const todayKey = localDayKey(now);
  const monthKey = localMonthKey(now);
  const sinceMs = startOfLocalDayMs(options.allTimeSince) || 0;
  const result = { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };

  for (const entry of copilotCliEventFiles(options.homeDir || os.homedir())) {
    const session = readLastShutdownSession(entry.filePath, entry.sessionId);
    if (!session) continue;
    const used = new Date(session.lastUsedAt);
    const usedMs = used.getTime();
    if (!Number.isFinite(usedMs) || usedMs < sinceMs) continue;
    const period = periodFromSession(session);
    addPeriodInto(result.allTime, period);
    if (localMonthKey(used) === monthKey) addPeriodInto(result.month, period);
    if (localDayKey(used) === todayKey) addPeriodInto(result.today, period);
  }
  return result;
}

module.exports = {
  collectCopilotCliPeriods,
  copilotCliEventFiles,
  readLastShutdownSession,
  sessionFromShutdown
};
