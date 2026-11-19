'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const {
  SERVICE_STATUS_PROVIDERS,
  createServiceStatusClient,
  summarizeInstatusProvider,
  summarizeStatuspageProvider
} = require('../../src/electron/serviceStatus');

const copilot = SERVICE_STATUS_PROVIDERS.find((entry) => entry.id === 'github');
const zed = SERVICE_STATUS_PROVIDERS.find((entry) => entry.id === 'zed');
const copilotComponent = { id: 'pjmpxvq2cmr2', name: 'Copilot', status: 'operational' };
const modelComponent = { id: 'cnnb39dkkk82', name: 'Copilot AI Model Providers', status: 'operational' };
const actionsComponent = { id: 'br0l2tvcx85d', name: 'Actions', status: 'major_outage' };

test('Copilot ignores unrelated GitHub outages, incidents and maintenance', () => {
  const result = summarizeStatuspageProvider(copilot, {
    status: { indicator: 'major', description: 'Partial System Outage' },
    components: [actionsComponent, copilotComponent, modelComponent],
    incidents: [{ name: 'Actions jobs fail', status: 'investigating', impact: 'major', components: [actionsComponent] }],
    scheduled_maintenances: [{ name: 'Actions maintenance', status: 'in_progress', components: [actionsComponent] }]
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.description, 'All Systems Operational');
  assert.deepEqual(result.componentIssues, []);
  assert.equal(result.incidentTitle, '');
  assert.equal(result.incidentCount, 0);
  assert.equal(result.maintenanceCount, 0);
});

test('Copilot keeps the worst relevant component and only related incident details', () => {
  for (const affected of [copilotComponent, modelComponent]) {
    const result = summarizeStatuspageProvider(copilot, {
      status: { indicator: 'critical', description: 'Major System Outage' },
      components: [actionsComponent, copilotComponent, modelComponent].map((entry) => (
        entry.id === affected.id ? { ...entry, status: 'partial_outage' } : entry
      )),
      incidents: [
        { name: 'Actions down', status: 'investigating', impact: 'critical', components: [actionsComponent] },
        { name: 'Copilot requests fail', status: 'monitoring', impact: 'major', components: [affected] },
        { name: 'Earlier Copilot issue', status: 'resolved', impact: 'critical', components: [affected] }
      ],
      scheduled_maintenances: [{ name: 'Copilot maintenance', status: 'in_progress', components: [affected] }]
    });
    assert.equal(result.indicator, 'major', affected.name);
    assert.deepEqual(result.componentIssues, [{ name: affected.name, status: 'partial_outage' }]);
    assert.equal(result.incidentTitle, 'Copilot requests fail');
    assert.equal(result.incidentCount, 1);
    assert.equal(result.maintenanceCount, 1);
  }
});

test('Copilot notices a related incident before the component status changes', () => {
  const result = summarizeStatuspageProvider(copilot, {
    status: { indicator: 'none' },
    components: [copilotComponent, modelComponent],
    incidents: [{ name: 'Copilot errors', status: 'investigating', impact: 'major', components: [modelComponent] }]
  });
  assert.equal(result.indicator, 'major');
  assert.equal(result.incidentTitle, 'Copilot errors');
});

test('Copilot reports unknown if its components are missing from the feed', () => {
  for (const components of [[actionsComponent], [copilotComponent], [modelComponent], [copilotComponent, copilotComponent]]) {
    const result = summarizeStatuspageProvider(copilot, {
      status: { indicator: 'none' }, components
    });
    assert.equal(result.status, 'unknown', JSON.stringify(components));
  }
});

test('Zed preserves maintenance without counting it as an outage', () => {
  const payload = {
    page: { status: 'UNDERMAINTENANCE' },
    activeMaintenances: [{ name: 'Database maintenance', status: 'INPROGRESS' }]
  };
  const result = summarizeInstatusProvider(zed, payload);
  assert.equal(result.error, undefined);
  assert.equal(result.status, 'ok');
  assert.equal(result.maintenanceCount, 1);
  assert.equal(result.incidentCount, 0);
  const outage = summarizeInstatusProvider(zed, {
    ...payload,
    activeIncidents: [{ name: 'Collaboration down', impact: 'MAJOROUTAGE', updatedAt: '2026-11-05T09:00:00Z' }]
  });
  assert.equal(outage.status, 'outage');
  assert.equal(outage.maintenanceCount, 1);
  assert.equal(outage.updatedAt, '2026-11-05T09:00:00Z');
});

test('Zed reads the official incident updatedAt field', () => {
  const result = summarizeInstatusProvider(zed, {
    page: { status: 'HASISSUES' },
    activeIncidents: [{ name: 'Editing degraded', impact: 'DEGRADEDPERFORMANCE', updatedAt: '2026-11-05T09:00:00Z' }]
  });
  assert.equal(result.updatedAt, '2026-11-05T09:00:00Z');
});

test('MiniMax exposes independent China and international status and fetch preferences', async () => {
  const fetched = [];
  const client = createServiceStatusClient({
    fetchImpl: async (url) => {
      fetched.push(url);
      return { ok: true, json: async () => ({
        status: { indicator: url === 'https://status.minimax.io/api/v2/summary.json' ? 'major' : 'none' }
      }) };
    }
  });
  const result = await client.getServiceStatus({ providerIds: ['minimax', 'minimax-intl'] });
  assert.deepEqual(result.providers.map(({ id, status }) => ({ id, status })), [
    { id: 'minimax', status: 'ok' }, { id: 'minimax-intl', status: 'outage' }
  ]);
  assert.deepEqual(fetched, [
    'https://status.minimaxi.com/api/v2/summary.json', 'https://status.minimax.io/api/v2/summary.json'
  ]);
  fetched.length = 0;
  await client.getServiceStatus({ providerIds: ['minimax-intl'] });
  assert.deepEqual(fetched, ['https://status.minimax.io/api/v2/summary.json']);
});

test('status settings and pre-fetch rows match the main provider labels and links', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const declaration = app.match(/const SERVICE_STATUS_PLACEHOLDERS = (\[[\s\S]*?\n\]);/)[1];
  const rows = JSON.parse(JSON.stringify(vm.runInNewContext(declaration)));
  assert.deepEqual(rows, SERVICE_STATUS_PROVIDERS.map(({ id, label, pageUrl }) => ({ id, label, pageUrl })));
});

test('status defaults follow README tool order and preserve saved custom ordering', () => {
  const readme = fs.readFileSync(path.join(__dirname, '../../README.md'), 'utf8');
  const iconIds = [...readme.matchAll(/^\| <img src="\.github\/assets\/tools-icon\/([^".]+)\.png"/gm)].map((match) => match[1]);
  const toolIcons = { openai: 'codex', github: 'copilot', factory: 'droid', 'minimax-intl': 'minimax' };
  const listed = SERVICE_STATUS_PROVIDERS;
  const expected = [...listed].sort((a, b) => (
    iconIds.indexOf(toolIcons[a.id] || a.id) - iconIds.indexOf(toolIcons[b.id] || b.id)
  ));
  for (const { id } of listed) assert.ok(iconIds.includes(toolIcons[id] || id), id);
  assert.deepEqual(SERVICE_STATUS_PROVIDERS.map(({ id }) => id), expected.map(({ id }) => id));
  const preferences = require('../../src/electron/renderer/serviceStatusProviderPreferences');
  assert.deepEqual(preferences.visibleOrder(SERVICE_STATUS_PROVIDERS, 'zed,github,claude', '').slice(0, 3), ['zed', 'github', 'claude']);
});

test('Zed fetches its documented v3 API and exposes incident details', async () => {
  const client = createServiceStatusClient({
    providers: [zed],
    fetchImpl: async (url) => {
      assert.equal(url, 'https://status.zed.dev/v3/summary.json');
      return { ok: true, json: async () => ({
        page: { status: 'HASISSUES' },
        activeIncidents: [{ name: 'Editing degraded', impact: 'DEGRADEDPERFORMANCE', updatedAt: '2026-11-05T09:00:00Z' }]
      }) };
    }
  });
  const result = (await client.getServiceStatus()).providers[0];
  assert.equal(result.incidentTitle, 'Editing degraded');
  assert.equal(result.updatedAt, '2026-11-05T09:00:00Z');
});

test('status external links admit provider roots and reject unrelated Google URLs', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const declarations = main.slice(main.indexOf('const STATUS_PAGE_HOSTS'), main.indexOf('const diagnosticJournal'));
  const start = main.indexOf('function isAllowedExternalUrl(');
  const allowed = vm.runInNewContext(`${declarations}\n${main.slice(start, main.indexOf('\nfunction revealWindow(', start))}\nisAllowedExternalUrl`, {
    URL, SERVICE_STATUS_PROVIDERS, settings: {}, process: { env: {} },
    isAllowedVerificationUrl: () => false, isAllowedCodexLoginUrl: () => false, limitProviderUrlAllowed: () => false
  });
  assert.equal(allowed('https://status.minimax.io/'), true);
  assert.equal(allowed('https://status.minimaxi.com/'), true);
  for (const url of [
    'https://www.google.com/appsstatus/dashboard', 'https://www.google.com/', 'https://www.google.com/?q=test', 'https://www.google.com/#test',
    'https://www.google.com/appsstatus/dashboard?q=test', 'https://www.google.com/appsstatus/dashboard#test'
  ]) assert.equal(allowed(url), false, url);
});

test('revealed status providers render immediately without bypassing manual refresh', () => {
  const app = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const names = ['visibleServiceProviderIds', 'serviceStatusRows', 'serviceStatusRefreshMs', 'lastServiceStatusCheckedAt', 'maybeFetchServiceStatus'];
  const functions = names.map((name) => {
    const start = app.indexOf(`function ${name}(`);
    return app.slice(start, app.indexOf('\n}\n', start) + 3);
  }).join('\n');
  const claude = { id: 'claude', status: 'outage', description: 'API down', checkedAt: new Date().toISOString(), componentIssues: [] };
  const state = {
    settings: { serviceStatusRefreshMs: 0, hiddenServiceProviders: 'minimax-intl', serviceProviderDisplayOrder: 'minimax-intl,claude' },
    serviceStatus: { checkedAt: claude.checkedAt, providers: [claude] },
    serviceStatusBusy: false
  };
  let fetches = 0;
  const context = vm.createContext({
    state, SERVICE_STATUS_PLACEHOLDERS: SERVICE_STATUS_PROVIDERS,
    SERVICE_PROVIDER_OPTIONS: SERVICE_STATUS_PROVIDERS,
    serviceStatusProviderPreferencesApi: require('../../src/electron/renderer/serviceStatusProviderPreferences'),
    t: (key) => key,
    refreshServiceStatus: async () => { fetches += 1; }
  });
  vm.runInContext(functions, context);
  assert.equal(vm.runInContext('serviceStatusRows().some(row => row.id === "minimax-intl")', context), false);
  state.settings.hiddenServiceProviders = '';
  const rows = vm.runInContext('serviceStatusRows()', context);
  assert.equal(rows[0].id, 'minimax-intl');
  assert.equal(rows[0].status, 'unknown');
  assert.equal(rows[0].description, 'serviceStatus.notChecked');
  assert.equal(rows[0].checkedAt, '');
  assert.equal(rows[1], claude);
  vm.runInContext('maybeFetchServiceStatus()', context);
  assert.equal(fetches, 0);
  assert.equal(state.serviceStatus.providers.length, 1);

  state.serviceStatusBusy = true;
  assert.equal(vm.runInContext('serviceStatusRows()[0].description', context), 'serviceStatus.loading');
  const refreshed = { ...rows[0], status: 'ok', description: 'All Systems Operational', checkedAt: claude.checkedAt };
  state.serviceStatus.providers.push(refreshed);
  state.serviceStatusBusy = false;
  assert.equal(vm.runInContext('serviceStatusRows()[0]', context), refreshed);
});

test('unhiding checks status immediately and follows an in-flight request with the new selection', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const names = ['refreshServiceStatus', 'onServiceProviderVisibilityToggle', 'showAllServiceProviders'];
  const functions = names.map((name) => {
    const start = source.indexOf(`async function ${name}(`);
    return source.slice(start, source.indexOf('\n}\n', start) + 3);
  }).join('\n');
  const state = { settings: { hiddenServiceProviders: 'minimax-intl' }, serviceStatusBusy: false };
  const calls = [];
  const pending = [];
  const context = vm.createContext({
    state,
    window: { tokenMonitor: { getServiceStatus: (options) => {
      calls.push(options);
      return new Promise((resolve) => pending.push(() => resolve({ providers: options.providerIds.map((id) => ({ id, status: 'ok' })) })));
    } } },
    hiddenServiceProviderSet: () => new Set(state.settings.hiddenServiceProviders.split(',').filter(Boolean)),
    visibleServiceProviderIds: () => ['claude', 'minimax-intl'].filter((id) => !state.settings.hiddenServiceProviders.split(',').includes(id)),
    saveSettings: async (patch) => Object.assign(state.settings, patch),
    renderServiceStatus: () => {}
  });
  vm.runInContext(functions, context);
  const toggle = vm.runInContext('onServiceProviderVisibilityToggle("minimax-intl")', context);
  await new Promise(setImmediate);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].force, true);
  assert.deepEqual(Array.from(calls[0].providerIds), ['claude', 'minimax-intl']);
  pending.shift()();
  await toggle;

  await vm.runInContext('onServiceProviderVisibilityToggle("minimax-intl")', context);
  assert.equal(calls.length, 1, 'hiding does not fetch');
  const inFlight = vm.runInContext('refreshServiceStatus()', context);
  await vm.runInContext('onServiceProviderVisibilityToggle("minimax-intl")', context);
  assert.equal(calls.length, 2, 'no overlapping request');
  pending.shift()();
  await new Promise(setImmediate);
  assert.equal(calls.length, 3, 'new selection is checked after the active request');
  assert.deepEqual(Array.from(calls[2].providerIds), ['claude', 'minimax-intl']);
  assert.equal(calls[2].force, true);
  pending.shift()();
  await inFlight;
  assert.equal(state.serviceStatusBusy, false);
  assert.equal(state.serviceStatus.providers[1].status, 'ok');
  await vm.runInContext('showAllServiceProviders()', context);
  assert.equal(calls.length, 3, 'show all with nothing hidden does not fetch');
  await vm.runInContext('onServiceProviderVisibilityToggle("minimax-intl")', context);
  const showAll = vm.runInContext('showAllServiceProviders()', context);
  await new Promise(setImmediate);
  assert.equal(calls.length, 4);
  assert.equal(calls[3].force, true);
  pending.shift()();
  await showAll;
});

test('a failed status request only marks providers included in that request', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/renderer/app.js'), 'utf8');
  const start = source.indexOf('async function refreshServiceStatus(');
  const refresh = source.slice(start, source.indexOf('\n}\n', start) + 3);
  const state = { serviceStatusBusy: false };
  const context = vm.createContext({
    state, SERVICE_STATUS_PLACEHOLDERS: SERVICE_STATUS_PROVIDERS,
    visibleServiceProviderIds: () => ['claude'], renderServiceStatus: () => {},
    t: (key) => key,
    window: { tokenMonitor: { getServiceStatus: async () => { throw new Error('IPC failed'); } } }
  });
  await vm.runInContext(`${refresh}\nrefreshServiceStatus()`, context);
  assert.deepEqual(Array.from(state.serviceStatus.providers, (provider) => provider.id), ['claude']);
  assert.equal(state.serviceStatus.providers[0].description, 'serviceStatus.checkFailed');
  assert.equal(state.serviceStatus.providers[0].error, 'IPC failed');
  assert.ok(state.serviceStatus.providers[0].checkedAt);
  assert.equal(state.serviceStatusBusy, false);
});
