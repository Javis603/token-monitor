'use strict';

// OpenCode Go quota via the official usage API.
//
// Upstream route: packages/console/app/src/routes/zen/go/v1/usage.ts
// (repo anomalyco/opencode). The `zen/` path segment is only URL namespacing —
// the route reads the Go ("lite") subscription table and answers 403 for a
// workspace without one. There is no Zen balance endpoint, so `opencodeWeb.js`
// stays the only source for that.
//
// This path needs no user setup: `opencode` writes the subscription key into
// auth.json during its connect flow, which is why it is preferred over the
// cookie scrape and the local-DB estimate.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const { createOutboundFetch } = require('./outboundFetch');
const { resolveDataDir } = require('./opencodeLimits');

const GO_USAGE_URL = 'https://opencode.ai/zen/go/v1/usage';

// The provider id `opencode` writes for a Go subscription key. The Zen key is
// stored under `opencode` instead and is deliberately not tried here: this
// endpoint returns no balance, so a Zen-only account would gain nothing from
// the request and pay a 403 on every refresh.
const GO_AUTH_PROVIDER_ID = 'opencode-go';

// [payload key, our window kind, windowMinutes]. windowMinutes mirrors
// opencodeWeb's GO_WINDOW_MINUTES so a window keeps the same shape whichever
// source produced it. The rolling window length is actually server-configured
// (`limits.rollingWindow`) and is not in the response, so 300 stays an
// assumption here exactly as it already is on the web path.
const WINDOW_MAP = [
  ['rolling', 'session', 300],
  ['weekly', 'weekly', 10080],
  ['monthly', 'monthly', 43200]
];

function cleanSecret(value) {
  let raw = typeof value === 'string' ? value.trim() : '';
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

// A cancelled probe must not be reported as a provider status: the limits lane
// is latest-wins, and turning an abort into an `unavailable` row would publish
// a stale answer over the one that superseded it.
//
// The signal is the reliable test, not the error shape. LimitsRuntime cancels
// with `controller.abort(new Error('superseded'))`, and fetch rejects with that
// exact object — a plain Error with no AbortError name and no ABORT_ERR code —
// so sniffing the error alone misses every cancellation the runtime actually
// performs. The name/code check stays for an abort raised without a reason.
function isAbortError(error, signal) {
  if (signal?.aborted) return true;
  return error?.name === 'AbortError' || error?.code === 'ABORT_ERR';
}

function goAuthPath(env = process.env) {
  return path.join(resolveDataDir(env), 'auth.json');
}

// OpenCode's own credential set, read the way OpenCode itself reads it.
//
// Mirrors upstream `Auth.all()` rather than approximating it. Two details are
// load-bearing. The variable is tried first and, when it parses, is returned
// *instead of* the file rather than merged with it, so a container handed a
// deliberately restricted credential set does not quietly fall back to a fuller
// one on disk. Content that does not parse falls through to the file, which is
// upstream's behaviour too — its parse sits in an empty catch — so a mangled
// variable degrades to the file rather than to no credential at all.
//
// OpenCode sets this itself when it spawns a workspace child process, and it is
// the ordinary way to supply credentials in a container or a CI runner: exactly
// where the headless agent runs, and where there is no auth.json to read.
// The file is schema-checked, the variable is not — which is upstream's own
// asymmetry, not an oversight here. `Auth.all()` decodes auth.json through a
// union discriminated on `type`, whose API member is `{ type: Literal('api'),
// key: String }`, and drops every entry that does not match; the variable it
// returns straight from `JSON.parse`. Validating both would be tidier and would
// reintroduce exactly the bug the variable was added to fix: a credential
// OpenCode itself would use, that we would not.
//
// Sending a credential we cannot confirm is an API key as a Bearer token is the
// thing worth avoiding on the file path, and an entry OpenCode would ignore is
// not a credential the user has configured for anything.
function isGoApiCredential(entry) {
  return Boolean(entry)
    && typeof entry === 'object'
    && entry.type === 'api'
    && typeof entry.key === 'string';
}

function readGoAuthDocument(env) {
  const inline = String(env.OPENCODE_AUTH_CONTENT || '').trim();
  if (inline) {
    try {
      return { document: JSON.parse(inline), validated: false };
    } catch (_) { /* fall through to the file, as upstream does */ }
  }

  let raw;
  try {
    raw = fs.readFileSync(goAuthPath(env), 'utf8');
  } catch (_) {
    return null;
  }

  try {
    return { document: JSON.parse(raw), validated: true };
  } catch (_) {
    return null;
  }
}

// Returns '' when no key is available — the caller treats that as notConfigured.
function readGoApiKey(env = process.env) {
  const explicit = cleanSecret(env.TOKEN_MONITOR_OPENCODE_API_KEY);
  if (explicit) return explicit;

  const source = readGoAuthDocument(env);
  const parsed = source?.document;
  const entry = parsed && typeof parsed === 'object' ? parsed[GO_AUTH_PROVIDER_ID] : null;
  if (!entry || typeof entry !== 'object') return '';
  if (source.validated) return isGoApiCredential(entry) ? cleanSecret(entry.key) : '';
  const type = String(entry.type || '').toLowerCase();
  if (type && type !== 'api') return '';
  return cleanSecret(entry.key);
}

// The endpoint returns no workspace id, so the key itself is the identity.
// Upstream provisions exactly one "Default API Key" per (workspace, user) and
// returns early when one already exists, so two devices signed in to the same
// account normally hold the same key and therefore collapse into one row on the
// Hub. They diverge only if someone mints an extra key by hand, which is the
// safe direction: an over-eager constant would instead merge two *different*
// people's accounts on a shared hub and show one of them the other's quota.
// A cookie yields the real workspace identity regardless; see
// openCodeWebIdentity in limitCollector.js.
function goApiIdentity(apiKey) {
  // Full digest: truncating buys nothing here (this value is never displayed or
  // typed) and only narrows the space in which two accounts could collide.
  return `go-api:${crypto.createHash('sha256').update(String(apiKey || '')).digest('hex')}`;
}

function normalizeResetsAt(value) {
  const ms = Date.parse(String(value || ''));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : '';
}

function windowPercent(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const raw = Number(entry.percent);
  // Upstream already reports 100 alongside `rate-limited`; the fallback only
  // covers a payload that drops the number but keeps the status.
  if (!Number.isFinite(raw)) {
    return String(entry.status || '') === 'rate-limited' ? 100 : null;
  }
  return Math.max(0, Math.min(100, raw));
}

function parseGoUsage(payload) {
  const usage = payload && typeof payload === 'object' ? payload.usage : null;
  if (!usage || typeof usage !== 'object') return [];

  const windows = [];
  for (const [payloadKey, kind, windowMinutes] of WINDOW_MAP) {
    const entry = usage[payloadKey];
    const usedPercent = windowPercent(entry);
    if (usedPercent === null) continue;
    windows.push({
      kind,
      usedPercent,
      // The dollar limits behind these percentages live in a server-side secret
      // (ZEN_LIMITS) and are absent from the response. Back-deriving `used`
      // from our own $12/$30/$60 constants would invent precision the API never
      // gave us, so both stay null exactly as on the web path.
      used: null,
      limit: null,
      resetsAt: normalizeResetsAt(entry.resetsAt),
      windowMinutes
    });
  }

  // Every Go account has both of these. A payload missing either is an upstream
  // shape change, not a partial account, so report nothing rather than a
  // half-populated card.
  const kinds = new Set(windows.map((window) => window.kind));
  if (!kinds.has('session') || !kinds.has('weekly')) return [];
  return windows;
}

async function fetchGoApi(apiKey, deps = {}) {
  const key = cleanSecret(apiKey);
  if (!key) return { status: 'notConfigured', windows: [] };

  // createOutboundFetch returns deps.fetch when the caller injected one, so the
  // probe fetch (deadline + retry-after + cancellation) wins when present.
  const fetchFn = createOutboundFetch(deps.env || process.env, deps);

  let response;
  try {
    response = await fetchFn(GO_USAGE_URL, {
      headers: { Authorization: `Bearer ${key}`, Accept: 'application/json' },
      signal: deps.signal
    });
  } catch (error) {
    if (isAbortError(error, deps.signal)) throw error;
    return { status: 'unavailable', windows: [] };
  }

  const readJson = async () => {
    try {
      return await response.json();
    } catch (error) {
      if (isAbortError(error, deps.signal)) throw error;
      return null;
    }
  };

  const code = Number(response?.status) || 0;
  // The upstream EntitlementError means the key is valid and the account simply
  // has no Go subscription. That is not a failure, so it falls through to the
  // cookie quietly instead of surfacing an error on the card. It does not fall
  // through to the local estimate: `entitled: false` marks it as the server's
  // authoritative answer rather than an absent credential, and callers use that
  // to stop the estimate taking over, since it cannot tell a cancelled
  // subscription from a current one and would keep deriving quota from rows the
  // cancelled one left behind.
  //
  // That is a strong conclusion to draw, so it is drawn from the error the
  // application actually returns rather than from the status code carrying it.
  // A 403 can also come from a proxy, a WAF or an edge policy in front of the
  // endpoint, and none of those know anything about the account's plan; read as
  // an entitlement answer, one of them would report "no Go subscription" and
  // suppress the estimate that would otherwise have covered the outage.
  if (code === 403) {
    const body = await readJson();
    if (body?.error?.type === 'EntitlementError') {
      return { status: 'notConfigured', entitled: false, windows: [] };
    }
    return { status: 'unavailable', windows: [] };
  }
  if (code === 401) return { status: 'unauthorized', windows: [] };
  if (code === 429) return { status: 'sourceRateLimited', windows: [] };
  if (code !== 200) return { status: 'unavailable', windows: [] };

  const payload = await readJson();
  if (!payload) return { status: 'unavailable', windows: [] };

  const windows = parseGoUsage(payload);
  if (windows.length === 0) return { status: 'unavailable', windows: [] };
  return { status: 'ok', windows };
}

// Composed entry point used by the limit collector: resolve the key and probe.
// Passing an explicit `apiKey` of '' suppresses the ambient lookup entirely,
// which is how a caller says "this account has no API credential of its own".
async function collectGoApi(deps = {}) {
  const env = deps.env || process.env;
  const apiKey = deps.apiKey !== undefined ? deps.apiKey : readGoApiKey(env);
  if (!apiKey) return { status: 'notConfigured', windows: [], identity: '' };

  const result = await fetchGoApi(apiKey, deps);
  // Identity comes from the key, not from the probe result, so an account keeps
  // one identity across a failed refresh instead of collapsing into an empty
  // accountKey that matches nothing already on the Hub.
  return { ...result, identity: goApiIdentity(apiKey) };
}

module.exports = {
  GO_USAGE_URL,
  GO_AUTH_PROVIDER_ID,
  isAbortError,
  goAuthPath,
  readGoApiKey,
  goApiIdentity,
  parseGoUsage,
  fetchGoApi,
  collectGoApi
};
