'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeNtfyUrl, evaluateSessionAlerts, formatResetsIn } = require('../../src/electron/sessionAlertEvaluator');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeStats(providers) {
  return { limits: { providers } };
}

function provider(name, windows, { accountKey = 'acc1' } = {}) {
  return { provider: name, accountKey, windows };
}

function sessionWindow(remainingPercent) {
  return { kind: 'session', remainingPercent };
}

function weeklyWindow(remainingPercent) {
  return { kind: 'weekly', remainingPercent };
}

// ---------------------------------------------------------------------------
// normalizeNtfyUrl
// ---------------------------------------------------------------------------

test('normalizeNtfyUrl: ntfy.sh/<topic> → https URL', () => {
  assert.strictEqual(normalizeNtfyUrl('ntfy.sh/my-topic'), 'https://ntfy.sh/my-topic');
});

test('normalizeNtfyUrl: https://ntfy.sh/<topic> → unchanged (https)', () => {
  assert.strictEqual(normalizeNtfyUrl('https://ntfy.sh/my-topic'), 'https://ntfy.sh/my-topic');
});

test('normalizeNtfyUrl: http://ntfy.sh/<topic> → upgraded to https', () => {
  assert.strictEqual(normalizeNtfyUrl('http://ntfy.sh/my-topic'), 'https://ntfy.sh/my-topic');
});

test('normalizeNtfyUrl: null/empty → null', () => {
  assert.strictEqual(normalizeNtfyUrl(null), null);
  assert.strictEqual(normalizeNtfyUrl(''), null);
  assert.strictEqual(normalizeNtfyUrl('   '), null);
});

test('normalizeNtfyUrl: missing ntfy.sh/ prefix → null', () => {
  assert.strictEqual(normalizeNtfyUrl('my-topic'), null);
  assert.strictEqual(normalizeNtfyUrl('https://example.com/topic'), null);
});

test('normalizeNtfyUrl: ntfy.sh/ with no topic → null', () => {
  assert.strictEqual(normalizeNtfyUrl('ntfy.sh/'), null);
  assert.strictEqual(normalizeNtfyUrl('ntfy.sh/   '), null);
});

// ---------------------------------------------------------------------------
// Pulse duration formula (mirrors app.js onSessionAlert logic)
// ---------------------------------------------------------------------------

function pulseDuration(remaining, threshold) {
  const ratio = Math.max(0, Math.min(1, remaining / threshold));
  return 0.5 + 4.5 * ratio;
}

test('pulse duration is 5 s when just at threshold boundary', () => {
  assert.strictEqual(pulseDuration(10, 10), 5.0);
});

test('pulse duration is 0.5 s at 0% remaining', () => {
  assert.strictEqual(pulseDuration(0, 10), 0.5);
});

test('pulse duration is 2.75 s at half the threshold', () => {
  assert.strictEqual(pulseDuration(5, 10), 2.75);
});

test('pulse duration clamps below 0.5 for negative remaining', () => {
  assert.strictEqual(pulseDuration(-5, 10), 0.5);
});

// ---------------------------------------------------------------------------
// evaluateSessionAlerts — features disabled
// ---------------------------------------------------------------------------

test('evaluateSessionAlerts: no action when both features are off', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: false, ntfyEnabled: false };
  const stats = makeStats([provider('claude', [sessionWindow(0)])]);
  const { triggered, anyActive, clearVisual } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 0);
  assert.strictEqual(anyActive, false);
  assert.strictEqual(clearVisual, false);
  assert.strictEqual(keys.size, 0);
});

test('evaluateSessionAlerts: clears state and sets clearVisual when toggled off mid-session', () => {
  const keys = new Set(['claude:acc1:session']);
  const settings = { sessionAlertEnabled: false, ntfyEnabled: false };
  const stats = makeStats([]);
  const { clearVisual } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(clearVisual, true);
  assert.strictEqual(keys.size, 0);
});

// ---------------------------------------------------------------------------
// evaluateSessionAlerts — threshold logic
// ---------------------------------------------------------------------------

test('evaluateSessionAlerts: fires when session is below threshold', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([provider('claude', [sessionWindow(5)])]);
  const { triggered, anyActive, activeAlerts } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 1);
  assert.strictEqual(triggered[0].provider, 'claude');
  assert.strictEqual(triggered[0].remaining, 5);
  assert.strictEqual(anyActive, true);
  // activeAlerts always reflects current below-threshold state for pulse speed
  assert.strictEqual(activeAlerts.length, 1);
  assert.strictEqual(activeAlerts[0].remaining, 5);
});

test('evaluateSessionAlerts: does not fire when session is at or above threshold', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([provider('claude', [sessionWindow(10)])]);
  const { triggered, anyActive, activeAlerts } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 0);
  assert.strictEqual(anyActive, false);
  assert.strictEqual(activeAlerts.length, 0);
});

test('evaluateSessionAlerts: does not fire twice for the same session crossing', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([provider('claude', [sessionWindow(3)])]);

  const first = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(first.triggered.length, 1);

  const second = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(second.triggered.length, 0);
  assert.strictEqual(second.anyActive, true); // still below, just not "newly" triggered
  // activeAlerts still reports the current remaining so pulse speed stays live
  assert.strictEqual(second.activeAlerts.length, 1);
  assert.strictEqual(second.activeAlerts[0].remaining, 3);
});

test('evaluateSessionAlerts: re-arms after session recovers above threshold', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const low = makeStats([provider('claude', [sessionWindow(5)])]);
  const recovered = makeStats([provider('claude', [sessionWindow(50)])]);
  const low2 = makeStats([provider('claude', [sessionWindow(2)])]);

  evaluateSessionAlerts(low, settings, keys);
  assert.strictEqual(keys.size, 1); // key recorded

  evaluateSessionAlerts(recovered, settings, keys);
  assert.strictEqual(keys.size, 0); // key cleared after recovery

  const re = evaluateSessionAlerts(low2, settings, keys);
  assert.strictEqual(re.triggered.length, 1); // fires again
});

test('evaluateSessionAlerts: uses default threshold of 10 when not set', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true }; // no sessionAlertThreshold
  const stats = makeStats([provider('claude', [sessionWindow(9)])]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 1);
});

test('evaluateSessionAlerts: ignores non-session windows for threshold check', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  // weekly window at 2% but session at 50% — should NOT trigger
  const stats = makeStats([provider('claude', [weeklyWindow(2), sessionWindow(50)])]);
  const { triggered, anyActive } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 0);
  assert.strictEqual(anyActive, false);
});

test('evaluateSessionAlerts: includes all windows in triggered entry for ntfy message', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([
    provider('claude', [sessionWindow(3), weeklyWindow(45)])
  ]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 1);
  const kinds = triggered[0].windows.map((w) => w.kind);
  assert.ok(kinds.includes('session'));
  assert.ok(kinds.includes('weekly'));
});

// ---------------------------------------------------------------------------
// evaluateSessionAlerts — multiple providers
// ---------------------------------------------------------------------------

test('evaluateSessionAlerts: triggers for each provider below threshold independently', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([
    provider('claude', [sessionWindow(5)]),
    provider('cursor', [sessionWindow(2)], { accountKey: 'acc2' })
  ]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 2);
  const names = triggered.map((t) => t.provider).sort();
  assert.deepStrictEqual(names, ['claude', 'cursor']);
});

test('evaluateSessionAlerts: only providers below threshold appear in triggered', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([
    provider('claude', [sessionWindow(5)]),
    provider('cursor', [sessionWindow(50)], { accountKey: 'acc2' })
  ]);
  const { triggered, anyActive } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 1);
  assert.strictEqual(triggered[0].provider, 'claude');
  assert.strictEqual(anyActive, true);
});

// ---------------------------------------------------------------------------
// evaluateSessionAlerts — ntfy independent from visual alert
// ---------------------------------------------------------------------------

test('evaluateSessionAlerts: ntfyUrl is null when ntfy is disabled', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, ntfyEnabled: false, ntfyTopic: 'ntfy.sh/t' };
  const stats = makeStats([provider('claude', [sessionWindow(5)])]);
  const { ntfyUrl } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(ntfyUrl, null);
});

test('evaluateSessionAlerts: ntfyUrl is null when topic is empty', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, ntfyEnabled: true, ntfyTopic: '' };
  const stats = makeStats([provider('claude', [sessionWindow(5)])]);
  const { ntfyUrl } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(ntfyUrl, null);
});

test('evaluateSessionAlerts: ntfyUrl is resolved when ntfy is enabled with valid topic', () => {
  const keys = new Set();
  const settings = {
    sessionAlertEnabled: false,
    ntfyEnabled: true,
    ntfyTopic: 'https://ntfy.sh/token-monitor-matroad',
    sessionAlertThreshold: 10
  };
  const stats = makeStats([provider('claude', [sessionWindow(5)])]);
  const { triggered, ntfyUrl } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(ntfyUrl, 'https://ntfy.sh/token-monitor-matroad');
  assert.strictEqual(triggered.length, 1);
});

test('evaluateSessionAlerts: fires via ntfy-only when sessionAlertEnabled is false', () => {
  const keys = new Set();
  const settings = {
    sessionAlertEnabled: false, // visual alert OFF
    ntfyEnabled: true,
    ntfyTopic: 'ntfy.sh/my-topic',
    sessionAlertThreshold: 10
  };
  const stats = makeStats([provider('claude', [sessionWindow(5)])]);
  const { triggered, anyActive } = evaluateSessionAlerts(stats, settings, keys);
  // ntfy-only mode still detects the crossing
  assert.strictEqual(triggered.length, 1);
  assert.strictEqual(anyActive, true);
});

// ---------------------------------------------------------------------------
// evaluateSessionAlerts — edge cases
// ---------------------------------------------------------------------------

test('evaluateSessionAlerts: skips windows with null remainingPercent', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const stats = makeStats([provider('claude', [{ kind: 'session', remainingPercent: null }])]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 0);
});

test('evaluateSessionAlerts: handles empty providers array gracefully', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const { triggered, anyActive } = evaluateSessionAlerts(makeStats([]), settings, keys);
  assert.strictEqual(triggered.length, 0);
  assert.strictEqual(anyActive, false);
});

test('evaluateSessionAlerts: handles missing stats gracefully', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const { triggered } = evaluateSessionAlerts(null, settings, keys);
  assert.strictEqual(triggered.length, 0);
});

test('evaluateSessionAlerts: ignores invalid threshold (zero)', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 0 };
  const stats = makeStats([provider('claude', [sessionWindow(0)])]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 0);
});

// ---------------------------------------------------------------------------
// formatResetsIn
// ---------------------------------------------------------------------------

test('formatResetsIn: returns empty string for null/undefined', () => {
  assert.strictEqual(formatResetsIn(null), '');
  assert.strictEqual(formatResetsIn(undefined), '');
  assert.strictEqual(formatResetsIn(''), '');
});

test('formatResetsIn: returns empty string for a past timestamp', () => {
  const past = new Date(Date.now() - 60_000).toISOString();
  assert.strictEqual(formatResetsIn(past), '');
});

test('formatResetsIn: formats minutes only when under an hour', () => {
  const soon = new Date(Date.now() + 23 * 60_000).toISOString();
  assert.match(formatResetsIn(soon), /resets in \d+m/);
});

test('formatResetsIn: formats hours and minutes when under a day', () => {
  const future = new Date(Date.now() + (4 * 60 + 12) * 60_000).toISOString();
  const result = formatResetsIn(future);
  assert.match(result, /resets in 4h \d+m/);
});

test('formatResetsIn: formats days and hours when over a day', () => {
  const future = new Date(Date.now() + (2 * 24 * 60 + 3 * 60) * 60_000).toISOString();
  const result = formatResetsIn(future);
  assert.match(result, /resets in 2d \d+h/);
});

test('evaluateSessionAlerts: resetsAt is carried into triggered window info', () => {
  const keys = new Set();
  const settings = { sessionAlertEnabled: true, sessionAlertThreshold: 10 };
  const resetsAt = new Date(Date.now() + 30 * 60_000).toISOString();
  const stats = makeStats([
    provider('claude', [{ kind: 'session', remainingPercent: 5, resetsAt }])
  ]);
  const { triggered } = evaluateSessionAlerts(stats, settings, keys);
  assert.strictEqual(triggered.length, 1);
  const sessionWin = triggered[0].windows.find((w) => w.kind === 'session');
  assert.strictEqual(sessionWin.resetsAt, resetsAt);
});
