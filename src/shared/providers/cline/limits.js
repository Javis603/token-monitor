'use strict';

// Cline limits provider: the ClinePass usage windows, read from the account API
// Cline itself uses. Reached through providerFetchers() in
// src/shared/limits/collector.js.
//
// The endpoint and its response contract are the ones CodexBar, CodeBurn and
// OpenClaude already implement (`GET /api/v1/users/me/plan/usage-limits`, one
// `five_hour` / `weekly` / `monthly` window per entry), and the credential
// variable names are theirs too, so a key configured for one of those tools
// works here unchanged.
//
// Credentials come from two places, in this order:
//
//   1. `CLINE_API_KEY`, then `CLINEPASS_API_KEY` (or the provider options a
//      manual field would supply). Every implementation named above stops here,
//      which is why they all document ClinePass as key-only.
//   2. The sign-in Cline Desktop and the Cline CLI already persist in
//      `settings/providers.json` under the `~/.cline/data` tree whose
//      `sessions/` directory also supplies this client's token usage. That is
//      the zero-setup path for anyone actually running Cline, and it is the
//      reason this provider can work without the user pasting anything.
//
// Path 2 is refreshed in memory and never written back. Its token is a WorkOS
// access token with a one-hour lifetime, which goes stale whenever Cline has not
// been run recently, so a scan that finds it expired calls Cline's own refresh
// endpoint and uses the result. That endpoint returns the refresh token it was
// given — verified live — so refreshing here cannot invalidate Cline's copy, and
// writing into another application's credential file would buy nothing the next
// scan does not redo. Only a refused refresh, meaning the sign-in itself is gone,
// is reported as needing an update.
//
// Cline's per-model free allowance (`cline-free/*`) has no read surface at all:
// its daily cap appears only in the body of the 429 that refuses the call. So
// the windows here are the ClinePass subscription's, not the free tier's. The
// account's pay-as-you-go credit balance is a different endpoint
// (`/api/v1/users/{id}/balance`) keyed by a user id this file does not carry,
// so it is not read either.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLimitProvider } = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
  TOKEN_MONITOR_USER_AGENT,
  cleanSecret,
  envValue,
  errorWithStatus,
  fetchJson,
  nowIso,
  numberOrNull,
  providerStatusFromError,
  toIso
} = require('../../limits/providerHelpers');

const CLINE_API_BASE = 'https://api.cline.bot';
// Cline's API takes its WorkOS token in the stored form, prefix included.
const WORKOS_TOKEN_PREFIX = 'workos:';
const USAGE_LIMITS_PATH = '/api/v1/users/me/plan/usage-limits';
const REFRESH_PATH = '/api/v1/auth/refresh';

// Both point at the same account — Cline stores one token under `cline` (usage
// billing) and `cline-pass` (the subscription) — so this is a fallback chain for
// a file where only one section was written, not a preference between accounts.
const SESSION_PROVIDER_IDS = ['cline-pass', 'cline'];

// The window kinds Cline reports, mapped onto the shared vocabulary in
// src/shared/limits/core.js: its `five_hour` is the same rolling window Claude
// Code calls `session`, and its `monthly` is a billing cycle.
const WINDOW_KINDS = Object.freeze({
  five_hour: 'session',
  weekly: 'weekly',
  monthly: 'billing'
});
const WINDOW_MINUTES = Object.freeze({ session: 300, weekly: 10_080 });
// A `billing` window is a catch-all kind, so this repository labels it rather
// than giving it a duration: Kimi's and Command Code's monthly windows carry
// `label: 'Monthly'` and no `windowMinutes`. CodexBar's golden fixture calls the
// same window 43200 minutes, but that is a field of its own window model — the
// label is how the period is named here.
const WINDOW_LABELS = Object.freeze({ billing: 'Monthly' });

// A token expiring within the next minute is not worth a request: the answer
// would arrive after it stopped being valid.
const EXPIRY_MARGIN_MS = 60_000;

// The `settings/providers.json` Cline keeps its account sign-in in.
//
// Resolution mirrors `cline_cli_session_roots` in tokscale's scanner.rs — the
// same precedence the collector's session roots use — so a relocated Cline
// install is read where its sessions are read. The first variable that is set
// wins and there is deliberately no fallback past it: probing on to the default
// location would report whichever account happens to be signed in at `~/.cline`,
// which is a different install.
function clineProvidersPath(env = process.env) {
  const explicit = (name) => cleanSecret(envValue(env, name));
  const sessionDir = explicit('CLINE_SESSION_DATA_DIR');
  if (sessionDir) return path.join(path.dirname(sessionDir), 'settings', 'providers.json');
  const dataDir = explicit('CLINE_DATA_DIR');
  if (dataDir) return path.join(dataDir, 'settings', 'providers.json');
  const clineDir = explicit('CLINE_DIR');
  if (clineDir) return path.join(clineDir, 'data', 'settings', 'providers.json');
  return path.join(os.homedir(), '.cline', 'data', 'settings', 'providers.json');
}

// The OAuth access token goes out in its stored form, `workos:<jwt>`, while
// Cline's refresh endpoint hands back the bare JWT, so the prefix is ensured
// rather than stripped. Both directions are verified live against the endpoint,
// and they are opposites: `Bearer <bare jwt>` is rejected with 401 while
// `Bearer workos:<jwt>` authenticates. A user-supplied API key is the mirror
// image — `Bearer <key>` authenticates and `Bearer workos:<key>` is rejected —
// so it is sent exactly as configured and never touches this formatter.
function formatAccessToken(value) {
  const raw = cleanSecret(value);
  if (!raw) return '';
  return raw.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX) ? raw : `${WORKOS_TOKEN_PREFIX}${raw}`;
}

// Epoch milliseconds from whichever spelling Cline wrote. The CLI stores a
// number; an ISO string and a numeric string are both accepted because more than
// one front-end writes this field.
function tokenExpiryMs(auth) {
  const raw = auth?.expiresAt ?? auth?.expires_at;
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    return raw > 20_000_000_000 ? raw : raw * 1000;
  }
  const text = cleanSecret(raw);
  if (!text) return null;
  if (/^\d+$/.test(text)) {
    const value = Number(text);
    return value > 20_000_000_000 ? value : value * 1000;
  }
  const parsed = Date.parse(text);
  return Number.isNaN(parsed) ? null : parsed;
}

function readClineProvidersDocument(filePath) {
  try {
    const document = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return document && typeof document === 'object' ? document : null;
  } catch (_) {
    return null;
  }
}

// The stored Cline sign-in, or null when there is none. A section without an
// access token is skipped rather than reported, so a half-written file reads as
// "not signed in" instead of as a failed request.
function readClineSession(env = process.env, deps = {}) {
  const readFile = deps.readFile || readClineProvidersDocument;
  const document = readFile(clineProvidersPath(env));
  const providers = document?.providers;
  if (!providers || typeof providers !== 'object') return null;
  for (const providerId of SESSION_PROVIDER_IDS) {
    const auth = providers[providerId]?.settings?.auth;
    const accessToken = cleanSecret(auth?.accessToken);
    if (!accessToken) continue;
    const userInfo = auth?.metadata?.userInfo || {};
    return {
      accessToken,
      refreshToken: cleanSecret(auth?.refreshToken),
      accountId: cleanSecret(auth?.accountId) || cleanSecret(userInfo.clineUserId),
      email: cleanSecret(userInfo.email),
      expiresAt: tokenExpiryMs(auth)
    };
  }
  return null;
}

function clineApiKey(env = process.env, options = {}) {
  const explicit = cleanSecret(options.clineApiKey);
  if (explicit) return explicit;
  for (const name of ['CLINE_API_KEY', 'CLINEPASS_API_KEY']) {
    const value = cleanSecret(envValue(env, name));
    if (value) return value;
  }
  return '';
}

// The most recent in-memory refresh, kept so a stored token that stays expired
// costs one refresh per process rather than one per scan. Keyed by the refresh
// token, which is what a different sign-in changes.
let sessionRefresh = null;

function cachedRefresh(refreshToken, nowMs) {
  if (!sessionRefresh || sessionRefresh.refreshToken !== refreshToken) return null;
  if (sessionRefresh.expiresAt !== null && sessionRefresh.expiresAt <= nowMs + EXPIRY_MARGIN_MS) return null;
  return sessionRefresh;
}

// Best-effort error text from a failed response, for the one decision that needs
// it: whether a 400 means a rejected grant or a malformed request.
async function failureText(response) {
  try {
    const body = await response.text();
    return String(body || '');
  } catch (_) {
    return '';
  }
}

// Mirrors `refreshClineAccessToken`'s shape in providers/claude: its own timeout
// and its own status mapping, because fetchJson does not carry a method or body.
async function refreshClineSession(refreshToken, deps = {}) {
  const fetchFn = deps.fetch || fetch;
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(`${CLINE_API_BASE}${REFRESH_PATH}`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        accept: 'application/json',
        'user-agent': TOKEN_MONITOR_USER_AGENT
      },
      // The body Cline's own refresh sends. `grantType` is spelled that way in
      // its request, not as the OAuth `grant_type`.
      body: JSON.stringify({ refreshToken, grantType: 'refresh_token' }),
      ...(controller ? { signal: controller.signal } : {})
    });
    if (!response.ok) {
      // A rejected refresh is a credential problem, not an outage — but a 400 is
      // ambiguous, and both meanings were observed live: an empty body answers
      // `{"error":"Validation failed",...}`, while a bad token answers
      // `{"error":"failed to refresh token: invalid_grant"}`. Only the second is
      // the sign-in being gone, so only it is reported as such; Cline's own
      // classifier (`isLikelyInvalidGrant`) draws the same line from the same
      // signal. A bare 401/403 is a rejection outright.
      const invalidGrant = /invalid_grant|invalid_token|unauthorized|expired|revoked/i
        .test(await failureText(response));
      const status = response.status === 401 || response.status === 403
        ? 'unauthorized'
        : response.status === 400 && invalidGrant
          ? 'unauthorized'
          : response.status === 429
            ? 'sourceRateLimited'
            : 'unavailable';
      throw errorWithStatus(status, `Cline token refresh returned ${response.status}`);
    }
    const payload = await response.json();
    const accessToken = formatAccessToken(payload?.data?.accessToken);
    if (!accessToken) throw errorWithStatus('unavailable', 'Cline token refresh returned no access token');
    return { accessToken, expiresAt: tokenExpiryMs({ expiresAt: payload?.data?.expiresAt }) };
  } catch (error) {
    if (error?.name === 'AbortError') throw errorWithStatus('unavailable', 'Cline token refresh timed out');
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// A key the user configured beats the sign-in Cline happens to have on this
// machine, matching how every other provider here resolves credentials.
function resolveClineCredential(options = {}, env = process.env, deps = {}) {
  const apiKey = clineApiKey(env, options);
  if (apiKey) {
    // `api` for a configured key and `oauth` for a discovered sign-in, the split
    // docs/providers/zai.md states for its console key versus its discovered
    // credential. The key is also this lane's account identity.
    return { accessToken: apiKey, accountSeed: apiKey, expiresAt: null, accountId: '', email: '', source: 'api' };
  }
  const session = readClineSession(env, deps);
  if (!session) return null;
  return {
    ...session,
    accessToken: formatAccessToken(session.accessToken),
    // Only what survives a refresh: the server-issued id, or the refresh token
    // Cline's endpoint returns unchanged. Never the access token, which is
    // replaced hourly — an identity that rotates reads as a new account on every
    // hub ingest, the collapse antigravity's note warns about from the other side
    // (docs/providers/antigravity.md, anonymous rows).
    accountSeed: session.accountId || session.refreshToken || '',
    source: 'oauth'
  };
}

function clampPercent(value) {
  return Math.max(0, Math.min(100, value));
}

// The order the windows are reported in, so a response that lists them
// differently still renders in the same sequence on every refresh.
const WINDOW_ORDER = Object.freeze(['five_hour', 'weekly', 'monthly']);

// `null` when the response breaks its own documented shape, so a contract change
// surfaces as "no data" instead of as a plausible-looking wrong percentage.
// Only an unrecognized window type is skipped, so a window Cline adds later
// cannot take the whole reading down with it.
function parseClineLimits(payload) {
  if (!payload || typeof payload !== 'object' || payload.success !== true) return null;
  const limits = payload.data?.limits;
  if (!Array.isArray(limits)) return null;
  // Keyed by the reported type, so a repeated window replaces the earlier one
  // instead of rendering twice. CodexBar, CodeBurn and OpenClaude all collapse
  // it the same way (`windows[type] = …`), and only the last one is the
  // account's current reading.
  const byType = new Map();
  for (const raw of limits) {
    if (!raw || typeof raw !== 'object') return null;
    const type = String(raw.type || '').trim().toLowerCase();
    if (!WINDOW_KINDS[type]) continue;
    // A window the account has not touched yet can arrive with no percentage at
    // all. Cline's own dashboard reads that as 0, but a fabricated 0 renders here
    // as a real reading, so the window is kept without one —
    // `compactWindowRemaining()` already treats an absent percentage as unknown.
    // A value that is present and is not a number is a broken contract instead,
    // and drops the whole reading rather than silently one of its windows.
    const rawPercent = raw.percentUsed ?? raw.percent_used;
    const usedPercent = numberOrNull(rawPercent);
    const percentAbsent = rawPercent === null
      || rawPercent === undefined
      || String(rawPercent).trim() === '';
    if (usedPercent === null && !percentAbsent) return null;
    const resetsAt = toIso(raw.resetsAt ?? raw.resets_at);
    if (resetsAt === null && raw.resetsAt != null) return null;
    byType.set(type, {
      usedPercent: usedPercent === null ? null : clampPercent(usedPercent),
      resetsAt
    });
  }
  return WINDOW_ORDER.filter((type) => byType.has(type)).map((type) => {
    const kind = WINDOW_KINDS[type];
    const entry = byType.get(type);
    const label = WINDOW_LABELS[kind];
    return {
      kind,
      ...(label ? { label } : {}),
      usedPercent: entry.usedPercent,
      resetsAt: entry.resetsAt,
      windowMinutes: WINDOW_MINUTES[kind] ?? null
    };
  });
}

// An account with no subscription shows up two ways — an empty list, or the 404
// `no plan history found for user` that fetchJson maps to `unavailable` before
// reaching here (verified live) — and neither is the same as a live zero-usage
// window: report no data rather than 0%.
function providerResult(windows, { nowMs, credential }) {
  // `accountSeed` is decided per lane in resolveClineCredential; with no stable
  // identifier there is no accountKey, rather than one invented here.
  const seed = credential?.accountSeed || '';
  return normalizeLimitProvider({
    provider: 'cline',
    accountKey: seed ? hashKey('cline', seed) : '',
    accountLabel: '',
    accountEmail: String(credential?.email || '').trim().toLowerCase(),
    source: credential?.source || 'api',
    updatedAt: nowIso(nowMs ?? Date.now()),
    status: windows.length > 0 ? 'ok' : 'unavailable',
    windows: windows
  });
}

// Failure results name the source they failed on and nothing else: what could
// not be read is not an account, and every other provider here reports a
// failure the same way.
function failingProvider(status, nowMs, source = '') {
  return normalizeLimitProvider({
    provider: 'cline',
    ...(source ? { source } : {}),
    status,
    updatedAt: nowIso(nowMs ?? Date.now()),
    windows: []
  });
}

async function fetchClineLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  let credential = resolveClineCredential(options, env, deps);
  if (!credential) return failingProvider('notConfigured', nowMs);
  if (credential.expiresAt !== null && credential.expiresAt <= nowMs + EXPIRY_MARGIN_MS) {
    // Self-heal on the next scan: a stored sign-in goes stale whenever Cline has
    // not been run for an hour, and Cline's refresh token outlives it.
    if (!credential.refreshToken) return failingProvider('unauthorized', nowMs, credential.source);
    try {
      const refreshed = cachedRefresh(credential.refreshToken, nowMs)
        || await refreshSession(credential.refreshToken, deps);
      credential = { ...credential, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
    } catch (error) {
      return failingProvider(providerStatusFromError(error), nowMs, credential.source);
    }
  }
  try {
    // fetchJson owns the timeout and maps 401/403, 429 and everything else onto
    // the shared status vocabulary this module reports.
    const payload = await fetchJson(
      `${CLINE_API_BASE}${USAGE_LIMITS_PATH}`,
      { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' },
      deps
    );
    const windows = parseClineLimits(payload);
    if (!windows) return failingProvider('unavailable', nowMs);
    return providerResult(windows, { nowMs, credential });
  } catch (error) {
    return failingProvider(providerStatusFromError(error), nowMs, credential.source);
  }
}

async function refreshSession(refreshToken, deps) {
  const refreshed = await refreshClineSession(refreshToken, deps);
  // An expiry we cannot read is treated as "refresh again next scan" rather than
  // cached, which is what Cline's own rotation guard does with an unknown one.
  sessionRefresh = refreshed.expiresAt === null
    ? null
    : { refreshToken, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
  return { refreshToken, accessToken: refreshed.accessToken, expiresAt: refreshed.expiresAt };
}

module.exports = {
  CLINE_API_BASE,
  REFRESH_PATH,
  USAGE_LIMITS_PATH,
  clineApiKey,
  clineProvidersPath,
  fetchClineLimits,
  parseClineLimits,
  readClineSession,
  resolveClineCredential,
  formatAccessToken,
  refreshClineSession,
  tokenExpiryMs
};
