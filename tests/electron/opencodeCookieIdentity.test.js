'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const vm = require('node:vm');
const { hashKey } = require('../../src/shared/hashKey');
const { createOpencodeAccountService } = require('../../src/electron/providers/opencode/accountService');
const { fetchOpenCodeProfile } = require('../../src/shared/providers/opencode/limits');
const goApi = require('../../src/shared/providers/opencode/goApi');
const panel = require('../../src/electron/renderer/limits/accountSlotsPanel');
const cookieKey = cookie => hashKey('opencode', `cookie:${crypto.createHash('sha256').update(cookie).digest('hex').slice(0, 12)}`);
function harness(presentation = {}) {
  let config, rows;
  const calls = [];
  const window = { TokenMonitorAccountSlotsPanel: { createPanel(options) {
    config = options; return { element: {}, update(next) { rows = next; } };
  } } };
  vm.runInNewContext(fs.readFileSync(require.resolve('../../src/electron/renderer/limits/legacyAccountList'), 'utf8'), { window });
  const list = window.TokenMonitorLegacyAccountList.create({ document: {}, provider: 'opencode', container: { replaceChildren() {} }, t: key => key,
    bridge: { limits: { accountSlots: { presentation: async (...args) => { calls.push(args); return { ok: true }; } } } },
    getContext: () => ({ settings: { limitAccountPresentation: { opencode: presentation } } }), preserveScroll: fn => fn(),
    refresh() {}, changed() {}, enabled: async account => { calls.push(['enabled', account.id]); return { ok: true }; }
  });
  return { list, calls, row: () => rows[0], config: () => config };
}
async function dto(cookie, apiKey) {
  const service = createOpencodeAccountService({ env: {}, getOpencodeProfiles: () => ({ Local: { cookie, apiKey, enabled: true } }),
    getOpencodeAmbientEnabled: () => true, goApi: { ...goApi, readGoApiKey: () => '' } });
  return (await service.getProfiles()).profiles.Local;
}
async function reading(cookie, workspaceId, apiKey) {
  return fetchOpenCodeProfile('Same display name', cookie,
    async () => ({ status: workspaceId ? 'ok' : 'unavailable', workspaceId, windows: [] }),
    async () => ({ status: workspaceId ? 'ok' : 'unavailable', workspaceId, windows: [], balanceUsd: 1 }),
    Date.now(), new Date().toISOString(), { apiKey, deps: { env: {} }, collectGoApi: async () => ({ status: 'ok', windows: [] }) });
}
test('cookie-only unknown workspace exposes the existing fallback key with rename/order enabled and no secrets', async () => {
  const cookie = '__Host-console_session=private-session-one';
  const account = await dto(cookie);
  const result = await reading(cookie);
  assert.equal(account.accountKey, cookieKey(cookie));
  assert.equal(result.accountKey, account.accountKey);
  assert.equal(result.webAccountKey || '', '');
  const h = harness();
  h.list.update([{ ...account, id: 'Local' }], [result]);
  assert.equal(h.config().capabilities(h.row()).rename, true);
  assert.equal(h.config().capabilities(h.row()).move, true);
  await h.config().ipc.rename('opencode', 'Local', 'Office');
  assert.deepEqual(h.calls[0], ['opencode', account.accountKey, 'rename', 'Office']);
  assert.doesNotMatch(JSON.stringify({ account, result }), /private-session-one|__Host-console_session/);
});
test('verified workspace carries cookie alias and wins over a cached fallback reading for canonical commands', async () => {
  const cookie = 'private-session-two';
  const account = await dto(cookie);
  const resolved = await reading(cookie, 'org_work');
  const fallback = await reading(cookie);
  assert.equal(resolved.accountKey, hashKey('opencode', 'workspace:org_work'));
  assert.equal(resolved.webAccountKey, resolved.accountKey);
  for (const key of [cookieKey(cookie), hashKey('opencode', 'go:org_work'), hashKey('opencode', 'zen:org_work')]) assert.ok(resolved.accountKeyAliases.includes(key));
  const presentation = { labels: { [resolved.accountKey]: 'Office' }, order: [resolved.accountKey] };
  const h = harness(presentation);
  h.list.update([{ ...account, id: 'Local' }], [fallback, resolved]);
  assert.equal(h.row().accountKey, resolved.accountKey);
  assert.ok(h.row().accountKeyAliases.includes(account.accountKey));
  await h.config().ipc.rename('opencode', 'Local', 'Team');
  await h.config().ipc.setEnabled('opencode', 'Local', false);
  assert.deepEqual(h.calls, [['opencode', resolved.accountKey, 'rename', 'Team'], ['enabled', 'Local']]);
  const sorted = panel.applyAccountOrder([{ provider: 'opencode', accountKey: 'other' }, resolved], { opencode: [h.row()] }, '', { opencode: presentation });
  assert.equal(sorted[0].accountKey, resolved.accountKey);
  assert.equal(sorted[0].accountDisplayName, 'Office');
});
test('rotated cookie waits for workspace proof and never borrows another workspace by profile name', async () => {
  const oldCookie = 'old-private-session';
  const newCookie = 'rotated-private-session';
  const old = await reading(oldCookie, 'org_original');
  const account = await dto(newCookie);
  const h = harness();
  h.list.update([{ ...account, id: 'Same display name', accountName: old.accountName }], [old]);
  assert.equal(h.row().accountKey, cookieKey(newCookie));
  assert.ok(!h.row().accountKeyAliases?.includes(old.accountKey));
  const sameWorkspace = await reading(newCookie, 'org_original');
  h.list.update([{ ...account, id: 'Local' }], [sameWorkspace]);
  assert.equal(h.row().accountKey, old.accountKey);
  const differentWorkspace = await reading(newCookie, 'org_other');
  h.list.update([{ ...account, id: 'Local' }], [old, differentWorkspace]);
  assert.equal(h.row().accountKey, differentWorkspace.accountKey);
  assert.ok(!h.row().accountKeyAliases.includes(old.accountKey));
  assert.ok(!differentWorkspace.accountKeyAliases.includes(cookieKey(oldCookie)));
  assert.doesNotMatch(JSON.stringify({ account, old, sameWorkspace, differentWorkspace }), /old-private-session|rotated-private-session/);
});
test('API+cookie keeps API DTO precedence and publishes both aliases only from explicit paired credentials', async () => {
  const cookie = 'paired-private-session';
  const key = 'paired-private-key';
  const account = await dto(cookie, key);
  assert.equal(account.accountKey, hashKey('opencode', goApi.goApiIdentity(key)));
  const resolved = await reading(cookie, 'org_paired', key);
  assert.ok(resolved.accountKeyAliases.includes(account.accountKey));
  assert.ok(resolved.accountKeyAliases.includes(cookieKey(cookie)));
  const rotated = await dto(cookie, 'rotated-private-key');
  const h = harness();
  h.list.update([{ ...rotated, id: 'Local', accountName: resolved.accountName }], [resolved]);
  assert.equal(h.row().accountKey, rotated.accountKey);
  assert.notEqual(h.row().accountKey, resolved.accountKey);
  assert.doesNotMatch(JSON.stringify({ account, resolved, rotated }), /paired-private-session|paired-private-key|rotated-private-key/);
});
test('ambiguous credential alias cannot select a workspace', () => {
  const h = harness();
  h.list.update([{ id: 'Local', accountKey: 'credential' }], [
    { accountKey: 'one', accountKeyAliases: ['credential'] }, { accountKey: 'two', accountKeyAliases: ['credential'] }
  ]);
  assert.equal(h.row().accountKey, 'credential');
});

test('fallback label/order survives workspace resolution and canonical rename or clear takes precedence', async () => {
  const cookie = 'private-presentation-session';
  const account = await dto(cookie);
  const resolved = await reading(cookie, 'org_presentation');
  const presentation = { labels: { [account.accountKey]: 'Before discovery' }, order: [account.accountKey] };
  const h = harness(presentation);
  h.list.update([{ ...account, id: 'Local' }], [resolved]);
  assert.equal(h.row().label, 'Before discovery');
  const sorted = panel.applyAccountOrder([{ provider: 'opencode', accountKey: 'other' }, resolved], { opencode: [h.row()] }, '', { opencode: presentation });
  assert.equal(sorted[0].accountKey, resolved.accountKey);
  assert.equal(sorted[0].accountDisplayName, 'Before discovery');
  presentation.labels[resolved.accountKey] = 'Canonical name';
  h.list.update([{ ...account, id: 'Local' }], [resolved]);
  assert.equal(h.row().label, 'Canonical name');
  presentation.labels[resolved.accountKey] = '';
  h.list.update([{ ...account, id: 'Local' }], [resolved]);
  assert.equal(h.row().label, '');
});
