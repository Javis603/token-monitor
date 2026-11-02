'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { performance } = require('node:perf_hooks');
const { createBusinessDataService } = require('../../src/electron/plugins/businessData');
const { normalizePeriod } = require('../../src/shared/usage');

const auth = { active: true, pluginId: 'coverage-test' };
const query = resource => ({ version: 1, resource });

test('plugin usage preserves unsupported versus measured-zero capabilities and invalidates cached readings', async t => {
  const service = createBusinessDataService();
  t.after(() => service.dispose());
  const legacy = normalizePeriod({ totalTokens: 100 });
  service.publish({ periods: { today: legacy } });
  const before = await service.query(query('usage'), auth);
  assert.deepEqual(before.rows[0].capabilities, { tokenComponents: false, throughput: false });
  assert.equal(before.rows[0].timedDurationMs, 0);

  service.publish({ periods: { today: { ...legacy, capabilities: { tokenComponents: true, throughput: true } } } });
  const after = await service.query(query('usage'), auth);
  assert.deepEqual(after.rows[0].capabilities, { tokenComponents: true, throughput: true });
  assert.ok(after.snapshotRevision > before.snapshotRevision);
  assert.equal(before.rows[0].capabilities.throughput, false, 'prior snapshots stay immutable');

  service.publish({ periods: { today: { totalTokens: 100 } } });
  assert.deepEqual((await service.query(query('usage'), auth)).rows[0].capabilities,
    { tokenComponents: null, throughput: null }, 'missing provenance stays unknown');
});

test('tool throughput never borrows a model with the same name as a client', async t => {
  const service = createBusinessDataService();
  t.after(() => service.dispose());
  const counters = { timedTokens: 100, timedOutputTokens: 80, timedDurationMs: 1000 };
  service.publish({ periods: { today: {
    clients: { codex: 100 }, models: { codex: 100 }, modelThroughput: { codex: counters }
  } } });
  assert.deepEqual((await service.query(query('tools'), auth)).rows[0].throughput,
    { timedTokens: null, timedOutputTokens: null, timedDurationMs: null });
  assert.deepEqual((await service.query(query('models'), auth)).rows[0].throughput, counters);
});

for (const count of [1, 5001]) test(`plugin session model components preserve observed coverage (${count} sessions)`, async t => {
  // Coverage/invalidation is independent of machine speed. Keep both eager
  // projection and lazy scan/page work from consuming the admission budget.
  t.mock.method(performance, 'now', () => 0);
  const service = createBusinessDataService();
  t.after(() => service.dispose());
  const components = { totalTokens: 50, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 10, secret: 'DO_NOT_COPY' };
  const row = { client: 'codex', sessionId: 's', totalTokens: 100,
    models: { observed: 80, legacy: 20 }, modelTokenComponents: { observed: components } };
  const sessions = Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), { ...row, sessionId: String(i), title: i === 0 ? 'Target' : 'Other' }]));
  const request = { ...query('sessions'), filter: { search: 'Target' } };
  service.publish({ periods: { today: { sessions } } });
  const before = await service.query(request, auth);
  assert.equal(before.availability, 'available');
  const models = before.rows[0].models;
  assert.deepEqual(models.find(m => m.model === 'observed').tokenComponents,
    { totalTokens: 50, inputTokens: 10, cacheReadTokens: 20, cacheWriteTokens: 5, outputTokens: 10 });
  assert.equal(models.find(m => m.model === 'legacy').tokenComponents, null);
  assert.doesNotMatch(JSON.stringify(before), /DO_NOT_COPY/);
  assert.equal(models.reduce((sum, model) => sum + model.totalTokens, 0), 100, 'coverage is not extra usage');
  const next = { ...sessions, 0: { ...sessions[0], modelTokenComponents: { observed: { ...components, totalTokens: 60 } } } };
  service.publish({ periods: { today: { sessions: next } } });
  const after = await service.query(request, auth);
  assert.equal(after.availability, 'available');
  assert.equal(after.rows.find(r => r.id === before.rows[0].id).models.find(m => m.model === 'observed').tokenComponents.totalTokens, 60);
  assert.equal(models.find(m => m.model === 'observed').tokenComponents.totalTokens, 50);
});
