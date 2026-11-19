'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

const html = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/index.html'), 'utf8');
const i18n = require('../../src/electron/renderer/i18n');
const t = (key, values) => i18n.translate('en', key, values);

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function minimaxPanelHarness() {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const element = () => document.createElement('div');
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="(minimax[^" ]+)"[^>]*>/g)) {
    const node = element();
    node.className = match[0].match(/class="([^"]*)"/)?.[1] || '';
    if (match[0].startsWith('<select')) node.value = html.slice(match.index).match(/<option value="([^"]*)"/)[1];
    node.id = match[1];
    document.root.append(node);
    elements.set(match[1], node);
  }
  const get = id => { assert.ok(elements.has(id), `${id} must exist in the real markup`); return elements.get(id); };
  const walk = node => [node, ...node.children.flatMap(walk)];
  const rows = () => walk(get('minimaxKeyList')).filter(node => node.dataset.slotId);
  const saves = [], opened = [], refreshes = [], removed = [];
  const state = { settings: { minimaxApiRegion: 'cn', minimaxBillingMode: 'token-plan' } };
  const api = { getKeys: async () => [], addKey: async () => ({ ok: true }) };
  let providers = [], enabled = true;
  const context = {
    state, accountShellApi, accountShellErrors: {}, accountShellErrorTones: {},
    accountProfileRequests: accountShellApi.createRequestGuard(),
    accountProfileSaves: accountShellApi.createBusyGuard(),
    limitProviderPresentationApi: require('../../src/electron/renderer/limits/providerPresentation'),
    translatedLimitProviderTag: tag => tag?.label || '',
    t, isSettingsSurfaceVisible: () => true, renderSettingsSummaries() {}, refreshStats: async () => {},
    setExternalAccountExpanded: (_id, value) => { state.minimaxAccountExpanded = value; },
    refreshLimitProviderQuota: id => refreshes.push(id),
    localProviderStatuses: () => providers, limitProviderEnabled: () => enabled,
    document,
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'), tokenMonitor: { openExternal: url => opened.push(url), minimax: {
      getKeys: () => api.getKeys(), addKey: draft => { saves.push(draft); return api.addKey(draft); },
      removeKey: async id => { removed.push(id); return { ok: true }; }
    } } }
  };
  vm.runInNewContext(app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'))
    + app.slice(app.indexOf('function apiKeyAccountStatusText('), app.indexOf('function setExternalAccountExpanded(')), context);
  const owner = require('../../src/electron/renderer/limits/providerOwners/minimax').create({
    ...context, initial: {}, getSettings: () => state.settings,
    getAccountContext: () => ({ settings: state.settings }), preserveScroll: fn => fn()
  });
  owner.setup();
  return { get, api, saves, opened, refreshes, removed, state, rows,
    buttons: label => walk(get('minimaxKeyList')).filter(node => node.textContent === t(label === 'settings.minimax.clearApiKey' ? 'settings.slots.remove' : label)),
    render: () => owner.renderMinimaxApiKeys(),
    status: (rows, on = true) => { providers = rows.map(row => ({ provider: 'minimax', ...row })); enabled = on; owner.updateMinimaxApiKeysStatus(); },
    draft: values => { for (const [id, value] of Object.entries(values)) get(id).value = value; } };
}

test('MiniMax key input submits its billing and region choices and preserves a newer draft', async () => {
  const h = minimaxPanelHarness();
  h.draft({ minimaxApiKeyInput: 'work-secret', minimaxBillingModeInput: 'api' });
  const pending = deferred();
  h.api.addKey = () => pending.promise;
  const saving = h.get('minimaxKeySubmit').click();
  assert.equal(h.get('minimaxKeySubmit').disabled, true);
  await h.get('minimaxKeySubmit').click();
  assert.equal(h.saves.length, 1);
  assert.equal(h.saves[0].apiRegion, 'auto');
  assert.equal(h.saves[0].billingMode, 'api');
  h.draft({ minimaxApiKeyInput: 'personal-secret', minimaxBillingModeInput: 'token-plan' });
  await h.render();
  pending.resolve({ ok: true });
  await saving;
  assert.equal(h.get('minimaxKeySubmit').disabled, false);
  assert.equal(h.get('minimaxApiKeyInput').value, 'personal-secret');
  await h.get('minimaxKeySubmit').click();
  assert.equal(h.saves[1].apiRegion, 'auto');
  assert.equal(h.saves[1].billingMode, 'token-plan');
  assert.equal(h.get('minimaxApiKeyInput').value, '');
});

test('MiniMax key input retains a rejected draft and allows recovery', async () => {
  const h = minimaxPanelHarness();
  h.draft({ minimaxApiKeyInput: 'bad-key' });
  for (const [result, message] of [
    [{ ok: false, status: 'required' }, 'settings.common.credentialRequired'],
    [{ ok: false, status: 'invalidFormat' }, 'settings.common.credentialInvalidFormat'],
    [{ ok: false, status: 'unauthorized' }, 'settings.minimax.statusInvalid'],
    [{ ok: false, error: 'disk full' }, null]
  ]) {
    h.api.addKey = async () => result;
    await h.get('minimaxKeySubmit').click();
    assert.equal(h.get('minimaxErrorMessage').textContent, message ? t(message) : 'disk full');
    assert.equal(h.get('minimaxKeySubmit').disabled, false);
    assert.equal(h.get('minimaxApiKeyInput').value, 'bad-key');
    await h.render();
    assert.equal(h.get('minimaxErrorMessage').classList.contains('hidden'), false);
  }
  h.api.addKey = async () => ({ ok: true });
  await h.get('minimaxKeySubmit').click();
  assert.equal(h.get('minimaxErrorMessage').textContent, '');
  assert.equal(h.get('minimaxApiKeyInput').value, '');
});

test('MiniMax saved keys use independent API status and billing links, with removal', async (suite) => {
  const h = minimaxPanelHarness();
  h.api.getKeys = async () => [
    { id: 'a', accountKey: 'a', apiRegion: 'auto', billingMode: 'api' },
    { id: 'b', accountKey: 'b', apiRegion: 'cn', billingMode: 'token-plan' }
  ];
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.common.checking'));
  const info = id => h.rows().find(node => node.dataset.slotId === id).querySelector('.slot-status');
  const labels = () => h.rows().map(row => row.querySelector('.slot-name').textContent);
  const apiLabel = t('settings.minimax.billingApi');
  const tokenLabel = t('settings.minimax.billingTokenPlan');
  const accountLabel = number => t('settings.minimax.accountFallback', { number });
  await suite.test('billing modes remain visible on each account', () => {
    assert.deepEqual(labels(), [accountLabel(1), accountLabel(2)]);
    assert.deepEqual(h.rows().map(row => row.querySelector('.slot-detail').textContent),
      [`${t('settings.limits.sources.apiKey')} · ${apiLabel}`, `${t('settings.limits.sources.apiKey')} · ${tokenLabel}`]);
  });
  h.status([{ source: 'oauth', status: 'ok', accountKey: 'a' }, { source: 'api', accountKey: 'a', region: 'en', status: 'unauthorized' }]);
  await suite.test('API failure overrides a healthy OAuth reading', () => {
    assert.equal(info('a').textContent, `${t('settings.slots.invalidKey')}`);
  });
  h.status([{ source: 'oauth', status: 'ok', accountKey: 'a' }]);
  await suite.test('OAuth alone never marks the API credential connected', () => {
    assert.equal(info('a').textContent, `${t('settings.slots.unavailable')}`);
  });
  h.status([], false);
  await suite.test('disabled provider retires the account status', () => {
    assert.equal(info('a').textContent, `${t('settings.limits.status.disabled')}`);
  });
  assert.equal(h.get('minimaxStatus').textContent, t('settings.limits.status.disabled'));
  h.status([{ source: 'api', accountKey: 'a', region: 'cn', relatedAccountKey: 'code', status: 'ok' },
    { source: 'api', accountKey: 'b', region: 'cn', relatedAccountKey: 'code', status: 'ok' },
    { source: 'oauth', accountKey: 'code', region: 'cn', status: 'ok' }]);
  await suite.test('billing modes remain visible on each account', () => {
    assert.deepEqual(labels(), [accountLabel(1), accountLabel(2)]);
    assert.deepEqual(h.rows().map(row => row.querySelector('.slot-detail').textContent),
      [apiLabel, tokenLabel]);
  });
  h.status([{ source: 'api', accountKey: 'a', region: 'en', status: 'ok' }]);
  h.buttons('settings.minimax.openBrowser').forEach(button => button.click());
  assert.deepEqual(h.opened, ['https://platform.minimax.io/user-center/payment/balance',
    'https://platform.minimaxi.com/user-center/payment/token-plan']);
  const removes = h.buttons('settings.minimax.clearApiKey');
  assert.equal(removes.length, 2);
  await removes[0].click();
  assert.deepEqual(h.removed, []);
  await removes[0].click();
  assert.deepEqual(h.removed, ['a']);
  for (const [region, origin] of [['cn', 'platform.minimaxi.com'], ['intl', 'platform.minimax.io'], ['auto', 'platform.minimax.io']]) {
    h.draft({ minimaxApiRegionInput: region });
    h.get('minimaxOpenBrowser').click();
    assert.equal(h.opened.at(-1), `https://${origin}/user-center/payment/token-plan`,
      'the current selection wins over saved settings and stale readings');
  }
  h.status([]);
  h.get('minimaxOpenBrowser').click();
  assert.equal(h.opened.at(-1), 'https://platform.minimax.io/user-center/payment/token-plan',
    'an unremembered Auto choice uses the collector\'s International-first default');
  h.api.getKeys = async () => { throw new Error('IPC unavailable'); };
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.common.unavailable'));
  assert.equal(h.get('minimaxErrorMessage').textContent, '');
  h.status([{ source: 'api', accountKey: 'a', status: 'ok' }]);
  await suite.test('new API readings update the retained account row', () => {
    assert.equal(info('a').textContent, t('settings.limits.sources.apiKey'));
    assert.equal(info('a').classList.contains('slot-connected'), true);
  });
  h.api.getKeys = async () => [{ id: 'a', accountKey: 'a', apiRegion: 'auto', billingMode: 'api' }];
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.limits.status.live'));
  assert.equal(h.get('minimaxErrorMessage').textContent, '', 'a recovered list read must not retain a false save error');
  const retained = h.rows()[0];
  const remove = retained.querySelector('.plugin-menu').querySelectorAll('button').find(node => node.dataset.slotAction === 'remove');
  remove.click();
  remove.focus();
  h.status([{ source: 'api', accountKey: 'a', status: 'unauthorized' }]);
  assert.equal(h.rows()[0], retained);
  assert.equal(h.get('minimaxKeyList').document.activeElement, remove);
  assert.equal(remove.textContent, t('settings.slots.confirmRemove'));
  h.api.getKeys = async () => [{ id: 'a', accountKey: 'a', billingMode: 'api', enabled: false }];
  await h.render();
  assert.equal(info('a').textContent, `${t('settings.slots.paused')}`);
  h.status([], false);
  assert.equal(info('a').textContent, `${t('settings.slots.paused')}`, 'pause survives provider disable');

});

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function namedProfilesHarness() {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const nodes = suffix => new Map(['openrouter', 'thirdparty'].map(id => {
    const node = document.createElement('div');
    node.id = `${id}${suffix}`;
    document.root.append(node);
    return [id, node];
  }));
  const lists = nodes('ProfileList');
  const statuses = nodes('Status');
  const errors = nodes('ErrorMessage');
  const requests = { openrouter: [], thirdparty: [] };
  const state = { settings: {}, openrouterProfileCount: -1, thirdpartyProfileCount: -1 };
  let visible = true;
  let summaryRenders = 0;
  const context = {
    state,
    accountProfileRequests: accountShellApi.createRequestGuard(),
    accountShellApi,
    accountShellErrors: { openrouter: 'Failed to rename' },
    accountShellErrorTones: Object.create(null),
    isSettingsSurfaceVisible: () => visible,
    renderSettingsSummaries: () => { summaryRenders += 1; },
    t: (key) => key,
    document,
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'), tokenMonitor: {} },
    getAccountContext: () => ({ settings: state.settings }),
    preserveScroll: callback => callback(),
    localProviderStatuses: () => []
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  vm.runInNewContext(shellErrorSource, context);
  const owners = Object.fromEntries(['openrouter', 'thirdparty'].map(id => [id,
    require('../../src/electron/renderer/limits/providerOwners/thirdparty').create({
      ...context, initial: { thirdpartyProfileCount: -1 }, getSettings: () => state.settings
    })]));
  for (const id of Object.keys(owners)) owners[id].state[`${id}ProfileCount`] = -1;
  for (const id of Object.keys(owners)) Object.defineProperty(state, `${id}ProfileCount`, { get: () => owners[id].state[`${id}ProfileCount`] });
  const render = (providerId) => owners[providerId].renderNamedApiProfiles({
    providerId,
    profileSettingsKey: `${providerId}Profiles`,
    envConfiguredKey: `${providerId}EnvConfigured`,
    profileCountStateKey: `${providerId}ProfileCount`,
    api: { getProfiles: () => {
      const request = deferred();
      requests[providerId].push(request);
      return request.promise;
    } },
    updateStatus() {}
  });
  return {
    render, requests, lists, statuses, errors, state,
    setError: (providerId, message) => context.setAccountShellError(providerId, message),
    setVisible: (value) => { visible = value; },
    summaries: () => summaryRenders
  };
}

test('profile list ignores older responses and preserves shell errors across settings redraws', async () => {
  const harness = namedProfilesHarness();
  harness.render('openrouter');
  harness.render('openrouter');
  harness.requests.openrouter[1].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, 0);
  assert.equal(harness.lists.get('openrouter').children.length, 1);
  assert.equal(harness.errors.get('openrouter').textContent, 'Failed to rename');
  harness.setError('openrouter', 'Save failed');
  assert.equal(harness.errors.get('openrouter').textContent, 'Save failed');
  harness.requests.openrouter[0].resolve({ profiles: { stale: {} }, hasEnvVar: true });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, 0);
  assert.equal(harness.summaries(), 1);
  harness.render('openrouter');
  assert.equal(harness.errors.get('openrouter').textContent, 'Save failed');
  harness.requests.openrouter[2].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
});

test('profile list isolates providers and ignores stale failures and hidden responses', async () => {
  const harness = namedProfilesHarness();
  harness.render('openrouter');
  harness.render('thirdparty');
  harness.render('openrouter');
  harness.requests.openrouter[0].reject(new Error('stale'));
  harness.requests.thirdparty[0].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.thirdpartyProfileCount, 0);
  assert.equal(harness.statuses.get('openrouter').textContent, '');
  harness.setVisible(false);
  harness.requests.openrouter[1].resolve({ profiles: {}, hasEnvVar: false });
  await settle();
  assert.equal(harness.state.openrouterProfileCount, -1);
});

test('Cursor retires a failed manual login message when status is refreshed', async () => {
  const document = require('./accountOwnerDom.fixture.cjs').createDocument();
  const errors = document.createElement('div'); errors.textContent = '';
  const statusPill = { textContent: '', title: '' };
  const accountList = { children: [], replaceChildren() { this.children = []; }, append(node) { this.children.push(node); } };
  const manualInput = { value: 'bad session' };
  const manualSubmit = { addEventListener(type, handler) { if (type === 'click') this.click = handler; } };
  const elements = {
    cursorErrorMessage: errors,
    cursorAccountStatus: statusPill,
    cursorAccountList: accountList,
    cursorManualSubmit: manualSubmit,
    cursorManualInput: manualInput
  };
  const statusRequest = deferred();
  const state = { cursorAccount: { status: null, error: '', busy: false } };
  const context = {
    state,
    accountShellApi,
    accountShellErrors: Object.create(null),
    accountShellErrorTones: Object.create(null),
    accountProfileSaves: accountShellApi.createBusyGuard(),
    isSettingsSurfaceVisible: () => true,
    setCursorStatusText: (element, value) => { element.textContent = value; element.title = value; },
    setCursorCheckboxesEnabled() {},
    renderSettingsSummaries() {},
    t: (key, values) => values?.message ? `${key}: ${values.message}` : key,
    document: {
      getElementById: (id) => elements[id] || (['cursorSettingsToggle', 'cursorLoginButton'].includes(id) ? { addEventListener() {} } : null),
      querySelector: () => null,
      createElement: () => ({ className: '', textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, append() {} })
    },
    window: { TokenMonitorLegacyAccountList: require('../../src/electron/renderer/limits/legacyAccountList'), tokenMonitor: { cursor: {
      loginManual: async () => ({ ok: false, error: 'Invalid session' }),
      status: () => statusRequest.promise
    } } }
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  vm.runInNewContext(shellErrorSource, context);
  const owner = require('../../src/electron/renderer/limits/providerOwners/cursor').create({
    ...context, initial: state, getSettings: () => ({}), getAccountContext: () => ({ settings: {} }),
    preserveScroll: fn => fn(), localProviderStatuses: () => [], setAccountGroupExpanded() {},
    document: { ...document, getElementById: id => context.document.getElementById(id), querySelector: () => null }
  });
  owner.setup();

  await manualSubmit.click();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');
  owner.renderCursorStatus();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');

  const refresh = owner.refreshCursorStatus({ discover: true });
  assert.equal(errors.textContent, '');
  statusRequest.resolve({ accounts: [{ id: 'manual', email: 'user@example.com', enabled: true }], linkedCount: 1 });
  await refresh;
  assert.equal(statusPill.textContent, 'settings.cursor.connected');
  assert.equal(errors.textContent, '');
  assert.equal(errors.classList.contains('hidden'), true);
});

test('OpenCode status ignores an older probe after a newer status resolves', async () => {
  const requests = [];
  const info = { textContent: '' };
  const summaries = [];
  const context = {
    accountProfileStatuses: accountShellApi.createRequestGuard(),
    isSettingsSurfaceVisible: () => true,
    window: { tokenMonitor: { opencode: { status() {
      const request = deferred();
      requests.push(request);
      return request.promise;
    } } } },
    opencodeRowId: (prefix, name) => `${prefix}${name}`,
    document: { getElementById: (id) => id === 'opencode-info-main' ? info : null },
    t: (key) => key,
    renderOpenCodeProfilesStatusSummary: (profiles) => summaries.push(profiles)
  };
  const owner = require('../../src/electron/renderer/limits/providerOwners/opencode').create({
    ...context, encodeURIComponent, initial: {}, getSettings: () => ({}), accountShellApi: {
      render: value => summaries.push(value)
    }, document: { getElementById: id => id === 'opencodeCookieStatus' ? {} : id.startsWith('opencode-info-') ? info : null }
  });
  const older = owner.updateOpenCodeProfilesStatus();
  const newer = owner.updateOpenCodeProfilesStatus();
  requests[1].resolve({ profiles: { main: { expired: true } } });
  await newer;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  requests[0].resolve({ profiles: { main: { disabled: true } } });
  await older;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  assert.equal(summaries.length, 1);
});
