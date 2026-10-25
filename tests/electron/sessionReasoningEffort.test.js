'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { recentSessionRows } = require('../../src/electron/renderer/edgeDock/presentation');
const { sessionStatusNode, sessionReasoningEffortForRow } = require('../../src/electron/renderer/sessionRows');
const { translate, MESSAGES } = require('../../src/electron/renderer/i18n');
const at = Date.parse('2026-10-25T10:00:00Z');
const iso = offset => new Date(at + offset).toISOString();
const session = extra => ({ client: 'codex', sessionId: 's', totalTokens: 10, lastUsedAt: iso(0),
  turnEnded: true, contextTokens: 60, contextWindow: 100, reasoningEffort: 'high',
  promptCache: { observedAt: iso(0), ttlSeconds: 1800 }, ...extra });
function render(row, now = at, locale = 'en') {
  const document = { createElement: () => ({ children: [], dataset: {}, attributes: {}, style: { setProperty() {} },
    setAttribute(key, value) { this.attributes[key] = value; }, append(...nodes) { this.children.push(...nodes); } }) };
  return sessionStatusNode(document, row, { prefix: 'edge-dock-session', now,
    translate: (key, values) => translate(locale, key, values),
    view: { setDetailTooltip(node, entries) { node.entries = entries; } } });
}
function text(node) { return node ? [node.textContent || '', ...node.children.map(text)].join('') : ''; }

test('effort shares context/cache visibility while the metrics slot keeps only its reading', () => {
  const row = session();
  const context = render(row);
  assert.equal(text(context), '60%');
  assert.equal(sessionReasoningEffortForRow(row, at), 'high');
  assert.match(context.entries.at(-1).full, /Latest main-session turn.*high/);
  const cached = render(row, at + 600_001);
  assert.match(text(cached), /20m/);
  assert.doesNotMatch(text(cached), /high/);
  assert.equal(sessionReasoningEffortForRow(row, at + 600_001), 'high');
  assert.equal(sessionReasoningEffortForRow(row, at + 1800_000), null);
  assert.equal(render(row, at + 1800_000), null, 'expiry removes effort with the status');
  assert.equal(render(session({ promptCache: null }), at + 600_001), null);
  assert.equal(render(session({ archived: true })), null);
  for (const effort of [null, undefined, {}, ' ', '<script>', 'x'.repeat(33)]) {
    assert.equal(sessionReasoningEffortForRow(session({ reasoningEffort: effort }), at), null);
    assert.doesNotMatch(text(render(session({ reasoningEffort: effort }))), /high|script/);
  }
  for (const locale of Object.keys(MESSAGES)) {
    assert.match(render(row, at, locale).entries.at(-1).full, /high/);
    assert.notEqual(translate(locale, 'session.reasoningEffortTooltip', { effort: 'high' }), 'session.reasoningEffortTooltip');
  }
});

test('Dock carries latest main effort independently of cumulative models and child settings', () => {
  const make = effort => ({ periods: { month: { sessions: {
    'codex:old': session({ sessionId: 'old', nativeSessionId: 'conversation', reasoningEffort: 'high', lastUsedAt: iso(-1000), models: { old: 10 } }),
    'codex:new': session({ sessionId: 'new', nativeSessionId: 'conversation', reasoningEffort: effort, models: { current: 10 } }),
    'codex:child': session({ sessionId: 'child', parentSessionId: 'new', reasoningEffort: 'low', lastUsedAt: iso(1000), models: { child: 10 } })
  } } } });
  for (const effort of [null, 'xhigh']) {
    const rows = recentSessionRows(make(effort));
    assert.equal(rows.length, 1);
    const group = rows[0];
    assert.equal(group.groupRows[0].sessionId, 'new');
    assert.equal(group.groupRows[0].reasoningEffort, effort);
    assert.equal(Object.keys(group.models).length, 3);
    assert.equal(sessionReasoningEffortForRow(group, at), effort);
    assert.equal(text(render(group)), '60%');
  }
});
