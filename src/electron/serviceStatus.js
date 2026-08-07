'use strict';

const { appVersion } = require('../shared/appVersion');

const DEFAULT_CACHE_MS = 60_000;
// A failed check is only cached briefly so a transient network blip recovers on
// the next visit instead of being pinned to "unknown" for the full cache window.
const DEFAULT_ERROR_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const USER_AGENT = `TokenMonitor/${appVersion()} (+https://github.com/Javis603/routed-monitoring)`;

const SERVICE_STATUS_PROVIDERS = [
  {
    id: 'claude',
    label: 'Claude',
    pageUrl: 'https://status.claude.com',
    summaryUrl: 'https://status.claude.com/api/v2/summary.json'
  },
  {
    id: 'openai',
    label: 'OpenAI',
    pageUrl: 'https://status.openai.com',
    summaryUrl: 'https://status.openai.com/api/v2/summary.json'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    pageUrl: 'https://status.cursor.com',
    summaryUrl: 'https://status.cursor.com/api/v2/summary.json'
  },
  {
    id: 'deepseek',
    label: 'DeepSeek',
    // The official status.deepseek.com page only serves HTML to browsers — its
    // /api/v2 endpoint returns nothing to programmatic clients — so we fetch the
    // JSON from the Atlassian-hosted mirror while still linking users to the
    // official page.
    pageUrl: 'https://status.deepseek.com',
    summaryUrl: 'https://deepseek.statuspage.io/api/v2/summary.json'
  }
];

// Components in planned maintenance are intentionally not degradations — they
// are surfaced through maintenanceCount instead, matching how Atlassian and
// incident.io separate maintenance from incidents.
const COMPONENT_NON_ISSUE = new Set(['operational', 'under_maintenance']);
const INACTIVE_INCIDENT = new Set(['resolved', 'completed', 'postmortem']);
const INACTIVE_MAINTENANCE = new Set(['completed', 'canceled']);

function normalizeStatus(value) {
  return String(value || '').trim().toLowerCase();
}

function providerTone(indicator) {
  const value = normalizeStatus(indicator);
  if (value === 'none') return 'ok';
  if (value === 'minor') return 'degraded';
  if (value === 'major' || value === 'critical') return 'outage';
  return 'unknown';
}

function activeItems(items, inactiveStatuses) {
  return (Array.isArray(items) ? items : []).filter((item) => {
    const status = normalizeStatus(item?.status);
    return status && !inactiveStatuses.has(status);
  });
}

function componentIssues(components) {
  return (Array.isArray(components) ? components : [])
    .filter((component) => !COMPONENT_NON_ISSUE.has(normalizeStatus(component?.status)))
    .map((component) => ({
      name: String(component?.name || 'Unknown').trim() || 'Unknown',
      status: normalizeStatus(component?.status) || 'unknown'
    }));
}

function summarizeStatuspageProvider(provider, payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  if (options.error || !payload || typeof payload !== 'object') {
    return {
      id: provider.id,
      label: provider.label,
      pageUrl: provider.pageUrl,
      status: 'unknown',
      indicator: 'unknown',
      description: 'Unable to check status',
      checkedAt,
      updatedAt: '',
      componentIssues: [],
      incidentTitle: '',
      incidentCount: 0,
      maintenanceCount: 0,
      error: options.error?.message || 'Unable to check status'
    };
  }

  const indicator = normalizeStatus(payload.status?.indicator) || 'unknown';
  const issues = componentIssues(payload.components);
  const incidents = activeItems(payload.incidents, INACTIVE_INCIDENT);
  const maintenances = activeItems(payload.scheduled_maintenances, INACTIVE_MAINTENANCE);
  return {
    id: provider.id,
    label: provider.label,
    pageUrl: provider.pageUrl,
    status: providerTone(indicator),
    indicator,
    description: String(payload.status?.description || '').trim() || 'Unknown',
    checkedAt,
    updatedAt: String(payload.page?.updated_at || payload.status?.updated_at || '').trim(),
    componentIssues: issues,
    // The newest active incident's name — the headline the official status page
    // leads with (e.g. "Elevated errors on Claude Haiku 4.5"). Empty when none.
    incidentTitle: incidents.length ? String(incidents[0].name || '').trim() : '',
    incidentCount: incidents.length,
    maintenanceCount: maintenances.length
  };
}

async function fetchJsonWithTimeout(fetchImpl, url, timeoutMs) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const init = { headers: { 'User-Agent': USER_AGENT } };
  if (controller) init.signal = controller.signal;
  try {
    const response = await fetchImpl(url, init);
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function createServiceStatusClient(options = {}) {
  const providers = options.providers || SERVICE_STATUS_PROVIDERS;
  const fetchImpl = options.fetchImpl || globalThis.fetch;
  const cacheMs = Number(options.cacheMs || DEFAULT_CACHE_MS);
  const errorCacheMs = Number(options.errorCacheMs || DEFAULT_ERROR_CACHE_MS);
  const timeoutMs = Number(options.timeoutMs || DEFAULT_TIMEOUT_MS);
  const now = options.now || Date.now;
  let cache = null;
  let cacheUntil = 0;

  async function getServiceStatus({ force = false, providerIds = null } = {}) {
    const wanted = Array.isArray(providerIds)
      ? providers.filter((provider) => providerIds.includes(provider.id))
      : providers;
    const key = wanted.map((provider) => provider.id).slice().sort().join(',');
    const currentTime = Number(now());
    if (!force && cache && cache.key === key && currentTime < cacheUntil) return cache;
    const checkedAt = new Date(currentTime).toISOString();
    const results = await Promise.all(wanted.map(async (provider) => {
      try {
        const payload = await fetchJsonWithTimeout(fetchImpl, provider.summaryUrl, timeoutMs);
        return summarizeStatuspageProvider(provider, payload, { checkedAt });
      } catch (error) {
        return summarizeStatuspageProvider(provider, null, { checkedAt, error });
      }
    }));
    const anyError = results.some((entry) => entry.error);
    cache = { key, checkedAt, providers: results };
    cacheUntil = currentTime + (anyError ? errorCacheMs : cacheMs);
    return cache;
  }

  return { getServiceStatus };
}

module.exports = {
  SERVICE_STATUS_PROVIDERS,
  createServiceStatusClient,
  summarizeStatuspageProvider
};
