'use strict';

const { normalizeLimitProvider } = require('../../limits/core');
const { errorWithStatus, providerStatusFromError } = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { runWithProbeDeadline } = require('../../probeDeadline');
const { BROWSER_USER_AGENT } = require('../../browserUserAgent');

const ORIGIN = 'https://console.typesafe.ai';
const BILLING_URL = `${ORIGIN}/settings/billing`;
const USAGE_URL = `${ORIGIN}/api/usage?granularity=hour`;
// Fallbacks only — the live rates are scraped from the Console bundle's
// INPUT_TOKEN_COST_USD / OUTPUT_TOKEN_COST_USD constants during the same
// chunk scan that discovers the billing action.
const INPUT_USD_PER_TOKEN = 0.042 / 1_000_000;
const OUTPUT_USD_PER_TOKEN = 0;
const ACTION_PATTERN = /"([0-9a-f]{40,})"[^)]{0,150}"getBillingOverviewResult"/i;
const MAX_CHUNKS = 60;
const ACTION_TTL_MS = 12 * 60 * 60 * 1000;
let cachedActionId = '';
let cachedRates = null;
let actionExpiresAt = 0;

// 'free_plan' → 'Free', 'pro_plan' → 'Pro'; unknown ids still read as words
// rather than rendering as a raw enum or, worse, a blank badge.
function planLabel(plan) {
  const cleaned = String(plan || '').trim().replace(/_plan$/i, '').replace(/_/g, ' ').trim();
  if (!cleaned) return '';
  return cleaned.replace(/\b\w/g, (ch) => ch.toUpperCase());
}

function activeCreditGrants(credits, now) {
  if (!Array.isArray(credits)) return [];
  return credits
    .filter((credit) => credit && typeof credit === 'object')
    .map((credit) => ({ amount: credit.remaining, expiresAt: credit.expiresAt }))
    .filter(({ amount, expiresAt }) => Number.isFinite(amount) && amount > 0
      && typeof expiresAt === 'string' && Number.isFinite(Date.parse(expiresAt))
      && Date.parse(expiresAt) > now)
    .sort((left, right) => Date.parse(left.expiresAt) - Date.parse(right.expiresAt))
    .slice(0, 24)
    .map(({ amount, expiresAt }) => ({ amount, currency: 'USD', expiresAt: new Date(expiresAt).toISOString() }));
}

function typesafeCookie(env = process.env, options = {}) {
  let value = String(options.typesafeCookie || env?.TOKEN_MONITOR_TYPESAFE_COOKIE || env?.TYPESAFE_COOKIE || '').trim();
  if (/^Cookie\s*:/i.test(value)) value = value.replace(/^Cookie\s*:/i, '').trim();
  if (!value || /[\u0000-\u001f\u007f]/u.test(value)) return '';
  const pairs = value.split(';').filter((part) => part.trim()).map((part) => {
    const separator = part.indexOf('=');
    if (separator <= 0) return null;
    const name = part.slice(0, separator).trim();
    const cookieValue = part.slice(separator + 1).trim();
    // Empty cookie values are valid.
    return /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/u.test(name) ? `${name}=${cookieValue}` : null;
  });
  return pairs.length && pairs.every(Boolean) ? pairs.join('; ') : '';
}

function responseError(response) {
  if (response.type === 'opaqueredirect' || response.status === 401 || response.status === 403 || (response.status >= 300 && response.status < 400)) {
    return errorWithStatus('unauthorized', 'TypeSafe session expired');
  }
  if (response.status === 429) return errorWithStatus('sourceRateLimited', 'TypeSafe rate limited');
  return errorWithStatus('unavailable', `TypeSafe returned ${response.status}`);
}

async function readResponse(response, kind) {
  if (!response.ok || response.type === 'opaqueredirect') throw responseError(response);
  const body = await response.text();
  if ((/\b(?:sign in|log in)\b/i.test(body.slice(0, 5000)) && /<html/i.test(body.slice(0, 500)))
    || /\\?"\(auth\)\\?",\{\\?"children\\?":\[\\?"login\\?"/u.test(body)) {
    throw errorWithStatus('unauthorized', 'TypeSafe session expired');
  }
  if (kind === 'json') {
    try { return JSON.parse(body); } catch { throw errorWithStatus('unavailable', 'Invalid TypeSafe usage response'); }
  }
  return body;
}

function request(fetchImpl, url, cookie, options = {}) {
  if (!url.startsWith(`${ORIGIN}/`)) throw errorWithStatus('unavailable', 'Unexpected TypeSafe origin');
  return fetchImpl(url, {
    ...options,
    credentials: 'omit',
    redirect: 'manual',
    headers: { Cookie: cookie, 'User-Agent': BROWSER_USER_AGENT, ...options.headers }
  });
}

// The bundle registers rates as t.s(["INPUT_TOKEN_COST_USD",0,gt,...]) where
// the value is either a literal or a minified variable assigned earlier as
// name=.042/1e6 (USD per token). Resolve both shapes, evaluating a single
// division; anything else stays null so the caller falls back to the last
// observed constant.
function escapeRegExp(text) {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractRate(chunk, name) {
  const entry = new RegExp(`"${escapeRegExp(name)}"\\s*,\\s*[\\w$.eE+-]+\\s*,\\s*([\\w$.eE+-]+)`).exec(chunk);
  if (!entry) return null;
  const raw = entry[1];
  if (/^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/u.test(raw)) return Number(raw);
  if (!/^[\w$]+$/u.test(raw)) return null;
  const assignments = new RegExp(`(?:^|[^\\w$])${escapeRegExp(raw)}\\s*=\\s*([\\d.eE+-]+(?:\\s*\\/\\s*[\\d.eE+-]+)?)`, 'g');
  let latestAssignment = null;
  for (const match of chunk.slice(0, entry.index).matchAll(assignments)) latestAssignment = match[1];
  if (!latestAssignment) return null;
  const [numerator, denominator] = latestAssignment.split('/').map((part) => Number(part));
  if (denominator !== undefined && (!Number.isFinite(denominator) || denominator === 0)) return null;
  const value = denominator === undefined ? numerator : numerator / denominator;
  return Number.isFinite(value) ? value : null;
}

async function discoverBilling(fetchImpl, cookie, signal) {
  const html = await readResponse(await request(fetchImpl, BILLING_URL, cookie, {
    headers: { Accept: 'text/html' }, signal
  }), 'text');
  const urls = [...html.matchAll(/<script\b[^>]*\bsrc=["']([^"']+)["'][^>]*>/gi)]
    .map((match) => new URL(match[1], ORIGIN).href)
    .filter((url) => url.startsWith(`${ORIGIN}/`) && /\.js(?:$|\?)/i.test(url));
  let actionId = '';
  let inputRate = null;
  let outputRate = null;
  for (const url of [...new Set(urls)].slice(0, MAX_CHUNKS)) {
    const response = await request(fetchImpl, url, cookie, { signal });
    if (!response.ok) continue;
    const chunk = await response.text();
    if (!actionId) actionId = ACTION_PATTERN.exec(chunk)?.[1] || '';
    if (inputRate === null) inputRate = extractRate(chunk, 'INPUT_TOKEN_COST_USD');
    if (outputRate === null) outputRate = extractRate(chunk, 'OUTPUT_TOKEN_COST_USD');
    if (actionId && inputRate !== null && outputRate !== null) break;
  }
  if (!actionId) throw errorWithStatus('unavailable', 'TypeSafe billing action unavailable');
  cachedActionId = actionId;
  cachedRates = {
    input: inputRate === null ? INPUT_USD_PER_TOKEN : inputRate,
    output: outputRate === null ? OUTPUT_USD_PER_TOKEN : outputRate
  };
  actionExpiresAt = Date.now() + ACTION_TTL_MS;
  return { actionId, rates: cachedRates };
}

async function billingAction(fetchImpl, cookie, signal) {
  let session = cachedActionId && cachedRates && Date.now() < actionExpiresAt
    ? { actionId: cachedActionId, rates: cachedRates }
    : await discoverBilling(fetchImpl, cookie, signal);
  const post = (id) => request(fetchImpl, BILLING_URL, cookie, {
    method: 'POST',
    headers: {
      Origin: ORIGIN,
      'Next-Action': id,
      Accept: 'text/x-component',
      'Content-Type': 'application/json'
    },
    body: '[]',
    signal
  });
  let response = await post(session.actionId);
  if (response.status === 404 && response.headers.get('x-nextjs-action-not-found') === '1') {
    cachedActionId = '';
    session = await discoverBilling(fetchImpl, cookie, signal);
    response = await post(session.actionId);
  }
  const body = await readResponse(response, 'text');
  for (const line of body.split(/\r?\n/u)) {
    const separator = line.indexOf(':');
    if (separator < 1) continue;
    let result;
    try { result = JSON.parse(line.slice(separator + 1)); } catch { continue; }
    if (!result || typeof result !== 'object' || !Object.hasOwn(result, 'ok')) continue;
    if (result.ok !== true) throw errorWithStatus('unavailable', 'TypeSafe billing request failed');
    const billing = result.data?.billing;
    if (!billing || typeof billing.balance !== 'number' || !Number.isFinite(billing.balance)) {
      throw errorWithStatus('unavailable', 'TypeSafe billing balance missing');
    }
    return { billing, rates: session.rates };
  }
  throw errorWithStatus('unavailable', 'TypeSafe billing response changed');
}

function parseUsage(body, now, rates = {}) {
  if (!body || !Array.isArray(body.buckets)) throw errorWithStatus('unavailable', 'TypeSafe usage response changed');
  const inputRate = Number.isFinite(rates.input) ? rates.input : INPUT_USD_PER_TOKEN;
  const outputRate = Number.isFinite(rates.output) ? rates.output : OUTPUT_USD_PER_TOKEN;
  const dayKey = (date) => `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
  const current = new Date(now);
  const today = dayKey(current);
  const firstWeekDay = new Date(now);
  firstWeekDay.setHours(0, 0, 0, 0);
  firstWeekDay.setDate(firstWeekDay.getDate() - 6);
  const weekStart = dayKey(firstWeekDay);
  const monthStart = dayKey(new Date(current.getFullYear(), current.getMonth(), 1));
  const totals = { today: 0, week: 0, month: 0, monthInput: 0, monthOutput: 0, monthRequests: 0, monthCost: 0 };
  for (const bucket of body.buckets) {
    const timestamp = String(bucket?.day || '');
    const date = /^\d{4}-\d{2}-\d{2}T/u.test(timestamp) ? new Date(timestamp) : null;
    const day = date && !Number.isNaN(date.getTime()) ? dayKey(date) : '';
    const input = bucket?.inputTokens;
    const output = bucket?.outputTokens;
    const requests = bucket?.requests;
    if (!day
      || ![input, output, requests].every((n) => Number.isSafeInteger(n) && n >= 0)) {
      throw errorWithStatus('unavailable', 'Invalid TypeSafe usage bucket');
    }
    const spend = input * inputRate + output * outputRate;
    if (day === today) totals.today += input + output;
    if (day >= weekStart && day <= today) {
      totals.week += input + output;
    }
    if (day >= monthStart && day <= today) {
      totals.month += input + output;
      totals.monthInput += input;
      totals.monthOutput += output;
      totals.monthRequests += requests;
      totals.monthCost += spend;
    }
  }
  return totals;
}

async function fetchTypesafeLimits(options = {}, deps = {}) {
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  const cookie = typesafeCookie(deps.env || process.env, options);
  const base = { provider: 'typesafe', source: 'web', updatedAt };
  if (!cookie) return normalizeLimitProvider({ ...base, status: 'notConfigured', windows: [] });
  try {
    return await runWithProbeDeadline(async ({ signal }) => {
      const fetchImpl = deps.fetch || fetch;
      const { billing, rates } = await billingAction(fetchImpl, cookie, signal);
      const usageBody = await readResponse(
        await request(fetchImpl, USAGE_URL, cookie, { headers: { Accept: 'application/json' }, signal }),
        'json'
      );
      const usage = parseUsage(usageBody, now, rates);
      const tranches = activeCreditGrants(billing.credits, now);
      return normalizeLimitProvider({
        ...base,
        status: 'ok',
        accountKey: hashKey('typesafe', cookie),
        accountLabel: planLabel(billing.plan),
        // TypeSafe has no rate-limit windows. The balance ships as a credits
        // window; the meter derives from this month's estimated spend.
        // Billing's resetsInDays is not the credit expiry shown by the Console.
        // Individual credit grants carry their own expiry dates.
        windows: [{
          kind: 'billing',
          metric: 'credits',
          label: 'Balance',
          remaining: billing.balance,
          currency: 'USD',
          ...(tranches.length > 0 ? { resetsAt: tranches[0].expiresAt, boundaryKind: 'expiry' } : {})
        }],
        balance: { amount: billing.balance, currency: 'USD', monthSpend: usage.monthCost,
          tranches },
        usageSummary: { period: 'month', todayTokens: usage.today, weekTokens: usage.week,
          inputTokens: usage.monthInput, outputTokens: usage.monthOutput,
          totalTokens: usage.month, requests: usage.monthRequests, standardCost: usage.monthCost }
      });
    }, { signal: deps.signal, deadlineMs: Number(deps.typesafeFetchTimeoutMs || 15000) });
  } catch (error) {
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error), windows: [] });
  }
}

function resetBillingCache() {
  cachedActionId = '';
  cachedRates = null;
  actionExpiresAt = 0;
}

module.exports = { fetchTypesafeLimits, parseUsage, typesafeCookie, resetBillingCache };
