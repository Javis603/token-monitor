'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

const accountShellApi = require('../../src/electron/renderer/limits/accountShell');
const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

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
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const reasonixSessionGuard'));
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
  const shellErrorSource = app.slice(app.indexOf('function setAccountShellError('), app.indexOf('const reasonixSessionGuard'));
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
