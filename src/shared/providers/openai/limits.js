'use strict';

// OpenAI has no remaining-credit endpoint. This estimates one linked ChatGPT
// Pro API-credit grant: the published full-period allowance minus organization
// Costs since the UTC monthly renewal anchor. It is not the billing-page balance.

const { hashKey } = require('../../hashKey');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  cleanSecret,
  errorWithStatus,
  fetchJson,
  nowIso,
  numberOrNull,
  providerStatusFromError
} = require('../../limits/providerHelpers');

const COSTS_URL = 'https://api.openai.com/v1/organization/costs';
const MAX_COST_PAGES = 8;
const KEY_ENV = ['TOKEN_MONITOR_OPENAI_ADMIN_KEY', 'OPENAI_ADMIN_KEY'];
const PLAN_ENV = ['TOKEN_MONITOR_OPENAI_SUBSCRIPTION_PLAN', 'OPENAI_SUBSCRIPTION_PLAN'];
const RENEWAL_ENV = ['TOKEN_MONITOR_OPENAI_SUBSCRIPTION_RENEWAL', 'OPENAI_SUBSCRIPTION_RENEWAL'];

const OPENAI_PLANS = Object.freeze({
  pro5x: Object.freeze({ id: 'pro5x', allowanceUsd: 100, label: 'Pro 5x' }),
  pro20x: Object.freeze({ id: 'pro20x', allowanceUsd: 200, label: 'Pro 20x' }),
  pro50x: Object.freeze({ id: 'pro50x', allowanceUsd: 500, label: 'Pro 50x' })
});

const PLAN_ALIASES = Object.freeze({
  pro5x: 'pro5x',
  'pro-5x': 'pro5x',
  '5x': 'pro5x',
  pro100: 'pro5x',
  'pro-100': 'pro5x',
  pro20x: 'pro20x',
  'pro-20x': 'pro20x',
  '20x': 'pro20x',
  pro200: 'pro20x',
  'pro-200': 'pro20x',
  pro50x: 'pro50x',
  'pro-50x': 'pro50x',
  '50x': 'pro50x',
  pro500: 'pro50x',
  'pro-500': 'pro50x'
});

function firstEnv(env, names) {
  for (const name of names) {
    const raw = env?.[name];
    if (raw) return raw;
  }
  return '';
}

function openaiAdminKey(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  return cleanSecret(firstEnv(env, KEY_ENV));
}

function canonicalPlanId(value) {
  const key = String(value || '').trim().toLowerCase().replace(/[\s_]+/g, '-');
  if (!key) return '';
  return PLAN_ALIASES[key] || '';
}

function openaiPlan(value) {
  const id = canonicalPlanId(value);
  return id ? OPENAI_PLANS[id] : null;
}

function normalizeOpenaiPlan(value) {
  if (value === '' || value === undefined || value === null) return '';
  const id = canonicalPlanId(value);
  if (id) return id;
  const error = new Error('OpenAI plan must be pro5x, pro20x, or pro50x');
  error.code = 'OPENAI_PLAN_INVALID';
  throw error;
}

function parseRenewalDate(value) {
  const raw = String(value || '').trim();
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(raw);
  if (!match) return '';
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const utc = new Date(Date.UTC(year, month - 1, day));
  if (
    utc.getUTCFullYear() !== year
    || utc.getUTCMonth() !== month - 1
    || utc.getUTCDate() !== day
  ) return '';
  return raw;
}

function normalizeOpenaiRenewalDate(value) {
  if (value === '' || value === undefined || value === null) return '';
  const parsed = parseRenewalDate(value);
  if (parsed) return parsed;
  const error = new Error('OpenAI renewal date must be YYYY-MM-DD');
  error.code = 'OPENAI_RENEWAL_DATE_INVALID';
  throw error;
}

function daysInMonth(year, month) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function occurrenceMs(year, month, anchorDay) {
  return Date.UTC(year, month - 1, Math.min(anchorDay, daysInMonth(year, month)));
}

// The configured date only supplies the day of month. The period containing
// `now` is [start, end) in UTC. A short month clamps that one occurrence and
// the original day returns in the next longer month.
function openaiBillingPeriod(nowMs, anchorDate) {
  const anchor = parseRenewalDate(anchorDate);
  if (!anchor) return null;
  const now = Number(nowMs);
  if (!Number.isFinite(now)) return null;
  const anchorDay = Number(anchor.slice(8, 10));
  const date = new Date(now);
  let year = date.getUTCFullYear();
  let month = date.getUTCMonth() + 1;
  if (now < occurrenceMs(year, month, anchorDay)) {
    month -= 1;
    if (month === 0) {
      month = 12;
      year -= 1;
    }
  }
  const startMs = occurrenceMs(year, month, anchorDay);
  let endMonth = month + 1;
  let endYear = year;
  if (endMonth === 13) {
    endMonth = 1;
    endYear += 1;
  }
  return { startMs, endMs: occurrenceMs(endYear, endMonth, anchorDay), anchorDay };
}

function costsQueryEndMs(nowMs, periodEndMs) {
  const now = new Date(nowMs);
  const nextMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
  return Math.min(periodEndMs, nextMidnight);
}

function toMicro(value) {
  const number = numberOrNull(value);
  if (number === null) return null;
  return Math.round(number * 1e6);
}

function fromMicro(micro) {
  return micro / 1e6;
}

function bucketCostMicro(bucket, periodStartSec, periodEndSec) {
  const start = numberOrNull(bucket?.start_time);
  if (start === null) throw errorWithStatus('unavailable', 'OpenAI Costs API returned an unreadable bucket');
  if (start < periodStartSec || start >= periodEndSec) return 0;
  const results = bucket?.results;
  if (!Array.isArray(results) || results.length === 0) return 0;
  let spent = 0;
  for (const row of results) {
    const currency = String(row?.amount?.currency || '').trim().toLowerCase();
    if (currency !== 'usd') throw errorWithStatus('unavailable', 'OpenAI Costs API returned a non-USD amount');
    const micro = toMicro(row?.amount?.value);
    if (micro === null || micro < 0) throw errorWithStatus('unavailable', 'OpenAI Costs API returned an unreadable amount');
    spent += micro;
  }
  return spent;
}

async function fetchPeriodSpendMicro({ apiKey, period, now, deps }) {
  const startSec = Math.floor(period.startMs / 1000);
  const endMs = costsQueryEndMs(now, period.endMs);
  const endSec = Math.floor(endMs / 1000);
  if (endSec <= startSec) return 0;
  let page = '';
  let spent = 0;
  for (let index = 0; index < MAX_COST_PAGES; index += 1) {
    const url = new URL(COSTS_URL);
    url.searchParams.set('start_time', String(startSec));
    url.searchParams.set('end_time', String(endSec));
    url.searchParams.set('bucket_width', '1d');
    url.searchParams.set('limit', '62');
    if (page) url.searchParams.set('page', page);
    const body = await fetchJson(url.toString(), {
      Authorization: `Bearer ${apiKey}`,
      Accept: 'application/json'
    }, deps, { forbiddenIsUnauthorized: true });
    if (!Array.isArray(body?.data)) throw errorWithStatus('unavailable', 'OpenAI Costs API returned an unreadable page');
    for (const bucket of body.data) spent += bucketCostMicro(bucket, startSec, Math.floor(period.endMs / 1000));
    if (!body.has_more) return spent;
    page = typeof body.next_page === 'string' ? body.next_page : '';
    if (!page) throw errorWithStatus('unavailable', 'OpenAI Costs API page was incomplete');
  }
  throw errorWithStatus('unavailable', 'OpenAI Costs API page was incomplete');
}

function notConfigured(now) {
  return normalizeLimitProvider({
    provider: 'openai',
    source: 'api',
    status: 'notConfigured',
    updatedAt: nowIso(now),
    windows: []
  });
}

async function fetchOpenaiLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const apiKey = openaiAdminKey(env, options.openaiAdminKey);
  const plan = openaiPlan(options.openaiPlan || firstEnv(env, PLAN_ENV));
  const renewal = parseRenewalDate(options.openaiRenewalDate || firstEnv(env, RENEWAL_ENV));
  const period = openaiBillingPeriod(now, renewal);
  if (!apiKey || !plan || !period) return notConfigured(now);
  try {
    const spentMicro = await fetchPeriodSpendMicro({ apiKey, period, now, deps });
    const allowanceMicro = Math.round(plan.allowanceUsd * 1e6);
    const remainingMicro = Math.max(0, allowanceMicro - spentMicro);
    const remaining = fromMicro(remainingMicro);
    return normalizeLimitProvider({
      provider: 'openai',
      accountKey: hashKey('openai', apiKey),
      accountLabel: plan.label,
      planLabel: plan.label,
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      windows: [{
        kind: 'billing',
        metric: 'credits',
        label: 'API credit',
        boundaryKind: 'expiry',
        used: fromMicro(spentMicro),
        limit: plan.allowanceUsd,
        remaining,
        currency: 'USD',
        resetsAt: new Date(period.endMs).toISOString(),
        detail: 'Estimate: Pro allowance minus Costs since renewal. Not the billing balance.'
      }],
      balance: { amount: remaining, currency: 'USD' }
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'openai',
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt: nowIso(now),
      windows: []
    });
  }
}

module.exports = {
  fetchOpenaiLimits,
  normalizeOpenaiPlan,
  normalizeOpenaiRenewalDate,
  openaiAdminKey,
  openaiBillingPeriod,
  openaiPlan
};
