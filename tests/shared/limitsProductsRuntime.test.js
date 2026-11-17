'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
const { normalizeLimitWindow, normalizeLimitsSummary, publicLimits } = require('../../src/shared/limits/core');
const { rowMatchesScope, probeAccount, probeCoversRow } = require('../../src/shared/limits/accountScope');
const variants = ['cn', 'intl', 'cn-personal', 'intl-personal'];
const row = (region, usedPercent = 20) => ({ provider: 'alibaba', accountKey: 'same-uid', source: 'web', region, status: 'ok', updatedAt: '2026-11-17T00:00:00Z', windows: [{ kind: 'billing', usedPercent }] });
function runtime(probeProvider) { return createLimitsRuntime({ limitProviders: ['alibaba'] }, { autoStart: false, autoRetry: false, probeProvider }); }
test('Alibaba full/scoped refresh, retention and removal preserve UID variants', async () => {
  let result = variants.map(v => row(v));
  const rt = runtime(async () => result);
  try {
    await rt.refresh();
    assert.equal(rt.getSnapshot().providers.length, 4);
    result = [row('intl', 40), row('intl', 45)];
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid' });
    assert.equal(rt.getSnapshot().providers.length, 4);
    assert.equal(rt.getSnapshot().providers.find(r => r.region === 'intl').windows[0].usedPercent, 45);
    result = [row('cn-personal', 70), row('intl', 99)];
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid', region: 'cn-personal' });
    assert.equal(rt.getSnapshot().providers.find(r => r.region === 'intl').windows[0].usedPercent, 45);
    result = [{ ...row('cn-personal'), status: 'unavailable', windows: [] }];
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid', region: 'cn-personal' });
    assert.equal(rt.getSnapshot().providers.find(r => r.region === 'cn-personal').windows[0].usedPercent, 70);
    rt.clear({ provider: 'alibaba', accountKey: 'same-uid', region: 'cn-personal' });
    assert.deepEqual(rt.getSnapshot().providers.map(r => r.region).sort(), ['cn', 'intl', 'intl-personal']);
    result = [{ ...row('intl'), removed: true }];
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid' });
    assert.deepEqual(rt.getSnapshot().providers.map(r => r.region).sort(), ['cn', 'intl-personal']);
  } finally { rt.stop(); }
});
test('Alibaba region scopes and probes match only their variant, legacy scopes remain account-wide', () => {
  const scope = { provider: 'alibaba', accountKey: 'same-uid', region: 'cn' };
  assert.equal(rowMatchesScope(row('intl'), scope), false);
  assert.equal(probeCoversRow({ provider: 'alibaba', account: probeAccount(scope) }, row('intl')), false);
  assert.equal(rowMatchesScope(row('intl'), { ...scope, region: '' }), true);
});
test('optional product IDs cross normalization/public boundaries without changing legacy windows', () => {
  const legacy = normalizeLimitWindow({ kind: 'session', usedPercent: 1 });
  assert.equal(Object.hasOwn(legacy, 'productId'), false);
  for (const invalid of ['https://secret', '/private/key', 'x'.repeat(65), 42, 'api key']) assert.equal(Object.hasOwn(normalizeLimitWindow({ ...legacy, productId: invalid }), 'productId'), false);
  const summary = normalizeLimitsSummary({ providers: [{ ...row('cn'), windows: [{ ...legacy, productId: ' Token-Plan ' }] }] });
  assert.equal(summary.providers[0].windows[0].productId, 'token-plan');
  assert.equal(publicLimits(summary).providers[0].windows[0].productId, 'token-plan');
});

test('Alibaba removing a variant fences an in-flight full refresh, retaining siblings', async () => {
  let resolve;
  let started;
  const ready = new Promise(done => { started = done; });
  const result = new Promise(done => { resolve = done; });
  const rt = createLimitsRuntime({ limitProviders: ['alibaba'], previousLimits: { providers: variants.map(v => row(v)) } }, { autoStart: false, autoRetry: false, probeProvider: async () => { started(); return result; } });
  try {
    assert.equal(rt.getSnapshot().providers.length, 4);
    const pending = rt.refresh();
    await ready;
    rt.clear({ provider: 'alibaba', accountKey: 'same-uid', region: 'intl-personal' });
    resolve(variants.map(v => row(v, 55)));
    await pending;
    const rows = rt.getSnapshot().providers;
    assert.equal(rows.length, 3);
    assert.equal(rows.some(r => r.region === 'intl-personal'), false);
    assert.ok(rows.every(r => r.windows[0].usedPercent === 55));
  } finally { rt.stop(); }
});
test('Alibaba account-wide generic failures retain every variant without an extra row', async () => {
  const rt = createLimitsRuntime({ limitProviders: ['alibaba'], previousLimits: { providers: variants.map(v => row(v)) } }, { autoStart: false, autoRetry: false, probeProvider: async () => [{ provider: 'alibaba', status: 'unavailable', windows: [] }] });
  try {
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid' });
    assert.equal(rt.getSnapshot().providers.length, 4);
    assert.ok(rt.getSnapshot().providers.every(r => r.status === 'unavailable' && r.windows.length === 1));
  } finally { rt.stop(); }
});
test('Muse saved Web siblings and anonymous CLI retain independent runtime state', async () => {
  const rows = [{ ...row(''), provider: 'muse', source: 'web', accountKey: 'a' }, { ...row(''), provider: 'muse', source: 'web', accountKey: 'b' }, { ...row(''), provider: 'muse', source: 'cli', accountKey: '' }];
  let result = rows;
  const rt = createLimitsRuntime({ limitProviders: ['muse'] }, { autoStart: false, autoRetry: false, probeProvider: async () => result });
  try {
    await rt.refresh();
    assert.equal(rt.getSnapshot().providers.length, 3);
    result = [{ ...rows[0], windows: [{ kind: 'session', usedPercent: 88 }] }];
    await rt.refresh({ provider: 'muse', accountKey: 'a' });
    rt.clear({ provider: 'muse', accountKey: 'a' });
    assert.deepEqual(rt.getSnapshot().providers.map(r => [r.source, r.accountKey]), [['web', 'b'], ['cli', '']]);
  } finally { rt.stop(); }
});
test('product metadata crosses device normalization/aggregation and never changes history identities', () => {
  const { normalizeDeviceRecord, aggregateDevices } = require('../../src/shared/usage');
  const { historyAccountKey } = require('../../src/electron/limits/historyIdentity');
  const { limitWindowKey } = require('../../src/shared/limits/usageItems');
  const original = row('cn');
  const tagged = { ...original, windows: original.windows.map(w => ({ ...w, productId: 'token-plan-team' })) };
  const device = normalizeDeviceRecord({ deviceId: 'fixture', limits: { providers: [tagged] } });
  assert.equal(device.limits.providers[0].windows[0].productId, 'token-plan-team');
  const aggregate = aggregateDevices([device]);
  assert.equal(publicLimits(aggregate.limits).providers[0].windows[0].productId, 'token-plan-team');
  assert.equal(historyAccountKey(original), historyAccountKey(tagged));
  assert.equal(limitWindowKey(original.windows[0]), limitWindowKey(tagged.windows[0]));
});
test('source declarations map entitlements and collection defaults only single-product providers', async () => {
  const { LIMIT_PROVIDER_ACCOUNTS } = require('../../src/shared/limits/accounts');
  const { probeLimitProvider } = require('../../src/shared/limits/collector');
  for (const account of LIMIT_PROVIDER_ACCOUNTS) for (const source of account.sources) {
    assert.ok(source.products.length);
    assert.equal(new Set(source.products).size, source.products.length);
  }
  const collect = provider => probeLimitProvider(provider, {}, {}, { providerFetchers: { [provider]: async () => ({ ...row(''), provider }) } });
  assert.equal((await collect('codex'))[0].windows[0].productId, 'codex');
  assert.equal(Object.hasOwn((await collect('opencode'))[0].windows[0], 'productId'), false);
});

test('Alibaba saved slots dispatch all same-UID variants and narrow by region after identity is known', async () => {
  const { limitProviderEntry } = require('../../src/shared/limits/registry');
  const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
  const entry = limitProviderEntry('alibaba');
  const calls = [];
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: async options => {
    calls.push(options.alibabaVariant);
    return [row(options.alibabaVariant)];
  } });
  const slots = variants.map(id => ({ id, accountKey: 'same-uid', enabled: true, values: { alibabaCookie: `session=${id}`, alibabaVariant: id } }));
  const config = { alibabaAccountSlots: slots, previousLimits: { providers: variants.map(v => row(v)) } };
  const rt = createLimitsRuntime({ ...config, limitProviders: ['alibaba'] }, { autoStart: false, autoRetry: false, env: {}, probeProvider: (_provider, options) => fetcher(options, { env: {} }) });
  try {
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid' });
    assert.deepEqual(calls.sort(), [...variants].sort());
    assert.equal(rt.getSnapshot().providers.length, 4);
    calls.length = 0;
    await rt.refresh({ provider: 'alibaba', accountKey: 'same-uid', region: 'intl-personal' });
    assert.deepEqual(calls, ['intl-personal']);
    assert.equal(rt.getSnapshot().providers.length, 4);
  } finally { rt.stop(); }
});

test('Alibaba slot removal/disable retires only the last owner of that UID variant', () => {
  const slots = variants.map(id => ({ id, accountKey: 'same-uid', enabled: true, values: { alibabaCookie: `session=${id}`, alibabaVariant: id } }));
  const duplicate = { ...slots[0], id: 'duplicate' };
  const rt = createLimitsRuntime({ limitProviders: ['alibaba'], alibabaAccountSlots: [...slots, duplicate], previousLimits: { providers: variants.map(v => row(v)) } }, { autoStart: false, autoRetry: false, env: {} });
  try {
    rt.reconfigure({ alibabaAccountSlots: slots });
    assert.equal(rt.getSnapshot().providers.length, 4);
    rt.reconfigure({ alibabaAccountSlots: slots.filter(s => s.id !== 'intl-personal') });
    assert.deepEqual(rt.getSnapshot().providers.map(r => r.region).sort(), ['cn', 'cn-personal', 'intl']);
    rt.reconfigure({ alibabaAccountSlots: slots.filter(s => s.id !== 'intl-personal').map(s => ({ ...s, enabled: s.id !== 'cn' })) });
    assert.deepEqual(rt.getSnapshot().providers.map(r => r.region).sort(), ['cn-personal', 'intl']);
  } finally { rt.stop(); }
});

for (const variant of variants) for (const settingOverride of [false, true]) {
  test(`Alibaba environment scoped refresh resolves ${variant} from ${settingOverride ? 'settings' : 'env'}`, async () => {
    const { limitProviderEntry } = require('../../src/shared/limits/registry');
    const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
    const entry = limitProviderEntry('alibaba');
    const calls = [];
    const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: async (options, deps) => {
      const region = entry.limits.alibabaVariant(options, deps.env);
      calls.push({ region, id: deps.accountSlotId });
      return row(region);
    } });
    const sibling = variant === 'cn' ? 'intl' : 'cn';
    const config = { alibabaSourcePreference: 'web', ...(settingOverride ? { alibabaVariant: variant } : {}),
      alibabaAccountSlots: [{ id: 'saved', enabled: true, values: { alibabaCookie: 'session=saved', alibabaVariant: sibling } }] };
    const deps = { env: { ALIBABA_TOKEN_PLAN_COOKIE: 'session=environment', ALIBABA_TOKEN_PLAN_VARIANT: settingOverride ? sibling : variant }, providerRuntimeState: new Map() };
    const full = await fetcher(config, deps);
    assert.deepEqual(full.map(item => item.region).sort(), [variant, sibling].sort());
    calls.length = 0;
    const result = await fetcher({ ...config, previousLimits: { providers: full }, limitRefreshScope: { provider: 'alibaba', accountKey: 'same-uid', region: variant } }, deps);
    assert.deepEqual(calls, [{ region: variant, id: 'environment' }]);
    assert.deepEqual(result.map(item => item.region), [variant]);
  });
}

for (const variant of variants) for (const operation of ['remove', 'pause']) for (const settingOverride of [false, true]) {
  test(`Alibaba ${operation} preserves environment-owned ${variant} quota (${settingOverride ? 'settings' : 'env'})`, async () => {
    const { limitProviderEntry } = require('../../src/shared/limits/registry');
    const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
    const entry = limitProviderEntry('alibaba');
    let unavailable = false;
    const sibling = variant === 'cn' ? 'intl' : 'cn';
    const env = { ALIBABA_TOKEN_PLAN_COOKIE: 'session=environment', ALIBABA_TOKEN_PLAN_VARIANT: settingOverride ? sibling : variant };
    const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: async (options, deps) => {
      const region = entry.limits.alibabaVariant(options, deps.env);
      return { ...row(region, region === variant ? 25 : 60), ...(unavailable ? { status: 'unavailable', windows: [] } : {}) };
    } });
    const duplicate = { id: 'duplicate', accountKey: 'same-uid', enabled: true, values: { alibabaCookie: 'session=duplicate', alibabaVariant: variant } };
    const other = { id: 'other', accountKey: 'same-uid', enabled: true, values: { alibabaCookie: 'session=other', alibabaVariant: sibling } };
    const rt = createLimitsRuntime({ limitProviders: ['alibaba'], alibabaSourcePreference: 'web',
      ...(settingOverride ? { alibabaVariant: variant } : {}), alibabaAccountSlots: [duplicate, other] }, {
      autoStart: false, autoRetry: false, env,
      probeProvider: (_provider, options, context, deps) => fetcher(options, { ...deps, signal: context.signal })
    });
    try {
      await rt.refresh();
      assert.equal(rt.getSnapshot().providers.length, 2);
      rt.reconfigure({ alibabaAccountSlots: operation === 'remove' ? [other] : [{ ...duplicate, enabled: false }, other] });
      const retained = () => rt.getSnapshot().providers.find(reading => reading.region === variant);
      assert.equal(retained()?.windows[0]?.usedPercent, 25, 'environment ownership preserves quota immediately');
      unavailable = true;
      await rt.refresh();
      assert.equal(retained()?.windows[0]?.usedPercent, 25, 'a failed refresh retains the environment quota');
      assert.equal(retained()?.status, 'unavailable');
      assert.equal(rt.getSnapshot().providers.find(reading => reading.region === sibling)?.windows[0]?.usedPercent, 60);
    } finally { rt.stop(); }
  });
}


for (const source of ['auto', 'cli', 'web']) test(`Alibaba seeded CLI ownership honors ${source} preference and exact variant`, () => {
  const slot = variant => ({ id: variant, accountKey: 'same-uid', enabled: true, values: { alibabaCookie: 'fixture=saved', alibabaVariant: variant } });
  const rt = createLimitsRuntime({ limitProviders: ['alibaba'], alibabaSourcePreference: source,
    alibabaAccountSlots: [slot('cn-personal'), slot('intl-personal')],
    previousLimits: { providers: [{ ...row('cn-personal', 70), source: 'cli', status: 'unavailable' }, row('intl-personal', 25)] }
  }, { autoStart: false, autoRetry: false, env: {} });
  try {
    rt.reconfigure({ alibabaAccountSlots: [] });
    assert.deepEqual(rt.getSnapshot().providers.map(row => row.region), source === 'web' ? [] : ['cn-personal']);
    if (source !== 'web') assert.equal(rt.getSnapshot().providers[0].windows[0].usedPercent, 70);
  } finally { rt.stop(); }
});

test('Alibaba slot retirement fences an in-flight Cookie reply without publishing an empty CLI quota', async () => {
  let release;
  let started;
  const running = new Promise(resolve => { started = resolve; });
  const held = new Promise(resolve => { release = resolve; });
  const slot = { id: 'saved', accountKey: 'same-uid', enabled: true, values: { alibabaCookie: 'fixture=saved', alibabaVariant: 'cn-personal' } };
  const rt = createLimitsRuntime({ limitProviders: ['alibaba'], alibabaAccountSlots: [slot],
    previousLimits: { providers: [{ ...row('cn-personal', 70), source: 'cli' }] }
  }, { autoStart: false, autoRetry: false, env: {}, probeProvider: async () => { started(); return held; } });
  try {
    const snapshots = [];
    rt.subscribe(snapshot => snapshots.push(snapshot));
    const refresh = rt.refresh();
    await running;
    rt.reconfigure({ alibabaAccountSlots: [] });
    release([row('cn-personal', 25)]);
    await refresh;
    assert.equal(rt.getSnapshot().providers[0]?.windows[0]?.usedPercent, 70);
    assert.ok(snapshots.every(snapshot => snapshot.providers[0]?.windows[0]?.usedPercent === 70));
  } finally { rt.stop(); }
});
