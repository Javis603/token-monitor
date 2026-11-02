'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { recentSessionRows } = require('../../src/electron/renderer/edgeDock/presentation');
const { sessionStatusNode, sessionReasoningEffortForRow, sessionModelMetadataNode, sessionModelMetadataLabel,
  sessionRowsForPeriod, groupSessionRows } = require('../../src/electron/renderer/sessionRows');
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

for (const client of ['codex', 'claude']) test(`${client} effort stays visible after context/cache expiry and archive retention`, () => {
  const row = session({ client });
  const context = render(row);
  assert.equal(text(context), '60%');
  assert.equal(sessionReasoningEffortForRow(row, at), 'high');
  assert.equal(context.entries.length, client === 'codex' ? 1 : 2, 'context/cache tooltip does not repeat effort');
  const cached = render(row, at + 600_001);
  if (client === 'codex') assert.equal(cached, null, 'legacy Codex cache is hidden');
  else assert.match(text(cached), /20m/);
  assert.doesNotMatch(text(cached), /high/);
  assert.equal(sessionReasoningEffortForRow(row, at + 600_001), 'high');
  assert.equal(sessionReasoningEffortForRow(row, at + 1800_000), 'high');
  assert.equal(render(row, at + 1800_000), null, 'only live metrics expire');
  assert.equal(sessionReasoningEffortForRow(session({ client, archived: true }), at + 86400_000), 'high');
  assert.equal(render(session({ promptCache: null }), at + 600_001), null);
  assert.equal(render(session({ archived: true })), null);
  for (const effort of [null, undefined, {}, ' ', '<script>', 'x'.repeat(33)]) {
    assert.equal(sessionReasoningEffortForRow(session({ reasoningEffort: effort }), at), null);
    assert.doesNotMatch(text(render(session({ reasoningEffort: effort }))), /high|script/);
  }
  for (const locale of Object.keys(MESSAGES)) {
    assert.equal(render(row, at, locale).entries.length, client === 'codex' ? 1 : 2);
    assert.notEqual(translate(locale, 'session.reasoningEffortLabel', { effort: 'high' }), 'session.reasoningEffortLabel');
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

for (const client of ['codex', 'claude']) test(`${client} resumed native metadata replaces archived effort consistently`, t => {
  t.mock.timers.enable({ apis: ['Date'], now: at });
  const key = `${client}:s`;
  const raw = session({ client, archived: true, costUsd: 1, lastUsedAt: iso(-1000) });
  for (const effort of ['low', null, undefined]) {
    const native = session({ client, native: true, reasoningEffort: effort,
      liveActivity: { state: 'running', observedAt: iso(0) } });
    const period = { sessions: { [key]: raw } };
    const nativeSessions = { [key]: native };
    const [row] = sessionRowsForPeriod(period, { nativeSessions, now: new Date(at) });
    const [dock] = recentSessionRows({ periods: { month: period }, nativeSessions: { month: nativeSessions } });
    assert.equal(sessionReasoningEffortForRow(row), effort ?? null);
    assert.equal(sessionReasoningEffortForRow(dock), effort ?? null);
    assert.equal(row.value, 10); assert.equal(row.cost, 1);
    assert.equal(dock.totalTokens, 10); assert.equal(dock.costUsd, 1);
  }
});

for (const client of ['codex', 'claude']) test(`${client} shared model metadata renders the same persistent setting in plain and grouped rows`, () => {
  const document = {
    createTextNode: textContent => ({ textContent, children: [] }),
    createElement: () => ({ children: [], attributes: {},
      append(...nodes) { this.children.push(...nodes); },
      setAttribute(key, value) { this.attributes[key] = value; } })
  };
  const options = { translate: (key, values) => translate('en', key, values),
    view: { setDetailTooltip(node, entries) { node.entries = entries; } } };
  const raw = session({ client, archived: true, title: 'Saved conversation', models: { 'gpt-test': 10 } });
  const [row] = sessionRowsForPeriod({ sessions: { [`${client}:s`]: raw } }, { now: new Date(at + 86400_000) });
  assert.equal(row.subtitle, `${client} · gpt-test · high`);
  assert.equal(text(sessionModelMetadataNode(document, row, options)), 'gpt-test · high');
  assert.equal(text(sessionModelMetadataNode(document, raw, options)), 'gpt-test · high');
  const [dock] = recentSessionRows({ periods: { month: { sessions: { [`${client}:s`]: raw } } } });
  assert.equal(sessionReasoningEffortForRow(dock), 'high');
  const child = session({ client, sessionId: 'child', parentSessionId: 's', reasoningEffort: 'low', models: { child: 10 } });
  const [group] = groupSessionRows(sessionRowsForPeriod({ sessions: { [`${client}:s`]: raw, [`${client}:child`]: child } }, {
    now: new Date(at + 86400_000)
  }));
  assert.equal(sessionModelMetadataLabel(group), '2 models · high');
  const node = sessionModelMetadataNode(document, group, options);
  assert.equal(text(node), '2 models · high');
  assert.equal(node.children[0].entries.length, 2, 'model breakdown retains its own tooltip');
  assert.match(node.children.at(-1).attributes['aria-label'], /high/);
  assert.equal(node.children.at(-1).entries, undefined, 'effort is plain text without a tooltip');
  assert.equal(node.children.at(-1).attributes.tabindex, undefined);
  assert.equal(sessionModelMetadataLabel({ ...raw, client: 'gemini' }), 'gpt-test');
  assert.equal(sessionModelMetadataLabel({ ...raw, reasoningEffort: null }), 'gpt-test');
});
