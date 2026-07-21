'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  collectLimitsOnce,
  parseLimitProviders,
  probeLimitProvider,
  providerPhysicalBoundMs
} = require('../../src/shared/limitCollector');

test('every supported limits provider declares a finite physical whole-dispatch bound', () => {
  for (const provider of parseLimitProviders()) {
    const bound = providerPhysicalBoundMs(provider);
    assert.ok(Number.isFinite(bound) && bound > 0, `${provider} needs a finite positive bound`);
  }
});

test('account-based serial probes scale their physical bound by dispatched jobs', () => {
  assert.equal(providerPhysicalBoundMs('codex', {
    codexManagedAccounts: [{ id: 'one', homePath: '/tmp/one' }, { id: 'two', homePath: '/tmp/two' }]
  }, { providerPhysicalBounds: { codex: 10 } }), 30);
  assert.equal(providerPhysicalBoundMs('mimo', {
    mimoManagedAccounts: [{ id: 'one' }, { id: 'two' }]
  }, { providerPhysicalBounds: { mimo: 10 } }), 20);
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
