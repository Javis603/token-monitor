'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createDeviceState } = require('../../src/shared/deviceState');
const { syncPayload } = require('../../src/shared/syncPayload');
const { mergeDeviceRecord, normalizeDeviceRecord } = require('../../src/shared/usage');
const { parseDeviceHistories } = require('../../src/electron/historySource');

function period(tokens) {
  return {
    totalTokens: tokens,
    costUsd: 0,
    clients: { codex: tokens },
    clientCosts: {},
    models: {},
    modelCosts: {}
  };
}

test('history availability survives sync and hub normalization', () => {
  const disabled = syncPayload({
    deviceId: 'device-disabled',
    historyAvailable: false,
    history: null,
    today: period(5),
    month: period(10),
    allTime: period(20)
  });
  const normalized = normalizeDeviceRecord(disabled);

  assert.equal(normalized.historyAvailable, false);
  assert.equal(normalized.history, null);
});

test('history transport omission survives sync and hub normalization', () => {
  const normalized = normalizeDeviceRecord(syncPayload({
    deviceId: 'device-omitted',
    historyAvailable: true,
    historyOmitted: true,
    today: period(5),
    month: period(10),
    allTime: period(20)
  }));

  assert.equal(normalized.historyAvailable, true);
  assert.equal(normalized.historyOmitted, true);
  assert.equal(parseDeviceHistories([normalized])['device-omitted'].available, false);
});

test('legacy normalized empty history with usage remains unavailable to ranges', () => {
  const legacy = normalizeDeviceRecord({
    deviceId: 'legacy-device',
    allTime: period(500),
    history: { daily: [], monthly: [], summary: {} }
  });
  const parsed = parseDeviceHistories([legacy]);

  assert.equal(Object.hasOwn(legacy, 'historyAvailable'), false);
  assert.equal(parsed['legacy-device'].available, false);
});

test('composed full records remain compatible with hub normalization and merging', () => {
  const records = [];
  const state = createDeviceState({
    envelope: {
      deviceId: 'device-1',
      hostname: 'host',
      platform: 'darwin-arm64',
      agentVersion: '1.2.3'
    },
    onRecord: (record, meta) => records.push({ record, meta })
  });
  state.updateUsage({
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    history: { daily: [{ date: '2026-07-21', totalTokens: 10, costUsd: 0 }] }
  });
  state.updateLimits({
    updatedAt: '2026-07-21T01:01:00.000Z',
    refreshMs: 300000,
    providers: [{
      provider: 'codex',
      status: 'unavailable',
      accountKey: 'account-1',
      windows: [{ kind: 'session', usedPercent: 40 }]
    }]
  });

  assert.equal(records.length, 2);
  assert.equal(Object.hasOwn(records[1].record, 'revision'), false);
  assert.equal(records[1].record.updatedAt, '2026-07-21T01:00:00.000Z');

  const normalized = normalizeDeviceRecord(records[1].record);
  assert.equal(normalized.periods.today.totalTokens, 10);
  assert.equal(normalized.history.daily[0].totalTokens, 10);
  assert.equal(normalized.limits.providers[0].status, 'unavailable');
  assert.equal(normalized.limits.providers[0].windows[0].usedPercent, 40);

  const merged = mergeDeviceRecord(records[0].record, {
    ...records[1].record,
    receivedAt: '2026-07-21T01:01:01.000Z'
  });
  assert.equal(merged.periods.today.totalTokens, 10);
  assert.equal(merged.history.daily[0].totalTokens, 10);
  assert.equal(merged.updatedAt, '2026-07-21T01:00:00.000Z');
  assert.equal(merged.receivedAt, '2026-07-21T01:01:01.000Z');
});

test('sync payload keeps retained public status/windows and drops runtime-only provider state', () => {
  const payload = syncPayload({
    deviceId: 'device-1',
    updatedAt: '2026-07-21T01:00:00.000Z',
    today: period(10),
    month: period(20),
    allTime: period(30),
    limits: {
      updatedAt: '2026-07-21T01:01:00.000Z',
      refreshMs: 300000,
      providers: [{
        provider: 'codex',
        status: 'unavailable',
        accountKey: 'account-1',
        windows: [{ kind: 'session', usedPercent: 40 }],
        lastAttempt: { status: 'unavailable' },
        error: 'private diagnostic',
        credentialDigest: 'private digest',
        revision: 99
      }]
    }
  });
  const provider = payload.limits.providers[0];
  assert.equal(provider.status, 'unavailable');
  assert.equal(provider.windows[0].usedPercent, 40);
  assert.equal(Object.hasOwn(provider, 'lastAttempt'), false);
  assert.equal(Object.hasOwn(provider, 'error'), false);
  assert.equal(Object.hasOwn(provider, 'credentialDigest'), false);
  assert.equal(Object.hasOwn(provider, 'revision'), false);
});
