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
  const element = () => {
    const node = { value: '', textContent: '', dataset: {}, attributes: {}, children: [], listeners: {},
      append(...children) { this.children.push(...children); }, replaceChildren() { this.children = []; },
      querySelector(selector) { return this.children.find(child => child.classList.contains(selector.slice(1)))
        || this.children.map(child => child.querySelector(selector)).find(Boolean); },
      addEventListener(type, handler) { this.listeners[type] = handler; },
      setAttribute(key, value) { this.attributes[key] = value; }, focus() {}, select() {},
      click() { return this.listeners.click?.({ currentTarget: this }); } };
    let classes = new Set();
    Object.defineProperty(node, 'className', { get: () => [...classes].join(' '), set: value => { classes = new Set(value.split(/\s+/)); } });
    node.classList = { contains: name => classes.has(name), add: name => classes.add(name), remove: name => classes.delete(name),
      toggle: (name, on) => on ? classes.add(name) : classes.delete(name) };
    return node;
  };
  const elements = new Map();
  for (const match of html.matchAll(/<[^>]+\bid="(minimax[^" ]+)"[^>]*>/g)) {
    const node = element();
    node.className = match[0].match(/class="([^"]*)"/)?.[1] || '';
    if (match[0].startsWith('<select')) node.value = html.slice(match.index).match(/<option value="([^"]*)"/)[1];
    elements.set(match[1], node);
  }
  const get = id => { assert.ok(elements.has(id), `${id} must exist in the real markup`); return elements.get(id); };
  const walk = node => [node, ...node.children.flatMap(walk)];
  const rows = () => walk(get('minimaxKeyList')).filter(node => node.dataset.minimaxKey);
  const saves = [], opened = [], refreshes = [], removed = [];
  const state = { settings: { minimaxApiRegion: 'cn', minimaxBillingMode: 'token-plan' } };
  const api = { getKeys: async () => [], addKey: async () => ({ ok: true }) };
  let providers = [], enabled = true;
  const context = {
    state, accountShellApi, accountShellErrors: {}, accountProfileRequests: accountShellApi.createRequestGuard(),
    accountProfileSaves: accountShellApi.createBusyGuard(),
    limitProviderPresentationApi: require('../../src/electron/renderer/limits/providerPresentation'),
    translatedLimitProviderTag: tag => tag?.label || '',
    t, isSettingsSurfaceVisible: () => true, renderSettingsSummaries() {}, refreshStats: async () => {},
    setExternalAccountExpanded: (_id, value) => { state.minimaxAccountExpanded = value; },
    refreshLimitProviderQuota: id => refreshes.push(id),
    localProviderStatuses: () => providers, limitProviderEnabled: () => enabled,
    document: { getElementById: get, createElement: element,
      querySelectorAll: () => rows() },
    window: { tokenMonitor: { openExternal: url => opened.push(url), minimax: {
      getKeys: () => api.getKeys(), addKey: draft => { saves.push(draft); return api.addKey(draft); },
      removeKey: async id => { removed.push(id); return { ok: true }; }
    } } }
  };
  const names = ['setAccountShellError', 'renderAccountShellError', 'minimaxBillingUrl', 'updateMinimaxApiKeysStatus', 'apiKeyAccountStatusText', 'minimaxKeyErrorText', 'renderMinimaxApiKeys'];
  const functions = names.map(name => {
    const marker = app.indexOf(`function ${name}(`);
    const start = app.slice(marker - 6, marker) === 'async ' ? marker - 6 : marker;
    return app.slice(start, app.indexOf('\n}\n', start) + 2);
  }).join('\n');
  const start = app.indexOf("  const minimaxToggle = document.getElementById('minimaxSettingsToggle');");
  vm.runInNewContext(`${functions}\n${app.slice(start, app.indexOf('\n  }\n', start) + 5)}`, context);
  return { get, api, saves, opened, refreshes, removed, state, rows,
    buttons: label => walk(get('minimaxKeyList')).filter(node => node.attributes['aria-label'] === t(label)),
    render: () => context.renderMinimaxApiKeys(),
    status: (rows, on = true) => { providers = rows.map(row => ({ provider: 'minimax', ...row })); enabled = on; context.updateMinimaxApiKeysStatus(); },
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

test('MiniMax saved keys use independent API status and billing links, with removal', async () => {
  const h = minimaxPanelHarness();
  h.api.getKeys = async () => [
    { id: 'a', accountKey: 'a', apiRegion: 'auto', billingMode: 'api' },
    { id: 'b', accountKey: 'b', apiRegion: 'cn', billingMode: 'token-plan' }
  ];
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.common.checking'));
  const info = id => h.rows().find(node => node.dataset.minimaxKey === id).querySelector('.managed-account-info');
  const labels = () => h.rows().map(row => row.querySelector('.managed-account-email').textContent);
  const apiLabel = t('settings.minimax.billingApi');
  const tokenLabel = t('settings.minimax.billingTokenPlan');
  const accountLabel = number => t('settings.minimax.accountFallback', { number });
  assert.deepEqual(labels(), [`${accountLabel(1)} · ${apiLabel}`, `${accountLabel(2)} · ${tokenLabel}`]);
  h.status([{ source: 'oauth', status: 'ok', accountKey: 'a' }, { source: 'api', accountKey: 'a', region: 'en', status: 'unauthorized' }]);
  assert.equal(info('a').textContent, t('settings.minimax.statusInvalid'));
  h.status([{ source: 'oauth', status: 'ok', accountKey: 'a' }]);
  assert.equal(info('a').textContent, t('settings.common.checking'));
  h.status([], false);
  assert.equal(info('a').textContent, t('settings.limits.status.disabled'));
  assert.equal(h.get('minimaxStatus').textContent, t('settings.limits.status.disabled'));
  h.status([{ source: 'api', accountKey: 'a', region: 'cn', relatedAccountKey: 'code', status: 'ok' },
    { source: 'api', accountKey: 'b', region: 'cn', relatedAccountKey: 'code', status: 'ok' },
    { source: 'oauth', accountKey: 'code', region: 'cn', status: 'ok' }]);
  assert.deepEqual(labels(), [`${accountLabel(1)} · ${apiLabel}`, `${accountLabel(2)} · ${tokenLabel}`]);
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
  h.get('minimaxRefreshButton').click();
  assert.deepEqual(h.refreshes, ['minimax']);
  h.api.getKeys = async () => { throw new Error('IPC unavailable'); };
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.common.unavailable'));
  assert.equal(h.get('minimaxErrorMessage').textContent, '');
  h.status([{ source: 'api', accountKey: 'a', status: 'ok' }]);
  assert.equal(info('a').textContent, t('settings.minimax.statusSet'));
  h.api.getKeys = async () => [{ id: 'a', accountKey: 'a', apiRegion: 'auto', billingMode: 'api' }];
  await h.render();
  assert.equal(h.get('minimaxStatus').textContent, t('settings.limits.status.live'));
  assert.equal(h.get('minimaxErrorMessage').textContent, '', 'a recovered list read must not retain a false save error');
});

async function settle() {
  await new Promise((resolve) => setImmediate(resolve));
}

function namedProfilesHarness() {
  const source = app.slice(app.indexOf('function renderNamedApiProfiles('), app.indexOf('function renderOpenRouterProfiles('));
  const lists = new Map(['openrouter', 'thirdparty'].map((id) => [id, {
    children: [],
    replaceChildren() { this.children = []; },
    append(node) { this.children.push(node); }
  }]));
  const statuses = new Map(['openrouter', 'thirdparty'].map((id) => [id, { textContent: '' }]));
  const errors = new Map(['openrouter', 'thirdparty'].map((id) => [id, { textContent: '', classList: { toggle() {} } }]));
  const requests = { openrouter: [], thirdparty: [] };
  const state = { settings: {}, openrouterProfileCount: -1, thirdpartyProfileCount: -1 };
  let visible = true;
  let summaryRenders = 0;
  const context = {
    state,
    accountProfileRequests: accountShellApi.createRequestGuard(),
    accountShellApi,
    accountShellErrors: { openrouter: 'Failed to rename' },
    isSettingsSurfaceVisible: () => visible,
    renderSettingsSummaries: () => { summaryRenders += 1; },
    t: (key) => key,
    document: {
      getElementById(id) {
        for (const [provider, list] of lists) {
          if (id === `${provider}ProfileList`) return list;
          if (id === `${provider}Status`) return statuses.get(provider);
          if (id === `${provider}ErrorMessage`) return errors.get(provider);
        }
        return null;
      },
      createElement() { return { className: '', textContent: '' }; }
    }
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  vm.runInNewContext(`${shellErrorSource}\n${source}\nthis.renderNamedApiProfiles = renderNamedApiProfiles;`, context);
  const render = (providerId) => context.renderNamedApiProfiles({
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
  const errors = { textContent: '', classList: { toggle(name, hidden) { this.hidden = hidden; } } };
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
    accountProfileSaves: accountShellApi.createBusyGuard(),
    isSettingsSurfaceVisible: () => true,
    setCursorStatusText: (element, value) => { element.textContent = value; element.title = value; },
    setCursorCheckboxesEnabled() {},
    renderSettingsSummaries() {},
    t: (key, values) => values?.message ? `${key}: ${values.message}` : key,
    document: {
      getElementById: (id) => elements[id] || null,
      createElement: () => ({ className: '', textContent: '', classList: { toggle() {} }, setAttribute() {}, addEventListener() {}, append() {} })
    },
    window: { tokenMonitor: { cursor: {
      loginManual: async () => ({ ok: false, error: 'Invalid session' }),
      status: () => statusRequest.promise
    } } }
  };
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const { clientColors, fallbackModelColors'));
  const renderSource = app.slice(app.indexOf('function renderCursorStatus('), app.indexOf('function setCursorCheckboxesEnabled('));
  const submitSource = app.slice(app.indexOf('  const cursorManualSubmit ='), app.indexOf('  refreshCursorStatus({ discover: true });', app.indexOf('  const cursorManualSubmit =')));
  vm.runInNewContext(`${shellErrorSource}\n${renderSource}\n${submitSource}\nthis.refreshCursorStatus = refreshCursorStatus; this.renderCursorStatus = renderCursorStatus;`, context);

  await manualSubmit.click();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');
  context.renderCursorStatus();
  assert.equal(errors.textContent, 'settings.cursor.loginFailed: Invalid session');

  const refresh = context.refreshCursorStatus({ discover: true });
  assert.equal(errors.textContent, '');
  statusRequest.resolve({ accounts: [{ id: 'manual', email: 'user@example.com', enabled: true }], linkedCount: 1 });
  await refresh;
  assert.equal(statusPill.textContent, 'settings.cursor.connected');
  assert.equal(errors.textContent, '');
  assert.equal(errors.classList.hidden, true);
});

test('OpenCode status ignores an older probe after a newer status resolves', async () => {
  const source = app.slice(app.indexOf('async function updateOpenCodeProfilesStatus('), app.indexOf('function renderOpenCodeProfilesStatusSummary('));
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
  vm.runInNewContext(`${source}\nthis.updateOpenCodeProfilesStatus = updateOpenCodeProfilesStatus;`, context);
  const older = context.updateOpenCodeProfilesStatus();
  const newer = context.updateOpenCodeProfilesStatus();
  requests[1].resolve({ profiles: { main: { expired: true } } });
  await newer;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  requests[0].resolve({ profiles: { main: { disabled: true } } });
  await older;
  assert.equal(info.textContent, 'settings.opencode.statusExpired');
  assert.equal(summaries.length, 1);
});
