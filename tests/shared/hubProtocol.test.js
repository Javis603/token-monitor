'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  acceptsEncoding,
  applyFreshnessEvent,
  encodeSseEvent,
  freshnessEvent,
  hubStatsContentKey,
  prepareSseFanout,
  sseClientKinds,
  sseFrameForClient,
  wantsFreshnessEvents,
  wantsMinimalResponse
} = require('../../src/shared/hubProtocol');

function spyTypedStringify() {
  const original = JSON.stringify;
  const typed = [];
  JSON.stringify = (value, replacer, space) => {
    if (value && typeof value === 'object' && value.type) {
      typed.push({ type: value.type, reason: value.reason });
    }
    return original(value, replacer, space);
  };
  return {
    typed,
    restore() { JSON.stringify = original; }
  };
}

function refreshedStats(current) {
  return stats({
    updatedAt: '2026-09-09T10:01:00.000Z',
    limits: { ...current.limits, updatedAt: '2026-09-09T10:01:00.000Z' },
    devices: [{
      ...current.devices[0],
      updatedAt: '2026-09-09T10:01:00.000Z',
      receivedAt: '2026-09-09T10:01:01.000Z',
      ageMs: 50
    }]
  });
}

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

test('SSE fan-out stringifies each distinct payload once', () => {
  const spy = spyTypedStringify();
  try {
    const current = stats();
    const frames = prepareSseFanout({
      reason: 'ingest',
      stats: current,
      at: '2026-09-09T10:00:00.000Z',
      lastContentKey: '',
      hasFreshnessClients: true,
      hasLegacyClients: true
    });
    assert.deepEqual(spy.typed, [{ type: 'stats', reason: 'ingest' }]);
    assert.equal(frames.freshness, '');
    assert.equal(frames.unchanged, false);
    assert.equal(frames.stats, encodeSseEvent('stats', {
      type: 'stats', reason: 'ingest', stats: current, at: '2026-09-09T10:00:00.000Z'
    }));
    assert.equal(sseFrameForClient(frames, { freshnessEvents: true }), frames.stats);
    assert.equal(sseFrameForClient(frames, { freshnessEvents: false }), frames.stats);

    spy.typed.length = 0;
    const refreshed = refreshedStats(current);
    const unchanged = prepareSseFanout({
      reason: 'ingest',
      stats: refreshed,
      at: '2026-09-09T10:01:02.000Z',
      lastContentKey: frames.contentKey,
      hasFreshnessClients: true,
      hasLegacyClients: true
    });
    assert.equal(hubStatsContentKey(current), hubStatsContentKey(refreshed));
    assert.deepEqual(spy.typed, [
      { type: 'stats', reason: 'ingest' },
      { type: 'freshness', reason: 'ingest' }
    ]);
    assert.equal(unchanged.unchanged, true);
    assert.ok(unchanged.stats);
    assert.ok(unchanged.freshness);
    assert.equal(sseFrameForClient(unchanged, { freshnessEvents: true }), unchanged.freshness);
    assert.equal(sseFrameForClient(unchanged, { freshnessEvents: false }), unchanged.stats);
  } finally {
    spy.restore();
  }
});

test('unchanged content-key can omit the frame a subscriber kind does not need', () => {
  const current = stats();
  const lastContentKey = hubStatsContentKey(current);
  const refreshed = refreshedStats(current);

  const spy = spyTypedStringify();
  try {
    const freshnessOnly = prepareSseFanout({
      reason: 'ingest',
      stats: refreshed,
      at: '2026-09-09T10:01:02.000Z',
      lastContentKey,
      hasFreshnessClients: true,
      hasLegacyClients: false
    });
    assert.equal(freshnessOnly.stats, '');
    assert.match(freshnessOnly.freshness, /^event: freshness\n/);
    assert.deepEqual(spy.typed, [{ type: 'freshness', reason: 'ingest' }]);

    spy.typed.length = 0;
    const legacyOnly = prepareSseFanout({
      reason: 'ingest',
      stats: refreshed,
      at: '2026-09-09T10:01:02.000Z',
      lastContentKey,
      hasFreshnessClients: false,
      hasLegacyClients: true
    });
    assert.match(legacyOnly.stats, /^event: stats\n/);
    assert.equal(legacyOnly.freshness, '');
    assert.deepEqual(spy.typed, [{ type: 'stats', reason: 'ingest' }]);

    spy.typed.length = 0;
    const nobody = prepareSseFanout({
      reason: 'ingest',
      stats: refreshed,
      at: '2026-09-09T10:01:02.000Z',
      lastContentKey,
      hasFreshnessClients: false,
      hasLegacyClients: false
    });
    assert.equal(nobody.stats, '');
    assert.equal(nobody.freshness, '');
    assert.deepEqual(spy.typed, []);
  } finally {
    spy.restore();
  }
});

test('subscriptions and deletes force a full stats frame even when content is unchanged', () => {
  const current = stats();
  const lastContentKey = hubStatsContentKey(current);
  const refreshed = refreshedStats(current);

  for (const reason of ['subscriptions', 'delete']) {
    const spy = spyTypedStringify();
    try {
      const frames = prepareSseFanout({
        reason,
        stats: refreshed,
        at: '2026-09-09T10:01:02.000Z',
        lastContentKey,
        hasFreshnessClients: true,
        hasLegacyClients: true,
        allowFreshness: false
      });
      assert.equal(frames.unchanged, false);
      assert.equal(frames.freshness, '');
      assert.match(frames.stats, new RegExp(`"reason":"${reason}"`));
      assert.deepEqual(spy.typed, [{ type: 'stats', reason }]);
      assert.equal(sseFrameForClient(frames, { freshnessEvents: true }), frames.stats);
      assert.equal(sseFrameForClient(frames, { freshnessEvents: false }), frames.stats);
    } finally {
      spy.restore();
    }
  }
});

test('sseClientKinds classifies mixed, modern-only, and legacy-only subscribers', () => {
  assert.deepEqual(sseClientKinds([]), { hasFreshnessClients: false, hasLegacyClients: false });
  assert.deepEqual(sseClientKinds([{ freshnessEvents: true }]), {
    hasFreshnessClients: true,
    hasLegacyClients: false
  });
  assert.deepEqual(sseClientKinds([{}]), {
    hasFreshnessClients: false,
    hasLegacyClients: true
  });
  assert.deepEqual(sseClientKinds([
    { freshnessEvents: true },
    { freshnessEvents: false },
    { freshnessEvents: true }
  ]), { hasFreshnessClients: true, hasLegacyClients: true });
});

test('sseFrameForClient falls back to an empty string when the chosen frame is missing', () => {
  assert.equal(sseFrameForClient({ unchanged: true, freshness: '', stats: '' }, { freshnessEvents: true }), '');
  assert.equal(sseFrameForClient({ unchanged: false, stats: '' }, { freshnessEvents: false }), '');
  assert.equal(sseFrameForClient(null, { freshnessEvents: true }), '');
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
