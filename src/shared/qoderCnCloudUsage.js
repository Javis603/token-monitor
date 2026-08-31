'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { runWithProbeDeadline } = require('./probeDeadline');
const { hashKey } = require('./hashKey');

// Qoder CN (com.qodercn.app.stable) cloud usage collection over the account's
// quota API. Since the 0.1.x rewrite the client keeps no local token-usage
// database — the legacy %APPDATA%\QoderCN local.db stopped updating, and the
// new main.sqlite stores chat content only. The cloud endpoint
// `GET /api/v2/quota/usage` on openapi.qoder.com.cn is the only live source; it
// answers cumulative credits, so daily usage is derived by snapshot
// differencing (first run establishes a baseline, usage while the monitor was
// not running is not recoverable).
//
// Auth: the `dt-` token is read automatically from the client's
// %APPDATA%\com.qodercn.app.stable\auth.v1.dat — DPAPI (Windows) decrypts the
// AES key from Local State, AES-256-GCM then decrypts the auth blob. An
// explicit token via settings/env wins when present.

const QODER_CN_CLOUD_ORIGIN = 'https://openapi.qoder.com.cn';
const QODER_CN_CLOUD_QUOTA_PATH = '/api/v2/quota/usage';
const QODER_CN_CLOUD_PLAN_PATH = '/api/v2/user/plan';
const QODER_CN_CLOUD_FETCH_TIMEOUT_MS = 12_000;
// Watch-triggered ticks from other clients must not hammer the Qoder endpoint.
// A cached snapshot serves them; the next interval tick refreshes it.
const QODER_CN_CLOUD_QUOTA_CACHE_TTL_MS = 5 * 60 * 1000;
const QODER_CN_AUTH_CACHE_TTL_MS = 10 * 60 * 1000;
const QODER_CN_CLOUD_STATE_VERSION = 1;
const QODER_CN_CLOUD_STATE_FILE = 'qoder-cn-credit-snapshots.json';
const QODER_CN_CLOUD_STATE_MAX_DAYS = 400;
const QODER_CN_CLOUD_MAIN_MODEL = 'Qoder Credits';
const QODER_CN_CLOUD_PACKAGE_MODEL = 'Qoder Package Credits';

const QODER_CN_CLOUD_ERROR_CODES = Object.freeze({
  MISSING_TOKEN: 'QODER_CN_MISSING_TOKEN',
  UNAUTHORIZED: 'QODER_CN_UNAUTHORIZED',
  BAD_RESPONSE: 'QODER_CN_BAD_RESPONSE'
});

function cleanSecret(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if ((raw.startsWith('"') && raw.endsWith('"')) || (raw.startsWith("'") && raw.endsWith("'"))) {
    raw = raw.slice(1, -1).trim();
  }
  return /[\r\n]/.test(raw) ? '' : raw;
}

function numeric(value) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : null;
}

function qoderCnError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function localDateKey(value) {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return '';
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

// Where the Qoder CN client keeps its encrypted account state on this machine.
function qoderCnAuthDir(options = {}) {
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const override = cleanSecret(env.QODER_CN_AUTH_DIR);
  if (override && path.isAbsolute(override)) return override;
  let appSupport;
  if (platform === 'darwin') appSupport = path.join(home, 'Library', 'Application Support');
  else if (platform === 'win32') appSupport = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming');
  else {
    const xdg = env.XDG_CONFIG_HOME;
    appSupport = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
  }
  return path.join(appSupport, 'com.qodercn.app.stable');
}

// ---------------------------------------------------------------------------
// Token — explicit first, then the client's encrypted auth file.

function qoderCnCloudToken(options = {}, env = process.env) {
  const explicit = cleanSecret(options.qoderCnAccessToken)
    .replace(/^authorization\s*:\s*/i, '')
    .replace(/^bearer\s+/i, '')
    .trim();
  if (explicit) return explicit;
  for (const name of ['TOKEN_MONITOR_QODER_CN_ACCESS_TOKEN', 'QODER_CN_ACCESS_TOKEN']) {
    const raw = cleanSecret(env[name]).replace(/^bearer\s+/i, '').trim();
    if (raw) return raw;
  }
  return '';
}

let cachedAuth = null;

function dpapiUnprotect(koffi, input) {
  const DATA_BLOB = koffi.struct('DATA_BLOB', { cbData: 'uint32', pbData: 'void *' });
  const crypt32 = koffi.load('crypt32.dll');
  const kernel32 = koffi.load('kernel32.dll');
  const CryptUnprotectData = crypt32.func('__stdcall', 'CryptUnprotectData', 'bool', [
    'DATA_BLOB *', 'const char **', 'void *', 'void *', 'void *', 'uint32', koffi.out(koffi.pointer(DATA_BLOB))
  ]);
  const LocalFree = kernel32.func('__stdcall', 'LocalFree', 'void *', ['void *']);
  const inBuf = Buffer.from(input);
  const inBlob = { cbData: inBuf.length, pbData: inBuf };
  const outBlob = { cbData: 0, pbData: null };
  const ok = CryptUnprotectData(inBlob, null, null, null, null, 0, outBlob);
  if (!ok) throw new Error('CryptUnprotectData failed');
  const bytes = koffi.decode(outBlob.pbData, 'uint8', outBlob.cbData);
  if (outBlob.cbData > 0) LocalFree(outBlob.pbData);
  return Buffer.from(bytes);
}

function decryptQoderCnAuth(authDir, options = {}) {
  const localStateRaw = fs.readFileSync(path.join(authDir, 'Local State'), 'utf8');
  const localState = JSON.parse(localStateRaw);
  const keyBlob = Buffer.from(String(localState?.os_crypt?.encrypted_key || ''), 'base64');
  // "DPAPI" (5-byte prefix) on Windows; "v10" would be the macOS/legacy shape.
  const keyPrefix = keyBlob.slice(0, 5).toString('latin1');
  const keyOffset = keyPrefix === 'DPAPI' ? 5 : keyPrefix.startsWith('v10') ? 3 : 0;
  if (keyOffset === 0 || keyBlob.length <= keyOffset) {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'Qoder CN Local State has no DPAPI/v10 os_crypt key');
  }
  const platform = options.platform || process.platform;
  if (platform !== 'win32') {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.MISSING_TOKEN, 'Qoder CN auth auto-decrypt is Windows-only; set an access token instead');
  }
  const koffi = require('koffi');
  const key = dpapiUnprotect(koffi, keyBlob.slice(keyOffset));
  const blob = fs.readFileSync(path.join(authDir, 'auth.v1.dat'));
  if (blob.slice(0, 3).toString('latin1') !== 'v10') {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'Qoder CN auth.v1.dat is not a v10 encrypted blob');
  }
  const nonce = blob.slice(3, 15);
  const tag = blob.slice(blob.length - 16);
  const ciphertext = blob.slice(15, blob.length - 16);
  const decipher = crypto.createDecipheriv('aes-256-gcm', key, nonce);
  decipher.setAuthTag(tag);
  const plain = Buffer.concat([decipher.update(ciphertext), decipher.final()]);
  const auth = JSON.parse(plain.toString('utf8'));
  if (!auth || typeof auth.token !== 'string' || !auth.token) {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'Qoder CN auth blob has no token');
  }
  return auth;
}

// Best-effort token: explicit → cached auth → on-disk decrypt. Returns '' when
// nothing is available (caller decides whether that is fatal).
async function qoderCnCloudTokenAuto(options = {}) {
  const explicit = qoderCnCloudToken(options, options.env || process.env);
  if (explicit) return explicit;
  const nowMs = options.nowMs ?? Date.now();
  if (cachedAuth && nowMs - cachedAuth.at < QODER_CN_AUTH_CACHE_TTL_MS && !options.forceRefresh) {
    if (Date.parse(cachedAuth.auth.expiresAt) > nowMs) return cachedAuth.auth.token;
  }
  const authDir = options.authDir || qoderCnAuthDir(options);
  const authPath = path.join(authDir, 'auth.v1.dat');
  if (!fs.existsSync(authPath)) return '';
  const auth = decryptQoderCnAuth(authDir, options);
  cachedAuth = { auth, at: nowMs };
  return auth.token;
}

// ---------------------------------------------------------------------------
// Quota API.

function qoderCnCloudHeaders(accessToken) {
  return {
    Accept: 'application/json',
    Authorization: `Bearer ${accessToken}`,
    'Cosy-ClientType': '10',
    'User-Agent': 'Qoder'
  };
}

function packageLabel(pkg) {
  const labels = Array.isArray(pkg?.displayLabels) ? pkg.displayLabels : [];
  const title = labels.find((entry) => String(entry?.dimension || '') === 'title');
  const i18n = title?.valueI18n;
  const label = (i18n && (i18n['zh-CN'] || i18n['en-US'])) || title?.value || pkg?.name || '';
  return String(label || '').trim().slice(0, 64);
}

function parseQoderCnCloudQuota(body) {
  const userQuota = body?.userQuota && typeof body.userQuota === 'object' ? body.userQuota : null;
  const used = numeric(userQuota?.used);
  const total = numeric(userQuota?.total);
  if (used === null || total === null) {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'Qoder CN quota response has no userQuota totals');
  }
  const packages = [];
  for (const pkg of Array.isArray(body?.dedicatedResourcePackages) ? body.dedicatedResourcePackages : []) {
    const pkgUsed = numeric(pkg?.used);
    const pkgTotal = numeric(pkg?.total);
    if (pkgUsed === null || pkgTotal === null) continue;
    packages.push({
      id: String(pkg?.id || '').trim(),
      name: String(pkg?.name || '').trim(),
      label: packageLabel(pkg),
      used: pkgUsed,
      total: pkgTotal,
      remaining: Math.max(0, numeric(pkg?.remaining) ?? Math.max(0, pkgTotal - pkgUsed)),
      expiresAt: numeric(pkg?.expiresAt) || null,
      available: pkg?.available !== false && pkg?.status !== 'QUOTA_DETAIL_STATUS_EXPIRED'
    });
  }
  return {
    userId: String(body?.userId || '').trim(),
    used,
    total,
    remaining: Math.max(0, numeric(userQuota?.remaining) ?? Math.max(0, total - used)),
    unit: String(userQuota?.unit || 'credits'),
    expiresAt: numeric(body?.expiresAt) || null,
    packages
  };
}

const quotaSnapshotCache = new Map();

async function fetchQoderCnCloudQuota(options = {}) {
  const accessToken = typeof options.accessToken === 'string' && options.accessToken
    ? options.accessToken
    : await qoderCnCloudTokenAuto(options);
  if (!accessToken) {
    throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.MISSING_TOKEN, 'qodercn cloud usage needs the Qoder CN client signed in (auth.v1.dat) or an access token');
  }
  const nowMs = options.nowMs ?? Date.now();
  const cacheKey = hashKey('qodercn-cloud', accessToken);
  const cached = quotaSnapshotCache.get(cacheKey);
  if (cached && nowMs - cached.at < (options.cacheTtlMs ?? QODER_CN_CLOUD_QUOTA_CACHE_TTL_MS) && !options.forceRefresh) {
    return cached.snapshot;
  }
  const origin = options.origin || QODER_CN_CLOUD_ORIGIN;
  const snapshot = await runWithProbeDeadline(
    async ({ signal }) => {
      const response = await (options.fetch || fetch)(`${origin}${QODER_CN_CLOUD_QUOTA_PATH}`, {
        headers: qoderCnCloudHeaders(accessToken),
        signal
      });
      if (response.status === 401 || response.status === 403) {
        cachedAuth = null;
        throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.UNAUTHORIZED, `Qoder CN quota API returned ${response.status} (token rejected)`);
      }
      if (!response.ok) {
        throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, `Qoder CN quota API returned ${response.status}`);
      }
      let body;
      try {
        body = await response.json();
      } catch (_) {
        throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'Qoder CN quota API returned a non-JSON body');
      }
      const quota = parseQoderCnCloudQuota(body);
      return { quota, accountKey: hashKey('qodercn', quota.userId || accessToken), at: nowMs };
    },
    { signal: options.signal, deadlineMs: options.fetchTimeoutMs ?? QODER_CN_CLOUD_FETCH_TIMEOUT_MS }
  );
  quotaSnapshotCache.set(cacheKey, { at: nowMs, snapshot });
  if (quotaSnapshotCache.size > 4) {
    const oldest = [...quotaSnapshotCache.entries()].sort((a, b) => a[1].at - b[1].at)[0];
    if (oldest) quotaSnapshotCache.delete(oldest[0]);
  }
  return snapshot;
}

// Plan tier for the limits account label. Non-fatal: any failure just leaves
// the label empty.
async function fetchQoderCnCloudPlanTier(options = {}) {
  const accessToken = typeof options.accessToken === 'string' && options.accessToken
    ? options.accessToken
    : await qoderCnCloudTokenAuto(options);
  if (!accessToken) return '';
  const origin = options.origin || QODER_CN_CLOUD_ORIGIN;
  try {
    return await runWithProbeDeadline(
      async ({ signal }) => {
        const response = await (options.fetch || fetch)(`${origin}${QODER_CN_CLOUD_PLAN_PATH}`, {
          headers: qoderCnCloudHeaders(accessToken),
          signal
        });
        if (!response.ok) return '';
        const body = await response.json();
        return String(body?.plan_tier_name || body?.planTierName || '').trim().slice(0, 64);
      },
      { signal: options.signal, deadlineMs: options.fetchTimeoutMs ?? QODER_CN_CLOUD_FETCH_TIMEOUT_MS }
    );
  } catch (_) {
    return '';
  }
}

function resetQoderCnCloudQuotaCache() {
  quotaSnapshotCache.clear();
  cachedAuth = null;
}

// ---------------------------------------------------------------------------
// Snapshot differencing — daily credit usage.

function qoderCnCloudStatePath(options = {}) {
  const explicit = cleanSecret(options.statePath);
  if (explicit && path.isAbsolute(explicit)) return explicit;
  const home = options.homeDir || os.homedir();
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  if (platform === 'win32') {
    const appData = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0) ? env.APPDATA : path.join(home, 'AppData', 'Roaming');
    return path.join(appData, 'Token Monitor', QODER_CN_CLOUD_STATE_FILE);
  }
  if (platform === 'darwin') return path.join(home, 'Library', 'Application Support', 'Token Monitor', QODER_CN_CLOUD_STATE_FILE);
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(home, '.config');
  return path.join(configHome, 'Token Monitor', QODER_CN_CLOUD_STATE_FILE);
}

function loadQoderCnCloudState(statePath) {
  try {
    const parsed = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    if (parsed && typeof parsed === 'object' && parsed.version === QODER_CN_CLOUD_STATE_VERSION) return parsed;
  } catch (_) {}
  return null;
}

function saveQoderCnCloudState(statePath, state) {
  try {
    fs.mkdirSync(path.dirname(statePath), { recursive: true });
    fs.writeFileSync(statePath, JSON.stringify(state));
  } catch (_) {
    // A read-only or locked state file degrades to in-memory differencing for
    // this process; the next tick re-reads whatever is on disk.
  }
}

function cloudRowsFromDays(days) {
  const rows = [];
  for (const [dayKey, day] of Object.entries(days || {})) {
    const createdAt = Date.parse(`${dayKey}T12:00:00`);
    if (!Number.isFinite(createdAt)) continue;
    if (day.credits > 0) {
      rows.push({
        sessionId: `qodercn:credits:${dayKey}`,
        messageId: `qodercn:credits:${dayKey}:main`,
        model: QODER_CN_CLOUD_MAIN_MODEL,
        projectLabel: '',
        input: Math.round(day.credits),
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        createdAt,
        messages: 1
      });
    }
    for (const [pkgId, amount] of Object.entries(day.packages || {})) {
      if (!(amount > 0)) continue;
      rows.push({
        sessionId: `qodercn:credits:${dayKey}:${pkgId}`,
        messageId: `qodercn:credits:${dayKey}:${pkgId}`,
        model: day.packageLabels?.[pkgId] || QODER_CN_CLOUD_PACKAGE_MODEL,
        projectLabel: '',
        input: Math.round(amount),
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        createdAt,
        messages: 1
      });
    }
  }
  return rows;
}

// One row set per tick. The snapshot state carries the last observed quota and
// per-day credit deltas; a decreasing used value (quota reset, renewal, or a
// newly granted package) rebaselines without emitting negative usage.
async function collectQoderCnCloudRows(options = {}) {
  const nowMs = options.nowMs ?? Date.now();
  const { quota, accountKey } = await fetchQoderCnCloudQuota({ ...options, nowMs });
  const statePath = qoderCnCloudStatePath(options);
  let state = loadQoderCnCloudState(statePath);
  if (!state || state.accountKey !== accountKey) {
    state = { version: QODER_CN_CLOUD_STATE_VERSION, accountKey, last: null, days: {} };
  }
  const dayKey = localDateKey(nowMs);
  if (!dayKey) throw qoderCnError(QODER_CN_CLOUD_ERROR_CODES.BAD_RESPONSE, 'could not resolve the local day for qodercn cloud credits');
  const day = state.days[dayKey] || (state.days[dayKey] = { credits: 0, packages: {}, packageLabels: {} });

  const previous = state.last;
  if (previous && previous.at < nowMs) {
    const deltaMain = quota.used - previous.used;
    if (deltaMain > 0) day.credits += deltaMain;
    const previousPackages = previous.packages || {};
    for (const pkg of quota.packages) {
      const previousUsed = previousPackages[pkg.id];
      if (previousUsed === undefined) continue; // newly appeared package: baseline only
      const delta = pkg.used - previousUsed;
      if (delta > 0) day.packages[pkg.id] = (day.packages[pkg.id] || 0) + delta;
    }
  }
  for (const pkg of quota.packages) {
    if (pkg.label) day.packageLabels[pkg.id] = pkg.label;
  }
  state.last = {
    at: nowMs,
    used: quota.used,
    packages: Object.fromEntries(quota.packages.map((pkg) => [pkg.id, pkg.used]))
  };
  const dayKeys = Object.keys(state.days).sort();
  for (const key of dayKeys.slice(0, Math.max(0, dayKeys.length - QODER_CN_CLOUD_STATE_MAX_DAYS))) {
    delete state.days[key];
  }
  saveQoderCnCloudState(statePath, state);

  const rows = cloudRowsFromDays(state.days);
  const sinceMs = options.sinceMs;
  if (sinceMs === undefined) return rows;
  return rows.filter((row) => row.createdAt >= sinceMs);
}

// ---------------------------------------------------------------------------
// Limits view projection (provider `qoder`, region cn).

function toIsoOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date.toISOString();
}

async function fetchQoderCnCloudLimits(options = {}, deps = {}) {
  const normalize = deps.normalizeLimitProvider || require('./limits').normalizeLimitProvider;
  const now = (deps.now || Date.now)();
  const updatedAt = new Date(now).toISOString();
  try {
    const { quota } = await fetchQoderCnCloudQuota({ ...options, nowMs: now });
    const windows = [];
    const percent = (used, total) => (total > 0 ? Math.max(0, Math.min(100, (used / total) * 100)) : 0);
    windows.push({
      kind: 'billing',
      label: 'Credits',
      used: quota.used,
      limit: quota.total,
      remaining: quota.remaining,
      usedPercent: percent(quota.used, quota.total),
      remainingPercent: 100 - percent(quota.used, quota.total),
      resetsAt: toIsoOrNull(quota.expiresAt),
      showMeter: true
    });
    for (const pkg of quota.packages) {
      if (!pkg.available) continue;
      windows.push({
        kind: 'billing',
        label: pkg.label || pkg.name || 'Package Credits',
        used: pkg.used,
        limit: pkg.total,
        remaining: pkg.remaining,
        usedPercent: percent(pkg.used, pkg.total),
        remainingPercent: 100 - percent(pkg.used, pkg.total),
        resetsAt: toIsoOrNull(pkg.expiresAt),
        showMeter: true
      });
    }
    const accountLabel = await fetchQoderCnCloudPlanTier({ ...options, nowMs: now });
    return normalize({
      provider: 'qoder',
      accountKey: hashKey('qodercn', quota.userId || 'qoder-cn-cloud'),
      accountLabel,
      source: 'cloud',
      status: 'ok',
      updatedAt,
      windows,
      region: 'cn'
    });
  } catch (error) {
    if (error?.code === QODER_CN_CLOUD_ERROR_CODES.MISSING_TOKEN) return null;
    return normalize({
      provider: 'qoder',
      source: 'cloud',
      status: 'unavailable',
      updatedAt,
      windows: [],
      region: 'cn'
    });
  }
}

module.exports = {
  QODER_CN_CLOUD_ERROR_CODES,
  QODER_CN_CLOUD_MAIN_MODEL,
  QODER_CN_CLOUD_ORIGIN,
  QODER_CN_CLOUD_STATE_FILE,
  collectQoderCnCloudRows,
  fetchQoderCnCloudLimits,
  fetchQoderCnCloudPlanTier,
  fetchQoderCnCloudQuota,
  qoderCnCloudToken,
  qoderCnCloudTokenAuto,
  qoderCnAuthDir,
  qoderCnCloudStatePath,
  resetQoderCnCloudQuotaCache
};
