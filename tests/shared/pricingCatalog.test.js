'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createPricingCatalogRefresher } = require('../../src/shared/pricingCatalog');

function fixture(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-price-refresh-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const env = { TOKSCALE_CONFIG_DIR: dir };
  const cache = path.join(dir, 'cache');
  fs.mkdirSync(cache);
  let now = 10_000_000;
  let pending = null;
  const delays = [];
  const timers = {
    now: () => now,
    random: () => 0,
    setTimeout(fn, ms) { delays.push(ms); pending = fn; return 1; },
    clearTimeout() { pending = null; }
  };
  function write(name = 'models-dev', age = 0) {
    fs.writeFileSync(path.join(cache, `pricing-${name}.json`), JSON.stringify({ timestamp: (now - age) / 1000, data: {} }));
  }
  return { env, timers, delays, write, advance(ms) { now += ms; }, fire() { const fn = pending; pending = null; fn(); }, pending: () => pending };
}

test('fresh catalogs avoid downloads; expired catalogs refresh once and notify replacements', async t => {
  const f = fixture(t);
  for (const name of ['litellm', 'openrouter', 'models-dev']) f.write(name);
  let calls = 0;
  let updates = 0;
  const refresher = createPricingCatalogRefresher({
    env: f.env,
    refresh: async () => { calls++; f.write('models-dev'); },
    onUpdate: async () => { updates++; }
  }, f.timers);
  t.after(() => refresher.stop());
  refresher.start();
  refresher.start();
  f.fire();
  assert.equal(calls, 0);
  assert.equal(f.delays.at(-1), 60_000);
  f.advance(3_600_001);
  f.fire();
  refresher.start();
  await refresher.whenIdle();
  assert.deepEqual(f.delays, [0, 60_000, 60_000], 'repeated starts never add timers');
  assert.equal(calls, 1, 'start cannot duplicate an active refresh');
  assert.equal(updates, 1);
});

test('failed downloads back off from five to thirty minutes and preserve partial successes', async t => {
  const f = fixture(t);
  let calls = 0;
  let updates = 0;
  const refresher = createPricingCatalogRefresher({
    env: f.env,
    refresh: async () => {
      calls++;
      if (calls === 1) f.write('litellm');
      throw new Error('slow download');
    },
    onUpdate: async () => { updates++; }
  }, f.timers);
  refresher.start();
  for (const delay of [300_000, 600_000, 1_200_000, 1_800_000, 1_800_000]) {
    f.fire();
    await refresher.whenIdle();
    assert.equal(f.delays.at(-1), delay);
    f.advance(delay);
  }
  assert.equal(updates, 1, 'a failed source does not hide a successfully refreshed source');
  assert.ok(fs.existsSync(path.join(f.env.TOKSCALE_CONFIG_DIR, 'cache', 'pricing-litellm.json')));
  refresher.stop();
  assert.equal(f.pending(), null);
});

test('stopping an active refresh prevents publication and future retries', async t => {
  const f = fixture(t);
  let finish;
  let updates = 0;
  const refresher = createPricingCatalogRefresher({
    env: f.env,
    refresh: () => new Promise(resolve => { finish = () => { f.write(); resolve(); }; }),
    onUpdate: async () => { updates++; }
  }, f.timers);
  refresher.start();
  f.fire();
  await Promise.resolve();
  refresher.stop();
  finish();
  await refresher.whenIdle();
  assert.equal(updates, 0);
  assert.equal(f.pending(), null);
});
