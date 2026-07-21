'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceState } = require('../../src/shared/deviceState');

function usage(updatedAt = '2026-07-21T01:00:00.000Z', extra = {}) {
  return {
    deviceId: 'producer-device',
    updatedAt,
    today: { totalTokens: 10 },
    month: { totalTokens: 20 },
    allTime: { totalTokens: 30 },
    history: { daily: [{ date: '2026-07-21', tokens: 10 }], monthly: [], summary: {} },
    clientStatus: { codex: 'active' },
    wslStatus: { state: 'active' },
    ...extra
  };
}

function limits(updatedAt = '2026-07-21T01:00:05.000Z', status = 'ok') {
  return {
    updatedAt,
    refreshMs: 300000,
    providers: [{ provider: 'codex', status, updatedAt, windows: [] }]
  };
}

test('buffers limits until usage exists instead of emitting a zero-period record', () => {
  const emitted = [];
  const state = createDeviceState({
    epoch: 7,
    envelope: { deviceId: 'configured-device', hostname: 'macbook.local' },
    onRecord: (record, meta) => emitted.push({ record, meta })
  });

  assert.equal(state.updateLimits(limits(), 'startup', { epoch: 7 }), null);
  assert.equal(state.getSnapshot(), null);
  assert.equal(emitted.length, 0);

  const record = state.updateUsage(usage(), 'startup', { epoch: 7 });
  assert.equal(record.deviceId, 'configured-device');
  assert.equal(record.today.totalTokens, 10);
  assert.equal(record.limits.providers[0].provider, 'codex');
  assert.equal(emitted.length, 1);
  assert.deepEqual(emitted[0].meta, { revision: 1, source: 'usage', reason: 'startup', epoch: 7 });
});

test('usage emits immediately and a later limits update emits a second full record', () => {
  const emitted = [];
  const state = createDeviceState({ onRecord: (record, meta) => emitted.push({ record, meta }) });

  const usageRecord = state.updateUsage(usage(), 'interval');
  assert.equal(Object.hasOwn(usageRecord, 'limits'), false);

  const limitsRecord = state.updateLimits(limits(), 'scheduled');
  assert.equal(limitsRecord.today.totalTokens, 10);
  assert.equal(limitsRecord.month.totalTokens, 20);
  assert.equal(limitsRecord.limits.providers[0].status, 'ok');
  assert.equal(emitted.length, 2);
  assert.equal(emitted[1].meta.revision, 2);
  assert.equal(emitted[1].meta.source, 'limits');
});

test('initial limits seed waits for first usage and is copied defensively', () => {
  const initialLimits = limits();
  const state = createDeviceState({ initialLimits });
  initialLimits.providers[0].status = 'mutated';

  assert.equal(state.getSnapshot(), null);
  const record = state.updateUsage(usage(), 'startup');
  assert.equal(record.limits.providers[0].status, 'ok');
});

test('limits-only updates preserve usage updatedAt and usage metadata', () => {
  const state = createDeviceState();
  state.updateUsage(usage('2026-07-21T01:00:00.000Z'), 'interval');

  const record = state.updateLimits(limits('2026-07-21T01:05:00.000Z', 'timeout'), 'timeout');
  assert.equal(record.updatedAt, '2026-07-21T01:00:00.000Z');
  assert.equal(record.history.daily[0].tokens, 10);
  assert.equal(record.clientStatus.codex, 'active');
  assert.equal(record.wslStatus.state, 'active');
  assert.equal(record.limits.updatedAt, '2026-07-21T01:05:00.000Z');

  record.today.totalTokens = 999;
  assert.equal(state.getSnapshot().today.totalTokens, 10);
});

test('partial usage previews carry broader periods and optional usage state', () => {
  const state = createDeviceState();
  state.updateUsage(usage('2026-07-21T01:00:00.000Z', {
    periodWindows: { today: { startsAt: '2026-07-21T00:00:00.000Z', endsAt: '2026-07-22T00:00:00.000Z' } },
    allTimeProjectsIncomplete: true
  }), 'interval');

  const preview = state.updateUsage({
    updatedAt: '2026-07-21T01:00:01.000Z',
    today: { totalTokens: 11 }
  }, 'progress', { preview: true });

  assert.equal(preview.today.totalTokens, 11);
  assert.equal(preview.month.totalTokens, 20);
  assert.equal(preview.allTime.totalTokens, 30);
  assert.equal(preview.history.daily[0].tokens, 10);
  assert.equal(preview.clientStatus.codex, 'active');
  assert.equal(preview.wslStatus.state, 'active');
  assert.equal(preview.periodWindows.today.endsAt, '2026-07-22T00:00:00.000Z');
  assert.equal(preview.allTimeProjectsIncomplete, true);
});

test('cold-start partial previews wait for a complete usage baseline', () => {
  const emitted = [];
  const state = createDeviceState({ onRecord: (record) => emitted.push(record) });

  assert.equal(state.updateUsage({
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: { totalTokens: 10 }
  }, 'progress', { preview: true }), null);
  assert.equal(state.getSnapshot(), null);
  assert.equal(emitted.length, 0);

  const record = state.updateUsage(usage(), 'startup', { preview: false });
  assert.equal(record.month.totalTokens, 20);
  assert.equal(record.allTime.totalTokens, 30);
  assert.equal(emitted.length, 1);
});

test('rejects stale epoch updates and stops publishing synchronously', () => {
  const emitted = [];
  const state = createDeviceState({ epoch: 4, onRecord: (record) => emitted.push(record) });

  assert.equal(state.updateUsage(usage(), 'stale', { epoch: 3 }), null);
  assert.equal(emitted.length, 0);
  state.updateUsage(usage(), 'current', { epoch: 4 });
  assert.equal(emitted.length, 1);

  state.stop();
  assert.equal(state.updateLimits(limits(), 'late', { epoch: 4 }), null);
  assert.equal(state.updateUsage(usage(), 'late', { epoch: 4 }), null);
  assert.equal(emitted.length, 1);
});
