'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const sessionRows = require('../../src/electron/renderer/sessionRows');
const { recentSessionRows } = require('../../src/electron/renderer/edgeDock/presentation');
const { extractUsageFromTokscale, stripSessionTextFromDeviceRecord } = require('../../src/shared/usage');

const AT = '2026-10-16T08:00:00.000Z';

test('OMP displays only the text of a Nerd Font card prefix and preserves its stored title', () => {
  // OMP's title-card.ts formats both generated and /rename titles as
  // <icon> <CODE>: <title>; the icon varies with the session's subject.
  const cases = [
    ['\u{F066E} PLAN: Plan carefully', 'PLAN: Plan carefully'],
    ['\u{F0093} FLAKY: Fix flaky tests', 'FLAKY: Fix flaky tests'],
    ['\uE000 Z3: 自訂標題 😀 \uE001', 'Z3: 自訂標題 😀 \uE001'],
    ['\u{100000} CACHE: Keep \u{F066E} inside', 'CACHE: Keep \u{F066E} inside'],
    ['🧪 FLAKY: Fix flaky tests', '🧪 FLAKY: Fix flaky tests'],
    ['Plain 中文 😀 title', 'Plain 中文 😀 title'],
    ['\u{F066E} Custom title', '\u{F066E} Custom title'],
    ['\u{F066E} lowercase: Custom title', '\u{F066E} lowercase: Custom title'],
    ['\u{F066E} TOOLONG: Custom title', '\u{F066E} TOOLONG: Custom title'],
    ['\u{F066E} PLAN:', '\u{F066E} PLAN:'],
    ['\u{F066E}', '\u{F066E}'],
    ['Custom \u{F066E} PLAN: title', 'Custom \u{F066E} PLAN: title']
  ];
  for (const client of ['omp', 'pi', 'codex', 'claude']) for (const [title, ompDisplay] of cases) {
    const session = Object.freeze({ client, sessionId: 's', title, totalTokens: 42, costUsd: 0.1,
      lastUsedAt: AT, models: { model: 42 } });
    const period = { sessions: { [`${client}:s`]: session } };
    const expected = client === 'omp' ? ompDisplay : title;
    assert.equal(sessionRows.sessionRowsForPeriod(period)[0].name, expected, `${client}: ${title}`);
    // Home and the Edge Dock share this projection, including grouped row names.
    const [recent] = recentSessionRows({ periods: { today: period, month: period } });
    assert.equal(recent.title, expected, `${client} recent title: ${title}`);
    assert.equal(session.title, title);
  }
});

test('OMP detail headings format current metadata and the captured title without rewriting either', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('function sessionDetailTitle(');
  const end = source.indexOf('\nfunction refreshSessionDetailHeading(', start);
  assert.ok(start >= 0 && end > start);
  const state = { settings: {}, period: 'today', openSession: {
    client: 'omp', sessionId: 's', title: '\u{F0093} OLD: Captured title'
  } };
  const heading = Function('state', 'sessionRowsApi', `return (${source.slice(start, end)});`)(state, sessionRows);
  assert.equal(heading(), 'OLD: Captured title');
  const current = Object.freeze({ client: 'omp', title: '\u{F066E} NEW: 自訂標題 😀 \uE000' });
  state.stats = { periods: { today: { sessions: { 'omp:s': current } } } };
  assert.equal(heading(), 'NEW: 自訂標題 😀 \uE000');
  assert.equal(current.title, '\u{F066E} NEW: 自訂標題 😀 \uE000');
  assert.equal(state.openSession.title, '\u{F0093} OLD: Captured title');
  state.settings.sessionTitlesEnabled = false;
  assert.equal(heading(), '');
  state.openSession.returnTo = { kind: 'session-group' };
  assert.equal(heading(), state.openSession.title, 'fixed model/time group headings retain their own semantics');
});

test('OMP family summaries and members share the same display-only card formatting', () => {
  const parent = Object.freeze({ client: 'omp', sessionId: 'parent', title: '\u{F066E} PLAN: Parent',
    totalTokens: 42, lastUsedAt: AT });
  const child = Object.freeze({ ...parent, sessionId: 'child', parentSessionId: 'parent',
    title: '\u{F0093} TEST: Child' });
  const period = { sessions: { 'omp:parent': parent, 'omp:child': child } };
  const [group] = recentSessionRows({ periods: { today: period, month: period } });
  assert.equal(group.title, 'PLAN: Parent');
  assert.deepEqual(group.groupRows.map(row => row.title), ['PLAN: Parent', 'TEST: Child']);
  assert.equal(group.totalTokens, 84);
  assert.equal(parent.title, '\u{F066E} PLAN: Parent');
  assert.equal(child.title, '\u{F0093} TEST: Child');
});

test('collection and permitted title sync retain private-use text for OMP and other clients', () => {
  const title = '\u{F066E} PLAN: Keep \uE000 \u{100000}';
  const period = extractUsageFromTokscale(['omp', 'pi', 'codex', 'claude'].map(client => ({
    client, sessionId: 's', sessionTitle: title, totalTokens: 42
  })));
  const sync = stripSessionTextFromDeviceRecord({ today: period }, { preserveSessionTitles: true });
  for (const client of ['omp', 'pi', 'codex', 'claude']) {
    const key = `${client}:s`;
    assert.equal(period.sessions[key].title, title);
    assert.equal(sync.today.sessions[key].title, title);
    sessionRows.sessionRowsForPeriod(period);
    assert.equal(period.sessions[key].title, title);
  }
});
