'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  collectClackyFileRows,
  collectClackyRows,
  buildClackyPeriods,
  buildClackyHistoryGraph
} = require('../../src/shared/clackyUsage');

function tempBillingDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'clacky-billing-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeBilling(dir, name, lines) {
  fs.writeFileSync(path.join(dir, name), `${lines.join('\n')}\n`, 'utf8');
}

const EVENT_A = {
  id: 'evt-a',
  session_id: 'sess-1',
  timestamp: '2026-08-02T10:23:39+08:00',
  model: 'glm-5-2-260617',
  prompt_tokens: 17255,
  completion_tokens: 187,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  cost_usd: 0.0042,
  cost_source: 'estimated'
};

const EVENT_B = {
  id: 'evt-b',
  session_id: 'sess-1',
  timestamp: '2026-08-03T09:00:00+08:00',
  model: 'glm-5-2-260617',
  prompt_tokens: 1000,
  completion_tokens: 500,
  cache_read_tokens: 8000,
  cache_write_tokens: 100,
  cost_usd: 0.0011,
  cost_source: 'estimated'
};

test('collectClackyFileRows maps billing events to usage rows', (t) => {
  const dir = tempBillingDir(t);
  writeBilling(dir, '2026-08.jsonl', [JSON.stringify(EVENT_A), JSON.stringify(EVENT_B)]);
  const rows = collectClackyFileRows(path.join(dir, '2026-08.jsonl'));

  assert.equal(rows.length, 2);
  const a = rows[0];
  assert.equal(a.sessionId, 'clacky:sess-1');
  assert.equal(a.model, 'glm-5-2-260617');
  assert.equal(a.input, 17255);
  assert.equal(a.output, 187);
  assert.equal(a.cacheRead, 0);
  assert.equal(a.cacheWrite, 0);
  assert.equal(a.cost, 0.0042);
  assert.equal(a.createdAt, Date.parse('2026-08-02T10:23:39+08:00'));
  assert.equal(a.messages, 1);
});

test('collectClackyFileRows dedupes by billing id (last occurrence wins)', (t) => {
  const dir = tempBillingDir(t);
  writeBilling(dir, '2026-08.jsonl', [
    JSON.stringify(EVENT_A),
    JSON.stringify({ ...EVENT_A, prompt_tokens: 999, cost_usd: 0.0099 }),
    JSON.stringify(EVENT_B)
  ]);
  const rows = collectClackyFileRows(path.join(dir, '2026-08.jsonl'));

  assert.equal(rows.length, 2);
  const a = rows.find((row) => row.id === 'evt-a');
  assert.equal(a.input, 999);
  assert.equal(a.cost, 0.0099);
});

test('collectClackyFileRows skips malformed lines and honors sinceMs', (t) => {
  const dir = tempBillingDir(t);
  writeBilling(dir, '2026-08.jsonl', [
    'not json at all',
    JSON.stringify(EVENT_A),
    JSON.stringify(EVENT_B)
  ]);
  const rows = collectClackyFileRows(path.join(dir, '2026-08.jsonl'), {
    sinceMs: Date.parse('2026-08-03T00:00:00+08:00')
  });

  assert.equal(rows.length, 1);
  assert.equal(rows[0].id, 'evt-b');
});

test('collectClackyRows reads every monthly ledger in the root', (t) => {
  const dir = tempBillingDir(t);
  writeBilling(dir, '2026-07.jsonl', [JSON.stringify(EVENT_A)]);
  writeBilling(dir, '2026-08.jsonl', [JSON.stringify(EVENT_B)]);
  const rows = collectClackyRows({ roots: [dir] });

  assert.equal(rows.length, 2);
});

test('buildClackyPeriods aggregates today, month, and all-time windows with ledger cost', (t) => {
  const dir = tempBillingDir(t);
  // July event, then two events on 2026-08-02 (same session/model).
  const EVENT_JULY = { ...EVENT_A, id: 'evt-july', timestamp: '2026-07-15T10:23:39+08:00' };
  writeBilling(dir, '2026-07.jsonl', [JSON.stringify(EVENT_JULY)]);
  writeBilling(dir, '2026-08.jsonl', [JSON.stringify(EVENT_A), JSON.stringify(EVENT_B)]);

  const periods = buildClackyPeriods({
    now: new Date('2026-08-02T12:00:00+08:00'),
    allTimeSince: 0,
    roots: [dir]
  });

  assert.equal(periods.today.entries.length, 1);
  const today = periods.today.entries[0];
  assert.equal(today.client, 'clacky');
  assert.equal(today.input, 17255 + 1000);
  assert.equal(today.output, 187 + 500);
  assert.equal(today.cacheRead, 8000);
  assert.equal(today.cacheWrite, 100);
  assert.equal(today.cost, 0.0042 + 0.0011);
  assert.equal(periods.today.totalCost, 0.0042 + 0.0011);

  assert.equal(periods.month.totalCost, 0.0042 + 0.0011);
  // July event lands in allTime but not in August's month window.
  assert.equal(periods.allTime.totalCost, (0.0042 + 0.0011) + 0.0042);
});

test('buildClackyHistoryGraph places contributions on their local dates', (t) => {
  const dir = tempBillingDir(t);
  // Use locally-constructed timestamps so the local calendar date is the same
  // under every TZ (an ISO string with a fixed offset flips across midnight in
  // negative offsets and breaks the date expectation — see CI timezones job).
  const localEvent = (id, day) => ({
    id,
    session_id: 'sess-h',
    timestamp: new Date(2026, 7, day, 12, 0, 0).toISOString(),
    model: 'glm-5-2-260617',
    prompt_tokens: 100,
    completion_tokens: 10,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    cost_usd: 0.001,
    cost_source: 'estimated'
  });
  writeBilling(dir, '2026-08.jsonl', [JSON.stringify(localEvent('a', 2)), JSON.stringify(localEvent('b', 3))]);
  const graph = buildClackyHistoryGraph({ roots: [dir] });

  assert.equal(graph.contributions.length, 2);
  assert.deepEqual(graph.contributions.map((day) => day.date), ['2026-08-02', '2026-08-03']);
  const day = graph.contributions[0];
  assert.equal(day.clients.length, 1);
  assert.equal(day.clients[0].client, 'clacky');
  assert.equal(day.clients[0].modelId, 'glm-5-2-260617');
  assert.equal(day.clients[0].tokens.input, 100);
  assert.equal(day.clients[0].cost, 0.001);
  assert.equal(day.clients[0].messages, 1);
});

test('collectClackyRows returns empty rows for a missing billing dir', () => {
  assert.deepEqual(collectClackyRows({ roots: [path.join(os.tmpdir(), 'no-such-clacky-billing-xyz')] }), []);
});
