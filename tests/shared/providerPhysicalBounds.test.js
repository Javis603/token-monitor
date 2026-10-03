'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

// These cases reach the MiMo provider, whose console ledger defaults to the
// app's own data directory; a test must never write there. The same isolation
// the archive tests make with this variable, for the whole file (node runs each
// test file in its own process).
const testDataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'mimo-ledger-tests-'));
process.env.TOKEN_MONITOR_SHARED_DIR = testDataDir;
test.after(() => fs.rmSync(testDataDir, { recursive: true, force: true }));

const {
  collectLimitsOnce,
  parseLimitProviders,
  probeLimitProvider,
  providerPhysicalBoundMs
} = require('../../src/shared/limits/collector');

test('every supported limits provider declares a finite physical whole-dispatch bound', () => {
  for (const provider of parseLimitProviders()) {
    const bound = providerPhysicalBoundMs(provider);
    assert.ok(Number.isFinite(bound) && bound > 0, `${provider} needs a finite positive bound`);
  }
});

test('provider physical bounds follow whether account jobs run serially or concurrently', () => {
  assert.equal(providerPhysicalBoundMs('codex', {
    codexManagedAccounts: [{ id: 'one', homePath: '/tmp/one' }, { id: 'two', homePath: '/tmp/two' }]
  }, { providerPhysicalBounds: { codex: 10 } }), 30);
  // MiMo accounts and the Console/Membership lanes run concurrently inside one
  // provider probe, so they share one physical deadline.
  assert.equal(providerPhysicalBoundMs('mimo', {
    mimoManagedAccounts: [{ id: 'one' }, { id: 'two' }]
  }, { providerPhysicalBounds: { mimo: 10 } }), 10);
  assert.equal(providerPhysicalBoundMs('mimo', {}, { providerPhysicalBounds: { mimo: 10 } }), 10);
  assert.equal(providerPhysicalBoundMs('mimo', {
    mimoManagedAccounts: [{ id: 'one' }]
  }, { providerPhysicalBounds: { mimo: 10 } }), 10);
  assert.equal(providerPhysicalBoundMs('mimo', {
    mimoManagedAccounts: [{ id: 'one' }, { id: 'two' }],
    limitRefreshScope: { provider: 'mimo', accountId: 'two' }
  }, { providerPhysicalBounds: { mimo: 10 } }), 10);
  assert.equal(providerPhysicalBoundMs('codex', {
    codexManagedAccounts: [{ id: 'one' }, { id: 'two' }],
    limitRefreshScope: { provider: 'codex', accountId: 'two' }
  }, { providerPhysicalBounds: { codex: 10 } }), 10);
});

test('probeLimitProvider passes runtime cancellation into the selected adapter', async () => {
  const controller = new AbortController();
  let observedSignal;
  const providers = await probeLimitProvider('kimi', {}, { signal: controller.signal }, {
    providerFetchers: {
      kimi: async (_options, deps) => {
        observedSignal = deps.signal;
        return { provider: 'kimi', status: 'ok', windows: [] };
      }
    }
  });

  assert.equal(observedSignal, controller.signal);
  assert.equal(providers[0].provider, 'kimi');
});

test('collectLimitsOnce preserves a standalone dependency cancellation signal', async () => {
  const controller = new AbortController();
  let observedSignal;
  const summary = await collectLimitsOnce({
    limitProviders: ['kimi']
  }, {
    signal: controller.signal,
    providerFetchers: {
      kimi: async (_options, deps) => {
        observedSignal = deps.signal;
        return { provider: 'kimi', status: 'ok', windows: [] };
      }
    }
  });

  assert.equal(observedSignal, controller.signal);
  assert.equal(summary.providers[0].provider, 'kimi');
});
