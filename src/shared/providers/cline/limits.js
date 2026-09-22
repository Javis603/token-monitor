'use strict';

// Cline limits provider: the ClinePass usage windows, read from the account API
// Cline itself uses. Reached through providerFetchers() in
// src/shared/limits/collector.js.
//
// The endpoint, the field names and the credential variable names are the ones the
// public ClinePass clients already use — CodexBar, CodeBurn and OpenClaude — and
// the ones Cline's own dashboard client calls
// (`GET /api/v1/users/me/plan/usage-limits`, one `five_hour` / `weekly` /
// `monthly` window per entry; CodexBar's ClinePass guide names that endpoint and
// those three windows verbatim), so a key configured for one of those tools works
// here unchanged. The guards below are this provider's own reading of that
// contract, and every choice they make where it is unclear is recorded in
// docs/providers/cline.md.
//
// Credentials come from two places, in this order:
//
//   1. `CLINE_API_KEY`, then `CLINEPASS_API_KEY` — behind a `clineApiKey`
//      provider option, which outranks both and is what the settings field
//      supplies. Every implementation named above
//      stops here, which is why they all document ClinePass as key-only.
//   2. The sign-in Cline Desktop and the Cline CLI already persist in
//      `settings/providers.json` under the `~/.cline/data` tree whose
//      `sessions/` directory also supplies this client's token usage. That is
//      the zero-setup path for anyone actually running Cline, and it is the
//      reason this provider can work without the user pasting anything.
//
// Path 2 is read only, which is where Cline's own implementation draws the line:
// its token response may carry a replacement refresh token (`toClineCredentials`
// takes `responseData.refreshToken` when present) and its auth service writes the
// rotated access token, refresh token, expiry and account id back to
// `providers.json` itself (`writeClineCredentials`, on any credential change).
// Refreshing here would mean discarding a replacement token, leaving Cline
// holding one the server has retired. So the stored token is used as-is: Cline
// refreshes it the next time it runs, a token that has expired is refused by the
// account API and reported as `unauthorized` rather than healed here, and nothing
// in this file writes to that credential file.
//
// Cline's per-model free allowance (`cline-free/*`) has no read surface at all:
// its daily cap appears only in the body of the 429 that refuses the call. So the
// plan windows here are the ClinePass subscription's, not the free tier's. What
// the account holds instead of a plan — its pay-as-you-go credit, the "Credits:
// 0.5000" on the account page — is read from `/api/v1/users/{id}/balance` and
// reported as a credits window. That endpoint is keyed by the user id and
// ownership-checked, so it is queried with the id belonging to the credential in
// use: the stored sign-in carries it, while a key-only install learns it from
// `/api/v1/users/me` first, which is one extra request per scan there.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { normalizeLimitProvider } = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
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
const USERS_ME_PATH = '/api/v1/users/me';
// The per-user credit balance. Keyed by the user id and ownership-checked —
// a request for someone else's id answers 403 — so it has to be queried with the
// id belonging to the credential in use; there is no `me` spelling of it.
const balancePath = (id) => `/api/v1/users/${encodeURIComponent(id)}/balance`;
// The daily usage report, priced in USD — the only spend Cline exposes, and the
// source of the `spend` window this provider reports beside the credit.
const usagesDailyPath = (id) => `/api/v1/users/${encodeURIComponent(id)}/usages/daily`;
// Cline keeps credits in micro-credits: its own dashboard divides by 1e6 before
// printing them, so `balance: 500000` is the "Credits: 0.5000" the account page
// shows.
const CREDIT_SCALE = 1_000_000;
// The usage report's `costUsd` is not dollars either: it is hundred-millionths of
// one. The ledger the same calls appear in pins it, without an assumption about any
// conversion rate — one row carries `creditsUsed` 23649 and `costUsd` 2364975 for
// the same charge, so a µ-credit is a micro-dollar and 1e8 units make a dollar.
// Reporting the raw sum as USD is off by eight orders of magnitude.
const SPEND_SCALE = 100_000_000;
// A free-tier row is real usage with a would-be price: live, a `cline-free/kimi-k3`
// call answered `costUsd` 2179200 with `creditsUsed` 0, so counting it would report
// money nobody paid. The vendor marks the tier by model id
// (`CLINE_FREE_MODEL_PREFIX` in apps/vscode/src/services/error/ClineError.ts), and
// the daily report spells it twice — a `cline-free/…` id and `aiModelTypeName:
// 'cline-free'` — so either field decides it: one of them surviving a rename is
// cheaper than reporting money nobody spent.
const FREE_MODEL_PREFIX = 'cline-free/';
// The same tier as the report spells it in `aiModelTypeName`, derived so the two
// cannot drift apart.
const FREE_MODEL_TYPE = FREE_MODEL_PREFIX.replace(/\/$/, '');
const isFreeTierRow = (item) => [item?.aiModelName, item?.aiModelTypeName].some((value) => {
  const field = String(value || '').trim().toLowerCase();
  return field === FREE_MODEL_TYPE || field.startsWith(FREE_MODEL_PREFIX);
});

// The section order is Cline's own, not a choice made here: the ClinePass
// selection writes its credentials into the `cline` entry too ("cline-pass stores
// under \"cline\"", apps/vscode/src/sdk/auth-service.ts), so `cline` is the
// authoritative section and `cline-pass` is read only as a fallback for a file an
// older version wrote. Reading `cline-pass` first would let a stale entry mask the
// current credential.
const SESSION_PROVIDER_IDS = ['cline', 'cline-pass'];

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
// `label: 'Monthly'` and no `windowMinutes`.
const WINDOW_LABELS = Object.freeze({ billing: 'Monthly' });

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

// The OAuth access token goes out in its stored form, `workos:<jwt>`. That form
// is the one the account API accepts: verified live, `Bearer <bare jwt>` answers
// 401 while `Bearer workos:<jwt>` authenticates. A user-supplied API key is the
// mirror image — `Bearer <key>` authenticates and `Bearer workos:<key>` is
// rejected — so it is sent exactly as configured and never touches this
// formatter.
function formatAccessToken(value) {
  const raw = cleanSecret(value);
  if (!raw) return '';
  return raw.toLowerCase().startsWith(WORKOS_TOKEN_PREFIX) ? raw : `${WORKOS_TOKEN_PREFIX}${raw}`;
}

// The stored Cline sign-in, or a refusal that says which of the two situations it
// is. Shaped like `readCodexOAuthAuth` in providers/codex: a store that cannot be
// read is `notConfigured`, while a store that read and holds no access token is
// `unauthorized` — "Cline is not installed here" and "Cline is installed and
// signed out" call for different answers, and only the file can tell them apart.
// A section written half-way is the second case, not a failed request.
function readClineSession(env = process.env) {
  let document;
  try {
    document = JSON.parse(fs.readFileSync(clineProvidersPath(env), 'utf8'));
  } catch (_) {
    throw errorWithStatus('notConfigured', 'Cline providers.json not found');
  }
  if (!document || typeof document !== 'object') {
    throw errorWithStatus('unauthorized', 'Cline access token not found');
  }
  for (const providerId of SESSION_PROVIDER_IDS) {
    const auth = document.providers?.[providerId]?.settings?.auth;
    const accessToken = cleanSecret(auth?.accessToken);
    if (!accessToken) continue;
    const userInfo = auth?.metadata?.userInfo || {};
    return {
      accessToken,
      accountId: cleanSecret(auth?.accountId) || cleanSecret(userInfo.clineUserId),
      email: cleanSecret(userInfo.email)
    };
  }
  throw errorWithStatus('unauthorized', 'Cline access token not found');
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

// Where the credential would come from when no key is configured, shaped like
// resolveFactoryAutomaticApiKey: the settings row reports this instead of a
// generic "configured", so a discovered sign-in reads as its own lane.
function resolveClineAutomaticCredential(env = process.env) {
  if (clineApiKey(env, {})) return { source: "env" };
  try {
    readClineSession(env);
    return { source: "cline-signin" };
  } catch (_) {
    return { source: "" };
  }
}

// A key the user configured beats the sign-in Cline happens to have on this
// machine, matching how every other provider here resolves credentials. The file
// lane refuses by throwing, so the caller reports which refusal it was.
function resolveClineCredential(options = {}, env = process.env) {
  const apiKey = clineApiKey(env, options);
  if (apiKey) {
    // `api` for a configured key and `oauth` for a discovered sign-in, the split
    // docs/providers/zai.md states for its console key versus its discovered
    // credential. The key is also this lane's account identity.
    return { accessToken: apiKey, accountSeed: apiKey, accountId: '', email: '', source: 'api' };
  }
  const session = readClineSession(env);
  return {
    ...session,
    accessToken: formatAccessToken(session.accessToken),
    // The server-issued account id, never the access token: Cline replaces that
    // one hourly, and an identity that rotates reads as a new account on every
    // hub ingest — the collapse antigravity's note warns about from the other side
    // (docs/providers/antigravity.md, anonymous rows).
    accountSeed: session.accountId || '',
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
    // A type that is present but is not a string is a broken contract, the rule
    // this file already applies to a present-but-non-numeric percentage: the row
    // cannot be placed at all, and stepping over it would report a quota that
    // silently lost a window. An absent or blank type is skipped instead — the same
    // present-versus-absent line the percentage and the timestamp use.
    if (raw.type !== undefined && raw.type !== null && typeof raw.type !== 'string') return null;
    const type = String(raw.type ?? '').trim().toLowerCase();
    if (!WINDOW_KINDS[type]) continue;
    // Two situations that look alike and are not. A percentage that is present
    // and is not a number is a broken contract, and drops the whole reading rather
    // than silently one of its windows. A window that carries no percentage at all
    // — one the account has not touched yet — is left out of the report instead:
    // this repository never turns an absent percentage into a fabricated 0
    // (`numberOrNull` in limits/providerHelpers.js, and `compactWindowRemaining`
    // reports the remainder as unknown), so reporting the window here would render
    // as a real quota; dropping it keeps the reading true for the windows that do
    // carry a percentage.
    const rawPercent = raw.percentUsed ?? raw.percent_used;
    const usedPercent = numberOrNull(rawPercent);
    const percentAbsent = rawPercent === null
      || rawPercent === undefined
      || String(rawPercent).trim() === '';
    if (usedPercent === null) {
      if (!percentAbsent) return null;
      continue;
    }
    // Validate the value that was actually read, not one spelling of it: a guard
    // on `raw.resetsAt` alone let `{"resets_at": "soon"}` through as "no reset"
    // while the camelCase spelling voided the reading.
    const rawResetsAt = raw.resetsAt ?? raw.resets_at;
    const resetsAt = toIso(rawResetsAt);
    const resetsAtAbsent = rawResetsAt === null
      || rawResetsAt === undefined
      || String(rawResetsAt).trim() === '';
    if (resetsAt === null && !resetsAtAbsent) return null;
    byType.set(type, {
      usedPercent: clampPercent(usedPercent),
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
function providerResult(windows, { nowMs, credential, status = '', accountSeed = '' }) {
  // `accountSeed` is decided per lane in resolveClineCredential; with no stable
  // identifier there is no accountKey, rather than one invented here.
  const seed = accountSeed || credential?.accountSeed || '';
  return normalizeLimitProvider({
    provider: 'cline',
    accountKey: seed ? hashKey('cline', seed) : '',
    accountLabel: '',
    accountEmail: String(credential?.email || '').trim().toLowerCase(),
    source: credential?.source || 'api',
    updatedAt: nowIso(nowMs ?? Date.now()),
    status: status || (windows.length > 0 ? 'ok' : 'unavailable'),
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

// The id `/api/v1/users/{id}/balance` is keyed by, for a credential that does not
// carry one: a key on a machine with no Cline install. It is read with the same
// credential, so it always names the account actually being queried — the endpoint
// answers `403 can only access own resources` for anyone else's id, and a key and
// a local sign-in can belong to different accounts.
async function fetchClineAccountId(credential, deps) {
  const payload = await fetchJson(
    `${CLINE_API_BASE}${USERS_ME_PATH}`,
    { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' },
    deps
  );
  return cleanSecret(payload?.data?.id);
}

// The credit the account holds, as a credits window, or null when it cannot be
// read. Best effort on purpose: the plan windows are this provider's answer, and a
// balance endpoint that is down, unreadable or answers about another account must
// not take that answer down with it (the same rule docs/providers/zai.md fixes for
// its billing lane).
async function readClineCredits(id, credential, deps) {
  try {
    const payload = await fetchJson(
      `${CLINE_API_BASE}${balancePath(id)}`,
      { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' },
      deps
    );
    const amount = numberOrNull(payload?.data?.balance);
    if (payload?.success !== true || amount === null || amount < 0) return null;
    return {
      kind: 'billing',
      metric: 'credits',
      // The label names the unit, which is why the value is not prefixed with it:
      // `limitBalanceDisplay` prints a `CREDITS` window as a bare amount beside
      // this label, exactly as Cline's own account page does.
      label: 'Credits',
      currency: 'CREDITS',
      remaining: amount / CREDIT_SCALE,
      // A balance has no denominator, so there is nothing to meter (workbuddy
      // files its unlimited package the same way).
      showMeter: false
    };
  } catch (_) {
    return null;
  }
}

// The month's spend in USD, as a `spend` window — the role Claude's "Usage
// credits" line plays: money already consumed, kept beside the credit rather than
// inside it, because the two units are different (the balance is credits, this API
// prices usage in dollars). Best effort like the balance read, and absent when the
// month recorded nothing, so a fresh account shows no empty line.
function localDateParts(nowMs) {
  const date = new Date(nowMs);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return { month: `${date.getFullYear()}-${month}-01`, day: `${date.getFullYear()}-${month}-${day}` };
}

async function readClineSpend(id, credential, nowMs, deps) {
  try {
    const { month, day } = localDateParts(nowMs);
    const payload = await fetchJson(
      `${CLINE_API_BASE}${usagesDailyPath(id)}?startdate=${month}&enddate=${day}`,
      { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' },
      deps
    );
    const items = payload?.data?.items;
    if (payload?.success !== true || !Array.isArray(items)) return null;
    let used = 0;
    for (const item of items) {
      if (isFreeTierRow(item)) continue;
      const cost = numberOrNull(item?.costUsd);
      if (cost !== null && cost > 0) used += cost;
    }
    // Converted once, from the unit the API reports to the one the panel prints.
    if (used > 0) used /= SPEND_SCALE;
    if (!(used > 0)) return null;
    return {
      kind: 'billing',
      metric: 'spend',
      label: 'Usage credits',
      used,
      // No monthly cap is reported, so there is no denominator: no meter, the same
      // rule commandcode and claude follow for a balance without one.
      limit: null,
      currency: 'USD',
      showMeter: false
    };
  } catch (_) {
    return null;
  }
}

async function fetchClineLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const nowMs = (deps.now || Date.now)();
  let credential;
  try {
    credential = resolveClineCredential(options, env);
  } catch (error) {
    // The file lane's refusal, reported as the credential problem it is — and it
    // still names the lane it came from.
    return failingProvider(providerStatusFromError(error), nowMs, 'oauth');
  }
  const headers = { Authorization: `Bearer ${credential.accessToken}`, Accept: 'application/json' };

  // The lanes below are independent, the shape providers/zai gives its quota and
  // balance lanes: an error decides the status and nothing else, so a lane that
  // answered is kept beside one that failed rather than being dropped with it. The
  // one shared fate is the credential itself — every request here carries the same
  // token, so a refusal ends the scan instead of asking two more endpoints for the
  // same 401, which is also why an expired sign-in costs exactly one request.
  let planWindows = [];
  // `''` means the lane answered (including a planless 404); anything else is the
  // shared status its failure maps to. Both paths below assign it.
  let planStatus;
  try {
    // fetchJson owns the timeout and maps the response onto the shared status
    // vocabulary: 401 to `unauthorized`, 429 to `sourceRateLimited`, everything
    // else — 403 and 5xx included — to `unavailable`. A stored token that has
    // expired arrives as that 401, which is the whole of this provider's answer
    // to a stale sign-in; refreshing it belongs to Cline, for the reason the
    // header gives.
    const payload = await fetchJson(`${CLINE_API_BASE}${USAGE_LIMITS_PATH}`, headers, deps);
    const parsed = parseClineLimits(payload);
    // A contract break is a failed lane like any other: the status reports it and
    // the credit beside it is still read, rather than either hiding the other.
    planStatus = parsed === null ? 'unavailable' : '';
    planWindows = parsed || [];
  } catch (error) {
    planStatus = providerStatusFromError(error);
    // A rejected credential is the whole answer — the balance endpoint would be
    // refused the same way — so it is the one failure that ends the scan.
    if (planStatus === 'unauthorized') return failingProvider(planStatus, nowMs, credential.source);
    // The one refusal that is still an answer is the planless 404 (verified live —
    // `no plan history found for user`): no plan is a state, not a failure, and the
    // credit read is what decides the row. `httpStatus` carries exactly this split,
    // because the shared vocabulary collapses 404 and 5xx into `unavailable`
    // (limits/providerHelpers.js); the providers that need it read it the same way
    // (providers/claude with 403/404, providers/volcengine with 401/403/404,
    // providers/codex with 408/5xx).
    if (Number(error?.httpStatus) === 404) planStatus = '';
  }
  // The account id both nested reads are keyed by, resolved once: the stored sign-in
  // carries it, and a key-only install learns it from the profile endpoint (which is
  // why that install costs one more request than this one).
  let accountId = credential.accountId || '';
  if (!accountId) {
    try {
      accountId = await fetchClineAccountId(credential, deps);
    } catch (_) {
      accountId = '';
    }
  }
  const credits = accountId ? await readClineCredits(accountId, credential, deps) : null;
  const spend = accountId ? await readClineSpend(accountId, credential, nowMs, deps) : null;
  // The identity is the lane's own seed, except where the stored sign-in carried none:
  // the profile read the balance needed has just named the account, and a row that
  // stayed anonymous would be merged with every other anonymous Cline account during
  // normalization. A configured key keeps the key as its identity for the reason
  // resolveClineCredential gives — a rejected key is a rejected account, not a fallback.
  const accountSeed = credential.accountSeed || accountId || '';
  const readings = [...planWindows, ...(credits ? [credits] : []), ...(spend ? [spend] : [])];
  // The status takes the lane priority providers/zai uses — the failure that matters
  // first, then anything readable as `ok`, then a bare `unavailable` — while the
  // windows stay the union of what the lanes answered. A failed plan read therefore
  // keeps its status without cost to the credit line, and a planless account reads
  // `ok` off the credit alone (`docs/providers/zai.md` states the same rule for a key
  // without a subscription whose console still answers a balance).
  const status = planStatus || (readings.length > 0 ? 'ok' : 'unavailable');
  if (readings.length === 0 && !planStatus) return failingProvider(status, nowMs, credential.source);
  return providerResult(readings, { nowMs, credential, status, accountSeed });
}

module.exports = {
  CLINE_API_BASE,
  USAGE_LIMITS_PATH,
  USERS_ME_PATH,
  balancePath,
  usagesDailyPath,
  clineApiKey,
  clineProvidersPath,
  fetchClineLimits,
  parseClineLimits,
  readClineSession,
  resolveClineCredential,
  resolveClineAutomaticCredential,
  formatAccessToken
};
