'use strict';

const { appVersion } = require('../shared/appVersion');

const DEFAULT_CACHE_MS = 60_000;
// A failed check is only cached briefly so a transient network blip recovers on
// the next visit instead of being pinned to "unknown" for the full cache window.
const DEFAULT_ERROR_CACHE_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 5_000;
const USER_AGENT = `TokenMonitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

// Each entry summarizes one official status source. Statuspage-shaped pages
// (`/api/v2/summary.json`) need no format field; the rest carry `summaryFormat`
// and are dispatched to a matching summarizer below. Providers without a
// usable public page (grok and kiro front theirs with bot checks that also
// 403 server-side; z.ai and qoder expose none) must not be added speculatively.
// Follow the README tool order.
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
    id: 'opencode',
    label: 'OpenCode',
    // OpenCode's official status API uses a custom JSON schema instead of the
    // Statuspage shape.
    pageUrl: 'https://status.opencode.ai',
    summaryUrl: 'https://status.opencode.ai/api/status',
    summaryFormat: 'opencode-json'
  },
  {
    id: 'cursor',
    label: 'Cursor',
    pageUrl: 'https://status.cursor.com',
    summaryUrl: 'https://status.cursor.com/api/v2/summary.json'
  },
  {
    id: 'factory',
    label: 'Factory Droid',
    pageUrl: 'https://status.factory.ai',
    summaryUrl: 'https://status.factory.ai/api/v2/summary.json'
  },
  {
    id: 'kimi',
    label: 'Kimi',
    pageUrl: 'https://status.moonshot.cn',
    summaryUrl: 'https://status.moonshot.cn/api/v2/summary.json'
  },
  {
    id: 'github',
    label: 'Copilot',
    pageUrl: 'https://www.githubstatus.com',
    summaryUrl: 'https://www.githubstatus.com/api/v2/summary.json',
    // GitHub's page also covers Actions, Pages and other unrelated services.
    // These are the Copilot and Copilot AI Model Providers component ids.
    componentIds: ['pjmpxvq2cmr2', 'cnnb39dkkk82']
  },
  {
    id: 'zed',
    label: 'Zed',
    pageUrl: 'https://status.zed.dev',
    summaryUrl: 'https://status.zed.dev/v3/summary.json',
    summaryFormat: 'instatus'
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
  },
  {
    id: 'devin',
    label: 'Devin',
    pageUrl: 'https://www.devinstatus.com',
    summaryUrl: 'https://www.devinstatus.com/api/v2/summary.json'
  },
  {
    id: 'minimax',
    label: 'MiniMax (China)',
    pageUrl: 'https://status.minimaxi.com',
    summaryUrl: 'https://status.minimaxi.com/api/v2/summary.json'
  },
  {
    id: 'minimax-intl',
    label: 'MiniMax (International)',
    pageUrl: 'https://status.minimax.io',
    summaryUrl: 'https://status.minimax.io/api/v2/summary.json'
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

// The Statuspage indicator vocabulary is the module's common denominator:
// every summarizer maps its source's severities onto it, and the renderer
// only knows these four states.
const INDICATOR_RANK = new Map([['none', 0], ['minor', 1], ['major', 2], ['critical', 3]]);

function worstIndicator(left, right) {
  return (INDICATOR_RANK.get(right) || 0) > (INDICATOR_RANK.get(left) || 0) ? right : left;
}

function canonicalDescription(indicator) {
  if (indicator === 'critical') return 'Major Outage';
  if (indicator === 'major') return 'Partial Service Outage';
  if (indicator === 'minor') return 'Degraded Performance';
  return 'All Systems Operational';
}

// Component rows reuse the Statuspage component vocabulary.
function indicatorToComponentStatus(indicator) {
  if (indicator === 'critical') return 'major_outage';
  if (indicator === 'major') return 'partial_outage';
  return 'degraded_performance';
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

// A shared status page's aggregate indicator cannot describe a single product.
// Scope both its health and supporting details to the declared components.
function scopeStatuspagePayload(payload, componentIds) {
  const components = (Array.isArray(payload.components) ? payload.components : [])
    .filter((component) => componentIds.includes(component?.id));
  const returnedIds = new Set(components.map((component) => component.id));
  if (componentIds.some((id) => !returnedIds.has(id))) throw new Error('Missing status components');
  const affectsScope = (item) => Array.isArray(item?.components)
    && item.components.some((component) => componentIds.includes(component?.id));
  const incidents = activeItems(payload.incidents, INACTIVE_INCIDENT).filter(affectsScope);
  const maintenances = activeItems(payload.scheduled_maintenances, INACTIVE_MAINTENANCE).filter(affectsScope);
  let indicator = 'none';
  for (const component of components) {
    const status = normalizeStatus(component.status);
    const severity = COMPONENT_NON_ISSUE.has(status) ? 'none'
      : status === 'major_outage' ? 'critical'
      : status === 'partial_outage' ? 'major' : 'minor';
    indicator = worstIndicator(indicator, severity);
  }
  for (const incident of incidents) {
    const impact = normalizeStatus(incident.impact);
    indicator = worstIndicator(indicator, INDICATOR_RANK.has(impact) ? impact : 'minor');
  }
  return {
    ...payload,
    status: { indicator, description: canonicalDescription(indicator) },
    components,
    incidents,
    scheduled_maintenances: maintenances
  };
}

function summarizeStatuspageProvider(provider, payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  if (!options.error && payload && provider.componentIds) {
    try {
      payload = scopeStatuspagePayload(payload, provider.componentIds);
    } catch (error) {
      return summarizeStatuspageProvider(provider, null, { checkedAt, error });
    }
  }
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
  if (!/<feed[\s>]/.test(text) || !/<\/feed\s*>\s*$/.test(text)) throw new Error('Unexpected feed content');
  const blocks = text.match(/<entry[\s>][\s\S]*?<\/entry>/g) || [];
  // The official page keeps its full event history in the feed, so an
  // entry-less feed means the response was empty/truncated or the format
  // drifted — never read that as "no incidents".
  if (!blocks.length) throw new Error('No feed entries');
  if ((text.match(/<entry[\s>]/g) || []).length !== blocks.length) throw new Error('Incomplete feed entry');
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

// Instatus v3 exposes granular page statuses alongside ranked active incidents.
// Healthy pages omit the incident arrays entirely, so a missing array is empty
// rather than malformed.
const INSTATUS_IMPACT_TO_INDICATOR = new Map([
  ['majoroutage', 'critical'],
  ['partialoutage', 'major'],
  ['degradedperformance', 'minor']
]);

const INSTATUS_PAGE_TO_INDICATOR = new Map([
  ['up', 'none'], ['hasissues', 'minor'], ['undermaintenance', 'none'],
  ...['all', 'some', 'one'].flatMap((prefix) => [
    [`${prefix}undermaintenance`, 'none'],
    [`${prefix}degradedperformance`, 'minor'],
    [`${prefix}partialoutage`, 'major'],
    [`${prefix}minoroutage`, 'minor'],
    [`${prefix}majoroutage`, 'critical']
  ])
]);

function summarizeInstatusProvider(provider, payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Unexpected payload');
    const pageStatus = normalizeStatus(payload.page?.status);
    if (!INSTATUS_PAGE_TO_INDICATOR.has(pageStatus)) throw new Error('Unexpected page status');
    for (const key of ['activeIncidents', 'activeMaintenances']) {
      if (payload[key] !== undefined && !Array.isArray(payload[key])) throw new Error(`Unexpected ${key}`);
    }
    const incidents = (payload.activeIncidents || []).map((incident) => ({
      // An unreadable impact still means the page reports a problem.
      indicator: INSTATUS_IMPACT_TO_INDICATOR.get(normalizeStatus(incident?.impact)) || 'minor',
      title: String(incident?.name || '').trim(),
      updatedAt: String(incident?.updatedAt || '').trim()
    }));
    // HASISSUES with no incident detail still means something is wrong —
    // degrade rather than report a false green.
    // Planned maintenance stays in maintenanceCount; concurrent incidents can
    // still raise the provider's severity.
    let worst = INSTATUS_PAGE_TO_INDICATOR.get(pageStatus);
    for (const incident of incidents) worst = worstIndicator(worst, incident.indicator);
    const headline = incidents.find((incident) => incident.indicator === worst && incident.title);
    return {
      id: provider.id,
      label: provider.label,
      pageUrl: provider.pageUrl,
      status: providerTone(worst),
      indicator: worst,
      description: canonicalDescription(worst),
      checkedAt,
      updatedAt: headline?.updatedAt || '',
      componentIssues: [],
      incidentTitle: headline?.title || '',
      incidentCount: incidents.length,
      maintenanceCount: (payload.activeMaintenances || []).length
    };
  } catch (error) {
    return summarizeStatuspageProvider(provider, null, { checkedAt, error });
  }
}

// status.opencode.ai/api/status is OpenCode's official feed with a custom JSON
// schema: a top-level status plus live per-service components. Unknown
// non-operational statuses degrade to minor — report "something is wrong"
// rather than a false green.
const OPENCODE_STATUS_TO_INDICATOR = new Map([
  ['operational', 'none'],
  ['degraded', 'minor'],
  ['degraded_performance', 'minor'],
  ['maintenance', 'minor'],
  ['under_maintenance', 'minor'],
  ['partial_outage', 'major'],
  ['major_outage', 'critical'],
  ['full_outage', 'critical'],
  ['outage', 'critical']
]);

function openCodeStatusToIndicator(status) {
  return OPENCODE_STATUS_TO_INDICATOR.get(normalizeStatus(status)) || 'minor';
}

function summarizeOpenCodeProvider(provider, payload, options = {}) {
  const checkedAt = options.checkedAt || new Date().toISOString();
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Unexpected payload');
    if (typeof payload.status !== 'string' || !payload.status.trim()) throw new Error('Missing status');
    if (payload.components !== undefined && !Array.isArray(payload.components)) throw new Error('Unexpected components');
    let worst = openCodeStatusToIndicator(payload.status);
    const componentIssues = [];
    // A malformed component entry must not be skipped: swallowing it would let
    // an otherwise-broken payload read green.
    for (const component of payload.components || []) {
      if (!component || typeof component !== 'object'
        || typeof component.service !== 'string' || !component.service.trim()
        || typeof component.status !== 'string') throw new Error('Unexpected component entry');
      const indicator = openCodeStatusToIndicator(component.status);
      worst = worstIndicator(worst, indicator);
      if (indicator !== 'none') {
        componentIssues.push({ name: component.service.trim(), status: indicatorToComponentStatus(indicator) });
      }
    }
    // The feed carries the reading's millisecond epoch instead of an ISO
    // page timestamp.
    const updatedAt = Number.isFinite(payload.updatedAt) && payload.updatedAt > 0
      ? new Date(payload.updatedAt).toISOString()
      : '';
    return {
      id: provider.id,
      label: provider.label,
      pageUrl: provider.pageUrl,
      status: providerTone(worst),
      indicator: worst,
      // The affected service names are the closest thing this format has to an
      // incident headline.
      description: worst === 'none'
        ? canonicalDescription(worst)
        : (componentIssues.map((issue) => issue.name).join('; ') || canonicalDescription(worst)),
      checkedAt,
      updatedAt,
      componentIssues,
      incidentTitle: '',
      incidentCount: 0,
      maintenanceCount: 0
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
        if (provider.summaryFormat === 'instatus') {
          return summarizeInstatusProvider(provider, body, { checkedAt });
        }
        if (provider.summaryFormat === 'opencode-json') {
          return summarizeOpenCodeProvider(provider, body, { checkedAt });
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
  summarizeInstatusProvider,
  summarizeOpenCodeProvider,
  summarizeStatuspageProvider
};
