'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');

const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret, numberOrNull: parseNumberOrNull, errorWithStatus, envValue, pathApiForPlatform, uniqueStrings } = require('../../limits/providerHelpers');
const { runCapturedCliProcess } = require('../../limits/cliProcess');
const { hashKey } = require('../../hashKey');
const { mcodeDataDirs } = require('../mcode/paths');

const MINIMAX_KEY_NAMES = ['MINIMAX_CODING_API_KEY'];

const MINIMAX_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains';
const MINIMAX_REMAINS_URL_EN = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/token_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_EN = 'https://api.minimax.io/v1/token_plan/remains';
const MINIMAX_BALANCE_URL_CN = 'https://api.minimaxi.com/account/query_balance';
const MINIMAX_BALANCE_URL_EN = 'https://api.minimax.io/account/query_balance';

const MINIMAX_CODE_MEMBERSHIP_URL_CN = 'https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_MEMBERSHIP_URL_INTL = 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_PLAN_REMAINS_URL_CN = 'https://www.minimaxi.com/backend/account/token_plan/remains_percent';
const MINIMAX_CODE_PLAN_REMAINS_URL_INTL = 'https://platform.minimax.io/backend/account/token_plan/remains_percent';

const MINIMAX_CODE_GROUP_STATE_KEY = 'minimax.code.group';

const MINIMAX_WINDOW_MINUTES_5H = 5 * 60;
const MINIMAX_WINDOW_MINUTES_WEEKLY = 7 * 24 * 60;

const MINIMAX_REGIONS = ['en', 'cn'];

// Only a successful quota reading establishes region affinity.
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

// JSON syntax errors establish a response; they must not trigger regional
// transport recovery. A disconnected body still permits that recovery.
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

function millisToIso8601(value) {
  const ms = parseNumberOrNull(value);
  if (ms === null) return null;
  // Compatibility cutoff: numeric epochs below 1e12 are interpreted as seconds.
  const normalized = ms < 1_000_000_000_000 ? ms * 1000 : ms;
  const date = new Date(normalized);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

// Token Plan and Code responses expose model_remains under data or at the
// top level. Prefer the nested shape when both are present.
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

// Token Plan's coding quota is the general bucket; video and voice are separate pools.
function selectMinimaxGeneralBucket(body) {
  const rows = readMinimaxRows(body);
  if (!rows) return null;
  return rows.find((row) => row && row.model_name === 'general') || null;
}

// Preserve the API-key placeholder rule for status 3 with missing/100%
// remaining. Code's different endpoint uses status 3 for unlimited quota.
// Missing status fields do not invalidate a usable Token Plan percentage.
function parseMinimaxTiers(body) {
  const item = selectMinimaxGeneralBucket(body);
  if (!item) return [];
  const windows = [];
  for (const [prefix, kind, label, resetField, windowMinutes] of [
    ['current_interval', 'session', '5h', 'end_time', MINIMAX_WINDOW_MINUTES_5H],
    ['current_weekly', 'weekly', 'Weekly', 'weekly_end_time', MINIMAX_WINDOW_MINUTES_WEEKLY]
  ]) {
    const remaining = parseNumberOrNull(item[`${prefix}_remaining_percent`]);
    if (remaining === null || (parseNumberOrNull(item[`${prefix}_status`]) === 3 && remaining >= 100)) continue;
    windows.push({
      kind, label,
      usedPercent: Math.max(0, Math.min(100, 100 - remaining)),
      remainingPercent: Math.max(0, Math.min(100, remaining)),
      resetsAt: millisToIso8601(item[resetField]),
      windowMinutes, showMeter: true
    });
  }
  return windows;
}

function minimaxCodeCredits(value) {
  const raw = typeof value === 'number' || typeof value === 'string' ? String(value).replace(/,/g, '').trim() : '';
  return /^\d+(?:\.\d+)?$/.test(raw) ? parseNumberOrNull(raw) : null;
}

// Code's current M Plan endpoint reports used/total percentages, unlike the
// API-key Token Plan endpoint. Status 3 here explicitly means unlimited.
function parseMinimaxCodePlan(body) {
  const rows = readMinimaxRows(body);
  if (!rows) return [];
  const isVideo = (row) => /video/i.test(row?.model_name || '');
  const general = rows.find(row => row?.model_name === 'general') || rows.find(row => row && !isVideo(row)) || rows[0];
  const percent = value => parseNumberOrNull(typeof value === 'string' ? value.trim().replace(/%$/, '') : value);
  const windows = [];
  for (const [prefix, kind, label, resetField, windowMinutes] of [
    ['current_interval', 'session', '5h', 'end_time', MINIMAX_WINDOW_MINUTES_5H],
    ['current_weekly', 'weekly', 'Weekly', 'weekly_end_time', MINIMAX_WINDOW_MINUTES_WEEKLY]
  ]) {
    if (!general) break;
    const unlimited = parseNumberOrNull(general[`${prefix}_status`]) === 3;
    const used = percent(general[`${prefix}_used_percent`]);
    const reportedTotal = percent(general[`${prefix}_total_percent`]);
    const total = reportedTotal > 0 ? reportedTotal : 100;
    if (!unlimited && used === null) continue;
    windows.push({
      kind, label, resetsAt: millisToIso8601(general[resetField]), windowMinutes,
      ...(unlimited
        ? { detail: 'unlimited', showMeter: false }
        : { usedPercent: used / total * 100, showMeter: true })
    });
  }
  const video = rows.find(row => isVideo(row) && parseNumberOrNull(row.current_interval_total_count) > 0);
  if (video) {
    const unlimited = parseNumberOrNull(video.current_interval_status) === 3;
    const used = parseNumberOrNull(video.current_interval_used_count);
    const limit = parseNumberOrNull(video.current_interval_total_count);
    if (unlimited || used !== null) {
      windows.push({
        kind: 'weekly', label: 'Video', resetsAt: millisToIso8601(video.end_time),
        ...(unlimited ? { detail: 'unlimited', showMeter: false } : {
          used, limit, remaining: Math.max(0, limit - used), showMeter: true
        })
      });
    }
  }
  return windows;
}

// Persistence must not turn an implicit environment choice into a stored pin.
// minimaxApiHost remains a supported legacy region setting.
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
  return raw === 'api' ? 'api' : 'token-plan';
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

async function minimaxCashSpend(balanceUrl, headers, fetchJson, deps, now) {
  const today = new Date(now);
  const week = new Date(now);
  week.setDate(week.getDate() - 6);
  const month = new Date(now);
  month.setDate(1);
  const day = date => date.toLocaleDateString('en-CA');
  // Post-voucher server totals exclude gifts. Neither recharge amounts nor
  // balance deltas establish cash spending in a calendar period.
  const specs = [['todaySpend', today], ['weekSpend', week], ['monthSpend', month]].map(([key, start]) =>
    [key, { page: 1, limit: 10, aggregate: true, start_date: day(start), end_date: day(today) }]);
  specs.push(['allTimeSpend', { page_num: 1, page_size: 10 }]);
  const requests = new Map();
  const results = await Promise.allSettled(specs.map(async ([key, params]) => {
    const cumulative = key === 'allTimeSpend';
    const url = new URL(cumulative ? '/account/query_recharge' : '/account/amount', balanceUrl);
    url.search = new URLSearchParams(params);
    if (!requests.has(url.href)) requests.set(url.href, fetchJson(url.href, headers, deps));
    const body = await requests.get(url.href);
    if (parseNumberOrNull(body?.base_resp?.status_code) !== 0) return null;
    const amount = parseNumberOrNull(cumulative ? body.cash_total_usage : body.consume_cash_after_voucher_sum);
    return amount === null ? null : [key, amount];
  }));
  // Cancelled and rejected periods are unknown figures. They must not fail the balance already parsed.
  return Object.fromEntries(results.filter(result => result.status === 'fulfilled' && result.value).map(result => result.value));
}

function minimaxRegionOrder(options = {}, env = {}) {
  const region = minimaxRegion(options, env);
  if (region === 'cn') return ['cn'];
  if (region === 'intl') return ['en'];
  const remembered = MINIMAX_REGIONS.includes(options.minimaxRememberedRegion)
    ? options.minimaxRememberedRegion
    : '';
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

function minimaxAttemptOrder(options = {}, env = {}) {
  return minimaxAttemptSpecs(options, env).map((attempt) => attempt.url);
}

function minimaxRegionForUrl(url) {
  if (url === MINIMAX_REMAINS_URL_EN || url === MINIMAX_TOKEN_PLAN_REMAINS_URL_EN || url === MINIMAX_BALANCE_URL_EN) return 'en';
  if (url === MINIMAX_REMAINS_URL_CN || url === MINIMAX_TOKEN_PLAN_REMAINS_URL_CN || url === MINIMAX_BALANCE_URL_CN) return 'cn';
  return '';
}

// Legacy callers use a single coding-plan URL without region retry.
function minimaxBaseUrl(options = {}, env = {}) {
  return minimaxRegion(options, env) === 'cn' ? MINIMAX_REMAINS_URL_CN : MINIMAX_REMAINS_URL_EN;
}

function shouldTryLegacyMinimaxEndpoint(error) {
  const code = Number(error && error.statusCode);
  if (isMinimaxAuthError(error) || code === 404 || code === 405) return true;
  if (Number.isFinite(code)) return false;
  if (error && error.status === 'sourceRateLimited') return false;
  if (error && error.status === 'unavailable') return true;
  return false;
}

function shouldTryNextMinimaxRegion(error) {
  return isMinimaxAuthError(error);
}

async function minimaxJsonFetch(fetchFn, url, init, deps = {}) {
  if (deps.signal?.aborted) throw errorWithStatus('unavailable', 'Request cancelled');
  const timeoutMs = Number(deps.fetchTimeoutMs || 12000);
  const controller = typeof AbortController !== 'undefined' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const response = await fetchFn(url, { ...init, ...(controller ? { signal: deps.signal ? AbortSignal.any([controller.signal, deps.signal]) : controller.signal } : {}) });
    if (!response.ok) {
      const status = (response.status === 401 || response.status === 403) ? 'unauthorized' : response.status === 429 ? 'sourceRateLimited' : 'unavailable';
      const error = new Error(`${url} returned ${response.status}`);
      error.status = status;
      error.statusCode = response.status;
      let body;
      try { body = await response.json(); } catch (_) { /* HTTP status still carries the verdict */ }
      // The API host rejects foreign-region keys as HTTP 400 + business 1004.
      if (response.status === 400 && parseNumberOrNull(body?.base_resp?.status_code) === 1004) error.status = 'unauthorized';
      throw error;
    }
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Official namespaces hold one current login; record keys identify storage.
// Other records in the namespace are not managed user accounts.
function isMinimaxCodeRecord(record) {
  return record?.schemaVersion === 1 && record.clientId === 'mcode-public' && record.audience === 'agent-backend'
    && record.tokenType === 'Bearer' && typeof record.accessToken === 'string' && record.accessToken.length > 0
    && typeof record.refreshToken === 'string' && record.refreshToken.length > 0
    && Array.isArray(record.scopes) && record.scopes.every(scope => typeof scope === 'string')
    && Number.isFinite(record.expiresAtMs) && Number.isSafeInteger(record.generation) && record.generation >= 0
    && ['subject', 'accountId', 'loginEpoch'].every(key => record[key] === undefined || typeof record[key] === 'string');
}

function readMinimaxCodeAuth(authPath, deps = {}) {
  if (process.platform !== 'win32' && [path.dirname(authPath), authPath].some(file => (fs.statSync(file).mode & 0o077) !== 0)) {
    throw errorWithStatus('unavailable', 'MiniMax Code credential store is not private');
  }
  const auth = JSON.parse((deps.readFileSync || fs.readFileSync)(authPath, 'utf8'));
  if (auth?.schemaVersion !== 1 || !auth.records || typeof auth.records !== 'object' || Array.isArray(auth.records)
    || !Object.values(auth.records).every(isMinimaxCodeRecord)) throw errorWithStatus('unavailable', 'MiniMax Code credential contract changed');
  return auth;
}

function minimaxCodeRecordKey(dataDir, regionDir) {
  // The official account key hashes the path spelling, not just the physical directory.
  const account = createHash('sha256').update(`${path.join(path.resolve(dataDir), 'auth')}\0mcode-public`).digest('base64url');
  return `com.minimax.mcode.oauth.prod.${regionDir}\0${account}`;
}

function minimaxCodeAuthFiles(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const regionSetting = minimaxRegion(options, env);
  const regions = regionSetting === 'cn' ? ['cn'] : regionSetting === 'intl' ? ['en'] : ['cn', 'en'];
  let unreadable = false;
  for (const base of mcodeDataDirs({ env, homeDir: deps.homeDir || os.homedir() })) {
    for (const regionDir of regions) {
      const directory = path.join(base, 'auth', 'prod', regionDir, 'mcode-public');
      const authPath = path.join(directory, 'auth.json');
      let auth;
      try { auth = readMinimaxCodeAuth(authPath, deps); }
      catch (error) {
        if (error.code !== 'ENOENT') unreadable = true;
        continue;
      }
      const recordKey = minimaxCodeRecordKey(base, regionDir);
      if (!auth.records[recordKey]) continue;
      return { dataDir: path.resolve(base), authPath, statePath: path.join(directory, 'auth-state.json'), regionDir, recordKey, record: auth.records[recordKey] };
    }
  }
  if (unreadable) throw errorWithStatus('unavailable', 'MiniMax Code credential store unreadable');
  return null;
}

function minimaxCodeAuthState(session, deps = {}) {
  let state;
  try { state = JSON.parse((deps.readFileSync || fs.readFileSync)(session.statePath, 'utf8')); }
  catch (error) { throw errorWithStatus(error.code === 'ENOENT' ? 'notConfigured' : 'unavailable', 'MiniMax Code auth state unavailable'); }
  if (![1, 2].includes(state?.schemaVersion) || state.storeKind !== 'file' || state.clientId !== 'mcode-public' || state.audience !== 'agent-backend'
    || !Array.isArray(state.scopes) || !state.scopes.includes('agent.default')
    || !((state.buildEnv === undefined && state.region === undefined)
      || (state.buildEnv === 'prod' && state.region === session.regionDir))
    || !Number.isSafeInteger(state.generation) || state.generation < 0) throw errorWithStatus('unavailable', 'MiniMax Code auth contract changed');
  if (['anonymous', 'logging_out', 'logout_pending', 'scope_upgrade_required'].includes(state.status)) {
    throw errorWithStatus('unauthorized', 'MiniMax Code sign-in required');
  }
  if (!session.record.scopes.includes('agent.default') || !['authenticated', 'expired'].includes(state.status)
    || state.generation !== session.record.generation) throw errorWithStatus('unavailable', 'MiniMax Code auth transition pending');
  return state;
}

function minimaxCodeCommand(deps) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const paths = pathApiForPlatform(platform);
  const home = deps.homeDir || os.homedir();
  const installDir = envValue(env, 'MCODE_INSTALL_DIR') || paths.join(home, '.minimax-code');
  const dirs = uniqueStrings([
    ...String(envValue(env, 'PATH') || '').split(platform === 'win32' ? ';' : ':').filter(Boolean),
    platform === 'win32' ? installDir : paths.join(installDir, 'bin'),
    ...(platform === 'win32'
      ? [envValue(env, 'APPDATA') && paths.join(envValue(env, 'APPDATA'), 'npm'), paths.join(home, '.npm-global')]
      : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', paths.join(home, '.npm-global', 'bin'), paths.join(home, '.local', 'bin')])
  ]);
  const names = platform === 'win32' ? ['mcode.exe', 'mcode.cmd'] : ['mcode'];
  return dirs.filter(dir => paths.isAbsolute(dir)).flatMap(dir => names.map(name => paths.join(dir, name)))
    .find(command => (deps.existsSync || fs.existsSync)(command));
}

function readMinimaxCodeSession(session, deps) {
  const record = readMinimaxCodeAuth(session.authPath, deps).records[session.recordKey];
  if (!record) throw errorWithStatus('notConfigured', 'MiniMax Code login missing');
  const current = { ...session, record };
  const state = minimaxCodeAuthState(current, deps);
  if (record.loginEpoch !== session.record.loginEpoch) throw errorWithStatus('unavailable', 'MiniMax Code login changed');
  return { current, state };
}

async function refreshMinimaxCodeSession(session, deps = {}) {
  if (deps.signal?.aborted) throw errorWithStatus('unavailable', 'Refresh skipped');
  if (!session.record.loginEpoch) throw errorWithStatus('unavailable', 'MiniMax Code login epoch unavailable');
  const { current, state } = readMinimaxCodeSession(session, deps);
  if (current.record.accessToken !== session.record.accessToken && state.status === 'authenticated'
    && current.record.expiresAtMs > (deps.now || Date.now)()) return current;
  const command = minimaxCodeCommand(deps);
  if (!command) throw errorWithStatus('unavailable', 'MiniMax Code CLI unavailable');
  const platform = deps.platform || process.platform;
  const env = { ...(deps.env || process.env), MINIMAX_DATA_DIR: session.dataDir, MAVIS_DATA_DIR: session.dataDir,
    MAVIS_REGION: session.regionDir, MAVIS_BUILD_ENV: 'prod' };
  const windowsShim = platform === 'win32' && /\.cmd$/i.test(command);
  // A fixed cmd line with the launcher in env avoids re-expanding path characters.
  const executable = windowsShim ? envValue(env, 'ComSpec') || 'cmd.exe' : command;
  const args = windowsShim ? ['/d', '/s', '/v:off', '/c', '""%TOKEN_MONITOR_MCODE_COMMAND_PATH%" provider list --json"']
    : ['provider', 'list', '--json'];
  if (windowsShim) env.TOKEN_MONITOR_MCODE_COMMAND_PATH = command;
  const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-mcode-'));
  try {
    if (deps.signal?.aborted) throw errorWithStatus('unavailable', 'Refresh skipped');
    // Official rotation must finish even when its quota collection is superseded.
    await runCapturedCliProcess(executable, args, { env, cwd, platform, execFile: deps.execFile,
      windowsVerbatimArguments: windowsShim, timeoutMs: deps.mcodeCliTimeoutMs || 12000 });
  } finally { fs.rmSync(cwd, { recursive: true, force: true }); }
  const reread = readMinimaxCodeSession(session, deps);
  const unchanged = reread.current.record.accessToken === session.record.accessToken;
  const expired = reread.current.record.expiresAtMs <= (deps.now || Date.now)();
  if (reread.state.status !== 'authenticated' || unchanged || expired) {
    throw errorWithStatus(unchanged && expired ? 'unauthorized' : 'unavailable', 'MiniMax Code CLI did not renew the login');
  }
  return reread.current;
}

async function minimaxCodeRequest(url, init, deps = {}) {
  const body = await minimaxJsonFetch(deps.fetch || fetch, url, {
    method: init.method || 'GET',
    headers: { accept: 'application/json', ...(init.headers || {}) },
    ...(init.body ? { body: init.body } : {})
  }, deps);
  const code = parseNumberOrNull(body?.base_resp?.status_code);
  if (code === 1004) throw errorWithStatus('unauthorized', 'MiniMax Code token rejected');
  if (code && code !== 2062) throw errorWithStatus('unavailable', 'MiniMax Code response failed');
  return body;
}

// Only complete active grants reconciled with membership establish a denominator.
async function minimaxCodeCreditMeter(membershipUrl, headers, credits, deps) {
  const grants = [];
  let total = null;
  // More than 1,000 grants leaves the denominator unknown.
  for (let page = 1; page <= 10; page++) {
    const url = new URL('/minimax-cloud/api/v1/credit/details', membershipUrl);
    url.search = new URLSearchParams({ page_number: page, page_size: 100, include_expired: false }).toString();
    const body = await minimaxCodeRequest(url.href, { headers }, deps);
    if (!Array.isArray(body.details) || !Number.isSafeInteger(body.total_count) || body.total_count < 0 || body.total_count > 1000
      || (total !== null && total !== body.total_count)) return null;
    total = body.total_count;
    grants.push(...body.details);
    if (grants.length === total) break;
    if (!body.details.length || grants.length > total) return null;
  }
  if (grants.length !== total) return null;
  let limit = 0;
  let remaining = 0;
  const now = (deps.now || Date.now)();
  for (const grant of grants) {
    const expires = parseNumberOrNull(grant?.expire_at_ms);
    if (expires === null) return null;
    if (expires <= now) continue;
    const amount = minimaxCodeCredits(grant.granted_amount);
    const left = minimaxCodeCredits(grant.remaining_amount);
    if (![1, 2].includes(grant.credit_type) || amount === null || left === null || left > amount) return null;
    limit += amount;
    remaining += left;
  }
  if (!(limit > 0) || !Number.isFinite(limit) || Math.abs(remaining - credits) > 0.005) return null;
  return { used: Math.max(0, limit - credits), limit, showMeter: true };
}

// The membership total includes purchased and gifted points, not API cash.
// M Plan quota is independent; a plan outage must not discard fresh credits.
async function fetchMinimaxCodeLimits(options = {}, deps = {}, context = {}) {
  const { now, updatedAt } = context;
  let session;
  let accountKey = '';
  let planLabel = '';
  const state = deps.providerRuntimeState instanceof Map ? deps.providerRuntimeState : null;
  const row = (status, windows = []) => normalizeLimitProvider({
    provider: 'minimax', accountKey, accountLabel: 'MiniMax Code', source: 'oauth',
    status, updatedAt, windows, planLabel, region: session?.regionDir || ''
  });
  const env = deps.env || process.env;
  if (['MCODE_OAUTH_DEVICE_AUTHORIZATION_ENDPOINT', 'MCODE_OAUTH_TOKEN_ENDPOINT', 'MCODE_OAUTH_REVOCATION_ENDPOINT']
    .some(key => cleanSecret(env[key]))) return row('unavailable');
  try { session = minimaxCodeAuthFiles(options, deps); }
  catch (error) { return row(error.status || 'unavailable'); }
  if (!session) return row('notConfigured');
  const region = session.regionDir;
  let refreshed = false;
  let refreshSucceeded = false;
  const refresh = async () => {
    refreshed = true;
    session = await refreshMinimaxCodeSession(session, deps);
    refreshSucceeded = true;
  };
  let authState;
  try { authState = minimaxCodeAuthState(session, deps); }
  catch (error) { return row(error.status || 'unavailable'); }
  if (authState.status === 'expired' || session.record.expiresAtMs <= now) {
    try { await refresh(); }
    catch (error) { return row(mapMinimaxErrorStatus(error)); }
  }
  // Membership and plan share at most one auth recovery per collection.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = { authorization: `Bearer ${session.record.accessToken}`, 'content-type': 'application/json' };
      const membershipUrl = region === 'cn' ? MINIMAX_CODE_MEMBERSHIP_URL_CN : MINIMAX_CODE_MEMBERSHIP_URL_INTL;
      const extra = await minimaxCodeRequest(new URL('/matrix/api/v1/user/get_user_extra_info', membershipUrl).href,
        { method: 'POST', headers, body: '{}' }, deps);
      const personal = extra?.workspaces?.filter(workspace => workspace?.workspace_type === 0);
      const workspace = personal?.length === 1 ? personal[0] : null;
      const workspaceId = workspace?.workspace_id;
      if (!((typeof workspaceId === 'string' && workspaceId.trim())
        || (Number.isSafeInteger(workspaceId) && workspaceId >= 0))) return row('unavailable');
      const membership = await minimaxCodeRequest(membershipUrl, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspaceId }) }, deps);
      const tier = workspace.token_plan_tier || membership.token_plan_tier;
      const hasPlan = Boolean(workspace.has_token_plan || membership.has_token_plan || tier);
      const tierName = cleanSecret(tier);
      planLabel = hasPlan ? (tierName && !/^\d+$/u.test(tierName) ? tierName : 'Subscription') : cleanSecret(membership.plan_name);
      const groupId = cleanSecret(workspace.op_group_id) || cleanSecret(membership?.op_group_id);
      accountKey = groupId ? hashKey('minimax', `code:${region}:${groupId}`) : '';
      const credits = minimaxCodeCredits(membership?.op_credit_summary?.total_remaining_amount)
        ?? minimaxCodeCredits(workspace.opcredit_balance ?? membership?.opcredit_balance);
      if (credits === null) return row('unavailable');
      if (region === 'cn' && groupId) {
        const previous = state?.get(MINIMAX_CODE_GROUP_STATE_KEY);
        context.codeIdentity = { accountKey, groupId,
          apiAccountKey: previous?.accountKey === accountKey ? previous.apiAccountKey : '' };
        state?.set(MINIMAX_CODE_GROUP_STATE_KEY, context.codeIdentity);
      }
      const windows = [{ kind: 'billing', metric: 'credits', label: 'Credits', remaining: credits,
        currency: 'CREDITS', showMeter: false }];
      const platformUrl = region === 'cn' ? MINIMAX_CODE_PLAN_REMAINS_URL_CN : MINIMAX_CODE_PLAN_REMAINS_URL_INTL;
      const platformHeaders = { ...headers, 'X-Group-Id': groupId };
      if (groupId) {
        try {
          const meter = await minimaxCodeCreditMeter(membershipUrl, headers, credits, deps);
          if (meter) Object.assign(windows[0], meter);
        } catch (error) {
          if (deps.signal?.aborted) throw error;
          // A missing denominator leaves the fresh amount visible without a bar.
        }
      }
      if (groupId && hasPlan) {
        if (/^\d+$/u.test(tierName)) {
          try {
            const url = new URL('/v1/api/openplatform/charge/combo/cycle_audio_resource_package', platformUrl);
            url.search = new URLSearchParams({ biz_line: '2', cycle_type: '3', resource_package_type: '7', business: 'Agent', device_platform: 'desktop' }).toString();
            const metadata = await minimaxCodeRequest(url.href, { headers: platformHeaders }, deps);
            const current = metadata?.current_subscribe;
            // A catalog card alone is not evidence of the current subscription.
            if (String(current?.curr_subscribe_combo_id ?? '').trim() === tierName) {
              const card = metadata.current_combo_card;
              planLabel = [String(card?.combo_id ?? '').trim() === tierName ? cleanSecret(card?.title) : '',
                cleanSecret(current.current_subscribe_title)].find(name => name && !/^\d+$/u.test(name)) || planLabel;
            }
          } catch (error) {
            if (deps.signal?.aborted) throw error;
            // Optional names cannot invalidate quota or trigger token rotation.
          }
        }
        try {
          const plan = await minimaxCodeRequest(platformUrl, { headers: platformHeaders }, deps);
          if (parseNumberOrNull(plan?.base_resp?.status_code) !== 2062) {
            const planWindows = parseMinimaxCodePlan(plan);
            if (!planWindows.length) throw errorWithStatus('unavailable', 'MiniMax Code plan quota missing');
            windows.push(...planWindows);
          }
        } catch (error) {
          if (deps.signal?.aborted || isMinimaxAuthError(error)) throw error;
          // Fresh points do not make retained plan quota fresh.
          return { ...row('ok', windows), invalidateCachedWindowLabels: windows.map(window => window.label) };
        }
      }
      return row('ok', windows);
    } catch (error) {
      if (!isMinimaxAuthError(error)) return row(mapMinimaxErrorStatus(error));
      if (refreshed) return row(refreshSucceeded ? 'unauthorized' : 'unavailable');
      try { await refresh(); }
      catch (refreshError) { return row(mapMinimaxErrorStatus(refreshError)); }
    }
  }
  return row('unauthorized');
}

async function fetchMinimaxCodeRows(options, deps, context) {
  const current = await fetchMinimaxCodeLimits(options, deps, context);
  const scope = options.limitRefreshScope;
  if (scope?.provider === 'minimax' && scope.accountKey) {
    // A scoped attempt keeps its target identity; unidentified or different
    // logins cannot replace that account's last-good data.
    if (current.status !== 'ok' || !current.accountKey) {
      return { ...current, accountKey: scope.accountKey,
        status: current.status === 'ok' ? 'unavailable' : current.status, windows: [] };
    }
    if (scope.accountKey !== current.accountKey) {
      return [{ provider: 'minimax', accountKey: scope.accountKey, removed: true }];
    }
  }
  const previous = (options.previousLimits?.providers || [])
    .filter(row => row.provider === 'minimax' && row.source === 'oauth');
  const identified = previous.filter(row => row.accountKey);
  // Failed or unidentified reads cannot establish a replacement login.
  if ((current.status !== 'ok' || !current.accountKey) && identified.length) {
    return identified.map(row => ({ ...current, accountKey: row.accountKey,
      status: current.status === 'ok' ? 'unavailable' : current.status, windows: [] }));
  }
  if (current.status !== 'ok' || !current.accountKey) return current;
  const removals = previous
    .filter(row => row.accountKey !== current.accountKey && (row.accountKey || row.accountLabel))
    .map(row => ({ provider: 'minimax', accountKey: row.accountKey, accountLabel: row.accountLabel, removed: true }));
  return removals.length ? [current, ...removals] : current;
}

async function fetchMinimaxApiLimits(options, deps, { now, updatedAt }) {
  const env = deps.env || process.env;
  const key = minimaxToken(env, options.minimaxApiKey);
  const accountKey = key ? hashKey('minimax', key) : '';
  if (!key) {
    return normalizeLimitProvider({
      provider: 'minimax',
      source: 'api',
      status: 'notConfigured',
      updatedAt,
      windows: []
    });
  }
  const apiBilling = normalizeMinimaxBillingMode(options.minimaxBillingMode) === 'api';
  const account = {
    provider: 'minimax', accountKey, source: 'api', updatedAt,
    accountLabel: apiBilling ? 'Pay-as-you-go' : 'Token Plan',
    planLabel: apiBilling ? '' : 'Subscription'
  };
  const fetchJson = deps.fetchJson
    || ((u, headers) => minimaxJsonFetch(deps.fetch || fetch, u, { headers }, deps));
  const headers = {
    Authorization: `Bearer ${key}`,
    Accept: 'application/json',
    'Content-Type': 'application/json'
  };
  // An explicit region-affinity hint takes precedence over runtime memory.
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
        throw errorWithStatus('unavailable', 'unexpected remains response shape');
      }
      const baseResp = data.base_resp;
      if (baseResp && typeof baseResp === 'object') {
        const statusCode = parseNumberOrNull(baseResp.status_code);
        if (statusCode !== null && statusCode !== 0) {
          const statusMsg = typeof baseResp.status_msg === 'string' ? baseResp.status_msg : 'unknown error';
          // Business 1004 is an auth rejection regardless of message language.
          // Legacy auth messages remain supported.
          const lower = statusMsg.toLowerCase();
          const looksLikeAuth = statusCode === 1004 || /\b(log\s*in|cookie|token|auth|key|expired|invalid)\b/.test(lower);
          const status = looksLikeAuth ? 'unauthorized' : 'unavailable';
          // A foreign-region key can fail with HTTP 200 plus business 1004.
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
        throw errorWithStatus('unavailable', 'MiniMax token-plan response has no quota windows');
      }
      const spend = attempt.kind === 'balance' && windows.length && !deps.probe
        ? await minimaxCashSpend(attempt.url, headers, fetchJson, deps, now)
        : {};
      // A response without quota cannot establish region affinity.
      if (windows.length) storeMinimaxRegionMemory(deps, attempt.region);
      return normalizeLimitProvider({
        ...account,
        status: windows.length ? 'ok' : 'unavailable',
        windows,
        ...(Object.keys(spend).length ? { balance: {
          amount: windows[0].remaining, currency: windows[0].currency, ...spend
        } } : {}),
        region: attempt.region
      });
    } catch (error) {
      lastError = error;
      const next = attempts[index + 1];
      if (isMinimaxTransportError(error)) {
        // A canceled runtime must not issue another request with stale config.
        if (deps.signal?.aborted) break;
        sawTransportFailure = true;
        const nextRegionIndex = attempts.findIndex(
          (candidate, candidateIndex) => candidateIndex > index && candidate.region !== attempt.region
        );
        if (nextRegionIndex > index) {
          index = nextRegionIndex - 1;
          continue;
        }
        break;
      }
      if (attempt.kind === 'tokenPlan' && next?.region === attempt.region && shouldTryLegacyMinimaxEndpoint(error)) continue;
      if (next && next.region !== attempt.region && shouldTryNextMinimaxRegion(error)) continue;
      break;
    }
  }
  // A foreign-region rejection cannot invalidate a key whose own region was
  // unreachable; preserve the transient failure and its last-good quota.
  const publishedStatus = sawTransportFailure && isMinimaxAuthError(lastError)
    ? 'unavailable'
    : mapMinimaxErrorStatus(lastError);
  return normalizeLimitProvider({
    ...account,
    status: publishedStatus,
    windows: []
  });
}

// Peer keys affect headings only; aliases would also change billing bindings.
async function linkMinimaxAccounts(rows, options, deps, context, key, apiAccountKey) {
  const previous = (options.previousLimits?.providers || []).filter(row => row.provider === 'minimax');
  const api = rows.find(row => !row.removed && row.source === 'api')
    || previous.find(row => row.source === 'api' && row.accountKey === apiAccountKey);
  const code = rows.find(row => !row.removed && row.source === 'oauth')
    || previous.find(row => row.source === 'oauth');
  const apiRegion = api?.region || previous.find(row => row.accountKey === apiAccountKey)?.region;
  // The cross-account controls cover CN pay-as-you-go keys only.
  if (!key || api?.accountKey !== apiAccountKey || !code?.accountKey || code.region !== 'cn'
    || (api.region && api.region !== 'cn')
    || minimaxRegion(options, deps.env || process.env) === 'intl' || deps.signal?.aborted) return;
  const identity = context.codeIdentity || deps.providerRuntimeState?.get(MINIMAX_CODE_GROUP_STATE_KEY);
  let linked = (identity?.accountKey === code.accountKey && identity.apiAccountKey === apiAccountKey)
    || previous.some(row => row.region === 'cn' && (
      (row.accountKey === apiAccountKey && row.relatedAccountKey === code.accountKey)
      || (row.accountKey === code.accountKey && row.relatedAccountKey === apiAccountKey)));
  if (!linked && identity?.accountKey === code.accountKey && apiRegion === 'cn'
    && normalizeMinimaxBillingMode(options.minimaxBillingMode) === 'api' && api.status === 'ok' && code.status === 'ok') {
    try {
      const url = new URL(MINIMAX_TOKEN_PLAN_REMAINS_URL_CN);
      url.searchParams.set('GroupId', identity.groupId);
      const fetchJson = deps.fetchJson
        || ((u, headers) => minimaxJsonFetch(deps.fetch || fetch, u, { headers, redirect: 'error' }, deps));
      const body = await fetchJson(url.href, { Authorization: `Bearer ${key}`, Accept: 'application/json' }, deps);
      const status = parseNumberOrNull(body?.base_resp?.status_code);
      // 2062 means the authorized group has no subscription, not a bad key.
      linked = status === 2062 || (status === 0 && readMinimaxRows(body) !== null);
    } catch (_) { /* Optional affiliation failures cannot invalidate either reading. */ }
  }
  if (!linked || deps.signal?.aborted) return;
  if (identity?.accountKey === code.accountKey) identity.apiAccountKey = apiAccountKey;
  for (const row of rows) {
    if (row.removed) continue;
    if (row.accountKey === apiAccountKey) row.relatedAccountKey = code.accountKey;
    else if (row.accountKey === code.accountKey) row.relatedAccountKey = apiAccountKey;
    if (row.relatedAccountKey) row.region ||= 'cn';
  }
}

async function fetchMinimaxLimits(options = {}, deps = {}) {
  const now = (deps.now || Date.now)();
  const context = { now, updatedAt: new Date(now).toISOString() };
  // Key probes must not let a healthy local login vouch for a bad draft.
  if (deps.probe) return fetchMinimaxApiLimits(options, deps, context);
  const key = minimaxToken(deps.env || process.env, options.minimaxApiKey);
  const apiAccountKey = key ? hashKey('minimax', key) : '';
  const scope = options.limitRefreshScope?.provider === 'minimax' ? options.limitRefreshScope : null;
  const previous = options.previousLimits?.providers || [];
  const scoped = scope?.accountKey || scope?.accountLabel;
  const apiScope = scope?.accountKey
    ? scope.accountKey === apiAccountKey || previous.some(row => row.provider === 'minimax' && row.source === 'api' && row.accountKey === scope.accountKey)
    : ['Token Plan', 'Pay-as-you-go'].includes(scope?.accountLabel);
  if (apiScope && scope?.accountKey && scope.accountKey !== apiAccountKey) {
    return [{ provider: 'minimax', accountKey: scope.accountKey, removed: true }];
  }
  const [api, code] = await Promise.all([
    (!scoped || apiScope)
      ? fetchMinimaxApiLimits(options, deps, context) : null,
    !apiScope ? fetchMinimaxCodeRows(options, deps, context) : null
  ]);
  const rows = [api, ...(Array.isArray(code) ? code : [code])].filter(Boolean);
  await linkMinimaxAccounts(rows, options, deps, context, key, apiAccountKey);
  if (!scoped) {
    rows.push(...previous.filter(row => row.provider === 'minimax' && row.source === 'api'
      && row.accountKey && row.accountKey !== apiAccountKey)
      .map(row => ({ provider: 'minimax', accountKey: row.accountKey, removed: true })));
  }
  // A missing optional lane must not add an unconfigured card beside a live lane.
  const present = rows.filter(row => row.status !== 'notConfigured' || row.accountKey);
  const result = present.length ? present : rows.slice(0, 1);
  return result.length === 1 ? result[0] : result;
}

function mapMinimaxErrorStatus(error) {
  const status = error && error.status;
  if (['disabled', 'notConfigured', 'unauthorized', 'rateLimited', 'sourceRateLimited', 'unavailable', 'error'].includes(status)) return status;
  return 'unavailable';
}

module.exports = {
  MINIMAX_KEY_NAMES,
  MINIMAX_REGION_MEMORY_STATE_KEY,
  MINIMAX_CODE_MEMBERSHIP_URL_CN,
  MINIMAX_CODE_PLAN_REMAINS_URL_CN,
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
