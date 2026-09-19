'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { limitWindowText } = require('../../src/shared/limitWindowText');
const { limitProviderFreshness } = require('../../src/electron/renderer/limitProviderPresentation');

function read(relativePath) {
  return fs.readFileSync(path.join(__dirname, '../..', relativePath), 'utf8');
}

function text(providerId, window, showLimitUsed = false) {
  return limitWindowText({ provider: providerId }, window, {
    showLimitUsed,
    formatCompact: (value) => `${value}`
  });
}

test('a spend meter reads as money for whichever provider reported it', () => {
  const capped = { kind: 'billing', metric: 'spend', used: 2.35, limit: 20, currency: 'USD' };
  const uncapped = { kind: 'billing', metric: 'spend', used: 2.35, currency: 'USD' };
  assert.equal(text('claude', capped).value, '$2.35 / $20.00');
  assert.equal(text('cursor', capped).value, '$2.35 / $20.00');
  // Without a cap the bare amount would be ambiguous, so it says what it is.
  assert.equal(text('claude', uncapped).value, '$2.35 spent');
  assert.equal(text('cursor', uncapped).value, '$2.35 spent');
  // A zero cap is not a denominator.
  assert.equal(text('cursor', { ...uncapped, limit: 0 }).value, '$2.35 spent');
});

test('a money grant keeps the percentage headline and puts the amount underneath', () => {
  const grant = { kind: 'billing', metric: 'credits', label: 'Monthly', remaining: 47.42, limit: 70, currency: 'USD' };
  // Replacing the headline would leave the bar and its own label disagreeing,
  // so the grant says so explicitly to the surfaces that lead balances with
  // money — without the flag the card read "$47.42" and the page "68% left".
  assert.deepEqual(text('commandcode', grant), { value: null, detail: '$47.42 / $70.00', percentLeads: true });
  // A top-up with no denominator has no percentage to lead with, so it does not
  // claim one and the card still shows the money.
  assert.equal(text('commandcode', { ...grant, limit: null, showMeter: false }).percentLeads, false);
  assert.equal(text('commandcode', grant, true).detail, '$22.58 / $70.00');
  assert.equal(text('commandcode', { kind: 'billing', metric: 'credits', remaining: 5 }).detail, '');
});

test('a meterless overage is one line with no bar behind it', () => {
  assert.deepEqual(
    text('kiro', { kind: 'billing', label: 'Overage', showMeter: false, used: 14, remaining: 0.56 }),
    { value: '14 credits · $0.56', detail: '', percentLeads: false }
  );
  // Either half may be missing.
  assert.equal(text('kiro', { kind: 'billing', showMeter: false, used: 14 }).value, '14 credits');
  assert.equal(text('kiro', { kind: 'billing', showMeter: false, remaining: 0.56 }).value, '$0.56');
  // A metered pool counts units instead.
  assert.equal(text('kiro', { kind: 'billing', used: 120, limit: 500 }).detail, '380/500');
});

// Each provider's rule applies to the window kind the Limits view applies it
// to, and no other. Command Code's rolling limits are USD, so an unscoped money
// rule handed them a denominator line the page never showed — and in a narrow
// card that second figure pushed "Reset 4h 6m" into "Res…".
test('a provider rule only touches the window kind it belongs to', () => {
  const fiveHour = { kind: 'session', used: 0.1, limit: 14, remaining: 13.9, currency: 'USD' };
  const weekly = { kind: 'weekly', used: 28.43, limit: 35, remaining: 6.57, currency: 'USD' };
  assert.equal(text('commandcode', fiveHour).detail, '');
  assert.equal(text('commandcode', weekly).detail, '');
  assert.equal(
    text('commandcode', { kind: 'billing', metric: 'credits', remaining: 41.57, limit: 70, currency: 'USD' }).detail,
    '$41.57 / $70.00'
  );

  // Z.ai prints a token pair for its daily windows and its plan buckets (the
  // billing windows carrying a plan id), not for the rolling percentages or
  // the MCP bucket, which has no id.
  assert.equal(text('zai', { kind: 'session', remaining: 100, limit: 200 }).detail, '');
  assert.equal(text('zai', { kind: 'weekly', remaining: 100, limit: 200 }).detail, '');
  assert.equal(text('zai', { kind: 'billing', label: 'MCP', remaining: 100, limit: 200 }).detail, '');
  assert.equal(text('zai', { kind: 'daily', remaining: 100, limit: 200 }).detail, '100 / 200');
  assert.equal(text('zai', { kind: 'billing', limitId: 'zcode-model:x', remaining: 100, limit: 200 }).detail, '100 / 200');

  for (const id of ['kiro', 'qoder', 'zed', 'kimi']) {
    assert.equal(text(id, { kind: 'session', used: 1, limit: 4, detail: 'x' }).detail, '', id);
  }
});

test('a window with no absolute units keeps its percentage-only look', () => {
  for (const id of ['kiro', 'qoder', 'zed', 'zai']) {
    assert.deepEqual(text(id, { kind: 'billing', usedPercent: 40 }), { value: null, detail: '', percentLeads: false }, id);
  }
  assert.deepEqual(text('codex', { kind: 'session', usedPercent: 40 }), { value: null, detail: '', percentLeads: false });
  assert.deepEqual(text('commandcode', null), { value: null, detail: '', percentLeads: false });
});

// `detail` is a general-purpose wire field that several providers use for
// something other than a figure under the bar — Zed and third-party presets
// read "unlimited" out of it, OpenRouter promotes it to the headline of a
// meterless window. Echoing it everywhere would invent rows.
test('the wire detail is shown only where it means a figure under the bar', () => {
  const window = { kind: 'billing', detail: 'Kimi 40% · Code 60%' };
  assert.equal(text('kimi', window).detail, 'Kimi 40% · Code 60%');
  assert.equal(text('zai', { ...window, limitId: 'zcode-model:x' }).detail, 'Kimi 40% · Code 60%');
  for (const id of ['copilot', 'codex', 'grok', 'openrouter', 'thirdparty', 'zed']) {
    assert.equal(text(id, { kind: 'billing', detail: 'Unlimited' }).detail, '', id);
  }
});

test('freshness reads the same on every surface', () => {
  const nowMs = Date.parse('2026-09-19T12:00:00.000Z');
  const at = (minutes) => new Date(nowMs - minutes * 60_000).toISOString();

  assert.deepEqual(
    limitProviderFreshness({ updatedAt: at(0.5) }, { nowMs }),
    { text: 'Updated just now', age: 'just now', tone: 'ok' }
  );
  assert.equal(limitProviderFreshness({ updatedAt: at(55) }, { nowMs }).text, 'Updated 55m ago');
  assert.equal(limitProviderFreshness({ updatedAt: at(55), stale: true }, { nowMs }).text, 'Stale · 55m ago');
  assert.equal(limitProviderFreshness({ updatedAt: at(200), stale: true }, { nowMs }).tone, 'stale');
  // Staleness still has to be reported when the timestamp is unreadable.
  assert.equal(limitProviderFreshness({ stale: true }, { nowMs }).text, 'Stale');
  assert.equal(limitProviderFreshness({}, { nowMs }).text, 'Update unknown');
});

test('both renderers paint from the shared modules, not their own copies', () => {
  const app = read('src/electron/renderer/app.js');
  const dock = read('src/electron/renderer/edgeDock/dock.js');

  assert.match(app, /const \{ limitWindowText \} = window\.TokenMonitorLimitWindowText;/);
  assert.match(dock, /const limitWindowTextApi = window\.TokenMonitorLimitWindowText;/);
  for (const page of ['src/electron/renderer/index.html', 'src/electron/renderer/edgeDock/index.html']) {
    assert.match(read(page), /limitWindowText\.js/, `${page} should load the module`);
  }

  // The per-provider formatters moved out of the renderer entirely.
  for (const name of [
    'formatCursorSpendValue',
    'formatZedBillingDetail',
    'formatZcodeTokensDetail',
    'formatKiroOverageValue',
    'formatCommandcodeCreditsDetail',
    'formatLimitCount'
  ]) {
    assert.doesNotMatch(app, new RegExp(`function ${name}\\(`), `${name} should live in the shared module`);
  }

  // One age formatter, called by both, replacing three hand-rolled copies. The
  // limits meta line is the shared view's, so the page reaches it through the
  // view rather than formatting an age of its own.
  assert.match(read('src/electron/renderer/limitWindowsView.js'), /presentationApi\.limitProviderFreshness\(provider\)/);
  // The card formats no age of its own — it renders the page's rows, so the
  // freshness wording has exactly one call site across both surfaces.
  assert.doesNotMatch(dock, /limitProviderFreshness/);
  assert.doesNotMatch(app, /function formatUpdatedAge\(/);
  assert.doesNotMatch(dock, /function updatedText\(/);
  // The card's separate staleness line is gone with the wording it explained.
  assert.doesNotMatch(dock, /edgeDock\.stale/);
  assert.doesNotMatch(read('src/electron/renderer/i18n.js'), /edgeDock\.stale/);

  // The wording module is reached through the shared view now: the card builds
  // the Limits page's rows rather than a second set that reads the same text.
  // Both card branches go through the view's own entry points, and neither page
  // hands the view per-provider options — which mark, colour and plan text an
  // account takes is the view's policy, so the two surfaces cannot be told
  // different things about the same provider.
  assert.match(dock, /limitWindowsView\.renderLimitProviderSolo\(/);
  assert.match(dock, /limitWindowsView\.renderLimitProviderGroup\(/);
  assert.match(dock, /limitWindowText: limitWindowTextApi\.limitWindowText/);
  for (const page of [app, dock]) {
    assert.doesNotMatch(page, /groupPlanText|markIdForProvider|colorForProvider|planTextForProvider/);
  }
  for (const name of ['windowNode', 'windowGrid', 'appendWindows', 'meterNode', 'windowValueText']) {
    assert.doesNotMatch(dock, new RegExp(`function ${name}\\(`), `${name} should come from the shared view`);
  }
});
