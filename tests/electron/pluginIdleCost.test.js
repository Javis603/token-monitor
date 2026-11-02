'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { runtimeFixture } = require('../helpers/trustedPlugin');
for (const master of [false, true]) test(`master ${master}: no enabled plugin does no data projection or backend work`, async t => {
  let projections = 0;
  const f = await runtimeFixture(t, { businessAdapters: { extras: () => { projections++; return {}; } } });
  await f.install(); f.settings.pluginsEnabled = master;
  for (let i = 0; i < 1000; i++) { f.runtime.publishStats({ periods: { today: { totalTokens: i } } }); f.runtime.refreshBusinessData(); }
  assert.equal(projections, 0); assert.equal(f.children.length, 0); assert.deepEqual(f.runtime.payload('home').views, {});
});
test('inactive source changes discard parked old stats and reactivation publishes only current source', async t => {
  let source = 'A';
  const f = await runtimeFixture(t, { businessAdapters: { sourceId: () => source } }); await f.install();
  f.runtime.publishStats({ periods: { today: { totalTokens: 10 } } });
  source = 'B'; f.runtime.refreshBusinessData();
  f.runtime.publishStats({ periods: { today: { totalTokens: 20 } } });
  await f.invoke('plugins:setEnabled', { id: 'trusted-fixture', enabled: true });
  const result = await f.invoke('plugins:host', 'trusted-fixture', 'data.query', { resource: 'usage', period: 'today' });
  assert.equal(result.rows[0].totalTokens, 20); assert.equal(f.children.length, 0);
});
