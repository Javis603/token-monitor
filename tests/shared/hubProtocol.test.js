'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  acceptsEncoding,
  applyFreshnessEvent,
  freshnessEvent,
  hubStatsContentKey,
  wantsFreshnessEvents,
  wantsMinimalResponse
} = require('../../src/shared/hubProtocol');

function stats(overrides = {}) {
  return {
    updatedAt: '2026-09-09T10:00:00.000Z',
    staleAfterMs: 600000,
    periods: { today: { totalTokens: 10, sessions: { a: { totalTokens: 10 } } } },
    limits: {
      updatedAt: '2026-09-09T10:00:00.000Z',
      providers: [{ provider: 'codex', updatedAt: '2026-09-09T09:59:00.000Z', stale: false }]
    },
    devices: [{
      deviceId: 'dev-a',
      updatedAt: '2026-09-09T10:00:00.000Z',
      receivedAt: '2026-09-09T10:00:01.000Z',
      ageMs: 1000,
      stale: false,
      periods: { today: { totalTokens: 10 } },
      limits: { updatedAt: '2026-09-09T09:59:00.000Z', providers: [] }
    }],
    ...overrides
  };
}

test('Hub content keys ignore transport timestamps but retain usage and limit freshness', () => {
  const original = stats();
  const refreshed = stats({
    updatedAt: '2026-09-09T10:01:00.000Z',
    limits: { ...original.limits, updatedAt: '2026-09-09T10:01:00.000Z' },
    devices: [{
      ...original.devices[0],
      updatedAt: '2026-09-09T10:01:00.000Z',
      receivedAt: '2026-09-09T10:01:01.000Z',
      ageMs: 50
    }]
  });
  assert.equal(hubStatsContentKey(original), hubStatsContentKey(refreshed));

  const usageChanged = stats({ periods: { today: { totalTokens: 11, sessions: { a: { totalTokens: 11 } } } } });
  assert.notEqual(hubStatsContentKey(original), hubStatsContentKey(usageChanged));

  const providerRefreshed = stats({
    limits: {
      ...original.limits,
      providers: [{ ...original.limits.providers[0], updatedAt: '2026-09-09T10:01:00.000Z' }]
    }
  });
  assert.notEqual(hubStatsContentKey(original), hubStatsContentKey(providerRefreshed));
});

test('freshness events update live metadata without replacing sessions or projects', () => {
  const original = stats();
  const current = stats({
    updatedAt: '2026-09-09T10:02:00.000Z',
    limits: {
      updatedAt: '2026-09-09T10:02:00.000Z',
      providers: [{ provider: 'should-not-be-sent' }]
    },
    devices: [{
      ...original.devices[0],
      updatedAt: '2026-09-09T10:02:00.000Z',
      receivedAt: '2026-09-09T10:02:01.000Z',
      ageMs: 5
    }]
  });
  const event = freshnessEvent(current, 'ingest', '2026-09-09T10:02:02.000Z');
  const applied = applyFreshnessEvent(original, event);

  assert.equal(applied.updatedAt, current.updatedAt);
  assert.equal(applied.devices[0].receivedAt, current.devices[0].receivedAt);
  assert.equal(applied.devices[0].ageMs, 5);
  assert.deepEqual(applied.periods, original.periods);
  assert.deepEqual(applied.devices[0].periods, original.devices[0].periods);
  assert.deepEqual(event.stats.limits, { updatedAt: current.limits.updatedAt });
  assert.deepEqual(applied.limits, {
    ...original.limits,
    updatedAt: current.limits.updatedAt
  });
});

test('Hub protocol features require explicit request headers', () => {
  assert.equal(wantsMinimalResponse({ headers: { 'X-Token-Monitor-Response': 'minimal' } }), true);
  assert.equal(wantsMinimalResponse({ headers: {} }), false);
  assert.equal(wantsFreshnessEvents(new Headers({ 'x-token-monitor-stream': '2' })), true);
  assert.equal(wantsFreshnessEvents(new Headers()), false);
  assert.equal(acceptsEncoding(new Headers({ 'accept-encoding': 'br, gzip' }), 'gzip'), true);
  assert.equal(acceptsEncoding(new Headers({ 'accept-encoding': 'br, gzip ; q=0.5' }), 'gzip'), true);
  assert.equal(acceptsEncoding(new Headers({ 'accept-encoding': 'gzip;q=0, br' }), 'gzip'), false);
  assert.equal(acceptsEncoding(new Headers({ 'accept-encoding': '*;q=0.5' }), 'gzip'), true);
  assert.equal(acceptsEncoding(new Headers({ 'accept-encoding': 'gzip;q=0, *;q=1' }), 'gzip'), false);
});
