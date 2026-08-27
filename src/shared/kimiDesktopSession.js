'use strict';

// Reads — and, when the Kimi Work desktop app is not running, refreshes — the
// app's session store so the limits collector can reuse its rotating web
// session instead of a hand-pasted token.
//
// Why this exists: www.kimi.com no longer authenticates with the legacy
// `kimi-auth` cookie (the website never refreshes it, so it expires 30 days
// after login), and the localStorage `access_token` lives only ~15 minutes.
// The desktop app holds an `access_token` + `refresh_token` pair, refreshes the
// access token whenever the app is active, and writes the new pair —
// DPAPI-protected via Electron safeStorage — to bridge-store/token-store.json
// after every rotation.
//
// Refreshing on the app's behalf is only safe while the app is NOT running:
// its TokenStore reads the file once at startup into an in-memory map (there is
// no file watcher), refresh tokens rotate on every use, and a refresh failure
// inside the app escalates to `clear()` — wiping the session and logging the
// user out. So this module checks for a running `kimi-desktop\Kimi.exe` before
// refreshing, and when the app is running it stays strictly read-only and lets
// the app remain the sole refresh owner. A refresh failure here never clears
// the store; the app's next real login self-heals whatever we leave behind.

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { sharedDataDir } = require('./config');

const KIMI_DESKTOP_DIR_NAME = 'kimi-desktop';
const TOKEN_STORE_RELATIVE_PATH = path.join('bridge-store', 'token-store.json');
const LOCAL_STATE_RELATIVE_PATH = 'Local State';
const DPAPI_PREFIX = 'DPAPI';
const MASTER_KEY_LENGTH = 32;
const POWERSHELL_TIMEOUT_MS = 10_000;
const TASKLIST_TIMEOUT_MS = 5_000;
const DISABLE_VALUES = new Set(['0', 'false', 'off', 'no']);

// Manual refresh-token sessions persist their rotated pair next to the other
// shared runtime state: the pasted seed stays in the user's credential store,
// while this cache is collector-owned and rewritten on every rotation.
const KIMI_MANUAL_SESSION_FILE = 'kimi-manual-session.json';
// Access tokens live ~15 minutes and refresh tokens ~90 days; anything with a
// lifetime past an hour is a refresh token for classification purposes.
const REFRESH_TOKEN_MIN_LIFETIME_S = 60 * 60;

// Same connect-RPC endpoint the desktop app's TokenStore uses (its REST
// fallback path no longer exists server-side).
const KIMI_AUTH_REFRESH_URL = 'https://auth.kimi.com/api/account.gateway.v1.AuthService/RefreshToken';
const KIMI_REFRESH_TIMEOUT_MS = 12_000;
const KIMI_REFRESH_RETRY_COOLDOWN_MS = 60_000;

function desktopSessionEnabled(env = process.env) {
  const raw = String(env?.TOKEN_MONITOR_KIMI_DESKTOP_SESSION ?? '').trim().toLowerCase();
  return !DISABLE_VALUES.has(raw);
}

// The store only exists on Windows; the APPDATA requirement also keeps the
// default reader out of tests, which pass a stripped `env: {}`.
function desktopSessionReadable(env = process.env, platform = process.platform) {
  return platform === 'win32' && Boolean(env?.APPDATA) && desktopSessionEnabled(env);
}

function kimiDesktopAppDataDir(env = process.env) {
  return env?.APPDATA ? path.join(env.APPDATA, KIMI_DESKTOP_DIR_NAME) : '';
}

function tokenStorePath(env = process.env) {
  const dir = kimiDesktopAppDataDir(env);
  return dir ? path.join(dir, TOKEN_STORE_RELATIVE_PATH) : '';
}

// Cheap synchronous probe for UI status; deliberately does not decrypt.
function kimiDesktopTokenStoreExists(env = process.env, platform = process.platform) {
  if (!desktopSessionReadable(env, platform)) return false;
  try {
    return fs.existsSync(tokenStorePath(env));
  } catch (_) {
    return false;
  }
}

// Chromium OSCrypt "v10" layout: `v10` || 12-byte nonce || ciphertext || 16-byte
// GCM tag, AES-256-GCM under the DPAPI-protected master key from Local State.
function decryptSafeStorageV10(buffer, key) {
  if (!Buffer.isBuffer(buffer) || buffer.length < 3 + 12 + 16) return null;
  if (buffer.slice(0, 3).toString('latin1') !== 'v10') return null;
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, buffer.slice(3, 15));
    decipher.setAuthTag(buffer.slice(buffer.length - 16));
    return Buffer.concat([decipher.update(buffer.slice(15, buffer.length - 16)), decipher.final()]).toString('utf8');
  } catch (_) {
    return null;
  }
}

function runPowerShell(script) {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-Command', script],
      { timeout: POWERSHELL_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? null : String(stdout))
    );
  });
}

// Decrypts one DPAPI blob with the current user's scope. The `DPAPI` prefix
// Chromium stores in front of the key is already stripped by the caller, so the
// script feeds FromBase64String's output straight to Unprotect. spawn-based, so
// callers cache the result.
async function unprotectDpapi(base64Blob) {
  const script = [
    'Add-Type -AssemblyName System.Security',
    `$b = [Convert]::FromBase64String('${String(base64Blob)}')`,
    '$k = [Security.Cryptography.ProtectedData]::Unprotect($b, $null, [Security.Cryptography.DataProtectionScope]::CurrentUser)',
    '[BitConverter]::ToString($k)'
  ].join('; ');
  const stdout = await runPowerShell(script);
  if (!stdout) return null;
  const hex = stdout.replace(/[^0-9a-fA-F]/g, '');
  if (hex.length !== MASTER_KEY_LENGTH * 2) return null;
  return Buffer.from(hex, 'hex');
}

function decodeJwtPayload(token) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return null;
  try {
    return JSON.parse(Buffer.from(parts[1], 'base64url').toString('utf8'));
  } catch (_) {
    return null;
  }
}

function jwtExpiryMs(payload) {
  const exp = Number(payload?.exp);
  return Number.isFinite(exp) && exp > 0 ? exp * 1000 : null;
}

// Master key per encrypted_key value (the desktop app only rotates it on
// reinstall) and the decrypted store keyed by token-store mtime, so steady-state
// limits ticks do no crypto work at all.
const masterKeyCache = new Map();
let storeCache = { appDataDir: '', mtimeMs: 0, session: null };
let lastRefreshAttemptMs = 0;
let lastRefreshOutcome = null;
let inFlightRefresh = null;

async function masterKeyFor(appDataDir, deps) {
  const localStatePath = path.join(appDataDir, LOCAL_STATE_RELATIVE_PATH);
  const readFile = deps.readFile || fs.readFileSync;
  let localState;
  try {
    localState = JSON.parse(readFile(localStatePath, 'utf8'));
  } catch (_) {
    return null;
  }
  const encryptedKey = String(localState?.os_crypt?.encrypted_key || '');
  if (!encryptedKey) return null;
  if (masterKeyCache.has(encryptedKey)) return masterKeyCache.get(encryptedKey);
  const blob = Buffer.from(encryptedKey, 'base64');
  if (blob.slice(0, DPAPI_PREFIX.length).toString('latin1') !== DPAPI_PREFIX) return null;
  const key = await (deps.unprotectDpapi || unprotectDpapi)(blob.slice(DPAPI_PREFIX.length).toString('base64'));
  if (!key || key.length !== MASTER_KEY_LENGTH) return null;
  masterKeyCache.set(encryptedKey, key);
  return key;
}

function encryptSafeStorageV10(plain, key) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()]);
}

function writeTokenStore(appDataDir, parsed, key, deps = {}) {
  const storePath = path.join(appDataDir, TOKEN_STORE_RELATIVE_PATH);
  const writeFile = deps.writeFile || fs.writeFileSync;
  const blob = encryptSafeStorageV10(JSON.stringify(parsed), key).toString('base64');
  writeFile(storePath, JSON.stringify({ encryption: 'safeStorage.v1', data: blob }));
  try { fs.chmodSync(storePath, 0o600); } catch (_) { /* Windows ACLs own this */ }
}

function parseTokenStore(plain, nowMs) {
  let parsed;
  try {
    parsed = JSON.parse(plain);
  } catch (_) {
    return null;
  }
  const tokens = parsed?.tokens && typeof parsed.tokens === 'object' ? parsed.tokens : null;
  const accessToken = typeof tokens?.access_token === 'string' ? tokens.access_token.trim() : '';
  const refreshToken = typeof tokens?.refresh_token === 'string' ? tokens.refresh_token.trim() : '';
  if (!accessToken || !refreshToken) return null;
  const accessPayload = decodeJwtPayload(accessToken);
  const refreshPayload = decodeJwtPayload(refreshToken);
  if (!accessPayload || !refreshPayload) return null;
  const accessExpiresAtMs = jwtExpiryMs(accessPayload);
  const refreshExpiresAtMs = jwtExpiryMs(refreshPayload);
  if (!accessExpiresAtMs || !refreshExpiresAtMs) return null;
  // msh_user_id is the stable account identifier; the refresh token rotates on
  // every desktop-app refresh, so keying the account on it would flap.
  const userId = String(tokens.msh_user_id || refreshPayload.sub || '').trim();
  return {
    accessToken,
    refreshToken,
    userId,
    accessExpiresAtMs,
    accessIsStale: accessExpiresAtMs <= nowMs,
    refreshExpiresAtMs,
    refreshIsDead: refreshExpiresAtMs <= nowMs
  };
}

// The parsed document behind a session, for write-back paths that must keep the
// sibling fields (origin, anonymous tokens, user metadata) untouched.
function decodeTokenStoreDocument(plain) {
  try {
    const parsed = JSON.parse(plain);
    return parsed && typeof parsed === 'object' && parsed.tokens && typeof parsed.tokens === 'object'
      ? parsed
      : null;
  } catch (_) {
    return null;
  }
}

// tasklist reports image name + full path; matching on the install dir keeps a
// same-named unrelated "Kimi.exe" from blocking our refresh.
function tasklistShowsKimiDesktop(stdout) {
  return /kimi-desktop[\\/]kimi\.exe/i.test(String(stdout || ''));
}

function checkKimiDesktopAppRunning(deps = {}) {
  if (typeof deps.checkAppRunning === 'function') {
    try {
      return Promise.resolve(deps.checkAppRunning());
    } catch (_) {
      return Promise.resolve(true); // fail closed: assume the app is running
    }
  }
  if ((deps.platform || process.platform) !== 'win32') return Promise.resolve(false);
  return new Promise((resolve) => {
    execFile(
      'tasklist.exe',
      ['/FI', 'IMAGENAME eq Kimi.exe', '/FO', 'CSV', '/NH'],
      { timeout: TASKLIST_TIMEOUT_MS, windowsHide: true, maxBuffer: 64 * 1024 },
      (error, stdout) => resolve(error ? true : tasklistShowsKimiDesktop(stdout))
    );
  });
}

function kimiDesktopAppRunning(deps = {}) {
  return checkKimiDesktopAppRunning(deps);
}

function validRefreshedTokens(json, nowMs) {
  const accessToken = typeof json?.accessToken === 'string' ? json.accessToken.trim() : '';
  const refreshToken = typeof json?.refreshToken === 'string' ? json.refreshToken.trim() : '';
  if (!accessToken || !refreshToken) return null;
  const accessPayload = decodeJwtPayload(accessToken);
  const refreshPayload = decodeJwtPayload(refreshToken);
  if (!accessPayload || !refreshPayload) return null;
  const accessExpiresAtMs = jwtExpiryMs(accessPayload);
  const refreshExpiresAtMs = jwtExpiryMs(refreshPayload);
  if (!accessExpiresAtMs || accessExpiresAtMs <= nowMs || !refreshExpiresAtMs) return null;
  return { accessToken, refreshToken, accessExpiresAtMs, refreshExpiresAtMs };
}

async function runKimiTokenRefreshFetch(url, init, deps) {
  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), Number(deps.refreshTimeoutMs) || KIMI_REFRESH_TIMEOUT_MS) : null;
  try {
    return await (deps.fetch || fetch)(url, { ...init, ...(controller ? { signal: controller.signal } : {}) });
  } finally {
    if (timer) clearTimeout(timer);
  }
}

// Kimi's auth endpoint occasionally hangs or drops a connection outright; one
// quick retry keeps a transient network blip from costing a whole limits tick.
async function requestKimiTokenRefresh(refreshToken, deps) {
  const init = {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'connect-protocol-version': '1'
    },
    body: JSON.stringify({ refreshToken })
  };
  let response;
  for (let attempt = 0; ; attempt += 1) {
    const startedAt = Date.now();
    try {
      response = await runKimiTokenRefreshFetch(KIMI_AUTH_REFRESH_URL, init, deps);
      break;
    } catch (error) {
      const transient = !error?.status && Date.now() - startedAt < 5_000;
      if (!transient || attempt >= 1) throw error;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
  }
  if (response.status === 401 || response.status === 403) {
    const error = new Error('Kimi refresh token rejected');
    error.status = 'unauthorized';
    throw error;
  }
  if (!response.ok) throw new Error(`Kimi token refresh returned ${response.status}`);
  return response.json();
}

// Refreshes the stored pair while the desktop app is not running and writes the
// rotated pair back in the app's own safeStorage format, so the app's next start
// picks it up transparently. Returns the refreshed session or null; a rejected
// refresh token never clears the store (unlike the app's own failure path) —
// the status is surfaced for the caller to report.
async function refreshKimiDesktopSession(deps = {}) {
  if (inFlightRefresh) return inFlightRefresh;
  inFlightRefresh = (async () => {
    const env = deps.env || process.env;
    const platform = deps.platform || process.platform;
    const nowMs = (deps.now || Date.now)();
    if (!desktopSessionReadable(env, platform)) return null;
    if (nowMs - lastRefreshAttemptMs < KIMI_REFRESH_RETRY_COOLDOWN_MS) return lastRefreshOutcome;
    lastRefreshAttemptMs = nowMs;
    lastRefreshOutcome = null;
    const running = await kimiDesktopAppRunning(deps);
    if (running) {
      console.log('[kimi] desktop app is running; leaving the refresh to it');
      return null;
    }
    const appDataDir = kimiDesktopAppDataDir(env);
    const storePath = path.join(appDataDir, TOKEN_STORE_RELATIVE_PATH);
    const readFile = deps.readFile || fs.readFileSync;
    let raw;
    try {
      raw = JSON.parse(readFile(storePath, 'utf8'));
    } catch (_) {
      return null;
    }
    if (raw?.encryption !== 'safeStorage.v1' || typeof raw.data !== 'string') return null;
    const key = await masterKeyFor(appDataDir, deps);
    if (!key) return null;
    const plain = decryptSafeStorageV10(Buffer.from(raw.data, 'base64'), key);
    if (!plain) return null;
    const document = decodeTokenStoreDocument(plain);
    const session = parseTokenStore(plain, nowMs);
    if (!document || !session || session.refreshIsDead) return null;
    let json;
    try {
      json = await requestKimiTokenRefresh(session.refreshToken, deps);
    } catch (error) {
      if (error?.status === 'unauthorized') {
        // Surface the dead refresh token but leave the store untouched: the
        // app itself will recover on the user's next real sign-in.
        const rejected = new Error('Kimi desktop app session expired; sign in to the Kimi app to renew it');
        rejected.status = 'unauthorized';
        lastRefreshAttemptMs = nowMs + KIMI_REFRESH_RETRY_COOLDOWN_MS; // steady 2x cooldown on hard failure
        throw rejected;
      }
      return null;
    }
    const refreshed = validRefreshedTokens(json, nowMs);
    if (!refreshed) return null;
    document.tokens.access_token = refreshed.accessToken;
    document.tokens.refresh_token = refreshed.refreshToken;
    try {
      writeTokenStore(appDataDir, document, key, deps);
    } catch (_) {
      // The rotation already happened server-side; without a successful
      // write-back the app would restart on a dead refresh token, so treat this
      // as a hard failure and let the next tick retry from the file we still have.
      return null;
    }
    const next = {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      userId: session.userId,
      accessExpiresAtMs: refreshed.accessExpiresAtMs,
      accessIsStale: false,
      refreshExpiresAtMs: refreshed.refreshExpiresAtMs,
      refreshIsDead: false
    };
    let mtimeMs = 0;
    try { mtimeMs = Number(fs.statSync(storePath).mtimeMs) || 0; } catch (_) { /* cache miss is fine */ }
    storeCache = { appDataDir, mtimeMs, session: next };
    lastRefreshOutcome = next;
    console.log('[kimi] desktop session refreshed while the app is closed');
    return next;
  })();
  try {
    return await inFlightRefresh;
  } finally {
    inFlightRefresh = null;
  }
}

// Classification for pasted credentials: a JWT whose declared lifetime marks it
// as a refresh token (access tokens live minutes, refresh tokens live days).
function looksLikeKimiRefreshToken(token) {
  const payload = decodeJwtPayload(token);
  if (!payload) return false;
  const iat = Number(payload.iat);
  const exp = Number(payload.exp);
  if (!Number.isFinite(exp) || exp <= 0) return false;
  const lifetime = Number.isFinite(iat) ? exp - iat : exp - Math.floor(Date.now() / 1000);
  return lifetime >= REFRESH_TOKEN_MIN_LIFETIME_S;
}

function manualSessionCachePath(deps = {}) {
  const dir = deps.dataDir || sharedDataDir({ env: deps.env || process.env });
  return path.join(dir, KIMI_MANUAL_SESSION_FILE);
}

function decodeManualSessionCache(raw, seedFingerprint) {
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (_) {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || parsed.seed !== seedFingerprint) return null;
  const accessToken = typeof parsed.accessToken === 'string' ? parsed.accessToken.trim() : '';
  const refreshToken = typeof parsed.refreshToken === 'string' ? parsed.refreshToken.trim() : '';
  if (!accessToken || !refreshToken) return null;
  return { accessToken, refreshToken };
}

function sessionFromTokenPair(accessToken, refreshToken, nowMs) {
  const accessPayload = decodeJwtPayload(accessToken);
  const refreshPayload = decodeJwtPayload(refreshToken);
  if (!accessPayload || !refreshPayload) return null;
  const accessExpiresAtMs = jwtExpiryMs(accessPayload);
  const refreshExpiresAtMs = jwtExpiryMs(refreshPayload);
  if (!accessExpiresAtMs || !refreshExpiresAtMs) return null;
  const userId = String(refreshPayload.sub || accessPayload.sub || '').trim();
  return {
    accessToken,
    refreshToken,
    userId,
    accessExpiresAtMs,
    accessIsStale: accessExpiresAtMs <= nowMs,
    refreshExpiresAtMs,
    refreshIsDead: refreshExpiresAtMs <= nowMs
  };
}

// Resolves the manually pasted refresh token into a live session, refreshing
// and persisting the rotated pair when needed. The seed only seeds the first
// rotation; afterwards the cache file is authoritative (refresh tokens rotate
// on every use, so the seed goes stale by design). Never throws: failures
// return null or surface an error carrying a provider status.
async function resolveKimiManualSession(seedRefreshToken, deps = {}) {
  const cleanSeed = String(seedRefreshToken || '').trim();
  if (!cleanSeed || !decodeJwtPayload(cleanSeed)) return null;
  const nowMs = (deps.now || Date.now)();
  const seedFingerprint = hashSeedFingerprint(cleanSeed);
  const cachePath = manualSessionCachePath(deps);
  const readFile = deps.readFile || fs.readFileSync;
  const writeFile = deps.writeFile || fs.writeFileSync;
  let cached = null;
  try {
    cached = decodeManualSessionCache(readFile(cachePath, 'utf8'), seedFingerprint);
  } catch (_) {
    // no cache yet (or unreadable): seed from the pasted token instead
  }
  let session = cached ? sessionFromTokenPair(cached.accessToken, cached.refreshToken, nowMs) : null;
  if (session && !session.accessIsStale && !session.refreshIsDead) return session;
  if (session?.refreshIsDead) return null;
  const refreshTokenForExchange = (session && !session.refreshIsDead ? session.refreshToken : cleanSeed);
  let json;
  try {
    json = await requestKimiTokenRefresh(refreshTokenForExchange, deps);
  } catch (error) {
    if (error?.status === 'unauthorized') {
      const rejected = new Error('Kimi manual refresh token rejected; paste a fresh one from the Kimi website');
      rejected.status = 'unauthorized';
      throw rejected;
    }
    // A transient network failure still leaves a usable cached access token.
    return session && !session.refreshIsDead && session.accessToken ? session : null;
  }
  const refreshed = validRefreshedTokens(json, nowMs);
  if (!refreshed) return null;
  const next = sessionFromTokenPair(refreshed.accessToken, refreshed.refreshToken, nowMs);
  if (!next) return null;
  try {
    writeFile(cachePath, JSON.stringify({
      seed: seedFingerprint,
      accessToken: next.accessToken,
      refreshToken: next.refreshToken
    }));
    try { fs.chmodSync(cachePath, 0o600); } catch (_) { /* Windows ACLs own this */ }
  } catch (_) {
    // Server-side rotation already happened; without persistence the next start
    // falls back to a stale seed, which will surface as a paste-again prompt.
  }
  return next;
}

function hashSeedFingerprint(seed) {
  return crypto.createHash('sha256').update(seed).digest('hex');
}

async function readKimiDesktopSession(deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  if (!desktopSessionReadable(env, platform)) return null;
  const appDataDir = kimiDesktopAppDataDir(env);
  const storePath = path.join(appDataDir, TOKEN_STORE_RELATIVE_PATH);
  const readFile = deps.readFile || fs.readFileSync;
  let mtimeMs;
  try {
    mtimeMs = Number(fs.statSync(storePath).mtimeMs) || 0;
  } catch (_) {
    return null;
  }
  if (storeCache.appDataDir === appDataDir && storeCache.mtimeMs === mtimeMs && storeCache.session) {
    // Recompute the liveness flags on every read: they are relative to "now",
    // and a cached false would let a token slide into expiry undetected.
    const cachedNowMs = (deps.now || Date.now)();
    return {
      ...storeCache.session,
      accessIsStale: storeCache.session.accessExpiresAtMs <= cachedNowMs,
      refreshIsDead: storeCache.session.refreshExpiresAtMs <= cachedNowMs
    };
  }
  let raw;
  try {
    raw = JSON.parse(readFile(storePath, 'utf8'));
  } catch (_) {
    return null;
  }
  if (raw?.encryption !== 'safeStorage.v1' || typeof raw.data !== 'string') return null;
  const key = await masterKeyFor(appDataDir, deps);
  if (!key) return null;
  const plain = decryptSafeStorageV10(Buffer.from(raw.data, 'base64'), key);
  if (!plain) return null;
  const nowMs = (deps.now || Date.now)();
  const session = parseTokenStore(plain, nowMs);
  if (!session) return null;
  storeCache = { appDataDir, mtimeMs, session };
  return session;
}

function clearKimiDesktopSessionCaches() {
  masterKeyCache.clear();
  storeCache = { appDataDir: '', mtimeMs: 0, session: null };
  lastRefreshAttemptMs = 0;
  lastRefreshOutcome = null;
}

module.exports = {
  KIMI_AUTH_REFRESH_URL,
  KIMI_DESKTOP_DIR_NAME,
  decryptSafeStorageV10,
  kimiDesktopAppRunning,
  kimiDesktopAppDataDir,
  kimiDesktopTokenStoreExists,
  desktopSessionEnabled,
  looksLikeKimiRefreshToken,
  refreshKimiDesktopSession,
  readKimiDesktopSession,
  resolveKimiManualSession,
  tasklistShowsKimiDesktop,
  clearKimiDesktopSessionCaches
};
