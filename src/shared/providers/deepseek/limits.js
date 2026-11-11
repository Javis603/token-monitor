'use strict';

// DeepSeek limits provider: the API-key balance read, and the derived spend it
// records through ./balanceHistory.js. Reached through providerFetchers() in
// src/shared/limits/collector.js.

const path = require('node:path');
const { recordConsumption } = require('./balanceHistory');
const { sharedDataDir } = require('../../config');
const {
  normalizeLimitProvider
} = require('../../limits/core');
const { hashKey } = require('../../hashKey');
const {
  cleanSecret,
  errorWithStatus,
  fetchJson,
  nowIso,
  numberOrNull,
  providerStatusFromError
} = require('../../limits/providerHelpers');

function deepseekToken(env = process.env, explicitKey = '') {
  const explicit = cleanSecret(explicitKey);
  if (explicit) return explicit;
  for (const name of ['DEEPSEEK_API_KEY', 'DEEPSEEK_KEY']) {
    const raw = cleanSecret(env[name]);
    if (raw) return raw;
  }
  return '';
}

// rows: balance_infos from /user/balance. Returns { currency, amount(total), paid(topped_up) }.
function selectFundedRow(rows) {
  const parsed = [];
  for (const row of rows || []) {
    const amount = Number(row && row.total_balance);
    const paid = Number(row && row.topped_up_balance);
    const currency = String((row && row.currency) || '').trim().toUpperCase();
    if (!Number.isFinite(amount) || !Number.isFinite(paid) || !currency) continue;
    parsed.push({ currency, amount, paid });
  }
  if (parsed.length === 0) throw errorWithStatus('unavailable', 'no usable balance rows');
  const funded = parsed
    .filter((r) => r.amount > 0)
    .sort((a, b) => (b.amount - a.amount) || (a.currency === 'USD' ? -1 : b.currency === 'USD' ? 1 : 0));
  if (funded.length) return funded[0];
  return parsed.find((r) => r.currency === 'USD') || parsed[0];
}

const DEEPSEEK_BALANCE_URL = 'https://api.deepseek.com/user/balance';
// Private console endpoint: needs a signed-in session token, read for the current month only.
const DEEPSEEK_CONSOLE_COST_URL = 'https://platform.deepseek.com/api/v0/usage/by_api_key/cost';

// Accept a bare or pasted Authorization token; reject anything that is not one.
function normalizeDeepseekWebToken(value) {
  const raw = cleanSecret(value).replace(/^authorization\s*:\s*/iu, '').replace(/^bearer\s+/iu, '').trim();
  return /[\u0000-\u001f\u007f;\s]/u.test(raw) ? '' : raw;
}

const CONSOLE_TOOL_NAMES = {
  searchSpend: ['server-tool-search', 'tool-search'],
  fetchSpend: ['server-tool-fetch', 'tool-fetch']
};

async function fetchToolSpends(token, { accountKey, currency, now }, deps) {
  if (!token || deps.probe) return null;
  const date = new Date(now);
  const tz = -date.getTimezoneOffset() * 60;
  // Both boundaries use one fixed console offset, including across DST changes.
  const window = {
    start: Date.UTC(date.getFullYear(), date.getMonth(), 1) / 1000 - tz,
    end: Date.UTC(date.getFullYear(), date.getMonth(), date.getDate() + 1) / 1000 - tz,
    tz
  };
  const state = deps.providerRuntimeState instanceof Map ? deps.providerRuntimeState : null;
  const cacheKey = hashKey('deepseek-console', accountKey, token, currency);
  const cached = state?.get(cacheKey);
  if (cached?.start === window.start && cached.expiresAt > now) return cached.toolSpends;
  try {
    const body = await fetchJson(`${DEEPSEEK_CONSOLE_COST_URL}?${new URLSearchParams(window)}`, { Authorization: `Bearer ${token}` }, deps);
    const data = body?.data?.biz_data;
    if (body?.code !== 0 || body?.data?.biz_code !== 0 || data?.start !== window.start || data?.end !== window.end) return null;
    const row = (data.data || []).find((item) => String(item?.currency || '').toUpperCase() === currency);
    // Prefer a non-empty `series` over `function_series`; a row with neither is malformed.
    const lists = [row?.series, row?.function_series].filter(Array.isArray);
    if (!lists.length) return null;
    const list = lists.find((items) => items.length) || [];
    const toolSpends = {};
    for (const [key, names] of Object.entries(CONSOLE_TOOL_NAMES)) {
      const costs = list.filter((item) => names.includes(item?.model))
        .flatMap((item) => item.buckets.map((bucket) => numberOrNull(bucket?.cost)));
      if (costs.includes(null)) return null;
      const total = costs.reduce((sum, cost) => sum + cost, 0);
      if (total > 0) toolSpends[key] = total;
    }
    state?.set(cacheKey, { start: window.start, expiresAt: now + 60 * 60_000, toolSpends });
    return toolSpends;
  } catch {
    // Optional console failures leave the balance intact and retry next refresh.
    return null;
  }
}

async function fetchDeepSeekLimits(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const now = (deps.now || Date.now)();
  const key = deepseekToken(env, options.deepseekApiKey);
  if (!key) {
    return normalizeLimitProvider({ provider: 'deepseek', source: 'api', status: 'notConfigured', updatedAt: nowIso(now), windows: [] });
  }
  try {
    const data = await fetchJson(DEEPSEEK_BALANCE_URL, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, deps);
    if (!data || !Array.isArray(data.balance_infos)) {
      throw errorWithStatus('unavailable', 'unexpected balance response shape');
    }
    const row = selectFundedRow(data.balance_infos);
    const accountKey = hashKey('deepseek', key);
    const dataDir = sharedDataDir({ env });
    const storePath = deps.deepseekStorePath || path.join(dataDir, 'deepseek-balance-v2.json');
    const legacyStorePath = deps.deepseekLegacyStorePath
      || (deps.deepseekStorePath ? null : path.join(dataDir, 'deepseek-balance.json'));
    // A save-time probe checks a credential that is not stored yet, so it must
    // not add a sample to the spend history the collector derives from.
    const spend = deps.probe ? {} : recordConsumption(
      { accountKey, currency: row.currency, paid: row.paid, now, storePath, legacyStorePath },
      deps
    );
    const webToken = normalizeDeepseekWebToken(options.deepseekWebToken);
    const toolSpends = await fetchToolSpends(webToken, { accountKey, currency: row.currency, now }, deps);
    return normalizeLimitProvider({
      provider: 'deepseek',
      accountKey,
      accountLabel: 'Pay-as-you-go',
      source: 'api',
      status: 'ok',
      updatedAt: nowIso(now),
      // DeepSeek has no rate-limit windows. The balance is the only quota it
      // exposes, so it ships as a credits window: money, no wire percentage.
      windows: [{
        kind: 'billing',
        metric: 'credits',
        label: 'Balance',
        remaining: row.amount,
        currency: row.currency
      }],
      balance: {
        amount: row.amount,
        currency: row.currency,
        todaySpend: spend.todaySpend,
        weekSpend: spend.weekSpend,
        monthSpend: spend.monthSpend,
        allTimeSpend: spend.allTimeSpend,
        trackingSince: spend.trackingSince,
        monthSinceTracking: spend.monthSinceTracking,
        ...(toolSpends || {})
      }
    });
  } catch (error) {
    return normalizeLimitProvider({
      provider: 'deepseek',
      source: 'api',
      status: providerStatusFromError(error),
      updatedAt: nowIso(now),
      windows: []
    });
  }
}

module.exports = {
  deepseekToken,
  fetchDeepSeekLimits,
  normalizeDeepseekWebToken,
  selectFundedRow
};
