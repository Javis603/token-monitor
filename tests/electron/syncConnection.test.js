'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { classifyStreamFailure } = require('../../src/electron/syncConnection');

test('eof maps to disconnected', () => {
  assert.deepEqual(classifyStreamFailure({ eof: true }), { reason: 'disconnected', detail: null });
});

test('401 and 403 map to unauthorized', () => {
  assert.deepEqual(classifyStreamFailure({ status: 401 }), { reason: 'unauthorized', detail: null });
  assert.deepEqual(classifyStreamFailure({ status: 403 }), { reason: 'unauthorized', detail: null });
});

test('other HTTP status maps to server_error with the code as detail', () => {
  assert.deepEqual(classifyStreamFailure({ status: 500 }), { reason: 'server_error', detail: '500' });
  assert.deepEqual(classifyStreamFailure({ status: 503 }), { reason: 'server_error', detail: '503' });
});

test('network errnos map to their reason', () => {
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ECONNREFUSED' }), { reason: 'refused', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ETIMEDOUT' }), { reason: 'timeout', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ENOTFOUND' }), { reason: 'dns', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'EAI_AGAIN' }), { reason: 'dns', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'EHOSTUNREACH' }), { reason: 'unreachable', detail: null });
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ENETUNREACH' }), { reason: 'unreachable', detail: null });
});

test('unknown errno falls back to network with the code as detail', () => {
  assert.deepEqual(classifyStreamFailure({ errorCode: 'ECONNRESET' }), { reason: 'network', detail: 'ECONNRESET' });
});

test('no recognizable signal falls back to network with the message as detail', () => {
  assert.deepEqual(classifyStreamFailure({ message: 'fetch failed' }), { reason: 'network', detail: 'fetch failed' });
  assert.deepEqual(classifyStreamFailure({}), { reason: 'network', detail: null });
});

test('adopted HTTP or iCloud cache reads preserve transport failure and retry frequency', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const handler = app.match(/window\.tokenMonitor\.onStatsPush\?\.\(\(payload\) => \{[\s\S]*?\n\}\);/)[0];
  const timer = app.slice(app.indexOf('function restartTimer()'), app.indexOf('\nfunction clamp('));
  for (const mode of ['client', 'icloud']) {
    let push; let interval;
    const state = { streamConnected: false, streamFailure: { reason: 'network' }, settings: { hubMode: mode }, period: 'today' };
    const context = { state, window: { tokenMonitor: { onStatsPush: fn => { push = fn; } } },
      allTimeSessions: { invalidate() {}, attach: stats => stats }, sessionStatsForDisplay: stats => stats,
      observeLiveTokenRate() {}, observeDisplayLiveTokenRates() {}, applyCodexActiveAccountFromStats() {},
      fixedPeriodRangesApi: { isDerived: () => false }, statsRenderScheduler: { request() {} },
      warmFixedPeriodHistory() {}, maybeUpdateBarsIcon() {}, refreshHubBuildStatus() {}, syncContentForm: null,
      setInterval: (_fn, ms) => { interval = ms; return 1; }, clearInterval() {}, refreshStats() {}
    };
    require('node:vm').runInNewContext(timer + '\n' + handler, context);
    for (const reason of ['local', 'presentation', 'read']) {
      const stats = { marker: reason };
      push({ event: 'stats', data: { reason, stats } });
      assert.equal(state.stats, stats);
      assert.equal(state.streamConnected, false, mode + ':' + reason);
      assert.deepEqual(state.streamFailure, { reason: 'network' });
      assert.equal(interval, 15000);
    }
    push({ event: 'stats', data: { reason: 'update', stats: {} } });
    assert.equal(state.streamConnected, true);
    assert.equal(state.streamFailure, null);
    assert.equal(interval, 300000);
  }
});
