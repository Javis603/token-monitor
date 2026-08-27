'use strict';

const os = require('node:os');
const path = require('node:path');
const { runWithProbeDeadline } = require('./probeDeadline');
const { BROWSER_USER_AGENT } = require('./browserUserAgent');
const { traeAccountKey } = require('./traeAccount');

// Trae CN (Trae Work / TRAE SOLO CN) usage collection over the account's cloud
// session-usage API — the same `Cloud-IDE-JWT` credential the Trae CN credits
// limits provider uses, so one saved account powers both panels.
//
// Why an API and not the local database: the agent database under
// ModularData/ai-agent is SQLCipher-encrypted with a key that only exists in
// process memory, so reading it means extracting memory as an administrator
// (rejected upstream in #218). The account API
// `POST /trae/api/v1/pay/query_user_usage_group_by_session` answers the same
// question server-side with per-session token totals.
//
// API shape (verified against api.trae.cn):
//   POST { start_time, end_time, page_size<=50, page_num, usage_type: [1..8] }
//   -> { total, user_usage_group_by_sessions: [{
//        session_id, usage_time (epoch sec), model_name,
//        extra_info: { input_token, output_token, cache_read_token, cache_write_token },
//        credits_float, cost_money_float, usage_source, product_type_list, ...
//      }] }
// `user_input_preview` carries the user's prompt text and is deliberately
// never read here — nothing from this module may persist prompt content.
//
// One row per session entry. `usage_time` is the session's last activity, so a
// session that spans midnight books all of its tokens on the later local day;
// the totals stay exact, only the day bucket is an approximation.

const TRAE_CN_API_ORIGIN = 'https://api.trae.cn';
const TRAE_CN_USAGE_PATH = '/trae/api/v1/pay/query_user_usage_group_by_session';
const TRAE_CN_FETCH_TIMEOUT_MS = 12_000;
// The server rejects page_size > 50 with a parameter error.
const TRAE_CN_PAGE_SIZE = 50;
// Safety valve for accounts with very long histories: 120 pages * 50 = 6,000
// sessions before the collector stops paginating and keeps what it has.
const TRAE_CN_MAX_PAGES = 120;
// Every usage type the account can report. The international Tokscale client
// filters to [5, 6]; the CN backend answers 404/empty for that pair and only
// fills the aggregated view when the full set is requested.
const TRAE_CN_USAGE_TYPES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8]);
const TRAE_CN_LOOKBACK_DAYS = 365;
// Watch-triggered ticks from other clients must not hammer the Trae endpoint.
// A cached snapshot serves them; the next interval tick refreshes it.
const TRAE_CN_CACHE_TTL_MS = 5 * 60 * 1000;

const TRAE_CN_CLIENT_ID = 'trae-cn';

const TRAE_CN_ERROR_CODES = Object.freeze({
  MISSING_TOKEN: 'TRAE_CN_MISSING_TOKEN',
  UNAUTHORIZED: 'TRAE_CN_UNAUTHORIZED',
  BAD_RESPONSE: 'TRAE_CN_BAD_RESPONSE'
});

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return /[\r\n]/.test(raw) ? '' : raw;
}

// Accepts the raw settings value or a copied request header; strips the
// scheme the way traeLimits does so one paste works everywhere.
function traeCnAccessToken(options = {}, env = process.env) {
  const explicit = cleanSecret(options.traeAccessToken)
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^cloud-ide-jwt\s+/i, '')
    .trim();
  if (explicit) return explicit;
  for (const name of ['TOKEN_MONITOR_TRAE_ACCESS_TOKEN', 'TRAE_ACCESS_TOKEN']) {
    const raw = cleanSecret(env[name])
      .replace(/^authorization\s*:\s*/i, '')
      .replace(/^cloud-ide-jwt\s+/i, '')
      .trim();
    if (raw) return raw;
  }
  return '';
}

function traeCnUsageUrl(origin = TRAE_CN_API_ORIGIN) {
  return `${origin}${TRAE_CN_USAGE_PATH}`;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.trunc(number) : null;
}

function timestampMs(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value > 0 && value < 1e12 ? value * 1000 : value;
  if (typeof value !== 'string' || !value.trim()) return 0;
  const number = Number(value);
  if (Number.isFinite(number)) return number > 0 && number < 1e12 ? number * 1000 : number;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function traeCnError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeTraeCnSession(session, options = {}) {
  if (!session || typeof session !== 'object') return null;
  const usage = session.extra_info && typeof session.extra_info === 'object'
    ? session.extra_info
    : {};
  const input = numeric(usage.input_token);
  const output = numeric(usage.output_token);
  if (input === null || output === null || input + output === 0) return null;
  const cacheRead = numeric(usage.cache_read_token) ?? 0;
  const cacheWrite = numeric(usage.cache_write_token) ?? 0;
  const sessionId = String(session.session_id || '').trim() || 'unknown';
  const createdAt = timestampMs(session.usage_time);
  const model = String(session.model_name || '').trim() || 'trae-agent';
  const accountKey = String(options.accountKey || '').trim();
  const accountLabel = String(options.accountLabel || '').trim().slice(0, 128);
  const accountPrefix = accountKey ? `${accountKey}:` : '';
  return {
    sessionId: `trae-cn:api:${accountPrefix}${sessionId}`,
    messageId: `trae-cn:api:${accountPrefix}${sessionId}:${createdAt}:${model}`,
    ...(accountKey ? { accountKey, accountLabel } : {}),
    model,
    projectLabel: '',
    input,
    output,
    cacheRead,
    cacheWrite,
    createdAt,
    messages: 1
  };
}

async function fetchTraeCnPage(context, pageNum, signal) {
  const response = await context.fetch(traeCnUsageUrl(context.origin), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      authorization: `Cloud-IDE-JWT ${context.accessToken}`,
      'User-Agent': BROWSER_USER_AGENT
    },
    body: JSON.stringify({
      start_time: context.startTimeSec,
      end_time: context.endTimeSec,
      page_size: TRAE_CN_PAGE_SIZE,
      page_num: pageNum,
      usage_type: [...TRAE_CN_USAGE_TYPES]
    }),
    signal
  });
  if (response.status === 401 || response.status === 403) {
    throw traeCnError(TRAE_CN_ERROR_CODES.UNAUTHORIZED, `trae-cn usage API returned ${response.status} (token rejected)`);
  }
  if (!response.ok) {
    throw traeCnError(TRAE_CN_ERROR_CODES.BAD_RESPONSE, `trae-cn usage API returned ${response.status}`);
  }
  let body;
  try {
    body = await response.json();
  } catch (_) {
    throw traeCnError(TRAE_CN_ERROR_CODES.BAD_RESPONSE, 'trae-cn usage API returned a non-JSON body');
  }
  const sessions = body?.user_usage_group_by_sessions;
  if (!Array.isArray(sessions)) {
    throw traeCnError(TRAE_CN_ERROR_CODES.BAD_RESPONSE, 'trae-cn usage response has no user_usage_group_by_sessions array');
  }
  return { sessions, total: numeric(body?.total) };
}

const traeCnSnapshotCache = new Map();

function resetTraeCnSnapshotCache() {
  traeCnSnapshotCache.clear();
}

async function fetchTraeCnSnapshot(options = {}) {
  const accessToken = typeof options.accessToken === 'string'
    ? options.accessToken
    : traeCnAccessToken(options, options.env || process.env);
  if (!accessToken) {
    throw traeCnError(TRAE_CN_ERROR_CODES.MISSING_TOKEN, 'trae-cn usage needs an access token (Settings → Trae CN Account)');
  }
  const accountKey = String(options.accountKey || '').trim() || traeAccountKey(accessToken);
  const accountLabel = String(options.accountLabel || '').trim().slice(0, 128);
  const nowMs = options.nowMs ?? Date.now();
  const startTimeSec = Math.floor(
    options.startMs !== undefined
      ? Math.max(0, options.startMs) / 1000
      : (nowMs - TRAE_CN_LOOKBACK_DAYS * 86400 * 1000) / 1000
  );
  const endTimeSec = Math.floor(nowMs / 1000);
  const context = {
    accessToken,
    origin: options.origin || TRAE_CN_API_ORIGIN,
    startTimeSec,
    endTimeSec,
    fetch: options.fetch || fetch
  };
  const rows = [];
  const seen = new Set();
  let total = null;
  let pageNum = 1;
  while (pageNum <= TRAE_CN_MAX_PAGES) {
    const { sessions, total: pageTotal } = await runWithProbeDeadline(
      ({ signal }) => fetchTraeCnPage(context, pageNum, signal),
      { signal: options.signal, deadlineMs: options.fetchTimeoutMs ?? TRAE_CN_FETCH_TIMEOUT_MS }
    );
    if (total === null) total = pageTotal;
    for (const session of sessions) {
      const row = normalizeTraeCnSession(session, { accountKey, accountLabel });
      if (!row || seen.has(row.messageId)) continue;
      seen.add(row.messageId);
      rows.push(row);
    }
    const knownTotal = total ?? 0;
    if (!sessions.length || (knownTotal > 0 && rows.length >= knownTotal) || sessions.length < TRAE_CN_PAGE_SIZE) break;
    pageNum += 1;
  }
  rows.sort((a, b) => a.createdAt - b.createdAt);
  return { rows, at: nowMs, accountKey, accountLabel };
}

async function collectTraeCnRows(options = {}) {
  const accessToken = typeof options.accessToken === 'string'
    ? options.accessToken
    : traeCnAccessToken(options, options.env || process.env);
  const nowMs = options.nowMs ?? Date.now();
  const cacheTtlMs = options.cacheTtlMs ?? TRAE_CN_CACHE_TTL_MS;
  const forceRefresh = options.forceRefresh === true;
  // Cache by stable account identity instead of retaining a credential fragment
  // in memory. Switching accounts gets a separate snapshot; token refreshes for
  // the same account reuse the normal short-lived cache.
  const cacheKey = String(options.accountKey || '').trim() || traeAccountKey(accessToken);
  const startMs = options.startMs !== undefined
    ? options.startMs
    : (() => {
      const since = String(options.allTimeSince || '').trim();
      const parsed = since ? Date.parse(`${since}T00:00:00.000Z`) : NaN;
      return Number.isFinite(parsed) ? parsed : nowMs - TRAE_CN_LOOKBACK_DAYS * 86400 * 1000;
    })();

  let snapshot = null;
  if (cacheKey) {
    const cached = traeCnSnapshotCache.get(cacheKey);
    if (cached && !forceRefresh && nowMs - cached.at < cacheTtlMs) snapshot = cached;
  }
  if (!snapshot) {
    snapshot = await fetchTraeCnSnapshot({ ...options, accessToken, startMs, nowMs });
    if (cacheKey) {
      traeCnSnapshotCache.set(cacheKey, snapshot);
      // One entry per account is all the cache needs to hold.
      if (traeCnSnapshotCache.size > 4) {
        const oldest = [...traeCnSnapshotCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
        if (oldest) traeCnSnapshotCache.delete(oldest[0]);
      }
    }
  }

  const sinceMs = options.sinceMs;
  if (sinceMs === undefined) return snapshot.rows;
  // Anchored (watch/interval today-only) ticks only need rows that can still
  // affect today's partition; the full snapshot stays cached for the next tick.
  return snapshot.rows.filter((row) => row.createdAt >= sinceMs);
}

// ---------------------------------------------------------------------------
// Pricing — same catalog lookup qodercn uses, minus the routing-tier guard
// (Trae session rows always name a concrete model).

const TRAE_CN_PRICING_CACHE_TTL_MS = 6 * 60 * 60 * 1000;
const TRAE_CN_PRICING_LOOKUP_TIMEOUT_MS = 3000;
const traeCnPricingCache = new Map();

function estimatedTraeCnRowCost(row, pricingByModel) {
  const modelId = String(row?.model || '').trim().toLowerCase();
  const pricing = pricingByModel?.[modelId];
  if (!pricing || typeof pricing !== 'object') return null;
  const components = [
    [row.input, pricing.inputCostPerToken],
    [row.output, pricing.outputCostPerToken],
    [row.cacheRead, pricing.cacheReadInputTokenCost],
    [row.cacheWrite, pricing.cacheCreationInputTokenCost]
  ];
  let cost = 0;
  for (const [tokens, unitCost] of components) {
    if (!tokens) continue;
    if (!Number.isFinite(Number(unitCost)) || Number(unitCost) < 0) return null;
    cost += tokens * Number(unitCost);
  }
  return cost;
}

function normalizeTraeCnPricing(result) {
  const source = result?.pricing;
  if (!source || typeof source !== 'object') return null;
  const pick = (key) => {
    const value = Number(source[key]);
    return Number.isFinite(value) && value >= 0 ? value : undefined;
  };
  const pricing = {
    inputCostPerToken: pick('inputCostPerToken'),
    outputCostPerToken: pick('outputCostPerToken'),
    cacheReadInputTokenCost: pick('cacheReadInputTokenCost'),
    cacheCreationInputTokenCost: pick('cacheCreationInputTokenCost')
  };
  return pricing.inputCostPerToken !== undefined || pricing.outputCostPerToken !== undefined ? pricing : null;
}

async function resolveTraeCnPricing(rows, options = {}) {
  const lookup = options.lookupModelPricing;
  const revision = options.pricingRevision ?? 0;
  const nowMs = options.nowMs ?? Date.now();
  const commandTimeoutMs = options.commandTimeoutMs || TRAE_CN_PRICING_LOOKUP_TIMEOUT_MS;
  const pricingByModel = {};
  const modelIds = [...new Set((Array.isArray(rows) ? rows : [])
    .map((row) => String(row?.model || '').trim().toLowerCase())
    .filter(Boolean))];
  for (const modelId of modelIds) {
    const cached = traeCnPricingCache.get(modelId);
    if (cached && cached.revision === revision && nowMs - cached.at < TRAE_CN_PRICING_CACHE_TTL_MS) {
      if (cached.pricing) pricingByModel[modelId] = cached.pricing;
      continue;
    }
    let pricing = null;
    if (typeof lookup === 'function') {
      try {
        pricing = normalizeTraeCnPricing(await lookup(modelId, commandTimeoutMs));
      } catch (_) {
        // An unknown model or an offline lookup stays cost-unavailable rather
        // than inheriting an unrelated catalog price.
      }
    }
    traeCnPricingCache.set(modelId, { at: nowMs, revision, pricing });
    if (pricing) pricingByModel[modelId] = pricing;
  }
  return pricingByModel;
}

function resetTraeCnPricingCache() {
  traeCnPricingCache.clear();
}

// ---------------------------------------------------------------------------
// Periods + history graph — the same row shape and tokscale-JSON projection
// qodercn produces, so mergePeriods/collectHistoryOnce treat both alike.

function buildTraeCnTokscaleJson(startMs, rows, pricingByModel, includeUndated = false) {
  const grouped = new Map();
  for (const row of rows) {
    if (startMs && (row.createdAt ? row.createdAt < startMs : !includeUndated)) continue;
    const key = `${row.sessionId}\0${row.model}`;
    if (!grouped.has(key)) grouped.set(key, { ...row, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, messages: 0, startedAt: 0, lastUsedAt: 0, cost: 0 });
    const group = grouped.get(key);
    group.input += row.input;
    group.output += row.output;
    group.cacheRead += row.cacheRead;
    group.cacheWrite += row.cacheWrite;
    group.messages += row.messages;
    const cost = estimatedTraeCnRowCost(row, pricingByModel);
    group.cost += cost === null ? 0 : cost;
    if (row.createdAt && (!group.startedAt || row.createdAt < group.startedAt)) group.startedAt = row.createdAt;
    if (row.createdAt > group.lastUsedAt) group.lastUsedAt = row.createdAt;
  }

  const entries = [...grouped.values()].map((row) => ({
    client: TRAE_CN_CLIENT_ID, mergedClients: null, sessionId: row.sessionId, model: row.model, provider: TRAE_CN_CLIENT_ID,
    accountKey: row.accountKey || '', accountLabel: row.accountLabel || '',
    input: row.input, output: row.output, cacheRead: row.cacheRead, cacheWrite: row.cacheWrite,
    reasoning: 0, messageCount: row.messages, cost: row.cost,
    startedAt: row.startedAt ? new Date(row.startedAt).toISOString() : '',
    lastUsedAt: row.lastUsedAt ? new Date(row.lastUsedAt).toISOString() : '',
    projectLabel: row.projectLabel || '', performance: null
  }));
  const sum = (key) => entries.reduce((total, row) => total + row[key], 0);
  return {
    groupBy: 'client,session,model', entries,
    totalInput: sum('input'), totalOutput: sum('output'), totalCacheRead: sum('cacheRead'),
    totalCacheWrite: sum('cacheWrite'), totalMessages: sum('messageCount'), totalCost: sum('cost'), processingTimeMs: 0
  };
}

function buildTraeCnPeriods(options = {}) {
  const now = options.now ? new Date(options.now) : new Date();
  const rows = Array.isArray(options.rows) ? options.rows : [];
  const pricingByModel = options.pricingByModel;
  const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const monthStart = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  return {
    today: buildTraeCnTokscaleJson(todayStart, rows, pricingByModel),
    month: buildTraeCnTokscaleJson(monthStart, rows, pricingByModel),
    allTime: buildTraeCnTokscaleJson(timestampMs(options.allTimeSince), rows, pricingByModel, true)
  };
}

function localDateKey(value) {
  if (!value) return '';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function buildTraeCnHistoryGraph(options = {}) {
  const days = new Map();
  for (const row of options.rows || []) {
    const date = localDateKey(row.createdAt);
    if (!date) continue;
    if (!days.has(date)) days.set(date, { date, clients: [] });
    const day = days.get(date);
    let model = day.clients.find((entry) => entry.modelId === row.model);
    if (!model) {
      model = { client: TRAE_CN_CLIENT_ID, modelId: row.model, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0 }, cost: 0, messages: 0 };
      day.clients.push(model);
    }
    const cost = estimatedTraeCnRowCost(row, options.pricingByModel);
    model.tokens.input += row.input;
    model.tokens.output += row.output;
    model.tokens.cacheRead += row.cacheRead;
    model.tokens.cacheWrite += row.cacheWrite;
    model.cost += cost === null ? 0 : cost;
    model.messages += row.messages;
  }
  return { contributions: [...days.values()].sort((a, b) => a.date.localeCompare(b.date)) };
}

// Where a Trae CN / TRAE SOLO CN install keeps its account state on this
// machine — the health panel's "is the source installed" evidence, and the
// watch roots that keep the collector from polling the API for a tool that
// is not even installed.
function traeCnDataPaths(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  let appSupport;
  if (platform === 'darwin') appSupport = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appSupport = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming');
  else {
    const xdg = env.XDG_CONFIG_HOME;
    appSupport = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
  }
  return {
    storagePaths: [
      path.join(appSupport, 'TRAE SOLO CN'),
      path.join(appSupport, 'Trae CN')
    ]
  };
}

module.exports = {
  TRAE_CN_CLIENT_ID,
  TRAE_CN_ERROR_CODES,
  buildTraeCnHistoryGraph,
  buildTraeCnPeriods,
  collectTraeCnRows,
  fetchTraeCnSnapshot,
  normalizeTraeCnSession,
  resolveTraeCnPricing,
  resetTraeCnPricingCache,
  resetTraeCnSnapshotCache,
  traeCnAccessToken,
  traeCnDataPaths,
  traeCnUsageUrl
};
