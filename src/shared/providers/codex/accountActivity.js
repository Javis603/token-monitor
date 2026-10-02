'use strict';

const { computeStreaks, dayKeyAddDays, localDayKey } = require('../../history');

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const FRESHNESS_MS = 60 * 60 * 1000;

function isAccountActivityStale(snapshot, nowMs = Date.now()) {
  if (!snapshot) return false;
  const ageMs = nowMs - Date.parse(snapshot.fetchedAt);
  return !Number.isFinite(ageMs) || ageMs > FRESHNESS_MS || ageMs < -5 * 60 * 1000;
}

function tokenCount(value) {
  return Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function normalizeAccountActivity(raw, accountKey) {
  const activity = raw?.codexAccountActivity;
  const lifetimeTokens = tokenCount(activity?.lifetimeTokens);
  if (!accountKey || activity?.status !== 'available' || activity?.source !== 'codex-app-server' || lifetimeTokens === null) return null;
  const fetchedAtMs = Date.parse(activity.fetchedAt || '');
  if (!Number.isFinite(fetchedAtMs)) return null;
  const fetchedAt = new Date(fetchedAtMs).toISOString();
  const dailyUsageBuckets = [];
  const seen = new Set();
  if (activity.dailyUsageBuckets != null && !Array.isArray(activity.dailyUsageBuckets)) return null;
  for (const bucket of activity.dailyUsageBuckets || []) {
    const date = bucket?.startDate;
    const tokens = tokenCount(bucket?.tokens);
    if (!DAY_RE.test(date || '') || Number.isNaN(Date.parse(`${date}T00:00:00Z`))
      || new Date(`${date}T00:00:00Z`).toISOString().slice(0, 10) !== date || tokens === null || seen.has(date)) return null;
    seen.add(date);
    dailyUsageBuckets.push({ date, tokens });
  }
  dailyUsageBuckets.sort((a, b) => a.date.localeCompare(b.date));
  const sum = dailyUsageBuckets.reduce((total, bucket) => total + bucket.tokens, 0);
  return {
    version: 1,
    accountKey,
    source: 'codex-app-server',
    fetchedAt,
    lifetimeTokens,
    dailyUsageBuckets,
    dailyCoverageComplete: dailyUsageBuckets.length > 0 && Number.isSafeInteger(sum) && sum === lifetimeTokens
  };
}

function selectAccountActivity(current, incoming, { correctionConfirmed = false } = {}) {
  if (!incoming) return { snapshot: current || null, conflict: false };
  if (!current || current.accountKey !== incoming.accountKey) return { snapshot: incoming, conflict: false };
  if (incoming.fetchedAt < current.fetchedAt) return { snapshot: current, conflict: false };
  if (incoming.lifetimeTokens < current.lifetimeTokens && !correctionConfirmed) return { snapshot: current, conflict: true };
  return { snapshot: incoming, conflict: false };
}

function accountCurrentStreak(buckets, nowMs) {
  const active = (buckets || []).filter((bucket) => bucket.tokens > 0);
  if (active.length === 0) return 0;
  const todayMs = Date.parse(`${new Date(nowMs).toISOString().slice(0, 10)}T00:00:00Z`);
  let expectedMs = Date.parse(`${active[active.length - 1].date}T00:00:00Z`);
  if (todayMs - expectedMs < 0 || todayMs - expectedMs > 86400000) return 0;
  let streak = 0;
  for (let index = active.length - 1; index >= 0; index -= 1) {
    const dayMs = Date.parse(`${active[index].date}T00:00:00Z`);
    if (dayMs !== expectedMs) break;
    streak += 1;
    expectedMs -= 86400000;
  }
  return streak;
}

function applyAccountActivityToStats(stats, snapshot, allTimeSince, localDeviceId = '', singleAccount = true, nowMs = Date.now()) {
  if (!stats || !snapshot) return stats;
  if (!singleAccount) return { ...stats, codexAccountActivity: { status: 'scope-unverified', fetchedAt: snapshot.fetchedAt } };
  if (stats.codexAccountActivity?.source === snapshot.source && stats.codexAccountActivity?.fetchedAt === snapshot.fetchedAt) return stats;
  const earliest = snapshot.dailyUsageBuckets?.[0]?.date;
  const covered = snapshot.dailyCoverageComplete === true && earliest && allTimeSince <= earliest;
  if (!covered) return { ...stats, codexAccountActivity: { status: 'range-unverified', fetchedAt: snapshot.fetchedAt } };
  if (Array.isArray(stats.devices) && stats.devices.some((device) =>
    device.deviceId !== localDeviceId && Number(device.periods?.allTime?.clients?.codex || 0) > 0)) {
    return { ...stats, codexAccountActivity: { status: 'scope-unverified', fetchedAt: snapshot.fetchedAt } };
  }
  const original = stats.periods?.allTime;
  if (!original) return stats;
  const localTokens = Number(original.clients?.codex || 0);
  const officialTokens = snapshot.lifetimeTokens;
  const stale = isAccountActivityStale(snapshot, nowMs);
  if (!Number.isSafeInteger(localTokens) || localTokens < 0
    || !Number.isSafeInteger(original.totalTokens)
    || !Number.isSafeInteger(original.totalTokens - localTokens + officialTokens)) {
    return { ...stats, codexAccountActivity: { status: 'conflict', fetchedAt: snapshot.fetchedAt } };
  }
  const period = {
    ...original,
    capabilities: { ...original.capabilities, tokenComponents: false },
    clients: { ...original.clients, codex: officialTokens },
    clientCacheReads: { ...original.clientCacheReads },
    clientCacheWrites: { ...original.clientCacheWrites },
    clientOutputs: { ...original.clientOutputs },
    clientUnclassifiedTokens: { ...original.clientUnclassifiedTokens, codex: officialTokens },
    totalTokens: original.totalTokens - localTokens + officialTokens,
    cacheReadTokens: Math.max(0, original.cacheReadTokens - (original.clientCacheReads?.codex || 0)),
    cacheWriteTokens: Math.max(0, original.cacheWriteTokens - (original.clientCacheWrites?.codex || 0)),
    outputTokens: Math.max(0, original.outputTokens - (original.clientOutputs?.codex || 0)),
    unclassifiedTokens: Math.max(0, original.unclassifiedTokens - (original.clientUnclassifiedTokens?.codex || 0)) + officialTokens
  };
  delete period.clientCacheReads.codex;
  delete period.clientCacheWrites.codex;
  delete period.clientOutputs.codex;
  if (localTokens > officialTokens) {
    // A local rollup above the account total cannot be a trustworthy partial
    // breakdown. Suppress the all-time details instead of inventing a split.
    for (const field of ['models', 'modelCosts', 'modelCacheReads', 'modelCacheWrites',
      'modelOutputs', 'modelUnclassifiedTokens', 'projects', 'sessions']) period[field] = {};
    period.clientModels = {};
    period.clientModelCosts = {};
    period.clientCosts = { ...original.clientCosts };
    period.costUsd = Math.max(0, original.costUsd - (period.clientCosts.codex || 0));
    delete period.clientCosts.codex;
    period.capabilities.throughput = false;
    period.timedTokens = 0;
    period.timedOutputTokens = 0;
    period.timedDurationMs = 0;
  }
  let status = 'applied';
  if (stale) status = 'stale';
  else if (localTokens > officialTokens) status = 'conflict';
  const result = {
    ...stats,
    periods: { ...stats.periods, allTime: period },
    codexAccountActivity: {
      status,
      source: snapshot.source,
      fetchedAt: snapshot.fetchedAt,
      lifetimeTokens: officialTokens,
      localDetailTokens: localTokens,
      detailsSuppressed: localTokens > officialTokens,
      dateBoundary: 'source-defined',
      ...(status === 'applied' ? { currentStreak: accountCurrentStreak(snapshot.dailyUsageBuckets, nowMs) } : {})
    }
  };
  if (localTokens > officialTokens) delete result.allTimeSessionsView;
  return result;
}

// The account reading has token buckets but no cost, model or task-time data.
// Replace only Codex tokens on each source-defined date; leave every local-only
// field untouched. The already-presented All Time total is the headline source
// of truth, so Dashboard and Home cannot disagree after the same validation.
function projectAccountActivityToHistory(history, snapshot, presentedStats, options = {}) {
  const account = presentedStats?.codexAccountActivity;
  if (!history || !snapshot?.dailyCoverageComplete
    || !['applied', 'stale'].includes(account?.status)
    || account.source !== snapshot.source || account.fetchedAt !== snapshot.fetchedAt
    || account.lifetimeTokens !== snapshot.lifetimeTokens
    || !Number.isSafeInteger(presentedStats?.periods?.allTime?.totalTokens)) return history;

  const buckets = new Map(snapshot.dailyUsageBuckets.map(({ date, tokens }) => [date, tokens]));
  const months = new Map();
  for (const [date, tokens] of buckets) months.set(date.slice(0, 7), (months.get(date.slice(0, 7)) || 0) + tokens);
  const replaceCodex = (row, accountTokens) => {
    const original = Number(row?.tokens || 0);
    const localCodex = Number(row?.perClient?.codex?.tokens || 0);
    if (!row?.perClient || !Number.isSafeInteger(original) || !Number.isSafeInteger(localCodex)
      || localCodex < 0 || original < localCodex) return null;
    return {
      ...row,
      tokens: original - localCodex + accountTokens,
      perClient: { ...row.perClient, codex: { ...row.perClient.codex, tokens: accountTokens } }
    };
  };
  const projectRows = (rows, field, accountByKey) => {
    const result = [];
    const remaining = new Map(accountByKey);
    for (const row of rows || []) {
      const key = String(row?.[field] || '');
      const projected = replaceCodex(row, remaining.get(key) || 0);
      if (!projected) return null;
      result.push(projected);
      remaining.delete(key);
    }
    for (const [key, tokens] of remaining) {
      result.push({ [field]: key, tokens, cost: 0, activeTimeMs: 0, perClient: { codex: { tokens, cost: 0 } }, perModel: {} });
    }
    return result.sort((a, b) => a[field].localeCompare(b[field]));
  };
  const fullDaily = projectRows(history.daily, 'date', buckets);
  const monthly = projectRows(history.monthly, 'month', months);
  if (!fullDaily || !monthly) return history;
  const now = new Date(options.nowMs ?? Date.now());
  const today = String(options.todayKey || (account.status === 'applied'
    ? now.toISOString().slice(0, 10) : localDayKey(now))).slice(0, 10);
  const streaks = computeStreaks(fullDaily, today);
  const currentStreak = streaks.currentStreak || computeStreaks(fullDaily, dayKeyAddDays(today, -1)).currentStreak;
  return {
    ...history,
    daily: fullDaily.filter((row) => row.date >= dayKeyAddDays(today, -369) && row.date <= today),
    monthly,
    summary: {
      ...history.summary,
      totalTokens: presentedStats.periods.allTime.totalTokens,
      activeDays: fullDaily.filter((row) => row.tokens > 0).length,
      currentStreak: account.status === 'applied' ? currentStreak : history.summary?.currentStreak || 0,
      longestStreak: account.status === 'applied'
        ? Math.max(history.summary?.longestStreak || 0, streaks.longestStreak)
        : history.summary?.longestStreak || 0,
      peakDayTokens: fullDaily.reduce((peak, row) => Math.max(peak, row.tokens), 0)
    },
    codexAccountActivity: { status: account.status, fetchedAt: account.fetchedAt, dateBoundary: 'source-defined' }
  };
}

module.exports = { normalizeAccountActivity, selectAccountActivity, applyAccountActivityToStats, projectAccountActivityToHistory, isAccountActivityStale };
