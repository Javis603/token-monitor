'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { aggregateLimits, normalizeLimitsSummary, publicLimits, syncLimits } = require('../../src/shared/limits/core');
const { normalizeDeviceRecord, mergeDeviceRecord } = require('../../src/shared/usage');
const { syncPayload } = require('../../src/shared/syncPayload');
const now = Date.parse('2026-11-16T10:00:00Z');
const row = (accountKey, extra = {}) => ({
  provider: 'kimi', accountKey, status: 'ok', source: 'api',
  updatedAt: new Date(now).toISOString(), windows: [], ...extra
});
const device = (deviceId, providers, signal = false) => ({
  deviceId, limits: { providers, ...(signal ? { multiAccountProviders: ['kimi'] } : {}) }
});

for (const variant of ['fresh', 'stale', 'unavailable', 'error', 'unauthorized']) {
  for (const shared of [false, true]) {
    test(`multi-account preserves ${variant} sibling with ${shared ? 'shared' : 'distinct'} remote identity`, () => {
      const a2 = variant === 'stale' ? { updatedAt: new Date(now - 3600000).toISOString() }
        : variant === 'fresh' ? {} : { status: variant };
      const devices = [device('a', [row('A1'), row('A2', a2)], true),
        device('b', [row(shared ? 'A1' : 'B1')]),
        device('c', [row('', { status: 'notConfigured' }), row('', { status: 'unavailable' })])];
      const result = aggregateLimits(devices, 0, now);
      assert.deepEqual(result.providers.map(p => p.accountKey), shared ? ['A1', 'A2'] : ['A1', 'A2', 'B1']);
      assert.equal(result.providers.find(p => p.accountKey === 'A2').stale, variant === 'stale');
      assert.equal(result.providers.find(p => p.accountKey === 'A2').status, a2.status || 'ok');
      assert.equal(Object.hasOwn(result, 'multiAccountProviders'), false);
      delete devices[0].limits.multiAccountProviders;
      assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => p.accountKey), [shared ? (variant === 'fresh' ? 'A2' : 'A1') : 'B1']);
    });
  }
}

test('signal is collected before rows, and stale configured accounts suppress keyless hints', () => {
  const devices = [device('a', [row('A1')]), device('b', [row('A2')]), device('c', [], true)];
  assert.equal(aggregateLimits(devices, 0, now).providers.length, 2);
  const stale = row('A1', { updatedAt: new Date(now - 3600000).toISOString() });
  assert.deepEqual(aggregateLimits([device('a', [stale], true), device('b', [row('', { status: 'unavailable' })])], 0, now)
    .providers.map(p => p.accountKey), ['A1']);
  assert.equal(aggregateLimits([device('a', [row('', { status: 'notConfigured' })], true),
    device('b', [row('', { status: 'unavailable' })])], 0, now).providers.length, 1);
});

test('balances and credits stay with their account, while same-account carry still works', () => {
  const balance = { amount: 42, currency: 'USD' };
  const devices = [device('a', [row('A1', { balance }), row('A2')], true),
    device('b', [row('A1', { updatedAt: new Date(now + 1000).toISOString() }), row('B1')])];
  const result = aggregateLimits(devices, 0, now).providers;
  assert.equal(result.find(p => p.accountKey === 'A1').balance.amount, 42);
  for (const key of ['A2', 'B1']) {
    const provider = result.find(p => p.accountKey === key);
    assert.equal(provider.balance, null);
    assert.equal(provider.windows.some(w => w.metric === 'credits'), false);
  }
  delete devices[0].limits.multiAccountProviders;
  assert.equal(aggregateLimits(devices, 0, now).providers.length, 1);
});

test('optional signal is normalized and survives authenticated wire and device normalization only', () => {
  const limits = { providers: [row('A1')], multiAccountProviders: ['deepseek', 'unknown', 'codex', 'deepseek', null, 1] };
  const expected = ['codex', 'deepseek'];
  for (const normalized of [normalizeLimitsSummary(limits), syncLimits(limits),
    syncPayload({ deviceId: 'a', limits }).limits, normalizeDeviceRecord({ deviceId: 'a', limits }).limits]) {
    assert.deepEqual(normalized.multiAccountProviders, expected);
  }
  assert.equal(Object.hasOwn(publicLimits(limits), 'multiAccountProviders'), false);
  for (const value of [undefined, null, [], ['unknown'], 'deepseek', {}]) {
    assert.equal(Object.hasOwn(normalizeLimitsSummary({ multiAccountProviders: value }), 'multiAccountProviders'), false);
  }
});

for (const provider of ['deepseek', 'factory', 'minimax', 'copilot']) {
  test(`same-device ${provider} retention keeps all accounts and respects widget clear/disable`, () => {
    const existing = { deviceId: 'a', agentRuntime: 'electron-widget', limits: {
      multiAccountProviders: [provider], providers: [row('A1', { provider }), row('A2', { provider })]
    } };
    const incoming = { deviceId: 'a', agentRuntime: 'headless-agent', limits: {
      providers: [row('', { provider, status: 'notConfigured' })]
    } };
    const merged = mergeDeviceRecord(existing, incoming);
    assert.deepEqual(merged.limits.providers.map(p => p.accountKey), ['A1', 'A2']);
    assert.deepEqual(merged.limits.multiAccountProviders, [provider]);
    incoming.agentRuntime = 'electron-widget';
    assert.equal(mergeDeviceRecord(existing, incoming).limits.providers[0].status, 'notConfigured');
    assert.equal(mergeDeviceRecord(existing, incoming).limits.providers.length, 1);
    assert.equal(Object.hasOwn(mergeDeviceRecord(existing, incoming).limits, 'multiAccountProviders'), false);
    incoming.agentRuntime = 'headless-agent';
    incoming.limits.providers[0].status = 'disabled';
    assert.equal(mergeDeviceRecord(existing, incoming).limits.providers.length, 1);
    assert.equal(mergeDeviceRecord(existing, incoming).limits.providers[0].status, 'disabled');
  });
}

test('several placeholders for one provider restore its accounts once', () => {
  const existing = { deviceId: 'a', agentRuntime: 'electron-widget', limits: {
    providers: [row('A1', { provider: 'minimax' }), row('A2', { provider: 'minimax' })]
  } };
  const incoming = { deviceId: 'a', agentRuntime: 'headless-agent', limits: { providers: [
    row('', { provider: 'minimax', status: 'notConfigured', source: 'api' }),
    row('', { provider: 'minimax', status: 'notConfigured', source: 'oauth' })
  ] } };
  assert.deepEqual(mergeDeviceRecord(existing, incoming).limits.providers.map(p => p.accountKey), ['A1', 'A2']);
});

test('the signal keeps keyed accounts apart ahead of provider-specific collapse rules', () => {
  const web = (accountKey) => row(accountKey, { provider: 'muse', source: 'web' });
  const devices = [{ deviceId: 'a', limits: { multiAccountProviders: ['muse'], providers: [web('M1'), web('M2')] } }];
  assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => p.accountKey), ['M1', 'M2']);
  delete devices[0].limits.multiAccountProviders;
  assert.equal(aggregateLimits(devices, 0, now).providers.length, 1);
});

test('the signal keeps keyed inactive accounts and drops keyless hints for account-scoped freshness keys', () => {
  const workspace = (accountKey, extra = {}) => row(accountKey, { provider: 'opendesign', source: 'web', ...extra });
  const devices = [
    { deviceId: 'a', limits: { multiAccountProviders: ['opendesign'],
      providers: [workspace('W1'), workspace('W2', { status: 'notConfigured' })] } },
    { deviceId: 'b', limits: { providers: [workspace('', { status: 'unavailable' })] } }
  ];
  assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => [p.accountKey, p.status]),
    [['W1', 'ok'], ['W2', 'notConfigured']]);
  // Without the signal the existing output stands: the inactive workspace is
  // dropped and the keyless hint is kept.
  delete devices[0].limits.multiAccountProviders;
  assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => p.accountKey), ['', 'W1']);
});

test('an account the incoming summary reports itself is not restored beside it', () => {
  const existing = { deviceId: 'a', agentRuntime: 'electron-widget', limits: {
    providers: [row('A1', { provider: 'minimax' }), row('A2', { provider: 'minimax' })]
  } };
  const incoming = { deviceId: 'a', agentRuntime: 'headless-agent', limits: { providers: [
    row('A1', { provider: 'minimax', source: 'oauth' }),
    row('', { provider: 'minimax', status: 'notConfigured', source: 'api' })
  ] } };
  assert.deepEqual(mergeDeviceRecord(existing, incoming).limits.providers.map(p => [p.accountKey, p.source]),
    [['A1', 'oauth'], ['A2', 'api']]);
});

test('a placeholder beside an incoming account does not restore that account through the provider lookup', () => {
  const existing = { deviceId: 'a', agentRuntime: 'electron-widget', limits: { providers: [row('A1', { provider: 'minimax' })] } };
  const incoming = { deviceId: 'a', agentRuntime: 'headless-agent', limits: { providers: [
    row('A1', { provider: 'minimax', source: 'oauth' }),
    row('', { provider: 'minimax', status: 'notConfigured', source: 'api' })
  ] } };
  assert.deepEqual(mergeDeviceRecord(existing, incoming).limits.providers.map(p => [p.accountKey, p.status, p.source]),
    [['A1', 'ok', 'oauth'], ['', 'notConfigured', 'api']]);
});

test('the signal keeps a healthy keyless reading from a separate source lane', () => {
  const muse = (accountKey, source, extra = {}) => row(accountKey, { provider: 'muse', source, ...extra });
  const devices = [{ deviceId: 'a', limits: { multiAccountProviders: ['muse'],
    providers: [muse('M1', 'web'), muse('M2', 'web'), muse('', 'cli')] } }];
  assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => [p.accountKey, p.source]).sort(),
    [['', 'cli'], ['M1', 'web'], ['M2', 'web']]);
  // Its failure is that lane's own state too; a keyless web hint is not.
  devices[0].limits.providers[2] = muse('', 'cli', { status: 'unavailable' });
  devices[0].limits.providers.push(muse('', 'web', { status: 'unavailable' }));
  assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => [p.accountKey, p.source]).sort(),
    [['', 'cli'], ['M1', 'web'], ['M2', 'web']]);
});

// No device advertises multiAccountProviders: each has only one credential.
for (const provider of ['deepseek', 'factory', 'zaiteam']) {
  const portableRow = (key, extra = {}) => row(key, { provider, ...extra });
  test(`portable accounts: ${provider} keeps distinct single-account devices and drops a keyless hint`, () => {
    const result = aggregateLimits([
      device('a', [portableRow('A')]), device('b', [portableRow('B')]),
      device('c', [portableRow('', { status: 'notConfigured' })])
    ], 0, now).providers;
    assert.deepEqual(result.map(p => p.accountKey), ['A', 'B']);
  });
  test(`portable accounts: ${provider} merges the same key across devices and carries its balance`, () => {
    const result = aggregateLimits([
      device('a', [portableRow('A', { balance: { amount: 42, currency: 'USD' } })]),
      device('b', [portableRow('A', { updatedAt: new Date(now + 1000).toISOString() })])
    ], 0, now).providers;
    assert.equal(result.length, 1);
    assert.equal(result[0].sourceDeviceId, 'b');
    assert.equal(result[0].balance.amount, 42);
  });
  for (const variant of ['unauthorized', 'unavailable', 'error']) {
    test(`portable accounts: ${provider} preserves a distinct ${variant} account without carrying another balance`, () => {
      const extra = { status: variant };
      const result = aggregateLimits([
        device('a', [portableRow('A', { balance: { amount: 42, currency: 'USD' } })]),
        device('b', [portableRow('B', extra)]),
        device('c', [portableRow('', { status: 'notConfigured' })])
      ], 0, now).providers;
      assert.deepEqual(result.map(p => [p.accountKey, p.status, p.stale]),
        [['A', 'ok', false], ['B', variant, false]]);
      assert.equal(result[1].balance, null);
      assert.equal(result[1].windows.some(w => w.metric === 'credits'), false);
    });
  }
  test(`portable accounts: ${provider} follows the portable rule for a stale account beside a fresh one`, () => {
    const devices = [device('a', [portableRow('A')]),
      device('b', [portableRow('B', { updatedAt: new Date(now - 3600000).toISOString() })])];
    assert.deepEqual(aggregateLimits(devices, 0, now).providers.map(p => p.accountKey), ['A']);
    const codex = devices.map(d => ({ ...d, limits: { providers: d.limits.providers.map(p => ({ ...p, provider: 'codex' })) } }));
    assert.deepEqual(aggregateLimits(codex, 0, now).providers.map(p => p.accountKey), ['A']);
  });
}
