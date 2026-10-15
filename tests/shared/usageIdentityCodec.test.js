'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { packUsageIdentity, normalizeUsageIdentity } = require('../../src/shared/usageIdentity');
const { unpackFixedIdentity } = require('../../src/shared/usageIdentityCodec');
const { normalizePeriod, extractUsageFromTokscale } = require('../../src/shared/usage');
const workerIdentity = require('../../worker/src/shared/usageIdentity');
const id = n => `sha256:${n.toString(16).padStart(64, '0')}`;
const capturedAt = '2026-10-13T02:00:00.000Z';
function fixture() {
  const usage = normalizePeriod(extractUsageFromTokscale({ entries: [
    { client: 'claude', sessionId: 's', model: 'model', provider: 'provider', input: 10, output: 2, cost: 0.01, messages: 1 }
  ] }));
  const raw = { version: 1, eventIdentityVersion: 2, periods: { today: { capturedAt,
    events: [{ id: id(1), observationKind: 'native', sessionId: 's', usage }] } } };
  const record = { today: usage };
  return { record, raw, wire: packUsageIdentity(normalizeUsageIdentity(raw, record)) };
}

test('fixed wire has exact successful Node/generated Worker parity', () => {
  const { record, wire } = fixture();
  assert.ok(wire);
  assert.deepEqual(workerIdentity.normalizeUsageIdentity(wire, record), normalizeUsageIdentity(wire, record));
});

test('event capture times survive fixed rows, bound their envelope and prevent unequal-time row sharing', () => {
  const { record, raw } = fixture();
  const early = '2026-10-13T01:00:00.000Z';
  raw.periods.today.events[0].capturedAt = capturedAt;
  raw.periods.allTime = structuredClone(raw.periods.today);
  raw.periods.allTime.events[0].capturedAt = early;
  record.allTime = record.today;
  const wire = packUsageIdentity(raw);
  assert.ok(wire);
  assert.equal(wire.events.length, 2, 'equal counters with different event authority cannot share a row');
  for (const identity of [{ normalizeUsageIdentity }, workerIdentity]) {
    const decoded = identity.normalizeUsageIdentity(wire, record);
    assert.equal(decoded.periods.today.events[0].capturedAt, capturedAt);
    assert.equal(decoded.periods.allTime.events[0].capturedAt, early);
    assert.deepEqual(identity.normalizeUsageIdentity(decoded, record), decoded);
  }
  assert.deepEqual(packUsageIdentity(normalizeUsageIdentity(wire, record)), wire);
  for (const invalid of [null, 123, '', 'bad-date', '2026-10-13T03:00:00.000Z']) {
    const badRaw = structuredClone(raw);
    badRaw.periods.today.events[0].capturedAt = invalid;
    assert.equal(packUsageIdentity(badRaw), null);
    const badWire = structuredClone(wire);
    badWire.events[badWire.periods.today.events[0]][5] = invalid;
    for (const identity of [{ normalizeUsageIdentity }, workerIdentity]) assert.equal(identity.normalizeUsageIdentity(badWire, { today: record.today }), null);
  }
});

test('fixed schema rejects malformed types, widths, duplicate IDs and nested caller maps', () => {
  const { record, wire } = fixture();
  for (const corrupt of [
    value => { value.models = { model: 0 }; },
    value => { value.models.push(value.models[0]); },
    value => { value.sessions[0] = '\0'; },
    value => { value.events[0][2] = -2; },
    value => { value.events[0][3] = 2; },
    value => { value.events[0][4][0][0][1] = 1.5; },
    value => { value.events[0][4][1][0][0][0] = NaN; },
    value => { value.events[0][4][1][0][2][0][1] = -1; },
    value => { value.periods.today.events = [0, 0]; },
    value => { value.periods.today.clientModels = { claude: { model: 10 } }; },
    value => { value.events[0][4][0][0][1] = { path: ['models', 'model'], value: 12 }; },
    value => { value.events[0][4][3] = [1, 0, 1]; value.events[0][4][0][0][8] = 1; }
  ]) {
    const bad = structuredClone(wire); corrupt(bad);
    for (const implementation of [normalizeUsageIdentity, workerIdentity.normalizeUsageIdentity]) {
      assert.equal(implementation(bad, record), null);
    }
  }
});

test('fixed schema bounds dictionary, references, per-event rows and total storage', () => {
  const { wire, raw } = fixture();
  assert.equal(packUsageIdentity({ ...raw, periods: { today: { capturedAt, events: Array(20001).fill(raw.periods.today.events[0]) } } }), null);
  for (const corrupt of [
    value => { value.models = Array.from({ length: 8193 }, (_, i) => `model-${i}`); },
    value => { value.events = Array(20001).fill(value.events[0]); },
    value => { value.periods.today.events = Array(20001).fill(0); },
    value => { value.models = Array.from({ length: 2000 }, (_, i) => `${i}${'x'.repeat(508)}`); },
    value => { value.events[0][4][0] = Array(65).fill(value.events[0][4][0][0]); }
  ]) {
    const bad = structuredClone(wire); corrupt(bad);
    assert.equal(unpackFixedIdentity(bad), null);
  }
  const many = structuredClone(wire);
  many.models = Array.from({ length: 64 }, (_, i) => `model-${i}`);
  // Unique captures are bounded globally even when each event/day fits its
  // own row cap. Decoder counts slots before allocating the next subtree.
  const models = many.models.map((_, i) => [i, 1, 0, 0, 0, null, null, null, null]);
  const days = Array.from({ length: 64 }, (_, i) => [`2026-${String(Math.floor(i / 28) + 1).padStart(2, '0')}-${String(i % 28 + 1).padStart(2, '0')}`,
    0, [null, null, null, null], [null, null, null, null], models]);
  many.events = Array.from({ length: 40 }, (_, i) => [id(i + 1), 1, -1, 1, days]);
  many.periods = {};
  many.history = { capturedAt, events: many.events.map((_, i) => i) };
  assert.equal(unpackFixedIdentity(many), null);
});

test('unsafe integer accumulation and cost-like model names cannot widen token bounds', () => {
  const { raw, record } = fixture();
  const usage = raw.periods.today.events[0].usage;
  const max = Number.MAX_SAFE_INTEGER;
  for (const field of ['models', 'clientModels']) {
    if (field === 'models') usage[field] = { 'cost-model': max, another: 1 };
    else usage[field] = { claude: { 'cost-model': max, another: 1 } };
  }
  usage.totalTokens = max; usage.clients.claude = max;
  assert.equal(packUsageIdentity(raw), null);
  assert.equal(normalizeUsageIdentity(raw, record), null);
});
