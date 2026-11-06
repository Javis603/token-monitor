'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const ROOT = path.join(__dirname, '..', '..');

const {
  SERVICE_STATUS_PROVIDERS,
  createServiceStatusClient,
  summarizeAtomFeedProvider,
  summarizeInstatusProvider,
  summarizeOpenCodeProvider,
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

test('default providers cover the tracked tools with per-format summary endpoints', () => {
  // Order mirrors the renderer placeholder list in app.js; the two lists must
  // stay in sync. Ids are unique — they are the hidden/display-order keys.
  const ids = SERVICE_STATUS_PROVIDERS.map((entry) => entry.id);
  assert.deepEqual(ids, [
    'claude', 'openai', 'opencode', 'cursor', 'factory', 'kimi', 'github',
    'zed', 'deepseek', 'devin', 'minimax', 'minimax-intl'
  ]);
  assert.equal(new Set(ids).size, ids.length);
  for (const entry of SERVICE_STATUS_PROVIDERS) {
    assert.ok(entry.pageUrl.startsWith('https://'), `${entry.id} pageUrl should be https`);
  }
  const byId = new Map(SERVICE_STATUS_PROVIDERS.map((entry) => [entry.id, entry]));
  // DeepSeek left Atlassian Statuspage; its events are summarized from the
  // official page's Atom feed instead of the stale statuspage.io mirror.
  assert.equal(byId.get('deepseek').summaryUrl, 'https://status.deepseek.com/feed.atom');
  assert.equal(byId.get('deepseek').summaryFormat, 'atom-feed');
  // OpenCode and Zed publish non-Statuspage feeds with their own shape.
  assert.equal(byId.get('opencode').summaryFormat, 'opencode-json');
  assert.equal(byId.get('zed').summaryFormat, 'instatus');
  for (const entry of SERVICE_STATUS_PROVIDERS.filter((item) => !item.summaryFormat)) {
    assert.match(entry.summaryUrl, /\/api\/v2\/summary\.json$/);
  }
});

function atomEntry(title, updated, status, components) {
  const summary = `&lt;p&gt;&lt;strong&gt;Status:&lt;/strong&gt; ${status}&lt;/p&gt;`
    + `&lt;p&gt;&lt;strong&gt;Affected components:&lt;/strong&gt; ${components.join(', ')}&lt;/p&gt;`;
  return `  <entry>\n    <title>${title}</title>\n    <updated>${updated}</updated>\n`
    + `    <summary type="html">${summary}</summary>\n  </entry>`;
}

function atomFeedOf(...entries) {
  return `<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom">\n`
    + `${entries.join('\n')}\n</feed>`;
}

const feedProvider = {
  id: 'deepseek',
  label: 'DeepSeek',
  pageUrl: 'https://status.deepseek.com',
  summaryUrl: 'https://status.deepseek.com/feed.atom',
  summaryFormat: 'atom-feed'
};

test('summarizeAtomFeedProvider reports an active outage incident from the feed', () => {
  const feed = atomFeedOf(
    atomEntry('DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）',
      '2026-11-03T18:04:53+08:00', 'monitoring', ['DeepSeek V4.1 Flash API服务(API Service)', '对话服务(Chatservice)']),
    atomEntry('DeepSeek API 性能下降（DeepSeek API Degraded Performance）',
      '2026-10-27T15:21:54+08:00', 'resolved', ['DeepSeek V4 Pro API服务(API Service)'])
  );

  const result = summarizeAtomFeedProvider(feedProvider, feed, { checkedAt: '2026-11-03T17:52:00Z' });

  assert.equal(result.status, 'outage');
  assert.equal(result.indicator, 'major');
  assert.equal(result.description, 'Partial Service Outage');
  assert.equal(result.incidentTitle, 'DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）');
  assert.equal(result.incidentCount, 1);
  assert.equal(result.maintenanceCount, 0);
  assert.equal(result.updatedAt, '2026-11-03T18:04:53+08:00');
  assert.deepEqual(result.componentIssues, [
    { name: 'DeepSeek V4.1 Flash API服务(API Service)', status: 'partial_outage' },
    { name: '对话服务(Chatservice)', status: 'partial_outage' }
  ]);
  assert.equal(result.checkedAt, '2026-11-03T17:52:00Z');
  assert.equal(result.pageUrl, 'https://status.deepseek.com');
});

test('summarizeAtomFeedProvider treats resolved-only feeds as operational', () => {
  const feed = atomFeedOf(
    atomEntry('DeepSeek API 性能下降（DeepSeek API Degraded Performance）',
      '2026-10-27T15:21:54+08:00', 'resolved', ['DeepSeek V4 Pro API服务(API Service)'])
  );

  const result = summarizeAtomFeedProvider(feedProvider, feed, { checkedAt: '2026-11-03T17:52:00Z' });

  assert.equal(result.status, 'ok');
  assert.equal(result.indicator, 'none');
  assert.equal(result.description, 'All Systems Operational');
  assert.equal(result.incidentTitle, '');
  assert.equal(result.incidentCount, 0);
  assert.deepEqual(result.componentIssues, []);
  assert.equal(result.updatedAt, '2026-10-27T15:21:54+08:00');
});

test('summarizeAtomFeedProvider degrades on non-outage incidents and keeps maintenance separate', () => {
  const feed = atomFeedOf(
    atomEntry('搜索服务异常（Search service error）', '2026-11-02T10:00:00+08:00', 'investigating', ['搜索服务']),
    atomEntry('计划维护（Scheduled maintenance）', '2026-11-01T10:00:00+08:00', 'monitoring', ['API Service'])
  );

  const result = summarizeAtomFeedProvider(feedProvider, feed, { checkedAt: '2026-11-03T17:52:00Z' });

  assert.equal(result.status, 'degraded');
  assert.equal(result.indicator, 'minor');
  assert.equal(result.description, 'Degraded Performance');
  assert.equal(result.incidentTitle, '搜索服务异常（Search service error）');
  assert.equal(result.incidentCount, 1);
  assert.equal(result.maintenanceCount, 1);
  assert.deepEqual(result.componentIssues, [{ name: '搜索服务', status: 'degraded_performance' }]);
});

test('summarizeAtomFeedProvider assigns each component its own incident severity', () => {
  const feed = atomFeedOf(
    // Degraded incident is newer, but the outage incident must still win for
    // the component both events share, and single-incident components keep
    // their own severity.
    atomEntry('搜索服务异常（Search service error）', '2026-11-03T10:00:00+08:00', 'investigating', ['搜索服务', '共享服务']),
    atomEntry('DeepSeek API 部分中断（DeepSeek API Partially Unavailable）', '2026-11-03T09:00:00+08:00', 'monitoring', ['API 服务', '共享服务'])
  );

  const result = summarizeAtomFeedProvider(feedProvider, feed, { checkedAt: '2026-11-03T17:52:00Z' });

  assert.equal(result.indicator, 'major');
  // Outage incidents are processed first so the shared component keeps the
  // higher severity under de-duplication.
  assert.deepEqual(result.componentIssues, [
    { name: 'API 服务', status: 'partial_outage' },
    { name: '共享服务', status: 'partial_outage' },
    { name: '搜索服务', status: 'degraded_performance' }
  ]);
});

test('summarizeAtomFeedProvider reports unknown for a feed without entries', () => {
  // The official page always carries its event history; an entry-less feed is
  // an empty/truncated response or format drift, never "no incidents".
  const result = summarizeAtomFeedProvider(feedProvider, '<?xml version="1.0" encoding="UTF-8"?><feed xmlns="http://www.w3.org/2005/Atom"></feed>', {
    checkedAt: '2026-11-03T17:52:00Z'
  });

  assert.equal(result.status, 'unknown');
  assert.match(result.error, /No feed entries/);
});

test('summarizeAtomFeedProvider treats events without a parseable status as active', () => {
  // A format drift on the feed side must never regress into the original bug
  // (showing "All Systems Operational" during an outage), so unknown statuses
  // are kept in the active set.
  const feed = atomFeedOf(
    atomEntry('Something happened', '2026-11-02T10:00:00+08:00', '???', ['API Service'])
  );

  const result = summarizeAtomFeedProvider(feedProvider, feed, { checkedAt: '2026-11-03T17:52:00Z' });

  assert.equal(result.incidentCount, 1);
  assert.notEqual(result.status, 'ok');
});

test('summarizeAtomFeedProvider reports unknown when the feed cannot be parsed', () => {
  const result = summarizeAtomFeedProvider(feedProvider, '<!DOCTYPE html><html>oops</html>', {
    checkedAt: '2026-11-03T17:52:00Z'
  });

  assert.equal(result.status, 'unknown');
  assert.equal(result.incidentTitle, '');
  assert.equal(result.incidentCount, 0);
  assert.match(result.error, /Unexpected feed content/);
});

test('summarizeAtomFeedProvider rejects an unclosed active entry even when the feed closes', () => {
  const resolved = atomEntry('Earlier incident', '2026-11-02T10:00:00Z', 'resolved', ['API']);
  const active = atomEntry('API Unavailable', '2026-11-03T10:00:00Z', 'investigating', ['API']);
  const malformed = atomFeedOf(resolved, active.replace('</entry>', ''));
  const result = summarizeAtomFeedProvider(feedProvider, malformed);
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /Incomplete feed entry/);
});

test('summarizeAtomFeedProvider rejects a feed truncated after a resolved entry', () => {
  const resolved = atomEntry('Earlier incident', '2026-11-02T10:00:00Z', 'resolved', ['API']);
  const active = atomEntry('API Unavailable', '2026-11-03T10:00:00Z', 'investigating', ['API']);
  const complete = atomFeedOf(resolved, active);
  assert.equal(summarizeAtomFeedProvider(feedProvider, complete).status, 'outage');
  const truncated = complete.slice(0, complete.lastIndexOf('</entry>'));
  const result = summarizeAtomFeedProvider(feedProvider, truncated);
  assert.equal(result.status, 'unknown');
  assert.match(result.error, /Unexpected feed content/);
});

const instatusProvider = {
  id: 'zed',
  label: 'Zed',
  pageUrl: 'https://status.zed.dev',
  summaryUrl: 'https://status.zed.dev/v3/summary.json',
  summaryFormat: 'instatus'
};

test('summarizeInstatusProvider reports an UP page as operational', () => {
  // Healthy Instatus pages omit the incident arrays entirely.
  const result = summarizeInstatusProvider(instatusProvider, { page: { status: 'UP' } }, {
    checkedAt: '2026-11-05T10:00:00Z'
  });

  assert.deepEqual(result, {
    id: 'zed',
    label: 'Zed',
    pageUrl: 'https://status.zed.dev',
    status: 'ok',
    indicator: 'none',
    description: 'All Systems Operational',
    checkedAt: '2026-11-05T10:00:00Z',
    updatedAt: '',
    componentIssues: [],
    incidentTitle: '',
    incidentCount: 0,
    maintenanceCount: 0
  });
});

test('summarizeInstatusProvider ranks active incidents by impact', () => {
  const payload = {
    page: { status: 'HASISSUES' },
    activeIncidents: [
      { name: 'Degraded editing', impact: 'DEGRADEDPERFORMANCE', updatedAt: '2026-11-05T09:00:00Z' },
      { name: 'Collaboration outage', impact: 'MAJOROUTAGE', updatedAt: '2026-11-05T09:30:00Z' },
      { name: 'Partial outage', impact: 'PARTIALOUTAGE', updatedAt: '2026-11-05T09:15:00Z' }
    ],
    activeMaintenances: [{ name: 'DB upgrade' }]
  };

  const result = summarizeInstatusProvider(instatusProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });

  assert.equal(result.status, 'outage');
  assert.equal(result.indicator, 'critical');
  assert.equal(result.description, 'Major Outage');
  assert.equal(result.incidentTitle, 'Collaboration outage');
  assert.equal(result.incidentCount, 3);
  assert.equal(result.maintenanceCount, 1);
  assert.equal(result.updatedAt, '2026-11-05T09:30:00Z');
});

test('summarizeInstatusProvider degrades HASISSUES without readable incident detail', () => {
  const result = summarizeInstatusProvider(instatusProvider, { page: { status: 'HASISSUES' } }, {
    checkedAt: '2026-11-05T10:00:00Z'
  });

  assert.equal(result.indicator, 'minor');
  assert.equal(result.status, 'degraded');
  assert.equal(result.incidentTitle, '');
});

test('summarizeInstatusProvider maps granular v3 page statuses and preserves incidents', () => {
  for (const prefix of ['ALL', 'SOME', 'ONE']) {
    for (const [suffix, indicator] of [
      ['UNDERMAINTENANCE', 'none'], ['DEGRADEDPERFORMANCE', 'minor'],
      ['PARTIALOUTAGE', 'major'], ['MINOROUTAGE', 'minor'], ['MAJOROUTAGE', 'critical']
    ]) {
      const page = { status: prefix + suffix };
      const result = summarizeInstatusProvider(instatusProvider, { page });
      assert.equal(result.indicator, indicator, page.status);
      const concurrent = summarizeInstatusProvider(instatusProvider, {
        page, activeIncidents: [{ name: 'Outage', impact: 'MAJOROUTAGE' }],
        activeMaintenances: [{ name: 'Maintenance' }]
      });
      assert.equal(concurrent.indicator, 'critical', page.status);
      assert.equal(concurrent.incidentTitle, 'Outage');
      assert.equal(concurrent.incidentCount, 1);
      assert.equal(concurrent.maintenanceCount, 1);
    }
  }
});

test('summarizeInstatusProvider reports unknown on malformed payloads', () => {
  for (const payload of [null, 'nope', [], { page: {} }, { page: { status: 'WEIRD' } }, { page: { status: 'UP' }, activeIncidents: 'nope' }]) {
    const result = summarizeInstatusProvider(instatusProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });
    assert.equal(result.status, 'unknown', JSON.stringify(payload));
    assert.ok(result.error);
  }
});

const openCodeProvider = {
  id: 'opencode',
  label: 'OpenCode',
  pageUrl: 'https://status.opencode.ai',
  summaryUrl: 'https://status.opencode.ai/api/status',
  summaryFormat: 'opencode-json'
};

test('summarizeOpenCodeProvider reports an operational payload as healthy', () => {
  const payload = {
    updatedAt: 1793836106718,
    status: 'operational',
    components: [
      { service: 'console', status: 'operational' },
      { service: 'inference', status: 'operational' }
    ]
  };

  const result = summarizeOpenCodeProvider(openCodeProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });

  assert.deepEqual(result, {
    id: 'opencode',
    label: 'OpenCode',
    pageUrl: 'https://status.opencode.ai',
    status: 'ok',
    indicator: 'none',
    description: 'All Systems Operational',
    checkedAt: '2026-11-05T10:00:00Z',
    updatedAt: new Date(1793836106718).toISOString(),
    componentIssues: [],
    incidentTitle: '',
    incidentCount: 0,
    maintenanceCount: 0
  });
});

test('summarizeOpenCodeProvider takes the worst of the top-level and component statuses', () => {
  const payload = {
    updatedAt: 1793836106718,
    status: 'operational',
    components: [
      { service: 'console', status: 'operational' },
      { service: 'go', status: 'degraded' },
      { service: 'payg', status: 'partial_outage' }
    ]
  };

  const result = summarizeOpenCodeProvider(openCodeProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });

  assert.equal(result.status, 'outage');
  assert.equal(result.indicator, 'major');
  // The headline describes severity; readable service names remain supporting detail.
  assert.equal(result.description, 'Partial Service Outage');
  assert.deepEqual(result.componentIssues, [
    { name: 'Go', status: 'degraded_performance' },
    { name: 'Pay-as-you-go', status: 'partial_outage' }
  ]);
});

test('summarizeOpenCodeProvider degrades unknown statuses instead of reading green', () => {
  const payload = { status: 'operational', components: [{ service: 'inference', status: 'wat' }] };

  const result = summarizeOpenCodeProvider(openCodeProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });

  assert.equal(result.indicator, 'minor');
  assert.deepEqual(result.componentIssues, [{ name: 'Inference API', status: 'degraded_performance' }]);
});

test('summarizeOpenCodeProvider reports unknown on malformed payloads', () => {
  const cases = [
    null,
    'nope',
    [],
    { components: [] },
    { status: 'operational', components: 'nope' },
    { status: 'operational', components: [{ status: 'operational' }] },
    { status: 'operational', components: [null] }
  ];
  for (const payload of cases) {
    const result = summarizeOpenCodeProvider(openCodeProvider, payload, { checkedAt: '2026-11-05T10:00:00Z' });
    assert.equal(result.status, 'unknown', JSON.stringify(payload));
    assert.ok(result.error);
  }
});

test('service status client dispatches each summaryFormat to its summarizer', async () => {
  const instatusPayload = { page: { status: 'HASISSUES' }, activeIncidents: [{ name: 'Editing degraded', impact: 'DEGRADEDPERFORMANCE', updatedAt: '2026-11-05T09:00:00Z' }] };
  const openCodePayload = { updatedAt: 1793836106718, status: 'operational', components: [] };
  const client = createServiceStatusClient({
    providers: [instatusProvider, openCodeProvider],
    now: () => 0,
    fetchImpl: async (url) => ({
      ok: true,
      json: async () => {
        if (url === instatusProvider.summaryUrl) return instatusPayload;
        return openCodePayload;
      }
    })
  });

  const result = await client.getServiceStatus();
  const byId = new Map(result.providers.map((entry) => [entry.id, entry]));

  assert.equal(byId.get('zed').indicator, 'minor');
  assert.equal(byId.get('opencode').indicator, 'none');
});

test('service status client summarizes atom feeds through response text', async () => {
  const feed = atomFeedOf(
    atomEntry('DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）',
      '2026-11-03T18:04:53+08:00', 'monitoring', ['API Service'])
  );
  const client = createServiceStatusClient({
    providers: [feedProvider],
    now: () => 0,
    fetchImpl: async () => ({ ok: true, text: async () => feed })
  });

  const result = await client.getServiceStatus();

  assert.equal(result.providers[0].status, 'outage');
  assert.equal(result.providers[0].incidentTitle, 'DeepSeek 网页/API 部分中断（DeepSeek Web/API Partially Unavailable）');
});

test('service status client reports unknown when an atom feed fetch fails', async () => {
  const client = createServiceStatusClient({
    providers: [feedProvider],
    now: () => 0,
    fetchImpl: async () => {
      throw new Error('network down');
    }
  });

  const result = await client.getServiceStatus();

  assert.equal(result.providers[0].status, 'unknown');
  assert.equal(result.providers[0].error, 'network down');
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

test('OpenCode describes the problem separately from readable affected service names', () => {
  const summarize = (components) => summarizeOpenCodeProvider(openCodeProvider, { status: 'degraded', components });
  const result = summarize([{ service: 'go', status: 'degraded', reason: 'upstream' }]);
  assert.equal(result.description, 'Upstream provider issues');
  assert.deepEqual(result.componentIssues, [{ name: 'Go', status: 'degraded_performance' }]);
  for (const reason of [undefined, 'new-reason']) {
    assert.equal(summarize([{ service: 'go', status: 'degraded', reason }]).description, 'Degraded Performance');
  }
  assert.equal(summarize([
    { service: 'go', status: 'degraded', reason: 'upstream' },
    { service: 'payg', status: 'partial_outage', reason: 'errors' }
  ]).description, 'Partial Service Outage');
  assert.equal(summarize([{ service: 'new-service', status: 'degraded' }]).componentIssues[0].name, 'new-service');
});
