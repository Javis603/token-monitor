'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const { runManualDeviceRefresh } = require('../../src/electron/deviceRuntimeCoordinator');

// main.js requires electron at the top level, so it cannot be loaded here; these
// guard the wiring at the source level instead (same approach as the
// renderHomeTrendsModule guard in homeOverview.test.js).
const rendererSource = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
const mainSource = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');

test('the manual refresh button asks for a history rescan', () => {
  const handler = rendererSource.match(/els\.refreshButton\.addEventListener\('click',[\s\S]*?\n\}\);/);
  assert.ok(handler, 'refresh button handler exists');
  assert.match(handler[0], /refreshStats\(\{[^}]*forceHistory: true[^}]*\}\)/);
});

test('only the manual refresh button drags history along with force (#177)', () => {
  // Tool settings, account sign-ins and limits actions all call refreshStats({ force: true });
  // folding history into plain `force` would re-run the expensive `tokscale graph` on each.
  const calls = rendererSource.match(/refreshStats\(\{[^}]*\}\)/g) || [];
  const withHistory = calls.filter((call) => call.includes('forceHistory'));
  assert.equal(withHistory.length, 1, `exactly one refreshStats call may force history, got: ${withHistory.join(', ')}`);
  // ...and it is the manual button's (the only call that drives the button feedback).
  assert.match(withHistory[0], /feedback: true/);
});

test('a forced history refresh restores the Home full-history retry budget', () => {
  const refreshStats = rendererSource.match(/async function refreshStats\(options = \{\}\) \{([\s\S]*?)\n\}\n\nasync function refreshStatusViewManually/);
  assert.ok(refreshStats, 'refreshStats exists');
  const body = refreshStats[1];
  assert.match(body, /options\.forceHistory === true/);
  assert.match(body, /homeHistoryLoadedSignature = ''/);
  assert.match(body, /homeHistoryRetrySignature = ''/);
  assert.match(body, /homeHistoryRetries = 0/);
  assert.match(body, /homeHistorySignature = ''/);
});

test('fetchStats reads forceHistory independently of force', () => {
  const fetchStats = mainSource.match(/async function fetchStats\(options = \{\}\) \{([\s\S]*?)\n {2}if \(mode === 'local'\)/);
  assert.ok(fetchStats, 'fetchStats exists');
  const head = fetchStats[1];
  // The tick option must come from its own flag, never be aliased to `force`.
  assert.match(head, /forceHistory: Boolean\(options\?\.forceHistory\)/);
  assert.doesNotMatch(head, /forceHistory: force\b/);
  assert.doesNotMatch(head, /forceHistory: true/);
  assert.match(head, /waitForLimits: options\?\.feedback === true && canRefreshEdgeDockLimits\(\)/);
});

for (const status of ['ok', 'unavailable']) {
  test(`App refresh feedback waits for limits and reflects ${status}`, async () => {
    let finishLimits;
    const runtime = {
      refreshLimits: () => new Promise((resolve) => { finishLimits = resolve; }),
      tick: async () => true
    };
    const feedback = [];
    const state = { floatingBubble: { collapsed: false } };
    const noop = () => {};
    const context = {
      state,
      window: { tokenMonitor: { getStats: async () => {
        await runManualDeviceRefresh(runtime, { waitForLimits: true });
        return { updatedAt: '2026-10-07T00:00:00Z' };
      } } },
      clearRefreshButtonFeedbackTimer: noop,
      setRefreshButtonState: (value) => feedback.push(value),
      settleRefreshButtonState: (value) => feedback.push(value),
      observeLiveTokenRate: noop, observeDisplayLiveTokenRates: noop,
      allTimeSessions: { invalidate: noop, attach: (value) => value },
      sessionStatsForDisplay: (value) => value,
      applyCodexActiveAccountFromStats: noop,
      fixedPeriodRangesApi: { isDerived: () => false }, warmFixedPeriodHistory: async () => {},
      statsRenderScheduler: { request: noop }, maybeUpdateBarsIcon: noop,
      isRendererWindowHidden: () => true, console: { log: noop }
    };
    const start = rendererSource.indexOf('async function refreshStats(');
    const end = rendererSource.indexOf('\nasync function refreshStatusViewManually(', start);
    vm.runInNewContext(rendererSource.slice(start, end), context);
    const pending = context.refreshStats({ force: true, feedback: true });
    await new Promise((resolve) => setImmediate(resolve));
    assert.deepEqual(feedback, ['refreshing']);
    assert.equal(state.refreshBusy, true);
    finishLimits({ results: [{ provider: 'claude' }], snapshot: { providers: [{ provider: 'claude', status }] } });
    await pending;
    assert.deepEqual(feedback, ['refreshing', status === 'ok' ? 'refreshed' : 'error']);
    assert.equal(state.refreshBusy, false);
  });
}
