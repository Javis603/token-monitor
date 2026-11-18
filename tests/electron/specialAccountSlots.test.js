'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { limitProviderEntry, LIMIT_PROVIDER_FETCHERS } = require('../../src/shared/limits/registry');
const { createAccountSlotFetcher } = require('../../src/shared/limits/accountSlotFetcher');
const { createAccountSlotService } = require('../../src/electron/limits/accountSlotService');
const { createCredentialCommands } = require('../../src/electron/limits/credentialCommands');
for (const id of ['stepfun', 'mistral', 'muse', 'volcengine', 'kimi', 'alibaba']) {
  test(`${id} uses the common account import, commands and redacted DTO`, async () => {
    const entry = limitProviderEntry(id);
    assert.equal(entry.accountSlots, true);
    let settings = {};
    const service = createAccountSlotService({ getSettings: () => settings, env: {},
      write: async patch => { settings = { ...settings, ...patch }; },
      probeDeps: () => ({ fetch: async () => { throw new Error('fixture offline'); } }) });
    const values = Object.fromEntries((entry.form.fields || [{ key: entry.form.field }]).map(f => [f.key,
      f.key === 'alibabaVariant' ? 'cn-personal' : f.key.includes('Cookie') ? (id === 'mistral' ? 'ory_session_x=SECRET' : 'session=SECRET') : f.key.includes('Region') ? 'cn-beijing' : 'SECRET']));
    const added = await service.add(id, values, 'Account');
    assert.equal(added.saved, true);
    assert.equal(added.accounts.length, 1);
    assert.ok(!JSON.stringify(added).includes('SECRET'));
    const slot = settings[`${id}AccountSlots`][0];
    assert.equal(slot.label, 'Account');
    await service.remove(id, slot.id);
    assert.equal(service.list(id).accounts.length, 0);
  });
}
test('array probes use the healthy lane and reject fully unauthorized results', async () => {
  const entry = limitProviderEntry('alibaba');
  // Real Alibaba probe is array-valued; a malformed cookie is rejected before transport.
  const commands = createCredentialCommands({ getSettings: () => ({}), env: {},
    applySettingsPatch: async patch => patch,
    probeDeps: () => ({ probe: true, fetch: async () => ({ ok: false, status: 401, text: async () => '{}' }) }) });
  assert.equal(entry.accountSlots, true);
  const result = await commands.saveCredential('alibaba', { alibabaCookie: 'session=SECRET', alibabaVariant: 'cn' });
  assert.equal(result.saved, false);
});
test('StepFun renewal is serialized, expected-old, and cannot restore a deleted or replaced slot', async () => {
  let settings = { stepfunAccountSlots: [{ id: 'one', enabled: true, values: { stepfunToken: 'old' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async p => { settings = { ...settings, ...p }; }, probeDeps: () => ({}) });
  const renewal = { provider: 'stepfun', slotId: 'one', field: 'stepfunToken', previous: 'old', value: 'new', values: { stepfunToken: 'old' } };
  assert.equal(await service.renew(renewal), true);
  assert.equal(settings.stepfunAccountSlots[0].values.stepfunToken, 'new');
  assert.equal(await service.renew(renewal), false);
  settings.stepfunAccountSlots[0].values.stepfunToken = 'replacement';
  assert.equal(await service.renew({ ...renewal, previous: 'new', values: { stepfunToken: 'new' } }), false);
  await service.remove('stepfun', 'one');
  assert.equal(await service.renew(renewal), false);
  assert.deepEqual(settings.stepfunAccountSlots, []);
});
test('slot dispatch routes renewal to its own id and never to the fixed credential', async () => {
  const entry = limitProviderEntry('stepfun');
  const calls = [];
  await createAccountSlotFetcher(entry)({ stepfunAccountSlots: [{ id: 'one', enabled: true, values: { stepfunToken: 'old...refresh' } }] }, {
    env: {}, fetch: async (url, init) => url.includes('RefreshToken')
      ? { ok: true, json: async () => ({ accessToken: { raw: 'new' } }) }
      : url.includes('GetStepPlanStatus') ? { ok: true, json: async () => ({}) }
      : init.headers.Cookie.includes('old...') ? { ok: false, status: 401 }
      : { ok: true, json: async () => ({ status: 1, five_hour_usage_left_rate: 0.8, weekly_usage_left_rate: 0.5, five_hour_usage_reset_time: '1780000000', weekly_usage_reset_time: '1780500000' }) },
    onStepfunTokenRenewed: () => assert.fail('fixed credential callback'),
    onAccountSlotCredentialRenewed: value => calls.push(value)
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].slotId, 'one');
  assert.equal(calls[0].previous, 'old...refresh');
});
test('Mistral slots isolate cookies and keep credits when subscription fails', async () => {
  const seen = [];
  const result = await LIMIT_PROVIDER_FETCHERS.mistral({ mistralAccountSlots: ['a', 'b'].map(id => ({ id, enabled: true, values: { mistralCookie: `ory_session_x=${id}` } })) }, {
    env: { MISTRAL_COOKIE: '' }, fetch: async (url, init) => {
      seen.push(init.headers.Cookie);
      return url.endsWith('/subscription') ? { ok: false, status: 503 } : { ok: true, json: async () => ({ wallet_amount: init.headers.Cookie.endsWith('a') ? 10 : 20, credit_notes_amount: 0, ongoing_usage_balance: 0, currency: 'EUR' }) };
    }
  });
  assert.equal(result.length, 2);
  assert.ok(result.every(row => row.status === 'ok' && row.windows.length === 1));
  assert.notEqual(result[0].accountKey, result[1].accountKey);
  assert.deepEqual(new Set(seen), new Set(['ory_session_x=a', 'ory_session_x=b']));
});

const { accountCredentialKey, hasAccountCredential, defaultAccountValues } = require('../../src/shared/limits/accountSlots');
const { historyAccountKey } = require('../../src/electron/limits/historyIdentity');
const { hashKey } = require('../../src/shared/hashKey');
test('declared primary lanes exclude console-only and incomplete companions', () => {
  assert.equal(hasAccountCredential(limitProviderEntry('deepseek'), { deepseekWebToken: 'console-only' }), false);
  const kimi = limitProviderEntry('kimi'), volc = limitProviderEntry('volcengine');
  assert.equal(accountCredentialKey(kimi, { kimiWebAccessToken: 'web' }), 'kimiWebAccessToken');
  assert.equal(accountCredentialKey(kimi, { kimiApiKey: 'api', kimiWebAccessToken: 'web' }), 'kimiApiKey');
  assert.equal(hasAccountCredential(volc, { volcengineAccessKeyId: 'AKLT-incomplete' }), false);
  assert.equal(accountCredentialKey(volc, { volcengineAccessKeyId: 'AKLT-complete', volcengineSecretAccessKey: 'secret' }), 'volcengineAccessKeyId');
  assert.equal(accountCredentialKey(volc, { volcengineAccessKeyId: 'AKLT-incomplete', volcengineApiKey: 'ark-valid' }), 'volcengineApiKey');
  const envValues = defaultAccountValues(volc, { volcengineAccessKeyId: 'AKLT-incomplete' }, { ARK_API_KEY: 'ark-env' });
  assert.equal(accountCredentialKey(volc, envValues), 'volcengineApiKey');
});
test('Volcengine product rows keep separate identities through dispatch, scoped refresh and history', async () => {
  const options = { volcengineAccountSlots: ['a', 'b'].map(id => ({ id, enabled: true, values: { volcengineAccessKeyId: `AKLT-${id}`, volcengineSecretAccessKey: 'secret' } })) };
  const resolved = [];
  const deps = { env: { TOKEN_MONITOR_VOLCENGINE_ARKCLI: '0' }, onAccountSlotResolved: (...args) => resolved.push(args), fetch: async url => ({ ok: true, status: 200, json: async () => url.includes('GetAFPUsage')
    ? { Result: { PlanType: 'Medium', AFPFiveHour: { Quota: 200, Used: 50, ResetTime: 1783314000 } } }
    : { Result: { Status: 'Active', UpdateTimestamp: 1783296000, QuotaUsage: [{ Level: 'session', Percent: 10, ResetTimestamp: 1783314000 }] } } }) };
  const rows = (await LIMIT_PROVIDER_FETCHERS.volcengine(options, deps)).filter(row => row.status === 'ok');
  assert.equal(rows.length, 4);
  assert.equal(new Set(rows.map(historyAccountKey)).size, 4);
  assert.equal(resolved.length, 2);
  assert.ok(rows.every(row => !row.accountKeyAliases?.some(key => rows.some(other => other.accountKey === key))));
  const agent = rows.find(row => row.accountLabel.includes('Agent'));
  const scoped = await LIMIT_PROVIDER_FETCHERS.volcengine({ ...options, previousLimits: { providers: rows }, limitRefreshScope: { provider: 'volcengine', accountKey: agent.accountKey } }, deps);
  assert.equal(scoped.filter(row => !row.removed).length, 1);
  assert.equal(scoped[0].accountKey, agent.accountKey);
});
test('Muse runs anonymous CLI once for multiple saved web slots and never lets it vouch for cookies', async () => {
  let calls = 0;
  const options = { museAccountSlots: ['a', 'b'].map(id => ({ id, enabled: true, values: { museWebCookie: `session=${id}` } })) };
  const deps = { env: { PATH: '/fixture' }, platform: 'linux', existsSync: path => path === '/fixture/muse',
    execFile: (_cmd, _args, _opts, cb) => { calls++; queueMicrotask(() => cb(null, JSON.stringify({ schemaVersion: 1, allowance: { tier: 'Power', window: { usedPercent: 10, resetsAtMs: 1783314000000 }, weekly: { usedPercent: 20, resetsAtMs: 1783914000000 } } }), '')); return { stdin: { end() {} } }; },
    museWebFetch: async () => ({ ok: false, status: 401, headers: new Headers(), text: async () => '' }) };
  const rows = await LIMIT_PROVIDER_FETCHERS.muse(options, deps);
  assert.equal(calls, 1);
  assert.equal(rows.filter(row => row.source === 'cli').length, 1);
  assert.equal(rows.filter(row => row.source === 'web' && row.status === 'unauthorized').length, 2);
  const web = rows.find(row => row.source === 'web');
  await LIMIT_PROVIDER_FETCHERS.muse({ ...options, previousLimits: { providers: rows }, limitRefreshScope: { provider: 'muse', accountKey: web.accountKey } }, deps);
  assert.equal(calls, 1);
});
test('Kimi configured primary survives Web fallback and keeps slot history separate', async () => {
  const requests = [];
  const rows = await LIMIT_PROVIDER_FETCHERS.kimi({ kimiAccountSlots: [{ id: 'a', enabled: true, values: { kimiApiKey: 'primary', kimiWebAccessToken: 'web' } }, { id: 'b', enabled: true, values: { kimiWebAccessToken: 'web-only' } }] }, {
    env: {}, fetch: async (url, init) => { requests.push(init.headers); return { ok: true, status: 200, json: async () => new URL(url).hostname === 'api.kimi.com'
      ? { usage: { used: 10, limit: 100 }, usages: { limit_5h: { used_ratio: 0.1 }, limit_month_total: { used_ratio: 0.3 }, limit_month_code: { used_ratio: 0.12 } } }
      : { usage: { used: 10, limit: 100 } } }; }
  });
  assert.equal(rows.length, 2);
  assert.equal(rows[0].accountKey, hashKey('kimi', 'primary'));
  assert.equal(rows[1].accountKey, hashKey('kimi', 'web-only'));
  assert.notEqual(historyAccountKey(rows[0]), historyAccountKey(rows[1]));
  assert.ok(requests.length >= 2);
});
test('Alibaba keeps same server uid across distinct regional plan variants', async () => {
  const entry = limitProviderEntry('alibaba');
  const fetcher = createAccountSlotFetcher({ ...entry, fetchLimits: async o => ({ provider: 'alibaba', source: 'web', status: 'ok', accountKey: 'same-uid', region: o.alibabaVariant, windows: [] }) });
  const options = { alibabaAccountSlots: ['cn', 'cn-personal', 'intl', 'intl-personal'].map(id => ({ id, enabled: true, values: { alibabaCookie: `session=${id}`, alibabaVariant: id } })) };
  const deps = { env: {}, existsSync: () => false };
  const rows = await fetcher(options, deps);
  assert.equal(rows.length, 4);
  const duplicate = await fetcher({ ...options, alibabaAccountSlots: [...options.alibabaAccountSlots, { id: 'duplicate', enabled: true, values: { alibabaCookie: 'session=other', alibabaVariant: 'cn' } }] }, deps);
  assert.equal(duplicate.length, 4);
  const scoped = await fetcher({ ...options, previousLimits: { providers: rows }, limitRefreshScope: { provider: 'alibaba', accountKey: 'same-uid' } }, deps);
  assert.ok(scoped.every(row => row.accountKey === 'same-uid' && !row.removed));
  assert.equal(new Set(rows.map(historyAccountKey)).size, 4);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { CredentialStore } = require('../../src/shared/credentialStore');
const { migrateAccountSlots } = require('../../src/electron/limits/accountSlotMigration');
for (const [name, input, expected] of [
  ['mixed AKLT pair', { volcengineAccessKeyId: 'AKLT-legacy', volcengineSecretAccessKey: 'legacy-secret' }, 'AKLT-legacy'],
  ['legacy Ark', { volcengineAccessKeyId: 'ark-legacy' }, 'ark-legacy'],
  ['new Ark fallback', { volcengineAccessKeyId: 'AKLT-incomplete', volcengineApiKey: 'ark-explicit' }, 'ark-explicit'],
  ['Kimi web only', { kimiWebAccessToken: 'web-legacy' }, 'web-legacy']
]) test(`import ${name} reads back before clear and reruns with credential and ID continuity`, t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-slot-import-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials(input);
  const id = name.startsWith('Kimi') ? 'kimi' : 'volcengine';
  const migrated = migrateAccountSlots(store, {}, Date.now, {});
  const slot = migrated[`${id}AccountSlots`][0];
  assert.ok(slot.id);
  const key = accountCredentialKey(limitProviderEntry(id), slot.values);
  assert.equal(slot.values[key], expected);
  for (const field of Object.keys(input)) assert.equal(migrated[field], undefined);
  const twice = migrateAccountSlots(store, {}, Date.now, {});
  assert.deepEqual(twice[`${id}AccountSlots`], [slot]);
  assert.deepEqual(store.settingsCredentials()[`${id}AccountSlots`], [slot]);
});
test('incomplete stored AKLT does not import an environment Ark credential', t => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-slot-env-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const store = new CredentialStore(dir);
  store.replaceSettingsCredentials({ volcengineAccessKeyId: 'AKLT-incomplete' });
  const migrated = migrateAccountSlots(store, {}, Date.now, { ARK_API_KEY: 'ark-environment' });
  assert.ok(!JSON.stringify(store.readDocument()).includes('ark-environment'));
  assert.equal(migrated.volcengineAccountSlots[0].values.volcengineAccessKeyId, 'AKLT-incomplete');
  const entry = limitProviderEntry('volcengine');
  assert.equal(accountCredentialKey(entry, defaultAccountValues(entry, migrated, { ARK_API_KEY: 'ark-environment' })), 'volcengineAccessKeyId');
  assert.equal(hasAccountCredential(entry, migrated.volcengineAccountSlots[0].values), false);
});
test('fetched Mistral slots record and query separate real history streams', async t => {
  const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'special-slot-history-'));
  const now = () => Date.parse('2026-11-17T00:00:00Z');
  const store = createLimitsHistoryStore(path.join(dir, 'history.sqlite'), { now });
  t.after(async () => {
    await store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const rows = await LIMIT_PROVIDER_FETCHERS.mistral({ mistralAccountSlots: ['a', 'b'].map(id => ({ id, enabled: true, values: { mistralCookie: `ory_session_x=${id}` } })) }, {
    env: {}, now, fetch: async (url, init) => url.endsWith('/subscription') ? { ok: false, status: 503 }
      : { ok: true, json: async () => ({ wallet_amount: init.headers.Cookie.endsWith('a') ? 10 : 20, credit_notes_amount: 0, ongoing_usage_balance: 0, currency: 'EUR' }) }
  });
  await store.record('local', { providers: rows });
  const histories = await Promise.all(rows.map(row => store.query('local', row)));
  assert.ok(histories.every(result => result.windows.length === 1 && result.windows[0].points.length === 1));
  assert.notDeepEqual(histories[0].windows[0].points, histories[1].windows[0].points);
});

test('renewal queued after removal or replacement cannot commit the old token', async () => {
  let settings = { stepfunAccountSlots: [{ id: 'one', enabled: true, values: { stepfunToken: 'old' } }] };
  const service = createAccountSlotService({ getSettings: () => settings, env: {}, write: async p => { settings = { ...settings, ...p }; },
    probeDeps: () => ({ fetch: async () => { throw new Error('offline'); } }) });
  const renewal = { provider: 'stepfun', slotId: 'one', field: 'stepfunToken', previous: 'old', value: 'renewed', values: { stepfunToken: 'old' } };
  const replace = service.replace('stepfun', 'one', { stepfunToken: 'replacement' });
  const stale = service.renew(renewal);
  assert.equal((await replace).saved, true);
  assert.equal(await stale, false);
  assert.equal(settings.stepfunAccountSlots[0].values.stepfunToken, 'replacement');
  const remove = service.remove('stepfun', 'one');
  const late = service.renew({ ...renewal, previous: 'replacement', values: { stepfunToken: 'replacement' } });
  await remove;
  assert.equal(await late, false);
  assert.deepEqual(settings.stepfunAccountSlots, []);
});
test('six shared form DTOs expose no secret paths, predicates or executable metadata', () => {
  const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
  for (const id of ['stepfun', 'mistral', 'muse', 'volcengine', 'kimi', 'alibaba']) {
    const dto = limitAccountFormsForRenderer().find(form => form.id === id);
    assert.ok(dto);
    assert.deepEqual(JSON.parse(JSON.stringify(dto)), dto);
    assert.ok(!/accountCredentialReady|storePath|envFallback/.test(JSON.stringify(dto)));
  }
});

test('Muse runtime isolates keyed web refresh/removal and global web invalidation from anonymous CLI', async () => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  const scopes = [];
  let percent = 10;
  const web = key => ({ provider: 'muse', source: 'web', accountKey: key, status: 'ok', windows: [{ kind: 'weekly', usedPercent: key === 'a' ? percent : 20 }] });
  const runtime = createLimitsRuntime({ limitProviders: 'muse' }, { autoStart: false, autoRetry: false,
    probeProvider: async (_provider, _options, context) => {
      scopes.push(context.scope);
      return context.scope.accountKey ? [web(context.scope.accountKey)] : [web('a'), web('b'), { provider: 'muse', source: 'cli', status: 'ok', windows: [{ kind: 'weekly', usedPercent: 30 }] }];
    } });
  try {
    await runtime.refresh({ provider: 'muse' }, 'manual');
    assert.equal(runtime.getSnapshot().providers.length, 3);
    percent = 55;
    await runtime.refresh({ provider: 'muse', accountKey: 'a' }, 'manual');
    const rows = runtime.getSnapshot().providers;
    assert.equal(scopes.at(-1).accountKey, 'a');
    assert.equal(rows.find(row => row.accountKey === 'a').windows[0].usedPercent, 55);
    assert.equal(rows.find(row => row.accountKey === 'b').windows[0].usedPercent, 20);
    runtime.clear({ provider: 'muse', accountKey: 'a' });
    assert.equal(runtime.getSnapshot().providers.filter(row => row.source === 'web').length, 1);
    assert.equal(runtime.getSnapshot().providers.find(row => row.source === 'web').accountKey, 'b');
    runtime.clear({ provider: 'muse', source: 'web' });
    assert.equal(runtime.getSnapshot().providers.length, 1);
    assert.equal(runtime.getSnapshot().providers[0].source, 'cli');
  } finally { runtime.stop(); }
});
