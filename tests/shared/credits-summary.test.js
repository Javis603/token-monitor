'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { buildCreditsSummary, normalizeCreditsSummary } = require('../../src/shared/credits/summary');

test('buildCreditsSummary shapes a collect result into the wire block', () => {
  const summary = buildCreditsSummary({
    available: true,
    totals: { credits: 48.77, requests: 3, byModel: { 'hy4-preview': 3.7 } },
    events: [
      { dedupKey: 's1:a1', sessionId: 's1', model: 'ds', credits: -25.78, updatedAt: 3 },
      { dedupKey: 's1:a2', sessionId: 's1', model: 'ds', credits: -19.29, updatedAt: 2 }
    ],
    warnings: ['', '']
  }, { now: new Date(0) });
  assert.equal(summary.available, true);
  assert.equal(summary.tool, 'workbuddy');
  assert.equal(summary.updatedAt, '1970-01-01T00:00:00.000Z');
  assert.equal(summary.totals.credits, 48.77);
  assert.equal(summary.warnings, 2);
  assert.equal(summary.recentEvents.length, 2);
});

test('buildCreditsSummary keeps only the newest 200 events', () => {
  const events = Array.from({ length: 260 }, (_, i) => ({
    dedupKey: `s:${i}`, credits: -1, updatedAt: i
  }));
  const summary = buildCreditsSummary({ available: true, totals: { credits: 260, requests: 260 }, events, warnings: [] });
  assert.equal(summary.recentEvents.length, 200);
  assert.equal(summary.recentEvents[0].dedupKey, 's:60');
  assert.equal(summary.recentEvents[199].dedupKey, 's:259');
});

test('buildCreditsSummary propagates unavailable collect results', () => {
  const summary = buildCreditsSummary({ available: false, reason: 'workbuddy.db not found' });
  assert.deepEqual(summary, { available: false, reason: 'workbuddy.db not found' });
});

test('normalizeCreditsSummary caps events, models and string lengths', () => {
  const normalized = normalizeCreditsSummary({
    available: true,
    updatedAt: 'x'.repeat(400),
    totals: {
      credits: 12.5,
      requests: 999,
      byModel: Object.fromEntries(Array.from({ length: 80 }, (_, i) => ['m' + i, 1]))
    },
    recentEvents: [
      { credits: -1, dedupKey: 'k'.repeat(400) },
      { credits: 'not-a-number' },
      { credits: -2 }
    ]
  });
  assert.equal(normalized.available, true);
  assert.equal(Object.keys(normalized.totals.byModel).length, 50);
  assert.equal(normalized.recentEvents.length, 2);
  assert.equal(normalized.recentEvents[0].dedupKey.length, 128);
  assert.ok(normalized.updatedAt.length <= 40);
});

test('normalizeCreditsSummary rejects junk and shapes unavailability', () => {
  assert.equal(normalizeCreditsSummary(null), null);
  assert.equal(normalizeCreditsSummary('credits'), null);
  assert.deepEqual(
    normalizeCreditsSummary({ available: false, reason: 'r'.repeat(400) }),
    { available: false, reason: 'r'.repeat(200) }
  );
  assert.deepEqual(
    normalizeCreditsSummary({ available: true, totals: { credits: 'NaN' } }),
    { available: false, reason: 'invalid totals' }
  );
});
