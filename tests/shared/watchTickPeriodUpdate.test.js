'use strict';

// Watch ticks used to rebuild month/allTime through applyPeriodDelta's full
// recursive copy and then mergePeriods, which normalizePeriod'd every retained
// session again. On a 10k-session history that was ~150ms and ~15MB of garbage
// every few seconds, before tokscale even ran. Unchanged sessions are re-shelled
// once; the published values still match the old merge.

const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const test = require('node:test');
const {
  applyPeriodDelta,
  emptyPeriod,
  mergeNormalizedPeriods,
  mergePeriods,
  normalizePeriod
} = require('../../src/shared/usage');

function session(index, tokens, extra = {}) {
  return {
    client: 'claude',
    sessionId: `s${index}`,
    totalTokens: tokens,
    costUsd: tokens / 1e6,
    messageCount: 3,
    inputTokens: 4,
    outputTokens: 1,
    cacheReadTokens: 4,
    cacheWriteTokens: 1,
    reasoningTokens: 0,
    timedOutputTokens: 1,
    timedDurationMs: 10,
    startedAt: '2026-01-01T00:00:00.000Z',
    lastUsedAt: '2026-08-01T00:00:00.000Z',
    contextTokens: 12,
    contextWindow: 200000,
    projectId: 'p',
    projectLabel: 'proj',
    title: `title ${index}`,
    models: { 'claude-opus': tokens },
    modelCosts: { 'claude-opus': tokens / 1e6 },
    providers: { anthropic: tokens },
    ...(index % 2 === 0 ? { turnEnded: true, parentSessionId: 'parent' } : {}),
    ...extra
  };
}

function periodFrom(sessions, extra = {}) {
  let total = 0;
  for (const row of Object.values(sessions)) total += row.totalTokens;
  return normalizePeriod({
    totalTokens: total,
    costUsd: total / 1e6,
    outputTokens: 1,
    cacheReadTokens: 1,
    cacheWriteTokens: 1,
    timedOutputTokens: 1,
    timedDurationMs: 1,
    timedTokens: 1,
    clients: { claude: total },
    models: { 'claude-opus': total },
    clientModels: { claude: { 'claude-opus': total } },
    projects: { p: { label: 'proj', tokens: total, costUsd: total / 1e6, clients: { claude: total } } },
    sessions,
    ...extra
  });
}

function watchTick(count, todayCount = 20) {
  const history = {};
  for (let index = 0; index < count; index += 1) history[`claude:s${index}`] = session(index, 1000 + (index % 17));
  const anchorTodaySessions = {};
  const freshSessions = {};
  for (let index = 0; index < todayCount; index += 1) {
    anchorTodaySessions[`claude:s${index}`] = session(index, 40, { contextWindow: 0, contextTokens: 4, turnEnded: false });
    freshSessions[`claude:s${index}`] = session(index, 70, { contextWindow: 0, contextTokens: 8, turnEnded: true, title: 'fresh' });
  }
  freshSessions['claude:new'] = session(count + 1, 15, {
    sessionId: 'new', contextWindow: 0, contextTokens: 9
  });
  const base = periodFrom(history);
  const anchorToday = periodFrom(anchorTodaySessions);
  const fresh = periodFrom(freshSessions);
  return { base, anchorToday, fresh };
}

test('anchored period update matches a full merge and does not rebuild unchanged sessions', () => {
  const { base, anchorToday, fresh } = watchTick(40);
  const historicalKey = 'claude:s30';
  const anchorSession = base.sessions[historicalKey];
  const anchorSnapshot = JSON.stringify(base);

  const delta = applyPeriodDelta(base, fresh, anchorToday);
  const summary = mergeNormalizedPeriods(delta, emptyPeriod());

  assert.deepEqual(summary, mergePeriods(delta, emptyPeriod()));
  assert.equal(JSON.stringify(base), anchorSnapshot);
  assert.notEqual(delta.sessions[historicalKey], anchorSession);
  assert.equal(delta.sessions[historicalKey].models, anchorSession.models);
  assert.notEqual(delta.sessions[historicalKey].modelCosts, anchorSession.modelCosts);
  assert.equal(summary.sessions[historicalKey], delta.sessions[historicalKey]);
  assert.equal(summary.sessions[historicalKey].totalTokens, anchorSession.totalTokens);
  summary.sessions[historicalKey].title = 'renamed in the summary';
  summary.sessions[historicalKey].modelCosts['claude-opus'] = 999;
  assert.equal(anchorSession.title, 'title 30');
  assert.notEqual(anchorSession.modelCosts['claude-opus'], 999);
  assert.equal(delta.sessions['claude:s0'].totalTokens, base.sessions['claude:s0'].totalTokens + 70 - 40);
  assert.ok(summary.sessions['claude:new']);
});

test('a second overlay still matches mergePeriods and does not alias the anchor', () => {
  const { base, anchorToday, fresh } = watchTick(25);
  const delta = applyPeriodDelta(base, fresh, anchorToday);
  const host = mergeNormalizedPeriods(delta, emptyPeriod());
  const overlay = periodFrom({
    'codex:dots': {
      ...session(1, 10),
      client: 'codex',
      sessionId: 'dots',
      models: { 'gpt-5.5': 10 },
      modelCosts: { 'gpt-5.5': 0.01 },
      providers: {}
    }
  });
  const summary = mergeNormalizedPeriods(host, overlay);
  assert.deepEqual(summary, mergePeriods(mergePeriods(delta, emptyPeriod()), overlay));
  assert.notEqual(summary.sessions['claude:s20'], base.sessions['claude:s20']);
  assert.equal(summary.sessions['codex:dots'].totalTokens, 10);
});

test('watch-tick period update stays well under the old full-history rebuild', () => {
  const { base, anchorToday, fresh } = watchTick(8000);
  const started = performance.now();
  const summary = mergeNormalizedPeriods(applyPeriodDelta(base, fresh, anchorToday), emptyPeriod());
  const elapsedMs = performance.now() - started;
  assert.equal(Object.keys(summary.sessions).length, 8001);
  assert.equal(summary.sessions['claude:s7000'].models, base.sessions['claude:s7000'].models);
  // The previous path took ~150ms at 10k sessions on this class of machine.
  // 200ms for 8k leaves room for a slow CI host and still rejects that rebuild.
  assert.ok(elapsedMs < 200, `watch-tick period update took ${elapsedMs.toFixed(1)}ms`);
});
