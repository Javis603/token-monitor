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
const { execFile } = require('node:child_process');
const { randomUUID } = require('node:crypto');

const { normalizeLimitProvider } = require('../../limits/core');
const { cleanSecret, numberOrNull: parseNumberOrNull, errorWithStatus } = require('../../limits/providerHelpers');
const { writePrivateJsonAtomic } = require('../../credentialStore');
const { hashKey } = require('../../hashKey');
const { mcodeDataDirs } = require('../mcode/paths');

const MINIMAX_KEY_NAMES = ['MINIMAX_CODING_API_KEY'];

const MINIMAX_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/api/openplatform/coding_plan/remains';
const MINIMAX_REMAINS_URL_EN = 'https://api.minimax.io/v1/api/openplatform/coding_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_CN = 'https://api.minimaxi.com/v1/token_plan/remains';
const MINIMAX_TOKEN_PLAN_REMAINS_URL_EN = 'https://api.minimax.io/v1/token_plan/remains';
const MINIMAX_BALANCE_URL_CN = 'https://api.minimaxi.com/account/query_balance';
const MINIMAX_BALANCE_URL_EN = 'https://api.minimax.io/account/query_balance';

// MiniMax Code OAuth origins verified against the official 3.1.6 app.
const MINIMAX_CODE_OAUTH_URL_CN = 'https://account.minimax.cn/oauth2/token';
const MINIMAX_CODE_OAUTH_URL_INTL = 'https://account.minimax.io/oauth2/token';
const MINIMAX_CODE_MEMBERSHIP_URL_CN = 'https://agent.minimax.cn/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_MEMBERSHIP_URL_INTL = 'https://agent.minimax.io/matrix/api/v1/commerce/get_membership_info';
const MINIMAX_CODE_PLAN_REMAINS_URL_CN = 'https://www.minimaxi.com/backend/account/token_plan/remains_percent';
const MINIMAX_CODE_PLAN_REMAINS_URL_INTL = 'https://platform.minimax.io/backend/account/token_plan/remains_percent';

const MINIMAX_CODE_REFRESH_LEEWAY_MS = 10 * 60 * 1000;
const MINIMAX_CODE_PENDING_WRITE_STATE_KEY = 'minimax.code.pending-write';

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

// Code's current M Plan endpoint reports used/total percentages, unlike the
// API-key Token Plan endpoint. Status 3 here explicitly means unlimited.
function parseMinimaxCodePlan(body) {
  const rows = readMinimaxRows(body);
  if (!rows) return [];
  const isVideo = (row) => /video/i.test(row?.model_name || '');
  const general = rows.find(row => row?.model_name === 'general') || rows.find(row => row && !isVideo(row)) || rows[0];
  const windows = [];
  for (const [prefix, kind, label, resetField, windowMinutes] of [
    ['current_interval', 'session', '5h', 'end_time', MINIMAX_WINDOW_MINUTES_5H],
    ['current_weekly', 'weekly', 'Weekly', 'weekly_end_time', MINIMAX_WINDOW_MINUTES_WEEKLY]
  ]) {
    if (!general) break;
    const unlimited = parseNumberOrNull(general[`${prefix}_status`]) === 3;
    const used = parseNumberOrNull(general[`${prefix}_used_percent`]);
    const reportedTotal = parseNumberOrNull(general[`${prefix}_total_percent`]);
    const total = reportedTotal > 0 ? reportedTotal : 100;
    if (!unlimited && used === null) continue;
    windows.push({ kind, label, resetsAt: millisToIso8601(general[resetField]), windowMinutes,
      ...(unlimited ? { detail: 'unlimited', showMeter: false } : { usedPercent: used / total * 100, showMeter: true }) });
  }
  const video = rows.find(row => isVideo(row) && parseNumberOrNull(row.current_interval_total_count) > 0);
  if (video) {
    const unlimited = parseNumberOrNull(video.current_interval_status) === 3;
    const used = parseNumberOrNull(video.current_interval_used_count);
    const limit = parseNumberOrNull(video.current_interval_total_count);
    if (unlimited || used !== null) {
      const remaining = used !== null && limit !== null ? Math.max(0, limit - used) : null;
      windows.push({
        kind: 'weekly', label: 'Video', resetsAt: millisToIso8601(video.end_time),
        ...(unlimited ? { detail: 'unlimited', showMeter: false } : {
          used, limit, remaining, showMeter: limit > 0,
          ...(limit > 0 && used !== null ? {
            usedPercent: used / limit * 100,
            remainingPercent: remaining / limit * 100
          } : {})
        })
      });
    }
  }
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
// Official OAuth namespaces are auth/prod/{cn,en}/mcode-public, with one
// current login per namespace. Other records are not additional user accounts.
// docs/providers/minimax.md holds the rotation and recovery contract.
function isMinimaxCodeRecord(key, record) {
  if (!record || typeof record !== 'object') return false;
  if (typeof record.refreshToken !== 'string' || !record.refreshToken) return false;
  if (typeof record.clientId === 'string' && record.clientId) return record.clientId === 'mcode-public';
  return String(key).startsWith('com.minimax.mcode.oauth');
}

// Sync fs entry points, injectable as a set so tests drive discovery and the
// write-back with one object.
function minimaxCodeFs(deps = {}) {
  return {
    readFileSync: deps.readFileSync || fs.readFileSync,
    writeFileSync: deps.writeFileSync || fs.writeFileSync,
    renameSync: deps.renameSync || fs.renameSync,
    unlinkSync: deps.unlinkSync || fs.unlinkSync
  };
}

function minimaxCodeAuthFiles(options = {}, deps = {}) {
  const env = deps.env || process.env;
  const { readFileSync } = minimaxCodeFs(deps);
  const regionSetting = minimaxRegion(options, env);
  const regions = regionSetting === 'cn' ? ['cn'] : regionSetting === 'intl' ? ['en'] : ['cn', 'en'];
  for (const base of mcodeDataDirs({ env, homeDir: deps.homeDir || os.homedir() })) {
    for (const regionDir of regions) {
      const directory = path.join(base, 'auth', 'prod', regionDir, 'mcode-public');
      const authPath = path.join(directory, 'auth.json');
      let auth;
      try { auth = JSON.parse(readFileSync(authPath, 'utf8')); } catch (_) { continue; }
      const records = auth && typeof auth.records === 'object' && auth.records;
      if (!records || Array.isArray(records)) continue;
      const keys = Object.keys(records).filter(key => key.startsWith(`com.minimax.mcode.oauth.prod.${regionDir}`)
        && isMinimaxCodeRecord(key, records[key]));
      if (keys.length !== 1) continue;
      return { authPath, statePath: path.join(directory, 'auth-state.json'), regionDir, recordKey: keys[0], record: records[keys[0]] };
    }
  }
  return null;
}

// Detection failure is not evidence that the app is quit. The official lock
// below also coordinates collectors and a client that starts after this check.
function minimaxCodeClientRunning(deps = {}) {
  if (typeof deps.clientRunning === 'function') return Promise.resolve().then(() => deps.clientRunning()).then(Boolean);
  const platform = deps.platform || process.platform;
  const execute = deps.execFile || execFile;
  return new Promise((resolve) => {
    try {
      if (platform === 'win32') {
        execute('tasklist', ['/FI', 'IMAGENAME eq MiniMax Code.exe', '/FO', 'CSV', '/NH'],
          { timeout: 2000, windowsHide: true }, (error, stdout) => {
            resolve(Boolean(error) || /MiniMax Code\.exe/i.test(String(stdout)));
          });
      } else {
        execute('pgrep', ['-f', 'MiniMax Code'], { timeout: 2000 }, (error) => {
          resolve(!error || error.code !== 1);
        });
      }
    } catch (_) { resolve(true); }
  });
}

function sameMinimaxCodeLease(left, right) {
  return left?.refreshToken === right?.refreshToken && left?.generation === right?.generation
    && left?.loginEpoch === right?.loginEpoch;
}

function minimaxCodeAuthState(session, deps = {}, pending) {
  let state;
  try { state = JSON.parse((deps.readFileSync || fs.readFileSync)(session.statePath, 'utf8')); }
  catch (error) { throw errorWithStatus(error.code === 'ENOENT' ? 'notConfigured' : 'unavailable', 'MiniMax Code auth state unavailable'); }
  if (['anonymous', 'logging_out', 'logout_pending', 'scope_upgrade_required'].includes(state?.status)) {
    throw errorWithStatus('unauthorized', 'MiniMax Code sign-in required');
  }
  if (![1, 2].includes(state?.schemaVersion) || state.clientId !== 'mcode-public' || state.audience !== 'agent-backend'
    || !Array.isArray(state.scopes) || !state.scopes.includes('agent.default')
    || !Number.isSafeInteger(state.generation) || state.generation < 0) throw errorWithStatus('unavailable', 'MiniMax Code auth contract changed');
  if (pending && state.status === 'refreshing' && state.refresh?.id === pending.session.refreshId
    && state.generation === pending.updated.generation) {
    const auth = JSON.parse((deps.readFileSync || fs.readFileSync)(session.authPath, 'utf8'));
    const current = auth?.records?.[session.recordKey];
    if (sameMinimaxCodeLease(current, pending.session.record)
      || sameMinimaxCodeLease(current, { ...pending.session.record, ...pending.updated })) return state;
  }
  if (!['authenticated', 'expired'].includes(state.status) || state.generation !== session.record.generation) {
    throw errorWithStatus('unavailable', 'MiniMax Code auth transition pending');
  }
  return state;
}

function minimaxCodeRefreshCurrent(session, state, generation) {
  return state?.status === 'refreshing' && state.refresh?.id === session.refreshId && state.generation === generation;
}

// Compare against the lease we actually refreshed, so logout/re-login cannot
// be undone by a late response. Reuse the credential store's private atomic writer.
function writeMinimaxCodeAuth(session, updated, deps = {}) {
  const fsApi = { ...fs, ...minimaxCodeFs(deps) };
  try {
    const state = JSON.parse(fsApi.readFileSync(session.statePath, 'utf8'));
    if (!minimaxCodeRefreshCurrent(session, state, updated.generation)) return 'stale';
    const fresh = JSON.parse(fsApi.readFileSync(session.authPath, 'utf8'));
    const current = fresh?.records?.[session.recordKey];
    if (!current || (!sameMinimaxCodeLease(current, session.record)
      && !sameMinimaxCodeLease(current, { ...session.record, ...updated }))) return 'stale';
    fresh.records[session.recordKey] = { ...current, ...updated };
    writePrivateJsonAtomic(session.authPath, fresh, { fs: fsApi });
    const latest = JSON.parse(fsApi.readFileSync(session.statePath, 'utf8'));
    if (!minimaxCodeRefreshCurrent(session, latest, updated.generation)) return 'stale';
    writePrivateJsonAtomic(session.statePath, { ...latest, status: 'authenticated', refresh: undefined,
      generation: updated.generation, expiresAtMs: updated.expiresAtMs }, { fs: fsApi });
    return 'written';
  } catch (_) { return 'pending'; }
}

function commitMinimaxCodeRefresh(session, updated, deps, state, pendingKey) {
  const result = writeMinimaxCodeAuth(session, updated, deps);
  if (result === 'written' || result === 'stale') state?.delete(pendingKey);
  if (result === 'stale') throw errorWithStatus('unavailable', 'MiniMax Code login changed');
  if (result === 'pending') minimaxCodeAuthState(session, deps, { session, updated });
  return { ...session, record: { ...session.record, ...updated } };
}

async function refreshMinimaxCodeSession(session, deps = {}) {
  if (deps.probe || deps.signal?.aborted) throw errorWithStatus('unavailable', 'Refresh skipped');
  // @mavis/oauth-core uses proper-lockfile on auth.lock, whose mutex is this
  // directory. Fail closed on busy/abandoned locks; never steal another lease.
  const lockPath = path.join(path.dirname(session.authPath), 'auth.lock.lock');
  try { fs.mkdirSync(lockPath, { mode: 0o700 }); }
  catch (_) { throw errorWithStatus('unavailable', 'MiniMax Code auth is locked'); }
  const identity = fs.statSync(lockPath);
  const ownsLock = () => {
    try { const current = fs.statSync(lockPath); return current.ino === identity.ino && current.dev === identity.dev && current.birthtimeMs === identity.birthtimeMs; }
    catch (_) { return false; }
  };
  const heartbeat = setInterval(() => {
    if (ownsLock()) {
      try { const time = new Date(); fs.utimesSync(lockPath, time, time); } catch (_) { /* fail closed */ }
    }
  }, 10000);
  try {
    if (await minimaxCodeClientRunning(deps)) throw errorWithStatus('unavailable', 'MiniMax Code is running');
    const auth = JSON.parse((deps.readFileSync || fs.readFileSync)(session.authPath, 'utf8'));
    const record = auth?.records?.[session.recordKey];
    if (!record) throw errorWithStatus('unavailable', 'MiniMax Code login changed');
    const state = deps.providerRuntimeState instanceof Map ? deps.providerRuntimeState : null;
    const pendingKey = `${MINIMAX_CODE_PENDING_WRITE_STATE_KEY}:${session.authPath}:${session.recordKey}`;
    const pending = state?.get(pendingKey);
    if (pending) {
      try { minimaxCodeAuthState(session, deps, pending); }
      catch (error) { state.delete(pendingKey); throw error; }
      if (sameMinimaxCodeLease(record, pending.session.record)
        || sameMinimaxCodeLease(record, { ...pending.session.record, ...pending.updated })) {
        if (!ownsLock()) throw errorWithStatus('unavailable', 'MiniMax Code auth lock changed');
        return commitMinimaxCodeRefresh(pending.session, pending.updated, deps, state, pendingKey);
      }
      state.delete(pendingKey);
    }
    // Another collector or a fresh login already replaced the failed token.
    const authState = minimaxCodeAuthState({ ...session, record }, deps);
    if (!sameMinimaxCodeLease(record, session.record)) {
      if (authState.status === 'authenticated' && Number(record.expiresAtMs) > (deps.now || Date.now)()) return { ...session, record };
      throw errorWithStatus('unavailable', 'MiniMax Code replacement lease not ready');
    }
    const fsApi = { ...fs, ...minimaxCodeFs(deps) };
    session = { ...session, refreshId: randomUUID() };
    const generation = Number(record.generation) + 1;
    const fence = { ...authState, status: 'refreshing', generation,
      refresh: { id: session.refreshId, owner: { pid: process.pid, startedAtMs: Math.trunc(performance.timeOrigin) } } };
    writePrivateJsonAtomic(session.statePath, fence, { fs: fsApi });
    const url = session.regionDir === 'cn' ? MINIMAX_CODE_OAUTH_URL_CN : MINIMAX_CODE_OAUTH_URL_INTL;
    let json;
    try {
      json = await minimaxJsonFetch(deps.fetch || fetch, url, {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({ grant_type: 'refresh_token', refresh_token: record.refreshToken,
          client_id: 'mcode-public', scope: 'agent.default', audience: 'agent-backend' }).toString()
      }, deps);
      let scopes = json?.scope;
      if (scopes == null) {
        try {
          const claims = JSON.parse(Buffer.from(json.access_token.split('.')[1], 'base64url').toString('utf8'));
          scopes = claims.scope ?? claims.scp;
        } catch (_) { /* opaque tokens require a scope in the response */ }
      }
      json = { ...json, refresh_token: cleanSecret(json?.refresh_token) || record.refreshToken };
      if (typeof json?.access_token !== 'string' || !json.access_token
        || typeof json?.refresh_token !== 'string' || !json.refresh_token
        || String(json.token_type).toLowerCase() !== 'bearer'
        || !(Array.isArray(scopes) ? scopes : String(scopes || '').split(/\s+/)).includes('agent.default')
        || !Number.isFinite(Number(json.expires_in)) || Number(json.expires_in) <= 0) {
        const error = errorWithStatus('unauthorized', 'OAuth response missing tokens');
        // A 200 with no usable grant is a rejected login. A bare HTTP 401 is not:
        // the shared fetch map marks every 401 unauthorized before the OAuth error
        // is known, and that must not log the official client out.
        error.minimaxCodeGrantUnusable = true;
        throw error;
      }
    } catch (error) {
      const grantRejected = ['invalid_grant', 'unauthorized_client'].includes(error.oauthError)
        || error.minimaxCodeGrantUnusable === true;
      if (grantRejected) error.status = 'unauthorized';
      else if (error.status === 'unauthorized') error.status = 'unavailable';
      if (!ownsLock()) throw errorWithStatus('unavailable', 'MiniMax Code auth lock changed');
      const latest = JSON.parse(fsApi.readFileSync(session.statePath, 'utf8'));
      if (minimaxCodeRefreshCurrent(session, latest, generation)) {
        writePrivateJsonAtomic(session.statePath, grantRejected
          ? { ...fence, status: 'anonymous', refresh: undefined }
          : authState, { fs: fsApi });
      }
      throw error;
    }
    const updated = {
      accessToken: json.access_token, refreshToken: json.refresh_token,
      expiresAtMs: (deps.now || Date.now)() + Number(json.expires_in) * 1000,
      generation
    };
    // Keep an uncommitted rotation for write retry; never consume the old token
    // again. This state stays in main and is discarded if the login changes.
    state?.set(pendingKey, { session, updated });
    if (!ownsLock()) throw errorWithStatus('unavailable', 'MiniMax Code auth lock changed');
    return commitMinimaxCodeRefresh(session, updated, deps, state, pendingKey);
  } finally {
    clearInterval(heartbeat);
    if (ownsLock()) {
      try { fs.rmdirSync(lockPath); } catch (_) { /* a leftover lock blocks further rotations */ }
    }
  }
}

// One fetch-JSON core for both billing lanes: a per-request timeout and the
// shared classification (401/403 → unauthorized, 429 → sourceRateLimited,
// else unavailable). An abort propagates untouched — the API lanes read it as
// a transport failure to jump regions with, the code lane maps it at its own
// catch sites.
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
      error.oauthError = body?.error;
      throw error;
    }
    return await response.json();
  } finally {
    if (timer) clearTimeout(timer);
  }
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

// The membership total includes purchased and gifted points, not API cash.
// M Plan quota is independent; a plan outage must not discard fresh credits.
async function fetchMinimaxCodeLimits(options = {}, deps = {}, context = {}) {
  const { now, updatedAt } = context;
  let session = minimaxCodeAuthFiles(options, deps);
  let accountKey = '';
  const state = deps.providerRuntimeState instanceof Map ? deps.providerRuntimeState : null;
  const region = session ? session.regionDir === 'cn' ? 'cn' : 'en' : '';
  const row = (status, windows = []) => normalizeLimitProvider({
    provider: 'minimax', accountKey, accountLabel: 'MiniMax Code', source: 'oauth',
    status, updatedAt, windows, region
  });
  if (!session) return row('notConfigured');
  let refreshed = false;
  let refreshSucceeded = false;
  const refresh = async () => {
    refreshed = true;
    session = await refreshMinimaxCodeSession(session, deps);
    refreshSucceeded = true;
  };
  const pendingKey = `${MINIMAX_CODE_PENDING_WRITE_STATE_KEY}:${session.authPath}:${session.recordKey}`;
  let authState;
  try { authState = minimaxCodeAuthState(session, deps, state?.get(pendingKey)); }
  catch (error) { state?.delete(pendingKey); return row(error.status || 'unavailable'); }
  const expiry = Number(session.record.expiresAtMs);
  if (state?.has(pendingKey) || !session.record.accessToken
    || authState.status === 'expired' || !Number.isFinite(expiry) || expiry - now < MINIMAX_CODE_REFRESH_LEEWAY_MS) {
    try { await refresh(); }
    catch (error) {
      if (error.status === 'unauthorized') return row('unauthorized');
      try { authState = minimaxCodeAuthState(session, deps, state?.get(pendingKey)); }
      catch (stateError) { return row(stateError.status || 'unavailable'); }
      if (authState.status === 'expired' || !session.record.accessToken || !Number.isFinite(expiry) || expiry <= now) return row('unavailable');
    }
  }
  // Claude's flow: use the discovered token, refresh once on auth rejection,
  // then retry once. Membership and plan calls share that recovery boundary.
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const headers = { authorization: `Bearer ${session.record.accessToken}`, 'content-type': 'application/json' };
      const membershipUrl = region === 'cn' ? MINIMAX_CODE_MEMBERSHIP_URL_CN : MINIMAX_CODE_MEMBERSHIP_URL_INTL;
      const extra = await minimaxCodeRequest(new URL('/matrix/api/v1/user/get_user_extra_info', membershipUrl).href,
        { method: 'POST', headers, body: '{}' }, deps);
      const personal = extra?.workspaces?.filter(workspace => workspace?.workspace_type === 0);
      const workspaceId = personal?.length === 1 ? personal[0].workspace_id : null;
      if (!((typeof workspaceId === 'string' && workspaceId.trim())
        || (Number.isSafeInteger(workspaceId) && workspaceId >= 0))) return row('unavailable');
      const membership = await minimaxCodeRequest(membershipUrl, { method: 'POST', headers, body: JSON.stringify({ workspace_id: workspaceId }) }, deps);
      const groupId = typeof membership?.op_group_id === 'string' ? membership.op_group_id.trim() : '';
      accountKey = groupId ? hashKey('minimax', `code:${region}:${groupId}`) : '';
      const credits = parseNumberOrNull(membership?.op_credit_summary?.total_remaining_amount);
      if (credits === null) return row('unavailable');
      // No allowance and no observed spend, so the shared top-up meter would
      // read a positive balance as full. Opt out the way Claude's prepaid pool
      // and Command Code's top-up do; the API wallet keeps the shared meter.
      const windows = [{ kind: 'billing', metric: 'credits', label: 'Credits', remaining: credits,
        currency: 'CREDITS', showMeter: false }];
      const platformUrl = region === 'cn' ? MINIMAX_CODE_PLAN_REMAINS_URL_CN : MINIMAX_CODE_PLAN_REMAINS_URL_INTL;
      const platformHeaders = { ...headers, 'X-Group-Id': groupId };
      if (groupId) {
        try {
          const balance = await minimaxCodeRequest(new URL('/account/query_balance', platformUrl).href, { headers: platformHeaders }, deps);
          windows.push(...parseMinimaxBalance(balance, region).map(window => ({ ...window, label: 'API Balance' })));
        } catch (error) {
          if (deps.signal?.aborted) throw error;
          // A cash-wallet refusal must not discard the separate Code points.
        }
      }
      if (groupId && membership.has_token_plan === true) {
        try {
          const plan = await minimaxCodeRequest(platformUrl, { headers: platformHeaders }, deps);
          if (parseNumberOrNull(plan?.base_resp?.status_code) !== 2062) {
            const planWindows = parseMinimaxCodePlan(plan);
            if (!planWindows.length) throw errorWithStatus('unavailable', 'MiniMax Code plan quota missing');
            windows.push(...planWindows);
          }
        } catch (error) {
          if (deps.signal?.aborted || isMinimaxAuthError(error)) throw error;
          // Reuse the runtime's partial-window merge: replace the current
          // credits but retain any prior plan windows with stale freshness.
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
  const fetchJson = deps.fetchJson
    || ((u, headers) => minimaxJsonFetch(deps.fetch || fetch, u, { headers }, deps));
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
  MINIMAX_CODE_PENDING_WRITE_STATE_KEY,
  MINIMAX_CODE_OAUTH_URL_CN,
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
