'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { exchangeRows, formatToolList } = require('../../src/electron/renderer/sessionDetail');
const ranges = require('../../src/electron/renderer/fixedPeriodRanges');
const sessionRows = require('../../src/electron/renderer/sessionRows');

const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function sessionDetailHarness(getSessionDetail) {
  const start = rendererSource.indexOf('function applySessionDetailResult(');
  const end = rendererSource.indexOf('\nfunction toggleDetailSort', start);
  assert.ok(start >= 0 && end > start, 'openSessionDetail should be present');
  const renders = [];
  const state = { period: 'today', openSession: null, settings: { deviceId: 'mac' } };
  const context = {
    state,
    fixedPeriodRangesApi: { isDerived: (period) => ['week', 'last7', 'last30'].includes(period) },
    visibleStatsSurface: () => 'main',
    isRendererWindowHidden: () => false,
    statsRenderScheduler: { request() {} },
    renderSessionDetail: (args) => renders.push(args),
    window: { tokenMonitor: { getSessionDetail } }
  };
  vm.runInNewContext(
    `${rendererSource.slice(start, end)}\nglobalThis.testOpenSessionDetail = openSessionDetail; globalThis.testSessionDetailTargetForRow = sessionDetailTargetForRow;`,
    context
  );
  return { openSessionDetail: context.testOpenSessionDetail, sessionDetailTargetForRow: context.testSessionDetailTargetForRow, renders, state };
}

const detail = {
  found: true,
  exchanges: [
    {
      promptPreview: '重構 collector',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 2,
      tools: ['Read', 'Bash'],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 },
      costEstimate: 0.3,
      turns: [
        { timestamp: '2026-05-30T06:00:02.000Z', tokens: { input: 100, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 100 }, tools: ['Read'], costEstimate: 0.2 },
        { timestamp: '2026-05-30T06:00:03.000Z', tokens: { input: 50, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 50 }, tools: ['Bash'], costEstimate: 0.1 }
      ]
    },
    {
      promptPreview: '',
      startedAt: '2026-05-30T06:00:05.000Z',
      turnCount: 1,
      tools: [],
      tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20 },
      costEstimate: 0.04,
      turns: [{ timestamp: '2026-05-30T06:00:05.000Z', tokens: { input: 20, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 20 }, tools: [], costEstimate: 0.04 }]
    }
  ]
};

test('exchangeRows defaults to time desc (newest exchange first)', () => {
  const rows = exchangeRows(detail, { now: new Date(2026, 4, 30, 12, 0) });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].title, '(session start)');     // startedAt 06:00:05 — newer
  assert.equal(rows[1].title, '重構 collector');       // startedAt 06:00:01 — older
  assert.equal(rows[0].isPrompt, false);
  assert.equal(rows[1].isPrompt, true);
  assert.equal(rows[1].turnCount, 2);
  assert.match(rows[1].subtitle, /2 turns/);
  assert.match(rows[1].subtitle, /2 tools/);
  // inner turns stay chronological (oldest first), not re-sorted
  assert.equal(rows[1].turns[0].value, 100);
  assert.equal(rows[1].turns[1].value, 50);
});

test('exchangeRows sorts by tokens when sortBy=tokens', () => {
  const rows = exchangeRows(detail, { now: new Date(2026, 4, 30, 12, 0), sortBy: 'tokens' });
  assert.equal(rows[0].title, '重構 collector');
  assert.equal(rows[0].value, 150);
  assert.equal(rows[1].value, 20);
});

test('exchangeRows labels compaction usage without consuming a reply number', () => {
  const rows = exchangeRows({
    exchanges: [{
      promptPreview: 'continue',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 1,
      tools: [],
      tokens: { total: 100 },
      costEstimate: 0.2,
      turns: [
        { type: 'compaction-summary', timestamp: '2026-05-30T06:00:02.000Z', tokens: { total: 30 }, tools: [], costEstimate: 0.06 },
        { type: 'reply', timestamp: '2026-05-30T06:00:03.000Z', tokens: { total: 70 }, tools: [], costEstimate: 0.14 }
      ]
    }]
  }, { now: new Date(2026, 4, 30, 12, 0) });

  assert.match(rows[0].subtitle, /1 turn/);
  assert.deepEqual(rows[0].turns.map((turn) => turn.label), ['Compaction summary', 'Reply #1']);
  assert.deepEqual(rows[0].turns.map((turn) => turn.value), [30, 70]);
});

test('exchangeRows labels model attempts without consuming a reply number', () => {
  const rows = exchangeRows({
    exchanges: [{
      promptPreview: 'retry this',
      startedAt: '2026-05-30T06:00:01.000Z',
      turnCount: 1,
      tools: [],
      tokens: { total: 100 },
      costEstimate: 0.2,
      turns: [
        { type: 'assistant-attempt', timestamp: '2026-05-30T06:00:02.000Z', tokens: { total: 30 }, tools: [], costEstimate: 0.06 },
        { type: 'reply', timestamp: '2026-05-30T06:00:03.000Z', tokens: { total: 70 }, tools: [], costEstimate: 0.14 }
      ]
    }]
  }, { now: new Date(2026, 4, 30, 12, 0) });

  assert.match(rows[0].subtitle, /1 turn/);
  assert.deepEqual(rows[0].turns.map((turn) => turn.label), ['Model attempt', 'Reply #1']);
  assert.deepEqual(rows[0].turns.map((turn) => turn.value), [30, 70]);
});

test('formatToolList dedupes and truncates', () => {
  assert.equal(formatToolList(['Read', 'Read', 'Bash']), 'Read · Bash');
  assert.equal(formatToolList([]), '');
});

test('openSessionDetail ignores a stale period result that completes last', async () => {
  const pending = [];
  const requests = [];
  const { openSessionDetail, renders, state } = sessionDetailHarness((args) => {
    const job = deferred();
    requests.push(args);
    pending.push(job);
    return job.promise;
  });
  const session = { client: 'claude', sessionId: 'same-session', sessionCost: 0.25, title: 'Session' };

  const todayRequest = openSessionDetail(session);
  state.period = 'month';
  const monthRequest = openSessionDetail(session);

  assert.equal(requests[0].period, 'today');
  assert.equal(requests[1].period, 'month');

  pending[1].resolve({ found: true, marker: 'month' });
  await monthRequest;
  pending[0].resolve({ found: true, marker: 'today' });
  await todayRequest;

  assert.equal(state.openSession.period, 'month');
  assert.equal(state.openSession.detail.marker, 'month');
  assert.deepEqual(renders.filter((render) => render.detail).map((render) => render.detail.marker), ['month']);
});

test('derived session rows open the original session with cumulative detail', async () => {
  const requests = [];
  const { openSessionDetail, sessionDetailTargetForRow, state } = sessionDetailHarness((args) => {
    requests.push(args);
    return Promise.resolve({ found: true });
  });
  state.period = 'week';
  const target = sessionDetailTargetForRow('session:mac:codex:original-id', 'codex', {
    sessions: {
      'mac:codex:original-id': { client: 'codex', sessionId: 'original-id', costUsd: 2.5 }
    }
  });
  assert.equal(target.sessionId, 'original-id');
  assert.equal(target.sessionCost, 2.5);
  await openSessionDetail({ ...target, title: 'Session' });
  assert.equal(requests[0].sessionId, 'original-id');
  assert.equal(requests[0].period, 'total');
  assert.equal(state.openSession.period, 'week');
});

test('remote and missing derived sessions cannot open a local transcript', () => {
  const { sessionDetailTargetForRow, state } = sessionDetailHarness(() => Promise.resolve({ found: true }));
  state.period = 'last30';
  const period = { sessions: {
    'mac:codex:same-id': { sessionId: 'same-id', costUsd: 1 },
    'other:codex:same-id': { sessionId: 'same-id', costUsd: 2 }
  } };
  assert.equal(sessionDetailTargetForRow('session:other:codex:same-id', 'codex', period), null);
  assert.equal(sessionDetailTargetForRow('session:mac:codex:missing', 'codex', period), null);
  assert.equal(sessionDetailTargetForRow('session:mac:codex:same-id', 'codex', period).sessionCost, 1);
});

test('fixed-range renderer includes locally retained Reasonix sessions', () => {
  const start = rendererSource.indexOf('function nativeSessionsForCurrentPeriod()');
  const end = rendererSource.indexOf('\nfunction sessionRowsForPeriod(', start);
  assert.ok(start >= 0 && end > start);
  const state = {
    period: 'last7', settings: { deviceId: 'mac' },
    fixedPeriodSnapshot: { devices: [{ deviceId: 'mac',
      range: { start: '2026-08-06', end: '2026-08-12' }, periodWindows: { timeZone: 'UTC' } }] },
    stats: { nativeSessions: { allTime: {
      'reasonix:branch': { client: 'reasonix', sessionId: 'reasonix:branch',
        totalTokens: 100, lastMessageAt: '2026-08-10T12:00:00.000Z',
        lastUsedAt: '2026-08-10T12:00:00.000Z' }
    } } }
  };
  const context = { state, fixedPeriodRangesApi: ranges, sessionRowsApi: sessionRows,
    clientLabels: {}, clientColors: {}, modelColor: () => '', stableColor: () => '',
    fallbackModelColors: [], t: () => '' };
  vm.runInNewContext(`${rendererSource.slice(start, end)}\nglobalThis.testRows = rawSessionRowsForPeriod;`, context);
  const rows = context.testRows({ sessions: {} });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].key, 'session:reasonix:branch');
  assert.equal(rows[0].value, 100);
});

test('background-review runs open only a local session with its original id', () => {
  const start = rendererSource.indexOf('function backgroundReviewRunNode(');
  const end = rendererSource.indexOf('\nfunction renderBackgroundReviewDetail(', start);
  assert.ok(start >= 0 && end > start);
  const opened = [];
  const state = { period: 'week', settings: { deviceId: 'mac' }, stats: { periods: { week: {
    sessions: {
      'mac:codex:same-id': { sessionId: 'same-id', costUsd: 1 },
      'remote:codex:same-id': { sessionId: 'same-id', costUsd: 2 }
    }
  } } } };
  const context = {
    state, fixedPeriodRangesApi: ranges, nativeSessionsForCurrentPeriod: () => ({}),
    sessionRowsApi: { compactSessionTime: () => '12:00' },
    document: { createElement: () => {
      const attributes = new Map();
      const listeners = new Map();
      return { attributes, listeners, className: '', innerHTML: '',
        setAttribute: (key, value) => attributes.set(key, value),
        querySelector: () => ({ textContent: '' }),
        addEventListener: (key, callback) => listeners.set(key, callback) };
    } },
    rowWidth: () => 50, applyBarScale: () => {}, formatNumber: String,
    formatCost: String, t: () => 'Reviews',
    openSessionDetail: (request) => opened.push(request)
  };
  const targetStart = rendererSource.indexOf('function sessionDetailTargetForRow(');
  const targetEnd = rendererSource.indexOf('\nasync function openSessionDetail(', targetStart);
  vm.runInNewContext(`${rendererSource.slice(targetStart, targetEnd)}\n${rendererSource.slice(start, end)}\nglobalThis.testRunNode = backgroundReviewRunNode;`, context);
  const local = context.testRunNode({ key: 'session:mac:codex:same-id', client: 'codex', value: 10, cost: 1 }, 10, {});
  const remote = context.testRunNode({ key: 'session:remote:codex:same-id', client: 'codex', value: 10, cost: 2 }, 10, {});
  assert.equal(remote.attributes.has('role'), false);
  assert.equal(remote.listeners.has('click'), false);
  local.listeners.get('click')();
  assert.equal(opened[0].sessionId, 'same-id');
  assert.equal(opened[0].sessionCost, 1);
});

test('Reasonix rows enter the shared detail navigation path instead of a native accordion', () => {
  assert.match(rendererSource, /client !== 'claude' && client !== 'codex' && client !== 'opencode' && client !== 'reasonix'/);
  assert.match(rendererSource, /rowEl\.dataset\.detailUnavailable === 'true'/);
  assert.doesNotMatch(rendererSource, /nativeSessionBreakdown/);
  const { sessionDetailTargetForRow } = sessionDetailHarness(() => Promise.resolve({ found: true }));
  const target = sessionDetailTargetForRow('session:reasonix:branch-id', 'reasonix', null, {
    'reasonix:branch-id': { reportedCostUsd: 1.25 }
  });
  assert.equal(target.sessionId, 'reasonix:branch-id');
  assert.equal(target.sessionCost, 1.25);
});
