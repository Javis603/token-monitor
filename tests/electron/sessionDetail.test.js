'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const { exchangeRows, formatToolList } = require('../../src/electron/renderer/sessionDetail');

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

test('session detail renders its heading before loading, errors and empty results, and keeps it when sorting', () => {
  const timers = [];
  const frames = [];
  let reducedMotion = false;
  function element() {
    const classes = new Set();
    return {
      children: [], isConnected: true, scrollLeft: 0, scrollWidth: 600, clientWidth: 200,
      closest: () => ({}),
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), contains: value => classes.has(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
      append(...nodes) { this.children.push(...nodes); },
      replaceChildren(...nodes) { this.children = nodes; },
      addEventListener(type, handler) { this[type] = handler; },
      querySelector(selector) { return this.children.find(node => `.${node.className}` === selector) || null; }
    };
  }
  const els = { breakdown: element(), sessionDetail: element(), sessionDetailHead: element() };
  const state = { detailSort: 'tokens', openSession: null };
  const start = rendererSource.indexOf('function renderSessionDetail(');
  const end = rendererSource.indexOf('function backgroundReviewRunNode(', start);
  let render;
  const context = {
    els, state, document: { createElement: element, querySelectorAll: () => els.sessionDetailHead.children.filter(node => node.className === 'detail-heading') }, window: { addEventListener() {} }, t: key => key,
    sessionDetailBack() {},
    detailNote: text => ({ textContent: text }),
    sessionDetailApi: { exchangeRows: detail => detail?.exchanges || [] },
    exchangeNode: row => ({ textContent: row.title }),
    prefersReducedMotion: () => reducedMotion,
    setTimeout: callback => { timers.push(callback); return timers.length; },
    clearTimeout() {},
    requestAnimationFrame: callback => { frames.push(callback); return frames.length; },
    cancelAnimationFrame() {},
    performance: { now: () => 0 },
    toggleDetailSort() {
      state.detailSort = 'time';
      render({ detail: state.openSession.detail });
    }
  };
  const overflowText = require('../../src/electron/renderer/overflowText').create({
    document: context.document,
    window: { ...context, addEventListener() {} },
    prefersReducedMotion: context.prefersReducedMotion
  });
  context.bindHoverMarquee = overflowText.bind;
  vm.runInNewContext(`${rendererSource.slice(start, end)}\nglobalThis.render = renderSessionDetail;`, context);
  render = context.render;
  for (const title of ['gpt-5.6-sol · 12:34', 'A long ordinary session title that exceeds the available header width']) {
    state.openSession = { title, detail: { exchanges: [{ title: 'Reply', value: 10 }] } };
    for (const options of [{ loading: true }, { error: true }, { detail: { found: false } },
      { detail: { exchanges: [] } }, { detail: state.openSession.detail }]) {
      render(options);
      const heading = els.sessionDetailHead.querySelector('.detail-heading');
      assert.equal(heading.textContent, title);
      assert.equal(heading.title, title);
      assert.equal(els.sessionDetailHead.children[0].className, 'detail-back');
    }
    els.sessionDetailHead.querySelector('.detail-sort').click();
    const heading = els.sessionDetailHead.querySelector('.detail-heading');
    assert.equal(heading.textContent, title);
    while (frames.length) frames.shift()(0);
    assert.equal(heading.classList.contains('has-overflow-fade'), true);
    heading.mouseenter();
    timers.pop()();
    frames.pop()(8000);
    assert.ok(heading.scrollLeft > 0, 'hover reveals the clipped title');
    assert.equal(heading.classList.contains('has-overflow-fade'), false, 'the end stays readable after scrolling');
    assert.equal(heading.classList.contains('is-hover-scrolling'), true);
    heading.mouseleave();
    assert.equal(heading.scrollLeft, 0);
    assert.equal(heading.classList.contains('has-overflow-fade'), true);
    assert.equal(heading.classList.contains('is-hover-scrolling'), false);
    reducedMotion = true;
    heading.mouseenter();
    assert.equal(heading.scrollLeft, 0);
    assert.equal(heading.title, title, 'full title remains available without motion');
    reducedMotion = false;
    heading.scrollWidth = heading.clientWidth;
    overflowText.update(heading);
    assert.equal(heading.classList.contains('has-overflow-fade'), false, 'fitting text stays opaque');
  }
  state.openSession = {};
  render({ loading: true });
  assert.equal(els.sessionDetailHead.querySelector('.detail-heading'), null);
});

function sessionDetailHarness(getSessionDetail) {
  const start = rendererSource.indexOf('function applySessionDetailResult(');
  const end = rendererSource.indexOf('\nfunction toggleDetailSort', start);
  assert.ok(start >= 0 && end > start, 'openSessionDetail should be present');
  const renders = [];
  const state = { period: 'today', openSession: null };
  const context = {
    state,
    visibleStatsSurface: () => 'main',
    isRendererWindowHidden: () => false,
    statsRenderScheduler: { request() {} },
    renderSessionDetail: (args) => renders.push(args),
    window: { tokenMonitor: { getSessionDetail } }
  };
  vm.runInNewContext(
    `${rendererSource.slice(start, end)}\nglobalThis.testOpenSessionDetail = openSessionDetail;`,
    context
  );
  return { openSessionDetail: context.testOpenSessionDetail, renders, state };
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

test('Reasonix rows enter the shared detail navigation path instead of a native accordion', () => {
  assert.match(rendererSource, /client !== 'claude' && client !== 'codex' && client !== 'opencode' && client !== 'reasonix'/);
  assert.match(rendererSource, /const sessionId = client === 'reasonix' \? `reasonix:\$\{match\[2\]\}` : match\[2\];/);
  assert.match(rendererSource, /state\.stats\?\.nativeSessions\?\.\[state\.period\]\?\.\[sessionId\]/);
  assert.match(rendererSource, /client === 'reasonix' && rowEl\.dataset\.detailUnavailable === 'true'/);
  assert.match(rendererSource, /sessionCost: client === 'reasonix' \? Number\(session\?\.reportedCostUsd \|\| 0\)/);
  assert.doesNotMatch(rendererSource, /nativeSessionBreakdown/);
});
