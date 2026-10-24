'use strict';

// MiniMax (a.k.a. Minimax / Hailuo AI) Token Plan quota or API balance lookup.
//
// Field shape verified against live Token Plan responses (see PR #32 review):
// the array is nested under data.model_remains, and the live response does
// not always carry current_interval_status / current_weekly_status. We
// therefore read whatever percent is present, and only suppress the
// status==3 placeholder lane that cc-switch / CodexBar both guard against.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret } = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { mcodeDataDirs } = require('../mcode/paths');

const MINIMAX_KEY_NAMES = ['MINIMAX_CODING_API_KEY'];

const MINIMAX_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains';
const MINIMAX_REMAINS_URL_EN = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/token_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_EN = 'https://api.minimax.io/v1/token_plan/remains';
const MINIMAX_BALANCE_URL_CN = 'https://api.minimaxi.com/account/query_balance';
const MINIMAX_BALANCE_URL_EN = 'https://api.minimax.io/account/query_balance';

// MiniMax Code OAuth lane (billingMode 'code'). Hosts verified live on
// 2026-10-24 against the CN account; the intl membership host follows the
// account/platform naming but is not live-verified (see docs/providers/minimax.md).
const MINIMAX_CODE_OAUTH_URL_CN = 'https://account.minimaxi.com/oauth2/token';
const MINIMAX_CODE_OAUTH_URL_INTL = 'https://account.minimax.io/oauth2/token';
const MINIMAX_CODE_MEMBERSHIP_URL_CN = 'https://agent.minimaxi.com/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_MEMBERSHIP_URL_INTL = 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_PLAN_REMAINS_URL_CN = 'https://www.minimaxi.com/v1/api/openplatform/coding_plan/remains';
const MINIMAX_CODE_PLAN_REMAINS_URL_INTL = 'https://platform.minimax.io/v1/api/openplatform/coding_plan/remains';

// Refresh well before expiry; MiniMax Code's own client uses 5 minutes, but a
// widget tick cadence is slower, so ask earlier. Set when a rotation succeeded
// but its write-back failed, so the next tick re-reads and re-refreshes rather
// than trusting a lease that may only exist in memory.
const MINIMAX_CODE_REFRESH_LEEWAY_MS = 10 * 60 * 1000;
const MINIMAX_CODE_FORCE_REFRESH_STATE_KEY = 'minimax.code.force-refresh';

const MINIMAX_WINDOW_MINUTES_5H = 5 * 60;
const MINIMAX_WINDOW_MINUTES_WEEKLY = 7 * 24 * 60;

const MINIMAX_REGIONS = ['en', 'cn'];

// Region of the last successful probe, kept in the runtime's persistent
// provider state (the same channel the Claude identity cache uses). The
// default order probes the global (en) endpoints first, which only suits
// global keys: a CN key pays two doomed requests per probe, and while those
// endpoints are unreachable from CN networks the whole probe used to fail
// before the CN endpoint was ever asked. Remembering the winner puts the
// key's own region first from the second probe on, so the flaky leg drops
// out of the steady state entirely.
const MINIMAX_REGION_MEMORY_STATE_KEY = 'minimax.last-good-region';

function rememberedMinimaxRegion(deps = {}) {
  if (!(deps.providerRuntimeState instanceof Map)) return '';
  const remembered = deps.providerRuntimeState.get(MINIMAX_REGION_MEMORY_STATE_KEY);
  return MINIMAX_REGIONS.includes(remembered) ? remembered : '';
}

function storeMinimaxRegionMemory(deps = {}, region) {
  if (!(deps.providerRuntimeState instanceof Map)) return;
  deps.providerRuntimeState.set(MINIMAX_REGION_MEMORY_STATE_KEY, region);
}

// A failure on the way to the host: connect timeout, DNS, TLS, reset, and the
// per-request abort. What marks those apart is an error that carries no
// HTTP-layer answer at all — the fetcher's rejection shapes always carry either
// a status or a statusCode — which says nothing about the key, and makes
// re-asking the same host's other endpoint pointless since it shares the
// network path that just failed.
//
// A response that arrived but did not parse is deliberately NOT one of those:
// it reached a server (an interception page, a reverse proxy, an HTML error
// page), so the request count and the region order stay worth honouring. Node
// reports that as a SyntaxError; Chromium's net.fetch rejects with a message
// rather than a cause code, which is why the rule reads "no HTTP answer"
// instead of a transport whitelist. A body cut off mid-stream still has no
// answer to point at and stays a transport failure, as it should: the region
// jump is what rescues that case.
function isMinimaxTransportError(error) {
  if (!error) return false;
  if (typeof error.statusCode === 'number' && Number.isFinite(error.statusCode)) return false;
  if (error.status) return false;
  return error.name !== 'SyntaxError';
}

function isMinimaxAuthError(error) {
  const code = Number(error && error.statusCode);
  return code === 401 || code === 403 || (error && error.status) === 'unauthorized';
}

function minimaxToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of MINIMAX_KEY_NAMES) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

// Parse a value that arrives as either a JS number or a numeric string into
// a number, or null if it's missing / not numeric. Used for status codes,
// percent fields (the live response sends them as strings), and timestamps —
// same shape, the unit is up to the caller.
function parseNumberOrNull(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return null;
}

function millisToIso8601(value) {
  const ms = parseNumberOrNull(value);
  if (ms === null) return null;
  // Treat <1e12 as seconds (matches cc-switch's `millis_to_iso8601`).
  const normalized = ms < 1_000_000_000_000 ? ms * 1000 : ms;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// The live endpoint nests model_remains under data, but a handful of proxies
// (and our test fixtures) flatten it. Read the nested shape first, fall back
// to the top level so both representations work.
function readMinimaxRows(body) {
  if (!body || typeof body !== 'object') return null;
  if (body.data && typeof body.data === 'object' && Array.isArray(body.data.model_remains)) {
    return body.data.model_remains;
  }
  if (Array.isArray(body.model_remains)) {
    return body.model_remains;
  }
  return null;
}

// Pull the `general` bucket out of `model_remains`. cc-switch treats
// model_name === 'general' as the coding-plan row; video / voice / other
// models live in the same array and must be ignored.
function selectMinimaxGeneralBucket(body) {
  const rows = readMinimaxRows(body);
  if (!rows) return null;
  return rows.find((row) => row && row.model_name === 'general') || null;
}

// A status==3 lane is the server's "no entitlement here" placeholder; it
// shows up as 100% / null percent depending on the plan. Suppress it so the
// widget doesn't render an empty meter. Matches the CodexBar placeholder
// guard the reviewer cross-checked against.
function isPlaceholderMinimaxLane(item, percentField, statusField) {
  if (!item) return true;
  if (parseNumberOrNull(item[statusField]) !== 3) return false;
  const pct = parseNumberOrNull(item[percentField]);
  return pct === null || pct >= 100;
}

// 5h window: `current_interval_remaining_percent` is "remaining" (0-100).
// Emit whenever a usable percent is present; suppress only the placeholder
// lane above. percents arrive as strings in the live response.
function buildMinimaxSessionWindow(item) {
  if (!item) return null;
  if (isPlaceholderMinimaxLane(item, 'current_interval_remaining_percent', 'current_interval_status')) return null;
  const remainPct = parseNumberOrNull(item.current_interval_remaining_percent);
  if (remainPct === null) return null;
  const used = Math.max(0, Math.min(100, 100 - remainPct));
  return {
    kind: 'session',
    label: '5h',
    usedPercent: used,
    remainingPercent: Math.max(0, Math.min(100, remainPct)),
    resetsAt: millisToIso8601(item.end_time),
    windowMinutes: MINIMAX_WINDOW_MINUTES_5H,
    showMeter: true
  };
}

// Weekly window: same shape as session, gated on the weekly fields.
function buildMinimaxWeeklyWindow(item) {
  if (!item) return null;
  if (isPlaceholderMinimaxLane(item, 'current_weekly_remaining_percent', 'current_weekly_status')) return null;
  const remainPct = parseNumberOrNull(item.current_weekly_remaining_percent);
  if (remainPct === null) return null;
  const used = Math.max(0, Math.min(100, 100 - remainPct));
  return {
    kind: 'weekly',
    label: 'Weekly',
    usedPercent: used,
    remainingPercent: Math.max(0, Math.min(100, remainPct)),
    resetsAt: millisToIso8601(item.weekly_end_time),
    windowMinutes: MINIMAX_WINDOW_MINUTES_WEEKLY,
    showMeter: true
  };
}

// Body must already be the parsed JSON. Returns the windows array, never
// throws. Returns [] when the response lacks the expected shape so the
// collector can still surface the provider row with status 'unavailable'.
function parseMinimaxTiers(body) {
  const item = selectMinimaxGeneralBucket(body);
  if (!item) return [];
  const windows = [];
  const session = buildMinimaxSessionWindow(item);
  if (session) windows.push(session);
  const weekly = buildMinimaxWeeklyWindow(item);
  if (weekly) windows.push(weekly);
  return windows;
}

// 'auto' probes the last successful region first, initially international,
// and tries the other region on auth rejection or transport failure. 'cn' /
// 'intl' pin the probe to one host regardless of that memory. The token-plan
// -> legacy fallback still applies inside a pinned region on endpoint or
// response migration signals; an unreachable host stops that region's probe.
//
// `env` defaults to {} rather than process.env on purpose: the registry calls
// this as the write-time normalizer with an empty env, and a stored setting must
// never be derived from the machine running the widget. The env lane is
// consulted by the probe itself, where deps.env carries the real environment.
//
// minimaxApiHost is the pre-setting option name. It stays honoured so existing
// callers and the host spellings it accepted keep working.
function minimaxRegion(options = {}, env = {}) {
  const raw = String(
    options.minimaxApiRegion
    || options.minimaxApiHost
    || env.TOKEN_MONITOR_MINIMAX_API_REGION
    || env.MINIMAX_API_REGION
    || env.MINIMAX_API_HOST
    || ''
  ).trim().toLowerCase();
  if (['cn', 'minimaxi.com', 'api.minimaxi.com'].includes(raw)) return 'cn';
  if (['intl', 'en', 'global', 'international', 'minimax.io', 'api.minimax.io'].includes(raw)) return 'intl';
  return 'auto';
}

// Empty means no user selection, so the runtime can still consult env.
function normalizeMinimaxRegionSetting(value) {
  return String(value || '').trim() ? minimaxRegion({ minimaxApiRegion: value }) : '';
}

function normalizeMinimaxBillingMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  return raw === 'api' ? 'api' : raw === 'code' ? 'code' : 'token-plan';
}

// available_amount is the spendable balance, not cash_balance alone. Missing
// or malformed amounts must not turn into a healthy zero-balance account.
function parseMinimaxBalance(body, region) {
  const amount = parseNumberOrNull(body?.available_amount);
  return amount === null ? [] : [{
    kind: 'billing',
    metric: 'credits',
    label: 'Balance',
    remaining: amount,
    currency: region === 'cn' ? 'CNY' : 'USD'
  }];
}

function minimaxRegionOrder(options = {}, env = {}) {
  const region = minimaxRegion(options, env);
  if (region === 'cn') return ['cn'];
  if (region === 'intl') return ['en'];
  const remembered = MINIMAX_REGIONS.includes(options.minimaxRememberedRegion)
    ? options.minimaxRememberedRegion
    : '';
  // The remembered region goes first; the other one stays behind it as the
  // fallback, so a key swapped between regions still resolves on its first
  // probe after the swap.
  if (remembered) return [remembered, ...MINIMAX_REGIONS.filter((region) => region !== remembered)];
  return ['en', 'cn'];
}

function minimaxUrlsForRegion(region, billingMode) {
  if (normalizeMinimaxBillingMode(billingMode) === 'api') {
    return [{ url: region === 'cn' ? MINIMAX_BALANCE_URL_CN : MINIMAX_BALANCE_URL_EN, region, kind: 'balance' }];
  }
  return region === 'cn'
    ? [
      { url: MINIMAX_TOKEN_PLAN_REMAINS_URL_CN, region: 'cn', kind: 'tokenPlan' },
      { url: MINIMAX_REMAINS_URL_CN, region: 'cn', kind: 'legacy' }
    ]
    : [
      { url: MINIMAX_TOKEN_PLAN_REMAINS_URL_EN, region: 'en', kind: 'tokenPlan' },
      { url: MINIMAX_REMAINS_URL_EN, region: 'en', kind: 'legacy' }
    ];
}

function minimaxAttemptSpecs(options = {}, env = {}) {
  return minimaxRegionOrder(options, env).flatMap((region) => minimaxUrlsForRegion(region, options.minimaxBillingMode));
}

// Candidate URLs in region order, token-plan before legacy. A transport
// failure skips the remaining candidates on the same host.
function minimaxAttemptOrder(options = {}, env = {}) {
  return minimaxAttemptSpecs(options, env).map((attempt) => attempt.url);
}

function minimaxRegionForUrl(url) {
  if (url === MINIMAX_REMAINS_URL_EN || url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN || url === MINIMAX_BALANCE_URL_EN) return 'en';
  if (url === MINIMAX_REMAINS_URL_CN || url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN || url === MINIMAX_BALANCE_URL_CN) return 'cn';
  return '';
}

// Pick a single URL for callers that want a forced region without retry
// behavior (legacy `minimaxBaseUrl` shape). Default is the global endpoint.
function minimaxBaseUrl(options = {}, env = {}) {
  return minimaxRegion(options, env) === 'cn' ? MINIMAX_REMAINS_URL_CN : MINIMAX_REMAINS_URL_EN;
}

function shouldTryLegacyMinimaxEndpoint(error) {
  const code = Number(error && error.statusCode);
  if (code === 401 || code === 403 || code === 404 || code === 405) return true;
  if (Number.isFinite(code)) return false;
  if (error && error.status === 'sourceRateLimited') return false;
  if (error && error.status === 'unavailable') return true;
  return false;
}

function shouldTryNextMinimaxRegion(error) {
  const code = Number(error && error.statusCode);
  return code === 401 || code === 403;
}

// --- MiniMax Code OAuth lane -------------------------------------------------
//
// The desktop app stores its OAuth lease in `<mcode data dir>/auth/prod/<region
// dir>/<record dir>/auth.json` as a nested `records` map whose keys contain
// spaces. The refresh token is strictly single-use: every accepted refresh
// rotates it, so a rotation whose write-back is lost kills the lease. All
// protocol facts here were measured live on 2026-10-24; see
// docs/providers/minimax.md for the contract.

// The target record is the desktop app's own (`clientId` `mcode-public`, key
// `com.minimax.mcode.oauth.<env>.<region> <hash>`). Record directory names and
// the intl storage spelling are not verified, so everything is enumerated.
function isMinimaxCodeRecord(key, record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.refreshToken !== 'string' || !record.refreshToken) return false;
  if (typeof record.clientId === 'string' && record.clientId) return record.clientId === 'mcode-public';
  return String(key).startsWith('com.minimax.mcode.oauth');
}

function minimaxCodeAuthFiles(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const regionSetting = minimaxRegion(options, env);
  for (const base of mcodeDataDirs({ env, homeDir: deps.homeDir || os.homedir() })) {
    const prodDir = path.join(base, 'auth', 'prod');
    let regionDirs;
    try {
      regionDirs = readdirSync(prodDir, { withFileTypes: true }).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch (_) { continue; }
    // `cn` is the verified spelling; a pinned region filters, Auto prefers cn.
    regionDirs.sort((a, b) => Number(b === 'cn') - Number(a === 'cn'));
    for (const regionDir of regionDirs) {
      if (regionSetting === 'cn' && regionDir !== 'cn') continue;
      if (regionSetting === 'intl' && regionDir === 'cn') continue;
      let recordDirs;
      try {
        recordDirs = readdirSync(path.join(prodDir, regionDir), { withFileTypes: true }).filter((entry) => entry.isDirectory());
      } catch (_) { continue; }
      for (const recordDir of recordDirs) {
        const authPath = path.join(prodDir, regionDir, recordDir.name, 'auth.json');
        let auth;
        try { auth = JSON.parse(readFileSync(authPath, 'utf8')); } catch (_) { continue; }
        const records = auth && typeof auth === 'object' && auth.records && typeof auth.records === 'object' ? auth.records : null;
        if (!records) continue;
        const keys = Object.keys(records).filter((key) => isMinimaxCodeRecord(key, records[key]));
        if (!keys.length) continue;
        return {
          authPath,
          statePath: path.join(prodDir, regionDir, recordDir.name, 'auth-state.json'),
          regionDir,
          recordKey: keys[0],
          record: records[keys[0]]
        };
      }
    }
  }
  return null;
}

// Refresh only while the desktop app is quit: its in-memory lease goes stale
// the moment we rotate, so the file protocol (and the red line) is "read-only
// while it runs". Detection is best effort — pgrep/tasklist with a short
// timeout; a missing tool reads as "not running" and the sync write-back keeps
// the lost-lease window minimal either way.
function minimaxCodeClientRunning(deps = {}) {
  if (typeof deps.clientRunning === 'function') return Boolean(deps.clientRunning());
  const platform = deps.platform || process.platform;
  try {
    if (platform === 'win32') {
      const out = execFileSync('tasklist', ['/FI', 'IMAGENAME eq MiniMax Code.exe', '/FO', 'CSV', 'NH'],
        { timeout: 2000, stdio: ['ignore', 'pipe', 'ignore'] }).toString();
      return out.includes('MiniMax Code');
    }
    execFileSync('pgrep', ['-f', 'MiniMax Code'], { timeout: 2000, stdio: ['ignore', 'ignore', 'ignore'] });
    return true;
  } catch (_) {
    return false;
  }
}

// scope and audience MUST ride along (from the record itself): a refresh
// without them still returns 200, but every resource server then rejects the
// minted token — the trap that derailed the first live experiment.
async function refreshMinimaxCodeToken(session, record, deps = {}) {
  const url = session.regionDir === 'cn' ? MINIMAX_CODE_OAUTH_URL_CN : MINIMAX_CODE_OAUTH_URL_INTL;
  const form = new URLSearchParams({
    grant_type: 'refresh_token',
    refresh_token: record.refreshToken,
    client_id: typeof record.clientId === 'string' && record.clientId ? record.clientId : 'mcode-public',
    scope: Array.isArray(record.scopes) && record.scopes.length ? String(record.scopes[0]) : 'agent.default',
    audience: typeof record.audience === 'string' && record.audience ? record.audience : 'agent-backend'
  }).toString();
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  let lastError = null;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await fetchFn(url, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: form,
        ...(controller ? { signal: controller.signal } : {})
      });
      const json = await response.json().catch(() => null);
      if (response.ok) {
        const accessToken = typeof json?.access_token === 'string' ? json.access_token : '';
        const refreshToken = typeof json?.refresh_token === 'string' ? json.refresh_token : '';
        // A missing rotation is a protocol break: writing the old refresh
        // token back would be fine, but assuming it is still valid is not.
        if (!accessToken || !refreshToken) {
          throw Object.assign(new Error('oauth2/token response missing tokens'), { status: 'unavailable' });
        }
        const lifetimeSec = Math.max(60, Number(json.expires_in) || 3600);
        return {
          accessToken,
          refreshToken,
          expiresAtMs: (deps.now || Date.now)() + lifetimeSec * 1000,
          generation: (Number(record.generation) || 0) + 1
        };
      }
      const errorCode = typeof json?.error === 'string' ? json.error : '';
      if ((response.status === 400 || response.status === 401)
        && (errorCode === 'invalid_grant' || errorCode === 'unauthorized_client')) {
        // Terminal: the lease is dead. The next tick re-reads auth.json, so a
        // re-login inside MiniMax Code heals this lane without any settings change.
        throw Object.assign(new Error(`oauth2/token rejected: ${errorCode}`), { status: 'unauthorized', statusCode: response.status });
      }
      lastError = Object.assign(new Error(`oauth2/token returned ${response.status}`), {
        status: response.status === 429 ? 'sourceRateLimited' : 'unavailable',
        statusCode: response.status
      });
      if (response.status === 429 || (response.status < 500 && response.status !== 400)) throw lastError;
    } catch (error) {
      if (error?.name === 'AbortError') {
        lastError = Object.assign(new Error('oauth2/token timed out'), { status: 'unavailable' });
      } else if (error?.status) {
        throw error;
      } else {
        // No HTTP answer at all: transport failure, worth one more attempt.
        lastError = Object.assign(new Error(`oauth2/token transport failure: ${error?.message || error}`), { status: 'unavailable' });
      }
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
  throw lastError || Object.assign(new Error('oauth2/token failed'), { status: 'unavailable' });
}

// Fully synchronous on purpose: the rotation has already happened server-side,
// so nothing may be awaited between reading the response and the rename. Only
// the refreshed record's own fields move, merged into a fresh read so another
// writer's records survive; auth-state.json mirrors generation/expiresAtMs.
function writeMinimaxCodeAuth(session, updated, deps = {}) {
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const writeFileSync = deps.writeFileSync || fs.writeFileSync;
  const renameSync = deps.renameSync || fs.renameSync;
  const unlinkSync = deps.unlinkSync || fs.unlinkSync;
  let fresh;
  try { fresh = JSON.parse(readFileSync(session.authPath, 'utf8')); } catch (_) { return false; }
  if (!fresh || typeof fresh !== 'object' || !fresh.records || typeof fresh.records !== 'object'
    || !fresh.records[session.recordKey] || typeof fresh.records[session.recordKey] !== 'object') return false;
  fresh.records[session.recordKey] = { ...fresh.records[session.recordKey], ...updated };
  const tmpPath = `${session.authPath}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmpPath, `${JSON.stringify(fresh, null, 2)}\n`, { mode: 0o600 });
    renameSync(tmpPath, session.authPath);
  } catch (_) {
    try { unlinkSync(tmpPath); } catch (__) {}
    return false;
  }
  try {
    const state = JSON.parse(readFileSync(session.statePath, 'utf8'));
    if (state && typeof state === 'object') {
      state.generation = updated.generation;
      state.expiresAtMs = updated.expiresAtMs;
      const tmpState = `${session.statePath}.tmp-${process.pid}-${Date.now()}`;
      writeFileSync(tmpState, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
      renameSync(tmpState, session.statePath);
    }
  } catch (_) { /* auth.json is the source of truth; the mirror is best effort */ }
  return true;
}

async function minimaxCodeRequest(url, init, deps = {}) {
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await (deps.fetch || fetch)(url, {
      method: init.method || 'GET',
      headers: { accept: 'application/json', ...(init.headers || {}) },
      ...(init.body ? { body: init.body } : {}),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      const status = (response.status === 401 || response.status === 403) ? 'unauthorized'
        : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      const error = new Error(`${new URL(url).host} returned ${response.status}`);
      error.status = status;
      error.statusCode = response.status;
      throw error;
    }
    return await response.json();
  } catch (error) {
    if (error?.name === 'AbortError') {
      throw Object.assign(new Error(`${new URL(url).host} timed out`), { status: 'unavailable' });
    }
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

function minimaxCodeIsAuthError(error) {
  const code = Number(error && error.statusCode);
  return code === 401 || code === 403 || (error && error.status) === 'unauthorized';
}

// The two books never mix: check-in credits are a money-shaped `credits`
// window in the record's own region currency, the M Plan rides the same
// model_remains shape the Token Plan lane parses. `2062` (no subscription) is
// a healthy lane without plan windows, not an error.
async function fetchMinimaxCodeLimits(options = {}, deps = {}, context = {}) {
  const { now, updatedAt } = context;
  const codeRow = (status, extra = {}) => normalizeLimitProvider({
    provider: 'minimax',
    accountKey: extra.accountKey,
    accountLabel: 'MiniMax Code',
    source: 'oauth',
    status,
    updatedAt,
    windows: extra.windows || []
  });
  const session = minimaxCodeAuthFiles(options, deps);
  if (!session) return codeRow('notConfigured');
  const accountKey = hashKey('minimax', `code:${session.recordKey}`);
  const runtimeState = deps.providerRuntimeState instanceof Map ? deps.providerRuntimeState : null;
  const setForceRefresh = (value) => {
    if (!runtimeState) return;
    if (value) runtimeState.set(MINIMAX_CODE_FORCE_REFRESH_STATE_KEY, true);
    else runtimeState.delete(MINIMAX_CODE_FORCE_REFRESH_STATE_KEY);
  };
  // A credential probe must never mutate the lease (the registry's
  // persistent-bookkeeping rule): it reads whatever is on disk, the same way
  // the lane behaves while the desktop app is running.
  const clientRunning = deps.probe === true ? true : minimaxCodeClientRunning(deps);
  let accessToken = typeof session.record.accessToken === 'string' ? session.record.accessToken : '';
  const expiresAtMs = Number(session.record.expiresAtMs);
  let refreshAttempted = false;
  if (!clientRunning
    && (runtimeState?.get(MINIMAX_CODE_FORCE_REFRESH_STATE_KEY) === true
      || !accessToken || !Number.isFinite(expiresAtMs) || expiresAtMs - now < MINIMAX_CODE_REFRESH_LEEWAY_MS)) {
    refreshAttempted = true;
    try {
      const refreshed = await refreshMinimaxCodeToken(session, session.record, deps);
      accessToken = refreshed.accessToken;
      // Rotation consumed the old refresh token: write back before anything else.
      const written = writeMinimaxCodeAuth(session, refreshed, deps);
      setForceRefresh(!written);
    } catch (error) {
      setForceRefresh(false);
      if (error?.status === 'unauthorized') return codeRow('unauthorized', { accountKey });
      // Transient: fall through with the on-disk access token, which may still
      // answer; a 401 below is then reported as unavailable, not unauthorized.
    }
  }
  const membershipUrl = session.regionDir === 'cn' ? MINIMAX_CODE_MEMBERSHIP_URL_CN : MINIMAX_CODE_MEMBERSHIP_URL_INTL;
  const planRemainsUrl = session.regionDir === 'cn' ? MINIMAX_CODE_PLAN_REMAINS_URL_CN : MINIMAX_CODE_PLAN_REMAINS_URL_INTL;
  const bearerHeaders = () => ({ authorization: `Bearer ${accessToken}`, 'content-type': 'application/json' });
  let membership;
  try {
    membership = await minimaxCodeRequest(membershipUrl, { method: 'POST', headers: bearerHeaders(), body: '{}' }, deps);
  } catch (error) {
    if (minimaxCodeIsAuthError(error)) {
      if (clientRunning || refreshAttempted) {
        // While the app runs, its own rotation can outrun the file mid-tick;
        // an unauthorized verdict here would be a false terminal.
        return codeRow('unavailable', { accountKey });
      }
      try {
        const refreshed = await refreshMinimaxCodeToken(session, session.record, deps);
        accessToken = refreshed.accessToken;
        setForceRefresh(!writeMinimaxCodeAuth(session, refreshed, deps));
        membership = await minimaxCodeRequest(membershipUrl, { method: 'POST', headers: bearerHeaders(), body: '{}' }, deps);
      } catch (retryError) {
        return codeRow(retryError?.status === 'unauthorized' ? 'unauthorized' : 'unavailable', { accountKey });
      }
    } else {
      return codeRow(error?.status === 'sourceRateLimited' ? 'sourceRateLimited' : 'unavailable', { accountKey });
    }
  }
  const credits = parseNumberOrNull(membership?.op_credit_summary?.total_remaining_amount);
  if (credits === null) return codeRow('unavailable', { accountKey });
  const windows = [{
    kind: 'billing',
    metric: 'credits',
    label: 'Check-in',
    remaining: credits,
    currency: session.regionDir === 'cn' ? 'CNY' : 'USD',
    showMeter: false
  }];
  const groupId = typeof membership?.op_group_id === 'string' && membership.op_group_id ? membership.op_group_id : '';
  if (groupId) {
    try {
      // GroupId is a query parameter; the header form is ignored by the server.
      const remains = await minimaxCodeRequest(`${planRemainsUrl}?GroupId=${encodeURIComponent(groupId)}`, { headers: bearerHeaders() }, deps);
      const statusCode = parseNumberOrNull(remains?.base_resp?.status_code);
      if (statusCode === null || statusCode === 0) windows.push(...parseMinimaxTiers(remains));
    } catch (_) { /* the plan lane is supplementary; check-in credits stand alone */ }
  }
  return codeRow('ok', { accountKey, windows });
}


async function fetchMinimaxLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  if (normalizeMinimaxBillingMode(options.minimaxBillingMode) === 'code') {
    return fetchMinimaxCodeLimits(options, deps, { now, updatedAt });
  }
  const key = minimaxToken(env, options.minimaxApiKey);
  if (!key) {
    return normalizeLimitProvider({
      provider: 'minimax',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const fetchJson = deps.fetchJson || (async (u, headers) => {
    const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
    const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
    const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
    try {
      const response = await (deps.fetch || fetch)(u, { headers, ...(controller ? { signal: controller.signal } : {}) });
      if (!response.ok) {
        const status = (response.status === 401 || response.status === 403) ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
        const error = new Error(`${u} returned ${response.status}`);
        error.status = status;
        error.statusCode = response.status;
        throw error;
      }
      return await response.json();
    } finally {
      if (timer) clearTimeout(timer);
    }
  });
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  // An explicit `minimaxRememberedRegion` option wins over the runtime state
  // (tests drive both layers through it); the hydrated value only fills the
  // gap when the option is absent.
  const rememberedRegion = MINIMAX_REGIONS.includes(options.minimaxRememberedRegion)
    ? options.minimaxRememberedRegion
    : rememberedMinimaxRegion(deps);
  const attempts = minimaxAttemptSpecs({ ...options, minimaxRememberedRegion: rememberedRegion }, env);
  let lastError = null;
  let sawTransportFailure = false;
  for (let index = 0; index < attempts.length; index += 1) {
    const attempt = attempts[index];
    try {
      const data = await fetchJson(attempt.url, headers, deps);
      if (!data || typeof data !== 'object') {
        throw Object.assign(new Error('unexpected remains response shape'), { status: 'unavailable' });
      }
      const baseResp = data.base_resp;
      if (baseResp && typeof baseResp === 'object') {
        const statusCode = parseNumberOrNull(baseResp.status_code);
        if (statusCode !== null && statusCode !== 0) {
          const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : 'unknown error';
          // Map auth-shaped errors to 'unauthorized' so the UI surfaces
          // 'Update API key' instead of the generic 'Unavailable'. The endpoint
          // signals auth failures via base_resp.status_msg phrasing ("log in",
          // "cookie", "token", "auth", "key", "expired") rather than the HTTP
          // status, which is always 200. Heuristic but matches the only
          // failure mode observed against the live endpoint (status_code 1004).
          const lower = statusMsg.toLowerCase();
          const looksLikeAuth = /\b(log\s*in|cookie|token|auth|key|expired|invalid)\b/.test(lower);
          const status = looksLikeAuth ? 'unauthorized' : 'unavailable';
          // Auth-shaped base_resp errors also drive the region retry. The
          // endpoint returns 200 OK with status_code: 1004 ("cookie is missing,
          // log in again") when the token belongs to the OTHER region — that's
          // the same signal a 401 carries, just hidden in the body. Set
          // statusCode: 401 so the retry loop in the caller picks it up.
          const retrySignal = looksLikeAuth ? 401 : null;
          throw Object.assign(new Error(`MiniMax error (code ${statusCode}): ${statusMsg}`), {
            status,
            ...(retrySignal !== null ? { statusCode: retrySignal } : {})
          });
        }
      }
      const windows = attempt.kind === 'balance' ? parseMinimaxBalance(data, attempt.region) : parseMinimaxTiers(data);
      const next = attempts[index + 1];
      if (!windows.length && attempt.kind === 'tokenPlan' && next?.region === attempt.region) {
        throw Object.assign(new Error('MiniMax token-plan response has no quota windows'), { status: 'unavailable' });
      }
      const accountKey = hashKey('minimax', key);
      // Only a parseable quota counts as "this region works": a response that
      // answered but parsed to nothing is not evidence either way, and
      // remembering it would send the next probe down the same blind alley.
      if (windows.length) storeMinimaxRegionMemory(deps, attempt.region);
      return normalizeLimitProvider({
        provider: 'minimax',
        accountKey,
        accountLabel: attempt.kind === 'balance' ? 'Pay-as-you-go' : 'Token Plan',
        source: 'api',
        status: windows.length ? 'ok' : 'unavailable',
        updatedAt,
        windows,
        region: attempt.region
      });
    } catch (error) {
      lastError = error;
      const next = attempts[index + 1];
      // A transport failure never reached an HTTP server, so the rest of this
      // region would only repeat the same wait on the same host. Jump
      // straight to the next region — that cross-region fallback is why two
      // regions are probed at all, and it is what keeps a CN key off
      // 'unavailable' while the global host is unreachable from CN networks.
      if (isMinimaxTransportError(error)) {
        // A canceled runtime must not issue another request with stale config.
        if (deps.signal?.aborted) break;
        sawTransportFailure = true;
        const nextRegionIndex = attempts.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate.region !== attempt.region
        );
        if (nextRegionIndex > index) {
          index = nextRegionIndex - 1; // the loop's own increment lands on it
          continue;
        }
        break;
      }
      if (attempt.kind === 'tokenPlan' && next?.region === attempt.region && shouldTryLegacyMinimaxEndpoint(error)) continue;
      if (next && next.region !== attempt.region && shouldTryNextMinimaxRegion(error)) continue;
      break;
    }
  }
  // The fallback region rejects a foreign key with an auth-shaped error by
  // design (2049 / 1004 / 401). When that rejection trails a transport
  // failure on the key's own region, publishing it would wipe the retained
  // quota and show "Update API key" for what is a network outage — publish
  // the transport failure instead.
  const publishedStatus = sawTransportFailure && isMinimaxAuthError(lastError)
    ? 'unavailable'
    : mapMinimaxErrorStatus(lastError);
  return normalizeLimitProvider({
    provider: 'minimax',
    source: 'api',
    status: publishedStatus,
    updatedAt,
    windows: []
  });
}

function mapMinimaxErrorStatus(error) {
  const status = error && error.status;
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(status)) return status;
  return 'unavailable';
}

module.exports = {
  MINIMAX_KEY_NAMES,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_CODE_FORCE_REFRESH_STATE_KEY,
  MINIMAX_CODE_OAUTH_URL_CN,
  MINIMAX_CODE_OAUTH_URL_INTL,
  MINIMAX_CODE_MEMBERSHIP_URL_CN,
  MINIMAX_CODE_MEMBERSHIP_URL_INTL,
  MINIMAX_CODE_PLAN_REMAINS_URL_CN,
  MINIMAX_CODE_PLAN_REMAINS_URL_INTL,
  MINIMAX_REMAINS_URL_CN,
  MINIMAX_REMAINS_URL_EN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_CN,
  MINIMAX_TOKEN_PLAN_REMAINS_URL_EN,
  isMinimaxTransportError,
  minimaxToken,
  minimaxAttemptOrder,
  minimaxBaseUrl,
  minimaxRegion,
  normalizeMinimaxRegionSetting,
  normalizeMinimaxBillingMode,
  minimaxRegionForUrl,
  parseMinimaxTiers,
  fetchMinimaxLimits
};
