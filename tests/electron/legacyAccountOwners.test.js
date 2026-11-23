'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const renderer = path.resolve(__dirname, '../../src/electron/renderer');
function adapterHarness(settings = {}) {
  let config, update;
  const window = { TokenMonitorAccountIdentity: require(path.join(renderer, 'accountIdentity.js')),
    TokenMonitorAccountSlotsPanel: { createPanel(options) { config = options; return { element: {}, update(...args) { update = args; } }; } } };
  vm.runInNewContext(fs.readFileSync(path.join(renderer, 'limits/legacyAccountList.js'), 'utf8'), { window });
  const calls = [];
  const list = window.TokenMonitorLegacyAccountList.create({ document: {}, provider: 'codex', container: { replaceChildren() {} }, t: key => key,
    bridge: { limits: { accountSlots: { presentation: async (...args) => { calls.push(args); return { ok: true }; } } } },
    getContext: () => ({ settings: { limitAccountPresentation: { codex: { order: ['canonical'] } }, ...settings } }), preserveScroll: fn => fn(),
    refresh() {}, changed() {}, enabled: async (account, value) => { calls.push(['enabled', account.id, value]); return { ok: true }; },
    remove: async account => { calls.push(['remove', account.id]); return { ok: true }; }
  });
  return { list, calls, config: () => config, update: () => update, api: window.TokenMonitorLegacyAccountList };
}
test('legacy account lists use the shared email mask and respect the setting', () => {
  const settings = { maskLimitAccountEmails: true };
  const { config } = adapterHarness(settings);
  assert.equal(config().maskEmail('jordan@example.com'), 'j***n@example.com');
  assert.equal(config().maskEmail('j@example.com'), 'j***@example.com');
  settings.maskLimitAccountEmails = false;
  assert.equal(config().maskEmail('jordan@example.com'), 'jordan@example.com');
});
test('legacy commands retain authority id and use canonical history key only for presentation', async () => {
  const h = adapterHarness();
  h.list.update([{ id: 'managed-home', accountKey: 'canonical', accountKeyAliases: ['old'], email: 'user@example.com' }], []);
  await h.config().ipc.rename('codex', 'managed-home', 'Work');
  await h.config().ipc.setEnabled('codex', 'managed-home', false);
  assert.deepEqual(h.calls[0], ['codex', 'canonical', 'rename', 'Work']);
  assert.deepEqual(h.calls[1], ['enabled', 'managed-home', false]);
  assert.equal(h.update()[0][0].accountKeyAliases[0], 'old');
});
test('ambiguous email never lends an identity from another workspace', () => {
  const h = adapterHarness();
  h.list.update([{ id: 'home', email: 'same@example.com' }], [{ accountEmail: 'same@example.com', accountKey: 'one' }, { accountEmail: 'same@example.com', accountKey: 'two' }]);
  const row = h.update()[0][0];
  assert.equal(row.accountKey, undefined);
  assert.equal(h.config().capabilities(row).rename, false);
});
test('detected and external accounts expose only supported command capabilities', () => {
  const h = adapterHarness();
  h.list.update([{ id: 'desktop', accountKey: 'canonical', canPause: false, removable: false }], []);
  const permissions = h.config().capabilities(h.update()[0][0]);
  assert.equal(permissions.setEnabled, false);
  assert.equal(permissions.remove, false);
  assert.equal(permissions.rename, true);
});
test('owner boundaries retain provider-specific flows without receiving global state', () => {
  for (const name of ['claude','codex','opencode','cursor','antigravity','mimo','workbuddy','minimax','thirdparty']) {
    const source = fs.readFileSync(path.join(renderer, `limits/providerOwners/${name}.js`), 'utf8');
    assert.match(source, /TokenMonitorLegacyAccountList\.create/);
    assert.doesNotMatch(source, /state\s*=\s*host\.state/);
    assert.match(source, /get: host.getSettings/);
  }
  const codex = fs.readFileSync(path.join(renderer, 'limits/providerOwners/codex.js'), 'utf8');
  assert.match(codex, /isCurrentCodexSignInFlow/);
  assert.match(codex, /selectWorkspace/);
  const opencode = fs.readFileSync(path.join(renderer, 'limits/providerOwners/opencode.js'), 'utf8');
  assert.match(opencode, /offer\.stale\(at\)/);
  assert.match(opencode, /moveCredential/);
});
test('WorkBuddy delayed result cannot settle a cancelled attempt', async () => {
  const { create } = require(path.join(renderer, 'limits/providerOwners/workbuddy.js'));
  let settle;
  const pending = new Promise(resolve => { settle = resolve; });
  const owner = create({ initial: {}, getSettings: () => ({}), document: { getElementById: () => null }, t: x => x,
    window: { tokenMonitor: { workbuddy: { addAccount: () => pending, cancelLogin: async () => ({ ok: true }) } } },
    refreshStats: async () => {}, renderSettingsSummaries() {}, renderSubscriptionSettings() {} });
  const login = owner.startWorkbuddyLogin('cn');
  await owner.cancelWorkbuddyLogin();
  settle({ ok: true, accounts: [{ id: 'stale' }] });
  await login;
  assert.equal(owner.state.workbuddySignInBusy, false);
  assert.equal(owner.state.workbuddyLoginStatusKey, 'loginCancelled');
});

test('MiMo pending success retains a newly typed cookie draft', async () => {
  const { create } = require(path.join(renderer, 'limits/providerOwners/mimo.js'));
  const nodes = new Map();
  const node = id => {
    if (!nodes.has(id)) nodes.set(id, { value: '', listeners: {}, addEventListener(key, fn) { this.listeners[key] = fn; }, setAttribute() {},
      classList: { toggle() {}, contains() { return false; } } });
    return nodes.get(id);
  };
  let resolve;
  const pending = new Promise(done => { resolve = done; });
  const settings = {};
  const owner = create({ initial: {}, document: { getElementById: node }, getSettings: () => settings,
    window: { tokenMonitor: { mimo: { accounts: async () => [], onAccounts() {}, addAccount: () => pending } } },
    isSettingsSurfaceVisible: () => false, setAccountGroupExpanded() {}, t: x => x, refreshStats: async () => {} });
  owner.setup();
  node('mimoCookieInput').value = 'submitted';
  const save = node('mimoSaveAccountButton').listeners.click();
  node('mimoCookieInput').value = 'new draft';
  resolve({ ok: true });
  await save;
  assert.equal(node('mimoCookieInput').value, 'new draft');
});

test('owner-backed Claude keeps its editor outside generic saved-slot panels', () => {
  const { limitAccountFormsForRenderer } = require('../../src/electron/limits/accountSettings');
  const forms = limitAccountFormsForRenderer();
  const claude = forms.find(form => form.id === 'claude');
  assert.equal(claude.accountSlotOwner, true);
  assert.equal(claude.multipleAccounts, true);
  assert.ok(!forms.filter(form => form.accountSlots && !form.accountSlotOwner).some(form => form.id === 'claude'));
  const app = fs.readFileSync(path.join(renderer, 'app.js'), 'utf8');
  assert.match(app, /if \(form.accountSlots && !form.accountSlotOwner\)/);
});

for (const field of ['accountEmail', 'accountName']) test(`a single mismatched ${field} reading cannot lend identity or aliases`, () => {
  const h = adapterHarness();
  h.list.update([{ id: 'local', [field]: 'same' }], [{ [field]: 'same', accountKey: 'other-workspace', accountKeyAliases: ['other-product'], stale: true }]);
  const row = h.update()[0][0];
  assert.equal(row.accountKey, undefined);
  assert.equal(row.accountKeyAliases, undefined);
  assert.equal(h.config().capabilities(row).rename, false);
  assert.equal(h.config().capabilities(row).move, false);
});
test('explicit canonical DTO never borrows identity from a matching display name', () => {
  const h = adapterHarness();
  h.list.update([{ id: 'local', accountKey: 'canonical', accountName: 'same' }], [{ accountName: 'same', accountKey: 'other', accountKeyAliases: ['wrong'] }]);
  assert.equal(h.update()[0][0].accountKey, 'canonical');
  assert.equal(h.update()[0][0].accountKeyAliases, undefined);
});
test('explicit key aliases resolve the canonical reading without changing authority id', async () => {
  const h = adapterHarness();
  h.list.update([{ id: 'profile', accountKey: 'api-key', accountName: 'Personal' }], [{ accountKey: 'workspace', accountKeyAliases: ['api-key', 'old-workspace'], accountName: 'Old name' }]);
  const row = h.update()[0][0];
  assert.equal(row.accountKey, 'workspace');
  assert.ok(row.accountKeyAliases.includes('api-key'));
  assert.equal(row.accountName, 'Personal');
  assert.equal(h.config().capabilities(row).move, true);
  await h.config().ipc.rename('codex', 'profile', 'Work');
  await h.config().ipc.setEnabled('codex', 'profile', false);
  assert.deepEqual(h.calls[0], ['codex', 'workspace', 'rename', 'Work']);
  assert.deepEqual(h.calls[1], ['enabled', 'profile', false]);
});

test('OpenCode DTO derives quota identity from owned keys and preserves pinned ambient authority', async () => {
  const { createOpencodeAccountService } = require('../../src/electron/providers/opencode/accountService');
  const goApi = require('../../src/shared/providers/opencode/goApi');
  const { hashKey } = require('../../src/shared/hashKey');
  let ambientKey = 'machine-key';
  let profiles = {
    paired: { apiKey: 'profile-key', cookie: 'private-cookie', enabled: true },
    pinned: { useAmbientKey: true, ambientKeyIdentity: goApi.goApiIdentity(ambientKey), enabled: false },
    cookieOnly: { cookie: 'another-private-cookie', enabled: true }
  };
  const service = createOpencodeAccountService({ getOpencodeProfiles: () => profiles, env: {},
    getOpencodeAmbientEnabled: () => false,
    goApi: { ...goApi, readGoApiKey: () => ambientKey }
  });
  const before = await service.getProfiles();
  assert.equal(before.profiles.paired.accountKey, hashKey('opencode', goApi.goApiIdentity('profile-key')));
  assert.equal(before.profiles.pinned.accountKey, hashKey('opencode', goApi.goApiIdentity('machine-key')));
  assert.equal(before.hasAmbientKey, false, 'disabled pinned owner still claims its key');
  assert.equal(before.ambientAccountKey, '');
  assert.equal(before.profiles.cookieOnly.accountKey, require('../../src/shared/providers/opencode/identity').openCodeCookieAccountKey('another-private-cookie'), 'unknown workspace uses credential-local fallback, never name');
  assert.doesNotMatch(JSON.stringify(before), /private-cookie|profile-key|machine-key/);
  ambientKey = 'rotated-machine-key';
  const rotated = await service.getProfiles();
  assert.equal(rotated.profiles.pinned.accountKey, '');
  assert.equal(rotated.profiles.pinned.ambientStale, true);
  assert.equal(rotated.hasAmbientKey, true);
  assert.equal(rotated.ambientAccountKey, hashKey('opencode', goApi.goApiIdentity(ambientKey)));
  assert.equal(rotated.ambientEnabled, false);
  profiles = { renamed: profiles.paired };
  assert.equal((await service.getProfiles()).profiles.renamed.accountKey, before.profiles.paired.accountKey);
});
test('verified OpenCode pairing retains canonical name/order and provider command routing', async () => {
  const { createOpencodeAccountService } = require('../../src/electron/providers/opencode/accountService');
  const { fetchOpenCodeProfile } = require('../../src/shared/providers/opencode/limits');
  const panel = require('../../src/electron/renderer/limits/accountSlotsPanel');
  const service = createOpencodeAccountService({ env: {},
    getOpencodeProfiles: () => ({ Work: { apiKey: 'paired-key', cookie: 'paired-cookie', enabled: true } }),
    getOpencodeAmbientEnabled: () => true,
    goApi: { ...require('../../src/shared/providers/opencode/goApi'), readGoApiKey: () => '' }
  });
  const dto = (await service.getProfiles()).profiles.Work;
  const reading = await fetchOpenCodeProfile('Work', 'paired-cookie',
    async () => ({ status: 'ok', workspaceId: 'org_WORK', windows: [] }),
    async () => ({ status: 'ok', workspaceId: 'org_WORK', windows: [], balanceUsd: 1 }),
    Date.now(), new Date().toISOString(), { apiKey: 'paired-key', deps: { env: {} },
      collectGoApi: async () => ({ status: 'ok', windows: [] }) });
  const h = adapterHarness();
  h.list.update([{ ...dto, id: 'Work', accountName: 'Work' }], [reading]);
  const row = h.update()[0][0];
  assert.equal(row.accountKey, reading.accountKey);
  assert.ok(row.accountKeyAliases.includes(dto.accountKey));
  const records = panel.applyAccountOrder([
    { provider: 'opencode', accountKey: 'other' }, { ...reading, provider: 'opencode' }
  ], { opencode: [row] }, '', { opencode: { order: [reading.accountKey], labels: { [reading.accountKey]: 'Office' } } });
  assert.equal(records[0].accountKey, reading.accountKey);
  assert.equal(records[0].accountDisplayName, 'Office');
  await h.config().ipc.setEnabled('codex', 'Work', false);
  assert.deepEqual(h.calls[0], ['enabled', 'Work', false]);
});
test('OpenCode owner forwards explicit profile and ambient DTO identities to the common list', async () => {
  const { create } = require(path.join(renderer, 'limits/providerOwners/opencode'));
  const node = () => ({ children: [], dataset: {}, classList: { add() {}, remove() {}, toggle() {} },
    setAttribute() {}, addEventListener() {}, append(...items) { this.children.push(...items); },
    appendChild(item) { this.children.push(item); }, replaceChildren() { this.children = []; }, before() {} });
  const list = node();
  let saved;
  const api = { getProfiles: async () => ({ profiles: { Work: { accountKey: 'canonical', accountKeyAliases: ['old'], enabled: true } },
    hasAmbientKey: true, ambientAccountKey: 'ambient-key', ambientEnabled: false }),
    status: async () => ({ profiles: {} }) };
  const owner = create({ initial: {}, getSettings: () => ({}), document: {
    getElementById: id => id === 'opencodeProfileList' ? list : null, createElement: node },
    window: { tokenMonitor: { opencode: api }, TokenMonitorLegacyAccountList: { create: () => ({ update(rows) { saved = rows; }, summary: () => ({ total: saved?.length || 0, linked: 0 }) }) } },
    isSettingsSurfaceVisible: () => true, renderAccountShellError() {},
    accountProfileRequests: { begin: () => () => true }, accountProfileStatuses: { retire() {}, begin: () => () => true },
    t: key => key, encodeURIComponent, renderSettingsSummaries() {}, localProviderStatuses: () => [] });
  owner.renderOpenCodeProfiles();
  await new Promise(resolve => setImmediate(resolve));
  assert.ok(saved, 'owner must finish rendering and update the list');
  assert.equal(saved[0].id, 'ambient:');
  assert.equal(saved[0].accountKey, 'ambient-key');
  assert.equal(saved[0].removable, false);
  assert.equal(saved[0].enabled, false);
  assert.equal(saved[1].id, 'profile:Work');
  assert.equal(saved[1].profileName, 'Work');
  assert.equal(saved[1].accountKey, 'canonical');
  assert.deepEqual(saved[1].accountKeyAliases, ['old']);
});
test('forward aliases keep authoritative DTO key and ambiguous reverse aliases cannot select a workspace', () => {
  const h = adapterHarness();
  h.list.update([{ id: 'profile', accountKey: 'canonical', accountKeyAliases: ['old'] }], [{ accountKey: 'old' }]);
  assert.equal(h.update()[0][0].accountKey, 'canonical');
  h.list.update([{ id: 'profile', accountKey: 'api' }], [
    { accountKey: 'workspace-a', accountKeyAliases: ['api'] }, { accountKey: 'workspace-b', accountKeyAliases: ['api'] }
  ]);
  assert.equal(h.update()[0][0].accountKey, 'api');
});


function liveOwnerHarness(provider) {
  const { createDocument } = require('./accountOwnerDom.fixture.cjs');
  const document = createDocument();
  const createElement = document.createElement;
  document.createElement = tag => {
    const node = createElement(tag);
    node.appendChild = child => { node.append(child); return child; };
    node.before = child => node.parentElement.insertBefore(child, node);
    return node;
  };
  const querySelectorAll = document.querySelectorAll;
  document.querySelectorAll = selector => selector.startsWith('[data-managed-profile-') ? [] : querySelectorAll(selector);
  const nodes = {};
  for (const id of [`${provider}ProfileList`, 'thirdpartyProfileName', 'thirdpartyBaseUrlInput',
    'thirdpartyAccessTokenInput', 'thirdpartyRefreshTokenInput', 'thirdpartyApiKeyInput', 'thirdpartyUserIdInput', 'thirdpartyPlatformInput', 'thirdpartyModeInput', 'thirdpartyAddDetails', 'thirdpartyAddToggle']) {
    nodes[id] = document.createElement('div'); nodes[id].id = id; document.root.append(nodes[id]);
  }
  let profiles = {}, readings = [];
  const settings = {};
  const api = {
    getProfiles: async () => ({ profiles }), status: async () => ({ profiles: {} }),
    deleteProfile: async id => { delete profiles[id]; return { ok: true }; }
  };
  const owner = require(path.join(renderer, `limits/providerOwners/${provider}.js`)).create({
    document, initial: {}, getSettings: () => settings, getAccountContext: () => ({ settings }),
    preserveScroll: fn => fn(), t: key => key, encodeURIComponent,
    isSettingsSurfaceVisible: () => true, localProviderStatuses: () => readings, limitProviderEnabled: () => true,
    accountProfileRequests: { begin: () => () => true }, accountProfileStatuses: { begin: () => () => true, retire() {} },
    renderAccountShellError() {}, renderSettingsSummaries() {}, accountShellApi: { render() {} },
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'), tokenMonitor: { [provider]: api } }
  });
  const flush = () => new Promise(resolve => setImmediate(resolve));
  return { document, nodes, owner, flush,
    rows: () => [...document.root.walk()].filter(node => node.classList.contains('slot-row')),
    async render(next) { profiles = next; owner[provider === 'opencode' ? 'renderOpenCodeProfiles' : 'renderThirdPartyProfiles'](); await flush(); },
    push(next) { readings = next; owner.updateThirdPartyProfilesStatus(); }
  };
}
const rowAction = (row, action) => [...row.walk()].find(node => action === 'replace'
  ? node.dataset.slotAction?.startsWith('replace') : node.dataset.slotAction === action);

test('third-party editing uses refreshed metadata and supports profiles added after initial render', async () => {
  const h = liveOwnerHarness('thirdparty');
  const profile = baseUrl => ({ baseUrl, adapter: 'newapi-token', canonicalAccountKey: 'key' });
  await h.render({ Work: profile('https://old.example') });
  await h.render({ Work: profile('https://new.example'), Personal: profile('https://personal.example') });
  rowAction(h.rows().find(row => row.dataset.slotId === 'Work'), 'replace').click();
  assert.equal(h.nodes.thirdpartyBaseUrlInput.value, 'https://new.example');
  rowAction(h.rows().find(row => row.dataset.slotId === 'Personal'), 'replace').click();
  assert.equal(h.nodes.thirdpartyBaseUrlInput.value, 'https://personal.example');
});

test('third-party quota pushes update common row health in both directions', async () => {
  const h = liveOwnerHarness('thirdparty');
  await h.render({ Work: { baseUrl: 'https://example.test', adapter: 'newapi-token', canonicalAccountKey: 'key' } });
  const status = () => h.rows()[0].querySelector('.slot-status').className;
  assert.match(status(), /slot-unavailable/);
  h.push([{ id: 'thirdparty', accountKey: 'key', status: 'ok' }]);
  assert.match(status(), /slot-connected/);
  h.push([{ id: 'thirdparty', accountKey: 'key', status: 'unauthorized' }]);
  assert.match(status(), /slot-invalid/);
});

test('OpenCode removing the final profile clears the common list and exposes the empty state', async () => {
  const h = liveOwnerHarness('opencode');
  await h.render({ Work: { accountKey: 'key', apiKey: 'set', enabled: true } });
  assert.equal(h.rows().length, 1);
  const old = h.rows()[0];
  const remove = rowAction(old, 'remove');
  await remove.click(); await remove.click(); await h.flush();
  assert.equal(h.rows().length, 0);
  assert.equal(old.isConnected, false);
  assert.equal(h.nodes.opencodeProfileList.classList.contains('hidden'), false);
  assert.equal(h.nodes.opencodeProfileList.textContent, 'settings.opencode.emptyList');
});
