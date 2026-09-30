'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');

test('an old Claude organization discovery cannot replace a newly saved cookie’s choices', async () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = app.indexOf('let claudeOrganizationChoicesRevision = 0;');
  const end = app.indexOf('\nfunction setupLimitAccountPanels()', start);
  assert.ok(start >= 0 && end > start);
  let resolveOld;
  const oldDiscovery = new Promise((resolve) => { resolveOld = resolve; });
  const select = {
    options: [],
    value: '',
    append(option) { this.options.push(option); }
  };
  const row = { classList: { toggle() {} } };
  const messages = [];
  const state = {
    settingsPushRevision: 0,
    settings: { claudeWebCookieConfigured: true, claudeWebOrganizationId: 'old' }
  };
  const context = {
    state,
    LIMIT_PROVIDERS: [{ id: 'claude', label: 'Claude' }],
    document: {
      getElementById: (id) => ({
        claudeWebOrganizationIdInput: select,
        claudeWebOrganizationRow: row
      })[id] || null,
      createElement: () => ({ value: '', textContent: '' })
    },
    window: { tokenMonitor: { limits: {
      listOrganizationChoices: () => oldDiscovery,
      clearCredential: async () => ({ settings: { claudeWebCookieConfigured: false, claudeWebOrganizationId: '' } }),
      saveCredential: async () => ({
        saved: true,
        verdict: 'valid',
        choices: [{ id: 'new', name: 'New workspace' }],
        settings: { claudeWebCookieConfigured: true, claudeWebOrganizationId: 'new' }
      })
    } } },
    t: (key) => key,
    setAccountPanelMessage: (_id, message) => messages.push(message),
    renderExternalProviderStatus() {},
    clearExternalProviderCheckPending() {},
    clearExternalProviderPendingStatus() {},
    markExternalProviderCheckPending() {},
    refreshStats: async () => {},
    setExternalAccountExpanded() {},
    externalProviderAccountLinked: () => true,
    applyPersistedSettings: (settings) => { state.settings = settings; }
  };
  vm.runInNewContext(app.slice(start, end), context);

  const loadingOld = context.loadClaudeOrganizationChoices();
  await context.clearAccountCredential('claude');
  await context.saveAccountCredential('claude', { claudeWebCookie: 'sessionKey=sk-ant-new', claudeWebOrganizationId: 'new' });
  resolveOld({ status: 'ok', choices: [{ id: 'old', name: 'Old workspace' }] });
  await loadingOld;

  assert.deepEqual(select.options.map((option) => option.value), ['', 'new']);
  assert.equal(select.value, 'new');
  assert.equal(messages.some((message) => message?.key === 'settings.claude.organizationUnavailable'), false);
});
