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
    const spend = recordConsumption(
      { accountKey, currency: row.currency, paid: row.paid, now, storePath, legacyStorePath },
      deps
    );
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
        monthSinceTracking: spend.monthSinceTracking
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
  selectFundedRow
};
