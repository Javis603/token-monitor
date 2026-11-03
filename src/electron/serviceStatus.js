'use strict';

const { appVersion } = require('../shared/appVersion');

const DEFAULT_CACHE_MS = 60_000;
// A failed check is only cached briefly so a transient network blip recovers on
// the next visit instead of being pinned to "unknown" for the full cache window.
const DEFAULT_ERROR_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const USER_AGENT = `TokenMonitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

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
    // status.deepseek.com moved off Atlassian Statuspage to a Flashcat-hosted
    // page. The old deepseek.statuspage.io mirror stopped receiving incidents
    // (last one: 2026-05) while its API kept answering "All Systems
    // Operational", so it must not be consulted again. The Flashcat page has no
    // anonymous JSON API, but its Atom feed carries every event with its live
    // status, so the feed is summarized instead. Both URLs point at the
    // official page.
    pageUrl: 'https://status.deepseek.com',
    summaryUrl: 'https://status.deepseek.com/feed.atom',
    summaryFormat: 'atom-feed'
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

// Feed events mirror the incident lifecycle of the Flashcat-hosted page.
// Unknown/missing statuses are treated as active on purpose: a format drift
// must surface as a possible incident, never as a healthy "operational".
const INACTIVE_FEED_EVENT = new Set(['resolved', 'completed', 'postmortem', 'canceled', 'cancelled']);
// Flashcat titles are bilingual (e.g. "... Partially Unavailable（...部分中断）"),
// so severity is derived from both languages' outage wording.
const FEED_OUTAGE_TITLE = /outage|unavailable|not available|中断|不可用|宕机/i;
const FEED_MAINTENANCE_TITLE = /maintenance|维护/i;

function decodeXmlEntities(value) {
  return String(value || '')
    .replace(/&#x([0-9a-fA-F]+);/g, (match, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (match, dec) => String.fromCodePoint(parseInt(dec, 10)))
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');
}

function parseFeedEntries(feedText) {
  const text = String(feedText || '');
  if (!/<feed[\s>]/.test(text)) throw new Error('Unexpected feed content');
  const blocks = text.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  // The official page keeps its full event history in the feed, so an
  // entry-less feed means the response was empty/truncated or the format
  // drifted — never read that as "no incidents".
  if (!blocks.length) throw new Error('No feed entries');
  return blocks.map((block) => {
    const title = decodeXmlEntities((block.match(/<title[^>]*>([\s\S]*?)<\/title>/) || [])[1]).trim();
    const updated = String((block.match(/<updated[^>]*>([\s\S]*?)<\/updated>/) || [])[1] || '').trim();
    const summary = decodeXmlEntities((block.match(/<summary[^>]*>([\s\S]*?)<\/summary>/) || [])[1]);
    const status = String((summary.match(/Status:<\/strong>\s*([a-z_]+)/i) || [])[1] || '').toLowerCase();
    const affected = String((summary.match(/Affected components:<\/strong>([^<]*)/) || [])[1] || '');
    return {
      title,
      updated,
      status,
      components: affected.split(',').map((name) => name.trim()).filter(Boolean)
    };
  });
}

function summarizeAtomFeedProvider(provider, feedText, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  try {
    const entries = parseFeedEntries(feedText)
      .sort((a, b) => (Date.parse(b.updated) || 0) - (Date.parse(a.updated) || 0));
    const events = entries.filter((entry) => !INACTIVE_FEED_EVENT.has(entry.status));
    const incidents = events.filter((entry) => !FEED_MAINTENANCE_TITLE.test(entry.title));
    const maintenances = events.filter((entry) => FEED_MAINTENANCE_TITLE.test(entry.title));
    const isOutage = (entry) => FEED_OUTAGE_TITLE.test(entry.title);
    const outage = incidents.some(isOutage);
    const indicator = incidents.length ? (outage ? 'major' : 'minor') : 'none';
    const seen = new Set();
    const componentIssues = [];
    // Each component takes its own incident's severity. Outage incidents are
    // processed first so de-duplication keeps the higher severity when a
    // component is affected by both an outage and a degradation.
    const ordered = [...incidents.filter(isOutage), ...incidents.filter((entry) => !isOutage(entry))];
    for (const incident of ordered) {
      const componentStatus = isOutage(incident) ? 'partial_outage' : 'degraded_performance';
      for (const name of incident.components) {
        if (seen.has(name)) continue;
        seen.add(name);
        componentIssues.push({ name, status: componentStatus });
      }
    }
    return {
      id: provider.id,
      label: provider.label,
      pageUrl: provider.pageUrl,
      status: providerTone(indicator),
      indicator,
      description: indicator === 'none'
        ? 'All Systems Operational'
        : (outage ? 'Partial Service Outage' : 'Degraded Performance'),
      checkedAt,
      updatedAt: entries.length ? String(entries[0].updated || '').trim() : '',
      componentIssues,
      incidentTitle: incidents.length ? incidents[0].title : '',
      incidentCount: incidents.length,
      maintenanceCount: maintenances.length
    };
  } catch (error) {
    return summarizeStatuspageProvider(provider, null, { checkedAt, error });
  }
}

// The abort timer must stay armed while the body is read as well: a server
// that sends headers and then stalls the body would otherwise leave the
// request pending forever and freeze the cached status snapshot.
async function fetchBodyWithTimeout(fetchImpl, url, timeoutMs, format) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  const init = { headers: { 'User-Agent': USER_AGENT } };
  if (controller) init.signal = controller.signal;
  try {
    const response = await fetchImpl(url, init);
    if (!response?.ok) throw new Error(`HTTP ${response?.status || 'error'}`);
    return format === 'atom-feed' ? await response.text() : await response.json();
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
        const body = await fetchBodyWithTimeout(fetchImpl, provider.summaryUrl, timeoutMs, provider.summaryFormat);
        if (provider.summaryFormat === 'atom-feed') {
          return summarizeAtomFeedProvider(provider, body, { checkedAt });
        }
        return summarizeStatuspageProvider(provider, body, { checkedAt });
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
  summarizeAtomFeedProvider,
  summarizeStatuspageProvider
};
