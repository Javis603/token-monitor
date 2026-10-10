'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const {
  applyBreakdownRowSemantics,
  archivedSessionCount,
  groupBackgroundReviewRows,
  groupSessionRows,
  handleBreakdownRowKeydown,
  sessionBreakdownIncomplete,
  sessionIdLabel,
  sessionDetailIdLabel,
  sessionModelTooltipEntries,
  sessionRowsForPeriod
} = require('../../src/electron/renderer/sessionRows');

test('archived usage joins only matching active native state while retaining its token and cost values', () => {
  const now = new Date('2026-10-10T00:00:00Z');
  const key = 'claude:resumed';
  const accounting = { client: 'claude', sessionId: 'resumed', totalTokens: 100, costUsd: 1,
    archived: true, turnEnded: true, lastUsedAt: '2026-10-09T00:00:00Z' };
  const native = { client: 'claude', sessionId: 'resumed', native: true, totalTokens: 0, costUsd: 0,
    liveActivity: { state: 'waiting', observedAt: now.toISOString() } };
  for (const [candidate, state] of [[native, 'waiting'], [{ ...native, client: 'codex' }, 'idle'],
    [{ ...native, sessionId: 'another' }, 'idle'],
    [{ ...native, liveActivity: { state: 'idle', observedAt: now.toISOString() } }, 'idle']]) {
    const [row, ...others] = sessionRowsForPeriod({ sessions: { [key]: accounting } }, {
      now, nativeSessions: { [key]: candidate }
    });
    assert.equal(row.activityState, state); assert.equal(others.length, 0);
    assert.equal(row.value, 100); assert.equal(row.cost, 1);
    assert.equal(accounting.archived, true); assert.equal(accounting.liveActivity, undefined);
  }
});

const clientLabels = { claude: 'Claude Code', codex: 'Codex' };
const clientColors = { claude: '#cc7c5e', codex: '#49a3b0', default: '#6ab4f0' };

function localIso(year, month, day, hour, minute) {
  return new Date(year, month - 1, day, hour, minute).toISOString();
}

test('session rows sort by latest activity and keep subtitles compact', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'codex:old': {
        client: 'codex',
        sessionId: 'rollout-2026-05-30T09-47-36-019e76fc-aaaa-bbbb-cccc-111111111111',
        totalTokens: 20548311,
        costUsd: 17.59,
        models: { 'gpt-5.5': 20548311 },
        messageCount: 160,
        lastUsedAt: localIso(2026, 5, 30, 11, 34)
      },
      'claude:newer': {
        client: 'claude',
        sessionId: '214c24d5-aaaa-bbbb-cccc-f87e',
        totalTokens: 21637,
        costUsd: 0.0812,
        models: { 'claude-opus-4-8': 21637 },
        messageCount: 1,
        lastUsedAt: localIso(2026, 5, 30, 12, 7)
      },
      'codex:newest': {
        client: 'codex',
        sessionId: 'rollout-2026-05-30T11-44-50-019e76fc-dddd-eeee-ffff-222222222222',
        totalTokens: 24870232,
        costUsd: 21.91,
        models: { 'gpt-5.5': 24870232 },
        messageCount: 184,
        lastUsedAt: localIso(2026, 5, 30, 12, 25)
      }
    }
  }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30)
  });

  assert.deepEqual(rows.map((row) => row.key), [
    'session:codex:newest',
    'session:claude:newer',
    'session:codex:old'
  ]);
  assert.equal(rows[0].name, 'Codex · gpt-5.5');
  assert.equal(rows[0].subtitle, '12:25 · 184 calls');
  assert.equal(rows[0].detail, '019e76fc-dddd-eeee-ffff-222222222222');
  assert.equal(rows[0].kind, 'session');
  assert.equal(rows[1].subtitle, '12:07 · 1 call');
  assert.equal(rows[1].detail, '214c24d5-aaaa-bbbb-cccc-f87e');
});

test('session rows fall back to month and day for older activity', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'claude:older': {
        client: 'claude',
        sessionId: '214c24d5-aaaa-bbbb-cccc-f87e',
        totalTokens: 21637,
        models: { 'claude-opus-4-8': 21637 },
        lastUsedAt: localIso(2026, 5, 29, 23, 8)
      }
    }
  }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30)
  });

  assert.equal(rows[0].subtitle, '05/29 23:08');
  assert.equal(rows[0].detail, '214c24d5-aaaa-bbbb-cccc-f87e');
});

test('session rows group client and model apart from activity metadata', () => {
  const [row] = sessionRowsForPeriod({ sessions: {
    'codex:titled': {
      client: 'codex',
      sessionId: 'titled',
      title: '修復 session detail',
      totalTokens: 120,
      models: { 'gpt-5.6-sol': 120 },
      messageCount: 4,
      lastUsedAt: localIso(2026, 5, 30, 12, 7)
    }
  } }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30)
  });

  assert.equal(row.name, '修復 session detail');
  assert.equal(row.subtitle, 'Codex · gpt-5.6-sol');
  assert.equal(row.activity, '12:07 · 4 calls');
  assert.equal(row.detail, 'titled');
});

test('session activity ends with the share of input served from cache', () => {
  const now = new Date(2026, 4, 30, 12, 30);
  const session = (id, fields) => ({
    client: 'codex',
    sessionId: id,
    title: id,
    totalTokens: 1_000,
    models: { 'gpt-5.6-sol': 1_000 },
    messageCount: 4,
    lastUsedAt: localIso(2026, 5, 30, 12, 7),
    ...fields
  });
  const rows = sessionRowsForPeriod({ sessions: {
    'codex:warm': session('warm', { inputTokens: 40, cacheReadTokens: 940, cacheWriteTokens: 20, outputTokens: 50 }),
    'codex:sliver': session('sliver', { inputTokens: 995, cacheReadTokens: 5, outputTokens: 50 }),
    // Writes with no reads is a real cold start, so it reads 0%.
    'codex:cold': session('cold', { inputTokens: 500, cacheWriteTokens: 500, outputTokens: 50 }),
    // No cache traffic at all says nothing about caching: no reading.
    'codex:unreported': session('unreported', { inputTokens: 950, outputTokens: 50 })
  } }, {
    clientLabels,
    clientColors,
    now
  });
  const byName = Object.fromEntries(rows.map((row) => [row.name, row]));

  assert.equal(byName.warm.activity, '12:07 · 4 calls · 94%');
  assert.equal(byName.sliver.activity, '12:07 · 4 calls · <1%');
  assert.equal(byName.cold.activity, '12:07 · 4 calls · 0%');
  assert.equal(byName.unreported.activity, '12:07 · 4 calls');
});

test('session activity ends with the session own generation speed after its cache hit', () => {
  const now = new Date(2026, 4, 30, 12, 30);
  const base = {
    client: 'codex',
    totalTokens: 1_000,
    models: { 'gpt-5.6-sol': 1_000 },
    messageCount: 4,
    lastUsedAt: localIso(2026, 5, 30, 12, 7),
    inputTokens: 40,
    cacheReadTokens: 940,
    cacheWriteTokens: 20,
    outputTokens: 50
  };
  const rows = sessionRowsForPeriod({ sessions: {
    'codex:timed': { ...base, sessionId: 'timed', title: 'timed', outputTokens: 1_850, timedOutputTokens: 1_850, timedDurationMs: 20_000 },
    // The client reported no durations: no reading rather than "0 tok/s".
    'codex:untimed': { ...base, sessionId: 'untimed', title: 'untimed' },
    // Untitled rows carry the same line as their subtitle.
    'codex:untitled': { ...base, sessionId: 'untitled', outputTokens: 1_200, timedOutputTokens: 1_200, timedDurationMs: 1_000 }
  } }, { clientLabels, clientColors, now });
  const byId = Object.fromEntries(rows.map((row) => [row.detail, row]));

  // Cache before speed: in a window too narrow for the line, the fade eats the
  // `tok/s` unit rather than the percentage's digits.
  assert.equal(byId.timed.activity, '12:07 · 4 calls · 94% · 93 tok/s');
  assert.equal(byId.untimed.activity, '12:07 · 4 calls · 94%');
  assert.equal(byId.untitled.subtitle, '12:07 · 4 calls · 94% · 1,200 tok/s');
});

test('session rows bound malformed generation speeds even without wire normalization', () => {
  for (const [outputTokens, timedOutputTokens, timedDurationMs, expected] of [
    [10, 1_000_000, 1000, '10 tok/s'],
    [10, 6, 1000, '6 tok/s'],
    [undefined, 1_000_000, 1000, ''],
    [10, -1, 1000, ''],
    [10, 10, 0, '']
  ]) {
    const [row] = sessionRowsForPeriod({ sessions: {
      'codex:malformed': { client: 'codex', sessionId: 'malformed', totalTokens: 100, outputTokens, timedOutputTokens, timedDurationMs }
    } });
    assert.equal(row.subtitle, expected);
  }
});

test('multi-model sessions expose every model with its tokens and share of the session', () => {
  const session = {
    totalTokens: 100,
    models: { 'gpt-5.6-sol': 70, 'claude-opus-5': 20 }
  };
  assert.deepEqual(sessionModelTooltipEntries(session), [
    ['gpt-5.6-sol', '70', '70%'],
    ['claude-opus-5', '20', '20%'],
    ['Unclassified', '10', '10%']
  ]);
  assert.deepEqual(sessionModelTooltipEntries(session, { unattributedLabel: '未分類' }).at(-1), [
    '未分類', '10', '10%'
  ]);
  // The rows follow the heaviest model first, not the models map's order,
  // with the tokens no model claimed trailing them.
  assert.deepEqual(
    sessionModelTooltipEntries({ totalTokens: 100, models: { 'claude-opus-5': 20, 'gpt-5.6-sol': 70 } })
      .map(([model]) => model),
    ['gpt-5.6-sol', 'claude-opus-5', 'Unclassified']
  );
});

test('model tooltip shares read the session total and floor at a real sliver', () => {
  // Models can out-sum the recorded total (overlapping reads); the share is
  // then of the attributed tokens rather than over 100% each.
  assert.deepEqual(sessionModelTooltipEntries({ totalTokens: 30, models: { a: 30, b: 10 } }), [
    ['a', '30', '75%'],
    ['b', '10', '25%']
  ]);
  assert.deepEqual(sessionModelTooltipEntries({ totalTokens: 1000, models: { a: 999, b: 1 } }), [
    ['a', '999', '100%'],
    ['b', '1', '<1%']
  ]);
  // Fewer than two models never abbreviates to "N models", so there is no
  // tooltip behind a label that names the model already.
  assert.deepEqual(sessionModelTooltipEntries({ totalTokens: 10, models: { a: 10 } }), []);
  assert.deepEqual(sessionModelTooltipEntries({ totalTokens: 10, models: { a: 10, b: 0 } }), []);
  assert.deepEqual(sessionModelTooltipEntries(null), []);
});

test('session rows carry the model tooltip entries behind the "N models" label', () => {
  const [row] = sessionRowsForPeriod({ sessions: {
    'codex:mixed': {
      client: 'codex',
      sessionId: 'mixed',
      title: 'Mixed run',
      totalTokens: 100,
      models: { 'gpt-5.6-sol': 60, 'gpt-5.6': 40 },
      lastUsedAt: localIso(2026, 5, 30, 12, 7)
    }
  } }, {
    clientLabels,
    clientColors,
    now: new Date(2026, 4, 30, 12, 30),
    unattributedLabel: 'Unclassified'
  });
  assert.equal(row.modelLabel, '2 models');
  assert.equal(row.subtitle, 'Codex · 2 models');
  assert.deepEqual(row.modelTooltipEntries, [
    ['gpt-5.6-sol', '60', '60%'],
    ['gpt-5.6', '40', '40%']
  ]);
});

test('a hovered background-review run tooltip holds the session repaint', () => {
  // The periodic rebuild of an open review detail replaces every run node;
  // sessionTooltipShouldHoldRender is what keeps a tooltip open through it.
  // The guard's selector must cover the run title, which carries the wrap
  // class itself — matching only the Sessions list's containers would leave
  // this surface unprotected.
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const body = source.slice(
    source.indexOf('function sessionTooltipShouldHoldRender('),
    source.indexOf('function flushPendingLimitDetailTooltipRender(')
  );
  const matchesPart = (part, el) => {
    const compounds = part.trim().split(/\s+/);
    const [cls, ...pseudos] = compounds.at(-1).split(':');
    if (!cls.split('.').filter(Boolean).every((c) => el.classes.includes(c))) return false;
    if (pseudos.includes('hover') && !el.hovered) return false;
    if (pseudos.includes('focus-within') && !el.focusWithin) return false;
    let anc = el.parent;
    for (let i = compounds.length - 2; i >= 0; i -= 1) {
      const required = compounds[i].split('.').filter(Boolean);
      while (anc && !required.every((c) => anc.classes.includes(c))) anc = anc.parent;
      if (!anc) return false;
      anc = anc.parent;
    }
    return true;
  };
  const document = {
    element: null,
    querySelector(selector) {
      return this.element && selector.split(',').some((part) => matchesPart(part, this.element))
        ? this.element
        : null;
    }
  };
  const shouldHold = Function('document', `${body}\nreturn sessionTooltipShouldHoldRender;`)(document);

  for (const flag of ['hovered', 'focusWithin']) {
    document.element = { classes: ['detail-ex-title', 'limit-detail-tooltip-wrap'], [flag]: true, parent: null };
    assert.equal(shouldHold(), true);
  }
  document.element = { classes: ['detail-ex-title', 'limit-detail-tooltip-wrap'], parent: null };
  assert.equal(shouldHold(), false);
});

test('the periodic review-detail rebuild defers to the tooltip hold', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const branch = source.slice(
    source.indexOf("state.openSession.kind === 'session-group'"),
    source.indexOf('state.openSession.renderOptions')
  );
  assert.match(branch, /!sessionTooltipShouldHoldRender\(\)/);
});

test('Codex merged rollout labels contain UUIDs only', () => {
  const first = '01a084ff-20ff-7563-beb4-045b31e5a47a';
  const second = '01a0876b-d178-7be2-a485-529a745ea1b0';
  assert.equal(
    sessionIdLabel(`rollout-2026-09-10T02-33-00-${first}_rollout-2026-09-10T02-40-00-${second}`),
    `${first} · ${second}`
  );
});

test('detail identities use Codex metadata without guessing a UUID position', () => {
  const first = '01a084ff-20ff-7563-beb4-045b31e5a47a';
  const second = '01a0876b-d178-7be2-a485-529a745ea1b0';
  for (const [raw, expected] of [
    [`rollout-2026-09-10T02-33-00-${first}_rollout-2026-09-10T02-40-00-${second}`, [first, second]],
    [`rollout-2026-09-10T02-33-00-${first}`, [first]],
    [first, [first]],
    ['ordinary · label', ['ordinary · label']],
    ['reasonix:ABC123', ['ABC123']],
    ['reasonix-stats:/private/stats/day.jsonl', []],
    ['reasonix:reasonix-stats:/private/stats/day.jsonl', []],
    ['2026-09-10T02-33-00', []],
    ['', []],
    [undefined, []]
  ]) {
    assert.equal(sessionIdLabel(raw), expected.join(' · '));
    assert.equal(sessionDetailIdLabel('claude', raw), expected.join(' · '));
    assert.equal(sessionDetailIdLabel('codex', raw), expected.length === 1 ? expected[0] : '');
  }
  const raw = `rollout-2026-09-10T02-33-00-${first}_${second}`;
  for (const canonicalSessionId of [first, second]) {
    assert.equal(sessionDetailIdLabel('codex', raw, { found: true, canonicalSessionId }), canonicalSessionId);
  }
  for (const detail of [undefined, { found: false, canonicalSessionId: first },
    { found: true }, { found: true, canonicalSessionId: `${first} · ${second}` }]) {
    assert.equal(sessionDetailIdLabel('codex', raw, detail), '');
  }
});

test('background review sessions collapse into one interactive aggregate row with newest-run context', () => {
  const rows = sessionRowsForPeriod({ sessions: {
    'codex:ordinary': {
      client: 'codex', sessionId: 'ordinary', totalTokens: 100,
      models: { 'gpt-5.6-sol': 100 }, lastUsedAt: localIso(2026, 5, 30, 12, 30)
    },
    'codex:review-a': {
      client: 'codex', sessionId: 'review-a', totalTokens: 20, costUsd: 0.1,
      sessionKind: 'background-review', models: { 'codex-auto-review': 20 },
      lastUsedAt: localIso(2026, 5, 30, 12, 20)
    },
    'codex:review-b': {
      client: 'codex', sessionId: 'review-b', totalTokens: 30, costUsd: 0.2,
      sessionKind: 'background-review', models: { 'gpt-5.6-sol': 30 },
      lastUsedAt: localIso(2026, 5, 30, 12, 10)
    }
  } }, { clientLabels, clientColors, now: new Date(2026, 4, 30, 12, 30) });

  const collapsed = groupBackgroundReviewRows(rows, {
    label: 'Background reviews',
    countLabel: (count) => `Sessions: ${count}`,
    summaryLabel: ({ latestTime, latestValue }) => `${latestTime} · ${latestValue}`,
    now: new Date(2026, 4, 30, 12, 30)
  });
  assert.deepEqual(collapsed.map((row) => row.key), [
    'session:codex:ordinary',
    'session-group:codex-auto-review'
  ]);
  assert.equal(collapsed[1].value, 50);
  assert.equal(collapsed[1].kind, 'summary');
  assert.ok(Math.abs(collapsed[1].cost - 0.3) < 1e-9);
  assert.equal(collapsed[1].barValue, 50);
  assert.equal(collapsed[1].subtitle, '12:20 · 20');
  assert.equal(collapsed[1].detail, 'Sessions: 2');
  assert.equal(collapsed[1].sessionGroup, 'codex-auto-review');
  assert.deepEqual(collapsed[1].groupRows.map((row) => row.key), [
    'session:codex:review-a',
    'session:codex:review-b'
  ]);
  assert.deepEqual(collapsed[1].groupRows.map((row) => row.modelLabel), [
    'codex-auto-review',
    'gpt-5.6-sol'
  ]);
  assert.equal(Object.hasOwn(collapsed[1], 'sessionGroupExpanded'), false);
  assert.equal(Object.hasOwn(collapsed[1], 'sessionDetailAvailable'), false);
});

test('pre-token native Codex reviews join the existing background group without hiding ordinary sessions', () => {
  const now = new Date(2026, 9, 9, 12);
  const rows = sessionRowsForPeriod({ sessions: {
    'codex:accounted-review': { client: 'codex', sessionId: 'accounted-review',
      sessionKind: 'background-review', totalTokens: 15, costUsd: 0.1, lastUsedAt: now.toISOString() }
  } }, { clientLabels, clientColors, now, nativeSessions: {
    'codex:native-review': { client: 'codex', sessionId: 'native-review', sessionKind: 'background-review',
      tokenDataUnavailable: true, totalTokens: 0, lastUsedAt: now.toISOString() },
    'codex:ordinary': { client: 'codex', sessionId: 'ordinary', model: 'codex-auto-review',
      tokenDataUnavailable: true, totalTokens: 0, lastUsedAt: now.toISOString() }
  } });
  const review = rows.find((row) => row.key === 'session:codex:native-review');
  assert.equal(review.backgroundReview, true);
  assert.equal(review.tokenDataUnavailable, true);
  const collapsed = groupBackgroundReviewRows(rows, { now });
  assert.deepEqual(collapsed.map((row) => row.key), ['session:codex:ordinary', 'session-group:codex-auto-review']);
  const group = collapsed[1];
  assert.deepEqual(group.groupRows.map((row) => row.key).sort(),
    ['session:codex:accounted-review', 'session:codex:native-review']);
  assert.equal(group.value, 15);
  assert.equal(group.cost, 0.1);
});

test('background review run headings show the model independently of session titles and keep the time', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const body = source.slice(source.indexOf('function sessionGroupRunNode('), source.indexOf('function renderSessionGroupDetail('));
  const sessionRowsApi = require('../../src/electron/renderer/sessionRows');
  let opened;
  const createNode = () => {
    const children = new Map();
    return {
      events: {},
      setAttribute() {},
      querySelector(selector) {
        if (!children.has(selector)) children.set(selector, {});
        return children.get(selector);
      },
      addEventListener(type, handler) { this.events[type] = handler; }
    };
  };
  const render = Function('document', 'sessionRowsApi', 't', 'formatNumber', 'formatCost', 'applyBarScale', 'rowWidth', 'openSessionDetail', 'bindHoverMarquee', 'limitWindowsView', `${body}\nreturn sessionGroupRunNode;`)(
    { createElement: createNode }, sessionRowsApi, () => 'Codex Auto Review', String, String, () => {}, () => 100,
    (request) => { opened = request; }, () => {}, { setDetailTooltip() {} }
  );
  for (const [models, expectedModel] of [
    [{ 'gpt-5.6-sol': 30 }, 'gpt-5.6-sol'],
    [{ 'gpt-5.6-sol': 20, 'gpt-5.6': 10 }, '2 models'],
    [{}, '']
  ]) {
    const [row] = sessionRowsForPeriod({ sessions: { 'codex:review': {
      client: 'codex', sessionId: 'review', title: 'Automatic review', sessionKind: 'background-review',
      totalTokens: 30, models, lastUsedAt: new Date().toISOString()
    } } });
    const parent = { kind: 'session-group' };
    const node = render(row, 30, parent);
    const time = sessionRowsApi.compactSessionTime(row.sortTime);
    const expectedTitle = [expectedModel, time].filter(Boolean).join(' · ');
    assert.equal(node.querySelector('.detail-ex-title').textContent, expectedTitle);
    assert.equal(node.querySelector('.detail-ex-title').title, expectedTitle);
    assert.equal(node.querySelector('.detail-ex-sub').textContent, 'review');
    node.events.click();
    assert.equal(opened.title, expectedTitle);
    assert.equal(opened.sessionId, 'review');
    assert.equal(opened.returnTo, parent);
  }
});

test('model name alone does not hide an ordinary Codex session in background reviews', () => {
  const rows = sessionRowsForPeriod({ sessions: {
    'codex:user-selected-review-model': {
      client: 'codex',
      sessionId: 'user-selected-review-model',
      totalTokens: 20,
      models: { 'codex-auto-review': 20 },
      lastUsedAt: localIso(2026, 5, 30, 12, 20)
    }
  } }, { clientLabels, clientColors, now: new Date(2026, 4, 30, 12, 30) });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].backgroundReview, undefined);
  assert.deepEqual(groupBackgroundReviewRows(rows).map((row) => row.key), [
    'session:codex:user-selected-review-model'
  ]);
});

test('breakdown row semantics keep sessions keyboard-accessible without changing accordion ownership', () => {
  class FakeElement {
    constructor() { this.attributes = new Map(); }
    getAttribute(name) { return this.attributes.get(name) ?? null; }
    hasAttribute(name) { return this.attributes.has(name); }
    removeAttribute(name) { this.attributes.delete(name); }
    setAttribute(name, value) { this.attributes.set(name, String(value)); }
  }

  const row = new FakeElement();
  const rowHead = new FakeElement();
  applyBreakdownRowSemantics(row, rowHead, {
    interactive: true,
    hasAccordion: false,
    ariaLabel: 'Codex session'
  });
  assert.equal(row.getAttribute('role'), 'button');
  assert.equal(row.getAttribute('tabindex'), '0');
  assert.equal(row.getAttribute('aria-label'), 'Codex session');
  assert.equal(rowHead.hasAttribute('role'), false);

  applyBreakdownRowSemantics(row, rowHead, {
    interactive: false,
    hasAccordion: true,
    expanded: true,
    ariaLabel: 'Codex, Total tokens: 10'
  });
  assert.equal(row.hasAttribute('role'), false);
  assert.equal(rowHead.getAttribute('role'), 'button');
  assert.equal(rowHead.getAttribute('tabindex'), '0');
  assert.equal(rowHead.getAttribute('aria-expanded'), 'true');
  assert.equal(rowHead.getAttribute('aria-label'), 'Codex, Total tokens: 10');
});

test('breakdown row keyboard activation handles Enter and Space', () => {
  let clicks = 0;
  let prevented = 0;
  const row = { click: () => { clicks += 1; } };
  const target = {
    closest: (selector) => selector === '.row[role="button"]' ? row : null
  };

  assert.equal(handleBreakdownRowKeydown({
    key: 'Enter', target, preventDefault: () => { prevented += 1; }
  }), true);
  assert.equal(handleBreakdownRowKeydown({
    key: ' ', target, preventDefault: () => { prevented += 1; }
  }), true);
  assert.equal(handleBreakdownRowKeydown({
    key: 'Escape', target, preventDefault: () => { prevented += 1; }
  }), false);
  assert.equal(clicks, 2);
  assert.equal(prevented, 2);
});

test('Reasonix native rows reuse the common session schema without a native accordion', () => {
  const rows = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:ABC123': {
        client: 'reasonix',
        sessionId: 'reasonix:ABC123',
        title: '测试一下',
        model: 'deepseek/deepseek-v4-flash',
        projectLabel: 'Qyen',
        totalTokens: 15382,
        promptTokens: 80,
        completionTokens: 30,
        reasoningTokens: 10,
        cacheHitTokens: 20,
        cacheMissTokens: 80,
        requestCount: 4,
        reportedCostUsd: 0.25,
        messageCount: 2,
        turns: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    clientColors: { reasonix: '#4d6bfe' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.kind, 'session');
  assert.equal(row.key, 'session:reasonix:ABC123');
  assert.equal(row.name, 'Reasonix · deepseek/deepseek-v4-flash');
  assert.equal(row.subtitle, '14:10 · 2 calls · 20%');
  assert.equal(row.detail, 'ABC123');
  assert.equal(row.value, 15382);
  assert.equal(row.cost, 0.25);
  assert.equal(row.sessionDetailAvailable, false);
  assert.equal(row.periodTokenDataUnavailable, false);
  assert.equal(row.client, 'reasonix');
  assert.equal(row.sortTime, new Date(localIso(2026, 8, 8, 14, 10)).getTime());
  assert.doesNotMatch(row.name, /测试一下/);
  assert.doesNotMatch(row.subtitle, /Qyen/);
  assert.doesNotMatch(row.detail, /reasonix:/);
  assert.equal(Object.hasOwn(row, 'nativeSessionBreakdown'), false);
  assert.equal(sessionIdLabel('reasonix:ABC123'), 'ABC123');

  const ordinary = sessionRowsForPeriod({
    sessions: {
      'codex:ordinary': {
        client: 'codex',
        sessionId: 'ordinary',
        totalTokens: 10,
        models: { 'gpt-5.6-luna': 10 },
        messageCount: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 9)
      }
    }
  }, { clientLabels, clientColors, now: new Date(2026, 7, 8, 14, 30) })[0];
  for (const field of ['name', 'subtitle', 'detail', 'value', 'cost', 'client', 'sortTime']) {
    assert.ok(Object.hasOwn(row, field), `Reasonix row is missing ${field}`);
    assert.ok(Object.hasOwn(ordinary, field), `ordinary row is missing ${field}`);
  }
  assert.equal(ordinary.name, 'Codex · gpt-5.6-luna');
  assert.equal(ordinary.subtitle, '14:09 · 1 call');
});

test('Reasonix cache percentages use native hits and misses without double-counting prompt tokens', () => {
  for (const [fields, expected] of [
    [{ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 80, cacheWriteTokens: 20 }, '90%'],
    [{ promptTokens: 1000, cacheHitTokens: 900 }, '90%'],
    [{ promptTokens: 1000, cacheHitTokens: 900, cacheMissTokens: 0 }, '100%'],
    [{ promptTokens: 1000, cacheHitTokens: 0, cacheMissTokens: 500, cacheWriteTokens: 500 }, '0%'],
    [{ promptTokens: 1000, cacheHitTokens: 5, cacheMissTokens: 995 }, '<1%'],
    [{ promptTokens: 1000, cacheHitTokens: 0, cacheMissTokens: 1000, cacheWriteTokens: 0 }, '0%'],
    [{ promptTokens: 1000, cacheHitTokens: 0, cacheMissTokens: 0, cacheWriteTokens: 0 }, ''],
    [{ promptTokens: 1000 }, ''],
    [{ cacheHitTokens: 0, cacheMissTokens: 0, cacheWriteTokens: 0 }, ''],
    [{ tokenDataUnavailable: true, cacheHitTokens: 0, cacheMissTokens: 1000 }, ''],
    [{ tokenDataUnavailable: true, cacheHitTokens: 900, cacheMissTokens: 100 }, '']
  ]) {
    const [row] = sessionRowsForPeriod({ sessions: {} }, { nativeSessions: {
      'reasonix:cache': { client: 'reasonix', sessionId: 'reasonix:cache', totalTokens: 1000, ...fields }
    } });
    assert.equal(row.subtitle, expected);
    assert.equal(row.sessionDetailAvailable, false, 'cache data does not enable per-turn details');
  }
});

test('Reasonix native rows omit turns from the compact subtitle when turns are unavailable', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:no-turns': {
        client: 'reasonix',
        sessionId: 'reasonix:no-turns',
        model: 'deepseek/deepseek-v4-flash',
        totalTokens: 1,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(row.subtitle, '14:10');
  assert.doesNotMatch(row.subtitle, /request|msg|turn/i);
});

test('Reasonix native rows remain visible when official per-session tokens are unavailable', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:official': {
        client: 'reasonix',
        sessionId: 'reasonix:official',
        model: 'deepseek/deepseek-v4-flash',
        tokenDataUnavailable: true,
        messageCount: 2,
        lastUsedAt: localIso(2026, 8, 8, 14, 10)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 8, 14, 30)
  });

  assert.equal(row.value, 0);
  assert.equal(row.tokenDataUnavailable, true);
  assert.equal(row.periodTokenDataUnavailable, false);
  assert.equal(row.sessionDetailAvailable, false);
  assert.equal(row.subtitle, '14:10 · 2 calls');
});

test('Reasonix native rows show cumulative totals for an unreliable bounded period', () => {
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:resumed': {
        client: 'reasonix',
        sessionId: 'reasonix:resumed',
        model: 'deepseek-v4-flash',
        totalTokens: 14777,
        reportedCostUsd: 0.00402028,
        periodTokenDataUnavailable: true,
        messageCount: 5,
        lastUsedAt: localIso(2026, 8, 9, 11, 46)
      }
    },
    clientLabels: { reasonix: 'Reasonix' },
    now: new Date(2026, 7, 9, 12, 0)
  });

  assert.equal(row.value, 14777);
  assert.equal(row.cost, 0.00402028);
  assert.equal(row.tokenDataUnavailable, false);
  assert.equal(row.periodTokenDataUnavailable, true);
});

test('Reasonix native rows hide legacy stats paths while keeping the compact message parameter', () => {
  const leakedPath = 'REASONIX:reasonix-stats:/Users/sunricardo/.reasonix/stats/2026-08-09.jsonl';
  const [row] = sessionRowsForPeriod({ sessions: {} }, {
    nativeSessions: {
      'reasonix:legacy-path': {
        client: 'reasonix',
        sessionId: leakedPath,
        model: 'deepseek-v4-flash',
        totalTokens: 123,
        messageCount: 6
      }
    },
    clientLabels: { reasonix: 'Reasonix' }
  });

  assert.equal(row.subtitle, '6 calls');
  assert.equal(row.detail, '');
  assert.doesNotMatch(row.title, /reasonix-stats|\/Users\//i);
  assert.equal(sessionIdLabel(leakedPath), '');
});

test('session rows label archived sessions without claiming the source was deleted', () => {
  const rows = sessionRowsForPeriod({
    sessions: {
      'opencode:deleted': {
        client: 'opencode',
        sessionId: 'deleted',
        totalTokens: 1200,
        models: { 'gpt-5': 1200 },
        messageCount: 3,
        lastUsedAt: localIso(2026, 5, 30, 12, 7),
        archived: true
      }
    }
  }, {
    clientLabels: { opencode: 'OpenCode' },
    now: new Date(2026, 4, 30, 12, 30),
    archivedLabel: 'Archived'
  });

  assert.equal(rows[0].archived, true);
  assert.equal(rows[0].subtitle, 'Archived · 12:07 · 3 calls');
  assert.equal(rows[0].title, 'OpenCode session deleted');
});

test('archived session count deduplicates retained sessions across periods', () => {
  assert.equal(archivedSessionCount({
    periods: {
      today: { sessions: {
        'claude:archived': { client: 'claude', sessionId: 'archived', archived: true },
        'claude:live': { client: 'claude', sessionId: 'live' }
      } },
      month: { sessions: {
        'claude:archived': { client: 'claude', sessionId: 'archived', archived: true },
        'codex:archived': { client: 'codex', sessionId: 'archived', archived: true }
      } },
      allTime: { sessions: {} }
    }
  }), 2);
  assert.equal(archivedSessionCount(null), 0);
});

test('session breakdown marks only periods affected by bounded sync detail', () => {
  const stats = { sessionDetailsOmitted: { today: 2, month: 7 } };
  assert.equal(sessionBreakdownIncomplete(stats, 'today'), true);
  assert.equal(sessionBreakdownIncomplete(stats, 'month'), true);
  assert.equal(sessionBreakdownIncomplete(stats, 'allTime'), false);
  assert.equal(sessionBreakdownIncomplete({ sessionDetailsOmitted: { today: 2 } }, 'allTime'), false);
  assert.equal(sessionBreakdownIncomplete({}, 'month'), false);
});

test('session layout keeps page chrome consistent and scrolls long labels on one line', () => {
  const styles = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'styles.css'), 'utf8');
  const renderer = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'renderer', 'app.js'), 'utf8');

  assert.doesNotMatch(styles, /\.shell\.session-mode\s*\{[^}]*gap:/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-panel/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.total-number/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.cost/);
  assert.doesNotMatch(styles, /\.shell\.session-mode \.row-title\s*\{[^}]*white-space:\s*normal;/s);
  assert.match(styles, /\.shell\.session-mode \.row-detail\s*\{[^}]*white-space:\s*nowrap;/s);
  assert.match(styles, /\.shell\.session-mode \.row-title\.is-hover-scrolling,/);
  assert.match(styles, /\.shell\.session-mode \.row-detail\.is-hover-scrolling\s*\{[^}]*text-overflow:\s*clip;/s);
  // A clickable row is marked by a hover wash keyed off its button role, not by
  // a `›` that would collide with the third right-hand line.
  assert.doesNotMatch(styles, /\.row-metrics::after/);
  assert.match(styles, /\.shell\.session-mode \.row\[role="button"\]:hover::before,\s*\.shell\.session-mode \.row\[role="button"\]:focus-visible::before\s*\{[^}]*opacity:\s*1;/s);
  assert.match(renderer, /class="row-activity"/);
  assert.match(renderer, /function setHoverMarqueeText\([^]*?overflowText\.setText\(element, value\)/);
});

test('a session still being written to is marked running and shows its context headroom', () => {
  const now = new Date(2026, 8, 18, 12, 30);
  const minutesAgo = (minutes) => new Date(now.getTime() - minutes * 60_000).toISOString();
  const rows = sessionRowsForPeriod({
    sessions: {
      'codex:live': {
        client: 'codex',
        sessionId: 'rollout-2026-09-18T11-44-50-019e76fc-dddd-eeee-ffff-222222222222',
        totalTokens: 24_870_232,
        costUsd: 21.91,
        models: { 'gpt-5.5': 24_870_232 },
        messageCount: 184,
        contextTokens: 190_867,
        contextWindow: 950_000,
        lastUsedAt: minutesAgo(2)
      },
      'codex:quiet': {
        client: 'codex',
        sessionId: 'rollout-2026-09-18T09-47-36-019e76fc-aaaa-bbbb-cccc-111111111111',
        totalTokens: 20_548_311,
        costUsd: 17.59,
        models: { 'gpt-5.5': 20_548_311 },
        messageCount: 160,
        lastUsedAt: minutesAgo(90)
      }
    }
  }, { clientLabels, clientColors, now });

  const live = rows.find((row) => row.key === 'session:codex:live');
  assert.equal(live.running, true);
  assert.deepEqual(live.context, {
    contextTokens: 190_867,
    contextWindow: 950_000,
    percentLeft: 80,
    percentUsed: 20,
    tone: ''
  });
  // The activity line keeps exactly what it carried before: it is one
  // ellipsizing line, so a headroom reading appended here would be paid for by
  // dropping the timestamp.
  assert.match(live.subtitle, /^\d{2}:\d{2} · 184 calls$/);

  const quiet = rows.find((row) => row.key === 'session:codex:quiet');
  assert.equal(quiet.running, undefined);
  assert.equal(quiet.context, undefined);
});

test('context headroom only takes on a colour as it runs out', () => {
  const now = new Date(2026, 8, 18, 12, 30);
  const toneAt = (contextTokens) => {
    const rows = sessionRowsForPeriod({
      sessions: {
        'codex:tight': {
          client: 'codex',
          sessionId: 'rollout-2026-09-18T11-44-50-019e76fc-dddd-eeee-ffff-444444444444',
          totalTokens: 1_000,
          models: { 'gpt-5.5': 1_000 },
          contextTokens,
          contextWindow: 200_000,
          lastUsedAt: new Date(now.getTime() - 60_000).toISOString()
        }
      }
    }, { clientLabels, clientColors, now });
    return rows[0].context;
  };

  assert.equal(toneAt(40_000).tone, '');
  assert.equal(toneAt(140_000).tone, 'caution');
  assert.equal(toneAt(180_000).tone, 'low');
  // The boundaries themselves belong to the more serious tone.
  assert.equal(toneAt(200_000 * 0.7).tone, 'caution');
  assert.equal(toneAt(200_000 * 0.9).tone, 'low');
  // Both readings of the gauge are published so the Remaining/Used preference
  // can flip the label without the two ever disagreeing by a point.
  assert.deepEqual(toneAt(190_000), {
    contextTokens: 190_000,
    contextWindow: 200_000,
    percentLeft: 5,
    percentUsed: 95,
    tone: 'low'
  });
});

test('an archived session is never running and a half-read context is not shown', () => {
  const now = new Date(2026, 8, 18, 12, 30);
  const rows = sessionRowsForPeriod({
    sessions: {
      'codex:archived': {
        client: 'codex',
        sessionId: 'rollout-2026-09-18T12-20-00-019e76fc-aaaa-bbbb-cccc-333333333333',
        totalTokens: 100,
        models: { 'gpt-5.5': 100 },
        archived: true,
        contextTokens: 5_000,
        contextWindow: 200_000,
        lastUsedAt: new Date(now.getTime() - 60_000).toISOString()
      },
      'claude:windowless': {
        client: 'claude',
        sessionId: '214c24d5-aaaa-bbbb-cccc-f87e',
        totalTokens: 200,
        models: { 'claude-opus-5': 200 },
        contextTokens: 5_000,
        lastUsedAt: new Date(now.getTime() - 60_000).toISOString()
      }
    }
  }, { clientLabels, clientColors, now, archivedLabel: 'Archived' });

  const archived = rows.find((row) => row.key === 'session:codex:archived');
  assert.equal(archived.running, undefined);
  assert.equal(archived.context, undefined);

  const windowless = rows.find((row) => row.key === 'session:claude:windowless');
  assert.equal(windowless.running, true);
  assert.equal(windowless.context, undefined);
});

test('session rows keep a completed session cache when the recent context expires in every period', () => {
  const at = Date.parse('2026-09-30T09:00:00Z');
  const session = { client: 'codex', sessionId: 'cache-session', totalTokens: 100, lastUsedAt: new Date(at).toISOString(), turnEnded: true,
    contextTokens: 60, contextWindow: 100, promptCache: { observedAt: new Date(at).toISOString(), ttlSeconds: 1800 } };
  for (const period of ['today', 'month', 'allTime']) {
    const before = sessionRowsForPeriod({ sessions: { cache: session } }, { now: new Date(at + 600_000) })[0];
    assert.equal(before.context.percentUsed, 60, period);
    const after = sessionRowsForPeriod({ sessions: { cache: session } }, { now: new Date(at + 600_001) })[0];
    assert.equal(after.context, undefined, period);
    assert.equal(after.promptCache.minutes, 20, period);
    assert.equal(after.contextSnapshot.contextTokens, 60, period);
    assert.equal(after.contextSnapshot.contextWindow, 100, period);
    assert.equal(sessionRowsForPeriod({ sessions: { cache: session } }, { now: new Date(at + 1800_000) })[0].promptCache, null, period);
  }
});

test('the shared metrics slot restores its meter and tone after cache or empty states', () => {
  const fs = require('node:fs');
  const source = fs.readFileSync(require.resolve('../../src/electron/renderer/app.js'), 'utf8');
  const body = source.slice(source.indexOf('function updateRowContext('), source.indexOf('// Flare the row', source.indexOf('function updateRowContext(')));
  const element = () => {
    const classes = new Set();
    return { dataset: {}, textContent: '', classList: { add: x => classes.add(x), remove: x => classes.delete(x), toggle: (x, on) => on ? classes.add(x) : classes.delete(x), contains: x => classes.has(x) }, removeAttribute(name) { delete this[name]; } };
  };
  const gauge = element(), meter = element(), value = element(), fill = { style: { setProperty() {} } };
  gauge.querySelector = selector => ({ '.row-context-meter': meter, '.row-context-value': value, '.row-context-fill': fill })[selector];
  const row = { querySelector: () => gauge };
  const update = Function('state', 't', 'sessionRowsApi', 'limitWindowsView', body + '\nreturn updateRowContext;')({ settings: {} }, (key, params) => `${key}:${JSON.stringify(params)}`, require('../../src/electron/renderer/sessionRows'), { setDetailTooltip(node, entries) { node.entries = entries; } });
  update(row, { percentLeft: 5, percentUsed: 95, tone: 'low' });
  assert.equal(gauge.dataset.tone, 'low');
  update(row, null, { minutes: 20, ttlSeconds: 1800 }, { contextTokens: 123000, contextWindow: 200000 });
  assert.equal(gauge.classList.contains('hidden'), false);
  assert.equal(meter.classList.contains('hidden'), true);
  assert.equal(gauge.dataset.tone, '');
  assert.match(value.textContent, /20/);
  assert.equal(gauge.entries[0].full, '123K / 200K');
  assert.match(gauge.entries[1].full, /20/);
  update(row, { percentLeft: 40, percentUsed: 60, tone: '' });
  assert.equal(meter.classList.contains('hidden'), false);
  assert.equal(value.textContent, '60%');
  update(row, { percentLeft: 40, percentUsed: 60, tone: '', contextTokens: 123000, contextWindow: 200000 }, { minutes: 29, ttlSeconds: 1800 });
  assert.equal(value.textContent, '60%');
  assert.match(gauge.entries.at(-1).full, /29/);
  assert.equal(gauge.entries[0].full, '123K / 200K');
  update(row, { percentLeft: 40, percentUsed: 60, tone: '' }, null, 'codex');
  assert.equal(gauge.entries.length, 0);
  update(row, null, null);
  assert.equal(gauge.classList.contains('hidden'), true);
  assert.equal(gauge.title, undefined);
  assert.deepEqual(gauge.entries, []);
});


test('Grok Bot groups all bot conversations by latest activity and conserves totals', () => {
  const now = new Date(2026, 4, 30, 12, 30);
  const at = localIso(2026, 5, 30, 12, 20);
  const bot = (id, patch = {}) => ({ client: 'cursor', sessionId: id, totalTokens: 20,
    costUsd: 0.1, models: { 'grok-bot-automation': 20 }, lastUsedAt: at, ...patch });
  const sessions = {
    'cursor:sand-subagent-a': bot('sand-subagent-a', { title: 'Renamed bot', unpricedTokens: 4 }),
    'cursor:sand-subagent-b': bot('sand-subagent-b', { archived: true, totalTokens: 30,
      models: { 'grok-bot-automation': 30 }, lastUsedAt: localIso(2026, 5, 30, 12, 10) }),
    'cursor:default': bot('default', { models: { 'grok-bot-default': 20 } }),
    'cursor:sand-subagent-knowledge': bot('sand-subagent-knowledge', { models: { 'grok-bot-knowledge-work': 20 } }),
    'cursor:sand-subagent-cua': bot('sand-subagent-cua', { models: { 'grok-bot-cua': 20 } }),
    'cursor:mixed': bot('mixed', { models: { 'grok-bot-default': 10, 'claude-opus-5-5-medium': 10 } }),
    'cursor:sand-subagent-claude': bot('sand-subagent-claude', { models: { 'claude-opus-5-5-medium': 20 } }),
    'cursor:ordinary-claude': bot('ordinary-claude', { models: { 'claude-opus-5-5-medium': 20 }, lastUsedAt: localIso(2026, 5, 30, 12, 30) }),
    'cursor:ordinary-grok': bot('ordinary-grok', { models: { 'cursor-grok-4.6-medium': 20 } }),
    'cursor:empty': bot('empty', { models: { 'grok-bot-default': 0, 'grok-4': 20 } }),
    'cursor:sand-subagent-': bot('sand-subagent-', { models: {} }),
    'claude:sand-subagent-other-client': bot('sand-subagent-other-client', { client: 'claude' }),
    'codex:review': { client: 'codex', sessionId: 'review', totalTokens: 10, costUsd: 0.2,
      sessionKind: 'background-review', models: { 'gpt-5': 10 }, lastUsedAt: localIso(2026, 5, 30, 12, 5) }
  };
  const before = JSON.stringify(sessions);
  for (const name of ['today', 'month', 'allTime']) {
    const rows = sessionRowsForPeriod({ sessions }, { now });
    const grouped = groupSessionRows(rows, { grokBot: { now, label: 'Grok Bot',
      countLabel: count => `${count} 筆活動記錄`, summaryLabel: ({ latestTime }) => `最近 ${latestTime}` } });
    const group = grouped.find(row => row.sessionGroup === 'cursor-grok-bot');
    assert.equal(group.name, 'Grok Bot');
    assert.equal(group.detail, '7 筆活動記錄');
    assert.equal(group.subtitle, '最近 12:20');
    assert.equal(group.value, 150);
    assert.ok(Math.abs(group.cost - 0.7) < 1e-9);
    assert.equal(group.unpricedTokens, 4);
    assert.equal(group.groupRows.length, 7);
    assert.equal(group.groupRows.at(-1).key, 'session:cursor:sand-subagent-b');
    assert.equal(group.groupRows.at(-1).archived, true);
    assert.equal(grouped[0].key, 'session:cursor:ordinary-claude');
    assert.ok(grouped.indexOf(group) < grouped.findIndex(row => row.sessionGroup === 'codex-auto-review'));
    assert.deepEqual(grouped.filter(row => !row.sessionGroup), rows.filter(row => !row.backgroundReview && !row.grokBot));
    assert.ok(grouped.every((row, i) => i === 0 || grouped[i - 1].sortTime >= row.sortTime), name);
    for (const metric of ['value', 'cost', 'unpricedTokens']) {
      const sum = list => list.reduce((n, row) => n + (Number(row[metric]) || 0), 0);
      assert.ok(Math.abs(sum(grouped) - sum(rows)) < 1e-9, `${name}: ${metric} counted once`);
    }
  }
  const rows = sessionRowsForPeriod({ sessions }, { now });
  const newest = rows.find(row => row.grokBot);
  const newer = rows.map(row => row === newest ? { ...row, sortTime: now.getTime() + 1000 } : row);
  assert.equal(groupSessionRows(newer)[0].sessionGroup, 'cursor-grok-bot');
  assert.equal(JSON.stringify(sessions), before, 'source sessions and identities remain untouched');
  assert.deepEqual(groupSessionRows([]), []);
  assert.deepEqual(groupSessionRows(undefined), []);
});

test('a Claude-only day joins a known bot conversation across period snapshots', () => {
  const claude = { client: 'cursor', sessionId: 'bot', totalTokens: 10, models: { 'claude-opus-5-5-medium': 10 } };
  const today = { sessions: { 'cursor:bot': claude, 'cursor:ordinary': { ...claude, sessionId: 'ordinary' } } };
  const month = { sessions: { 'cursor:bot': { ...claude, totalTokens: 20,
    models: { 'grok-bot-default': 10, 'claude-opus-5-5-medium': 10 } } } };
  const rows = groupSessionRows(sessionRowsForPeriod(today, { sourcePeriods: { today, month } }));
  assert.equal(rows.find(row => row.sessionGroup === 'cursor-grok-bot').value, 10);
  assert.equal(rows.find(row => row.key === 'session:cursor:ordinary').value, 10);
  assert.equal(groupSessionRows(sessionRowsForPeriod(today)).length, 2, 'missing evidence never guesses');
});

test('Grok group run summaries expose usage without an unsupported transcript action', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const body = source.slice(source.indexOf('function sessionGroupRunNode('), source.indexOf('function renderSessionGroupDetail('));
  const api = require('../../src/electron/renderer/sessionRows');
  const children = new Map();
  const node = { attributes: {}, events: {}, setAttribute(key, value) { this.attributes[key] = value; },
    querySelector(selector) { if (!children.has(selector)) children.set(selector, {}); return children.get(selector); },
    addEventListener(type, callback) { this.events[type] = callback; } };
  const render = Function('document', 'sessionRowsApi', 't', 'formatNumber', 'formatCost', 'applyBarScale', 'rowWidth',
    'openSessionDetail', 'bindHoverMarquee', 'limitWindowsView', `${body}\nreturn sessionGroupRunNode;`)(
    { createElement: () => node }, api, key => key, String, (cost, unpriced) => `${cost}:${unpriced || 0}`,
    () => {}, () => 100, () => assert.fail('Cursor has no transcript detail'), () => {}, {});
  const [row] = sessionRowsForPeriod({ sessions: { 'cursor:sand-subagent-run': {
    client: 'cursor', sessionId: 'sand-subagent-run', totalTokens: 30, costUsd: 0.5,
    unpricedTokens: 4, models: { 'grok-bot-automation': 30 }, lastUsedAt: new Date().toISOString()
  } } });
  render(row, 30, { kind: 'session-group', summary: { name: 'Grok Bot', sessionGroup: 'cursor-grok-bot' } });
  assert.equal(node.querySelector('.detail-ex-title').textContent, row.name);
  assert.equal(node.querySelector('.detail-ex-sub').textContent, row.subtitle);
  assert.equal(node.querySelector('.session-group-id').textContent, 'sand-subagent-run');
  assert.equal(node.querySelector('.detail-ex-value').textContent, '30');
  assert.equal(node.querySelector('.detail-ex-cost').textContent, '0.5:4');
  assert.equal(node.querySelector('.detail-chev').textContent, '');
  assert.deepEqual(node.attributes, {});
  assert.deepEqual(node.events, {});
});
