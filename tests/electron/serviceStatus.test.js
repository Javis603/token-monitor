'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

const {
  SERVICE_STATUS_PROVIDERS,
  createServiceStatusClient,
  summarizeStatuspageProvider
} = require('../../src/electron/serviceStatus');

const provider = {
  id: 'example',
  label: 'Example',
  pageUrl: 'https://status.example.com',
  summaryUrl: 'https://status.example.com/api/v2/summary.json'
};

const summary = {
  page: { updated_at: '2026-06-06T02:30:00Z' },
  status: { indicator: 'minor', description: 'Partially Degraded Service' },
  components: [
    { name: 'API', status: 'degraded_performance' },
    { name: 'Dashboard', status: 'operational' }
  ],
  incidents: [
    { name: 'API latency', status: 'investigating' }
  ],
  scheduled_maintenances: [
    { name: 'Database maintenance', status: 'scheduled' },
    { name: 'Finished maintenance', status: 'completed' }
  ]
};

test('summarizeStatuspageProvider converts statuspage summary into compact provider state', () => {
  const result = summarizeStatuspageProvider(provider, summary, { checkedAt: '2026-06-06T02:31:00Z' });

  assert.deepEqual(result, {
    id: 'example',
    label: 'Example',
    pageUrl: 'https://status.example.com',
    status: 'degraded',
    indicator: 'minor',
    description: 'Partially Degraded Service',
    checkedAt: '2026-06-06T02:31:00Z',
    updatedAt: '2026-06-06T02:30:00Z',
    componentIssues: [{ name: 'API', status: 'degraded_performance' }],
    incidentTitle: 'API latency',
    incidentCount: 1,
    maintenanceCount: 1
  });
});

test('summarizeStatuspageProvider surfaces the newest active incident name as incidentTitle', () => {
  const payload = {
    status: { indicator: 'minor', description: 'Partially Degraded Service' },
    incidents: [
      { name: 'Elevated errors on Claude Haiku 4.5', status: 'identified' },
      { name: 'Older active incident', status: 'monitoring' }
    ]
  };

  const result = summarizeStatuspageProvider(provider, payload, { checkedAt: '2026-06-06T02:31:00Z' });

  // The first entry mirrors the headline the official status page leads with.
  assert.equal(result.incidentTitle, 'Elevated errors on Claude Haiku 4.5');
  assert.equal(result.incidentCount, 2);
});

test('summarizeStatuspageProvider leaves incidentTitle empty when no incident is active', () => {
  const payload = {
    status: { indicator: 'none', description: 'All Systems Operational' },
    incidents: [{ name: 'Resolved last week', status: 'resolved' }]
  };

  const result = summarizeStatuspageProvider(provider, payload, { checkedAt: '2026-06-06T02:31:00Z' });

  assert.equal(result.incidentTitle, '');
  assert.equal(result.incidentCount, 0);
});

test('summarizeStatuspageProvider reports unknown when a provider fetch fails', () => {
  const result = summarizeStatuspageProvider(provider, null, {
    checkedAt: '2026-06-06T02:31:00Z',
    error: new Error('network down')
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.error, 'network down');
  assert.equal(result.incidentTitle, '');
  assert.equal(result.incidentCount, 0);
  assert.equal(result.maintenanceCount, 0);
});

test('summarizeStatuspageProvider counts under_maintenance as maintenance, not degradation', () => {
  const payload = {
    status: { indicator: 'maintenance', description: 'Scheduled Maintenance' },
    components: [
      { name: 'API', status: 'under_maintenance' },
      { name: 'Dashboard', status: 'operational' },
      { name: 'Search', status: 'degraded_performance' }
    ],
    scheduled_maintenances: [{ name: 'DB upgrade', status: 'in_progress' }]
  };

  const result = summarizeStatuspageProvider(provider, payload, { checkedAt: '2026-06-06T02:31:00Z' });

  // The degraded-component count must reflect real problems only — the
  // component under planned maintenance belongs to maintenanceCount instead.
  assert.deepEqual(result.componentIssues, [{ name: 'Search', status: 'degraded_performance' }]);
  assert.equal(result.maintenanceCount, 1);
});

test('default providers cover claude, openai, cursor, and deepseek with summary endpoints', () => {
  // Order mirrors the other settings lists (Claude → Codex/OpenAI → Cursor → …).
  const ids = SERVICE_STATUS_PROVIDERS.map((entry) => entry.id);
  assert.deepEqual(ids, ['claude', 'openai', 'cursor', 'deepseek']);
  for (const entry of SERVICE_STATUS_PROVIDERS) {
    assert.match(entry.summaryUrl, /\/api\/v2\/summary\.json$/);
    assert.ok(entry.pageUrl.startsWith('https://'), `${entry.id} pageUrl should be https`);
  }
});

test('service status client sends an identifying User-Agent header', async () => {
  let seenInit = null;
  const client = createServiceStatusClient({
    providers: [provider],
    now: () => 0,
    fetchImpl: async (_url, init) => {
      seenInit = init;
      return { ok: true, json: async () => summary };
    }
  });

  await client.getServiceStatus();

  assert.match(String(seenInit?.headers?.['User-Agent'] || ''), /TokenMonitor\//);
});

test('service status client retries soon after a failed check instead of caching the failure', async () => {
  let attempt = 0;
  let clock = 0;
  const client = createServiceStatusClient({
    providers: [provider],
    cacheMs: 60_000,
    errorCacheMs: 10_000,
    now: () => clock,
    fetchImpl: async () => {
      attempt += 1;
      if (attempt === 1) throw new Error('network down');
      return { ok: true, json: async () => summary };
    }
  });

  const first = await client.getServiceStatus();
  assert.equal(first.providers[0].status, 'unknown');

  // Still inside the success-cache window but past the short failure window.
  clock = 11_000;
  const second = await client.getServiceStatus();

  assert.equal(attempt, 2);
  assert.equal(second.providers[0].status, 'degraded');
});

test('service status client caches results until forced', async () => {
  let calls = 0;
  const client = createServiceStatusClient({
    providers: [provider],
    cacheMs: 60_000,
    now: () => Date.parse('2026-06-06T02:31:00Z'),
    fetchImpl: async (url) => {
      calls += 1;
      assert.equal(url, provider.summaryUrl);
      return { ok: true, json: async () => summary };
    }
  });

  const first = await client.getServiceStatus();
  const second = await client.getServiceStatus();
  const forced = await client.getServiceStatus({ force: true });

  assert.equal(calls, 2);
  assert.equal(first.providers[0].status, 'degraded');
  assert.equal(second, first);
  assert.notEqual(forced, first);
});

test('service status client fetches only the requested providerIds', async () => {
  const fetched = [];
  const providers = [
    { id: 'a', label: 'A', pageUrl: 'https://a.example.com', summaryUrl: 'https://a.example.com/api/v2/summary.json' },
    { id: 'b', label: 'B', pageUrl: 'https://b.example.com', summaryUrl: 'https://b.example.com/api/v2/summary.json' }
  ];
  const client = createServiceStatusClient({
    providers,
    now: () => 0,
    fetchImpl: async (url) => { fetched.push(url); return { ok: true, json: async () => summary }; }
  });

  const result = await client.getServiceStatus({ providerIds: ['a'] });

  assert.deepEqual(fetched, ['https://a.example.com/api/v2/summary.json']);
  assert.deepEqual(result.providers.map((entry) => entry.id), ['a']);
});

test('service status client makes no request when providerIds is empty', async () => {
  let calls = 0;
  const client = createServiceStatusClient({
    providers: [provider],
    now: () => 0,
    fetchImpl: async () => { calls += 1; return { ok: true, json: async () => summary }; }
  });

  const result = await client.getServiceStatus({ providerIds: [] });

  assert.equal(calls, 0);
  assert.deepEqual(result.providers, []);
});

// The status card is the one place the app reports on a third party's own
// network, and Cursor's page now redirects to status.x.ai, which never answers
// from mainland China without a proxy. Probed on the global fetch the card is
// pinned to "Unable to check status" on exactly the machines the runtime
// transport exists for, so it has to resolve the same way the quota probes do.
test('the status probe takes the runtime transport', () => {
  const main = fs.readFileSync(path.join(ROOT, 'src', 'electron', 'main.js'), 'utf8');

  assert.match(main, /createServiceStatusClient\(\{\s*fetchImpl: electronLimitsFetch\(\)\s*\}\)/);
});
