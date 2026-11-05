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
  const result = summarizeStatuspageProvider(copilot, {
    status: { indicator: 'none' }, components: [actionsComponent]
  });
  assert.equal(result.status, 'unknown');
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
        status: { indicator: url.includes('minimax.io') ? 'major' : 'none' }
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

test('status external links admit Google dashboard only at its exact URL', () => {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const declarations = main.slice(main.indexOf('const STATUS_PAGE_HOSTS'), main.indexOf('const diagnosticJournal'));
  const start = main.indexOf('function isAllowedExternalUrl(');
  const allowed = vm.runInNewContext(`${declarations}\n${main.slice(start, main.indexOf('\nfunction revealWindow(', start))}\nisAllowedExternalUrl`, {
    URL, SERVICE_STATUS_PROVIDERS, settings: {}, process: { env: {} },
    isAllowedVerificationUrl: () => false, isAllowedCodexLoginUrl: () => false, limitProviderUrlAllowed: () => false
  });
  assert.equal(allowed('https://www.google.com/appsstatus/dashboard'), true);
  assert.equal(allowed('https://status.minimax.io/'), true);
  assert.equal(allowed('https://status.minimaxi.com/'), true);
  for (const url of [
    'https://www.google.com/', 'https://www.google.com/?q=test', 'https://www.google.com/#test',
    'https://www.google.com/appsstatus/dashboard?q=test', 'https://www.google.com/appsstatus/dashboard#test'
  ]) assert.equal(allowed(url), false, url);
});
