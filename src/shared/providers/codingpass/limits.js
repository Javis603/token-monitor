'use strict';

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus } = require('../../limits/providerHelpers');
const { runWithProbeDeadline } = require('../../probeDeadline');

// The codingpass.ai console talks to an oRPC router under /api with cookie
// (session) authentication. There is no API-key quota endpoint.
const CODINGPASS_ORIGIN = 'https://codingpass.ai';
const STATE_URL = `${CODINGPASS_ORIGIN}/api/auth/state`;
const USAGE_URL = `${CODINGPASS_ORIGIN}/api/app/usage`;
const WALLET_URL = `${CODINGPASS_ORIGIN}/api/app/wallet`;
const WALLET_TIMEOUT_MS = 4_000;
// Every amount the console API returns is USD micro-units.
const MICRO = 1_000_000;

// DevTools copies the header as one line, but a multi-line paste of name=value
// rows is common too; both become one header. Anything that is not a list of
// cookie pairs is a mis-paste and never leaves this device.
function normalizeCodingpassCookieHeader(value) {
  if (typeof value !== 'string') return '';
  const raw = value.trim().replace(/^cookie\s*:\s*/iu, '');
  const pairs = raw.split(/[;\r\n]+/u).map((pair) => pair.trim()).filter(Boolean);
  if (!pairs.length) return '';
  for (const pair of pairs) {
    if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+=[\x21\x23-\x2b\x2d-\x3a\x3c-\x5b\x5d-\x7e]*$/u.test(pair)) return '';
  }
  return pairs.join('; ');
}

function codingpassCookie(env = process.env, options = {}) {
  return normalizeCodingpassCookieHeader(options.codingpassCookie
    || env.TOKEN_MONITOR_CODINGPASS_COOKIE || env.CODINGPASS_COOKIE || '');
}

function invalidResponse() {
  return errorWithStatus('unavailable', 'CodingPass usage response changed');
}

// oRPC serializes big counters as strings; accept both, reject anything else.
function micro(value) {
  if (value === null || value === undefined) return null;
  const number = typeof value === 'string' && /^-?\d+(\.\d+)?$/u.test(value) ? Number(value) : value;
  if (typeof number !== 'number' || !Number.isFinite(number)) throw invalidResponse();
  return number;
}

const usd = (value) => Math.round(value / MICRO * 1e6) / 1e6;

function timestamp(value) {
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  const time = typeof value === 'number' ? value : Date.parse(value);
  return Number.isFinite(time) ? new Date(time).toISOString() : null;
}

// Successful oRPC answers arrive as { json, meta }.
function unwrapRpc(body) {
  return body && typeof body === 'object' && Object.hasOwn(body, 'json') ? body.json : body;
}

// `quota` carries the plan's caps and the counters as of the last settlement;
// `live.global` carries the current counters with their reset times. A window
// whose cap is null or zero has no limit and is left out rather than drawn as
// an empty bar.
function parseCodingpassUsage(usage) {
  if (!usage || typeof usage !== 'object') throw invalidResponse();
  const quota = usage.quota && typeof usage.quota === 'object' ? usage.quota : null;
  const live = usage.live && typeof usage.live === 'object' ? usage.live : null;
  const layers = Array.isArray(live?.global) ? live.global : null;
  const models = Array.isArray(live?.models) ? live.models : null;
  const layer = (name) => layers?.find((entry) => entry?.layer === name) || null;
  const specs = [
    { kind: 'session', layer: layer('global_5h'), used: quota?.used5hMicro, limit: quota?.limit5hMicro, windowMinutes: 5 * 60 },
    { kind: 'weekly', layer: layer('global_week'), used: quota?.usedWeekMicro, limit: quota?.limitWeekMicro, windowMinutes: 7 * 24 * 60 },
    { kind: 'billing', layer: layer('global_month'), used: quota?.usedMicro, limit: quota?.limitMicro, fallbackReset: quota?.monthEnd }
  ];
  if (!layers && !models && !specs.some(({ limit }) => limit !== undefined)) throw invalidResponse();
  const windows = [];
  // Micro-units left in each plan window, for the per-model comparison below.
  const planRemaining = new Map();
  const toWindow = (spec, used, limit, resetsAt, extra = {}) => ({
    kind: spec.kind,
    ...extra,
    used: usd(used),
    limit: usd(limit),
    remaining: usd(Math.max(0, limit - used)),
    currency: 'USD',
    resetsAt,
    ...(spec.windowMinutes ? { windowMinutes: spec.windowMinutes } : {}),
    showMeter: true
  });
  for (const spec of specs) {
    const limit = micro(spec.limit) ?? micro(spec.layer?.limitMicro);
    if (limit === null || limit <= 0) continue;
    const used = Math.max(0, micro(spec.layer?.usedMicro) ?? micro(spec.used) ?? 0);
    planRemaining.set(spec.kind, Math.max(0, limit - used));
    // The 5-hour window has no reset time until a request opens it.
    const opened = spec.kind !== 'session' || Boolean(live?.window5hStartAt);
    const resetsAt = opened ? timestamp(spec.layer?.resetAt) ?? timestamp(spec.fallbackReset) : null;
    windows.push(toWindow(spec, used, limit, resetsAt));
  }
  // `live.models` repeats the windows per model, and some model groups carry
  // smaller caps than the plan. A live Plus account listed two windows for each
  // of ~20 models, so a row for every capped model would bury the plan. A model
  // row is shown only while that model would run out before the plan window it
  // belongs to, which is when it is the limit the user actually hits.
  const modelLayers = { model_5h: specs[0], model_week: specs[1], model_month: specs[2] };
  for (const model of models || []) {
    const modelKey = typeof model?.modelKey === 'string' ? model.modelKey.trim() : '';
    if (!modelKey || modelKey.length > 96) continue;
    const label = typeof model.label === 'string' && model.label.trim() ? model.label.trim() : modelKey;
    for (const entry of Array.isArray(model.layers) ? model.layers : []) {
      const spec = modelLayers[entry?.layer];
      const limit = spec ? micro(entry.limitMicro) : null;
      if (limit === null || limit <= 0) continue;
      const used = Math.max(0, micro(entry.usedMicro) ?? 0);
      const plan = planRemaining.get(spec.kind);
      if (plan !== undefined && limit - used >= plan) continue;
      windows.push(toWindow(spec, used, limit, timestamp(entry.resetAt),
        { additional: true, limitId: `codingpass.model.${modelKey}`, label }));
    }
  }
  const subscription = usage.subscription && typeof usage.subscription === 'object' ? usage.subscription : null;
  const planLabel = typeof subscription?.planName === 'string' ? subscription.planName.trim() : '';
  return { windows, planLabel };
}

// The pay-as-you-go wallet funds requests past the plan; the console shows it
// converted by `rateBps` (basis points per USD) when the account has a rate.
function parseCodingpassWallet(wallet) {
  if (!wallet || typeof wallet !== 'object') return null;
  const balance = micro(wallet.balanceMicro);
  if (balance === null) return null;
  if (balance <= 0 && wallet.paygEnabled !== true) return null;
  const rateBps = micro(wallet.rateBps);
  const factor = rateBps !== null && rateBps > 0 ? Math.round(MICRO / rateBps) / 100 : 1;
  const spent = micro(wallet.monthSpentMicro);
  return {
    amount: usd(balance * factor),
    currency: 'USD',
    ...(spent !== null ? { monthSpend: usd(spent * factor) } : {})
  };
}

async function fetchCodingpassLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const base = { provider: 'codingpass', source: 'web', windows: [],
    updatedAt: new Date((deps.now || Date.now)()).toISOString() };
  const raw = options.codingpassCookie || env.TOKEN_MONITOR_CODINGPASS_COOKIE || env.CODINGPASS_COOKIE;
  if (!raw) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
  const cookie = codingpassCookie(env, options);
  if (!cookie) return normalizeLimitProvider({ ...base, status: 'unavailable' });
  let identity = {};
  try {
    const reading = await runWithProbeDeadline(async ({ signal, deadlineMs }) => {
      const startedAt = performance.now();
      const call = async (url, body, requestSignal = signal) => {
        requestSignal.throwIfAborted();
        const response = await (deps.fetch || fetch)(url, {
          method: body === undefined ? 'GET' : 'POST',
          credentials: 'omit',
          redirect: 'error',
          signal: requestSignal,
          headers: {
            Accept: 'application/json',
            Cookie: cookie,
            ...(body === undefined ? {} : { 'Content-Type': 'application/json', Origin: CODINGPASS_ORIGIN })
          },
          ...(body === undefined ? {} : { body })
        });
        requestSignal.throwIfAborted();
        if (response.status !== 200) {
          throw errorWithStatus(response.status === 401 ? 'unauthorized'
            : response.status === 429 ? 'sourceRateLimited' : 'unavailable', `CodingPass returned ${response.status}`);
        }
        try { return await response.json(); } catch { throw invalidResponse(); }
      };
      // The state endpoint answers 200 either way and names a user only for a
      // live console session, so it doubles as the session check.
      const state = await call(STATE_URL);
      const userId = typeof state?.userId === 'string' ? state.userId.trim() : '';
      if (!userId || userId.length > 128) throw errorWithStatus('unauthorized', 'CodingPass session expired');
      identity = { accountKey: hashKey('codingpass', userId) };
      // End the optional wallet wait before the probe deadline even after a slow session check.
      const remainingMs = deadlineMs - (performance.now() - startedAt);
      const walletDeadlineMs = Math.min(WALLET_TIMEOUT_MS, Math.floor(remainingMs / 2));
      const [usage, wallet] = await Promise.all([
        call(USAGE_URL, JSON.stringify({ json: {} })),
        walletDeadlineMs > 0
          ? runWithProbeDeadline(({ signal: walletSignal }) => call(WALLET_URL, '{}', walletSignal),
            { signal, deadlineMs: walletDeadlineMs }).catch(() => null)
          : null
      ]);
      const parsed = parseCodingpassUsage(unwrapRpc(usage));
      let balance;
      try { balance = parseCodingpassWallet(unwrapRpc(wallet)); } catch { balance = null; }
      return { ...parsed, balance };
    }, { signal: deps.signal, deadlineMs: deps.codingpassFetchTimeoutMs || 15000 });
    return normalizeLimitProvider({
      ...base,
      ...identity,
      status: 'ok',
      planLabel: reading.planLabel,
      windows: reading.balance
        ? [...reading.windows, { kind: 'billing', metric: 'credits', label: 'Wallet', remaining: reading.balance.amount,
          currency: 'USD', showMeter: false }]
        : reading.windows,
      ...(reading.balance ? { balance: reading.balance } : {})
    });
  } catch (error) {
    const status = ['unauthorized', 'sourceRateLimited'].includes(error?.status) ? error.status : 'unavailable';
    return normalizeLimitProvider({ ...base, ...identity, status });
  }
}

// A key from the session's user id is a proven server identity; the
// credential-hash fallback is not.
function isCodingpassServerAccountKey(key, values) {
  return Boolean(key && key !== hashKey('codingpass', codingpassCookie({}, values)));
}

module.exports = {
  CODINGPASS_ORIGIN,
  codingpassCookie,
  fetchCodingpassLimits,
  isCodingpassServerAccountKey,
  normalizeCodingpassCookieHeader,
  parseCodingpassUsage,
  parseCodingpassWallet
};
