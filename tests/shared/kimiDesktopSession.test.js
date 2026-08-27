'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const test = require('node:test');

const {
  KIMI_AUTH_REFRESH_URL,
  decryptSafeStorageV10,
  kimiDesktopTokenStoreExists,
  desktopSessionEnabled,
  looksLikeKimiRefreshToken,
  refreshKimiDesktopSession,
  readKimiDesktopSession,
  resolveKimiManualSession,
  tasklistShowsKimiDesktop,
  clearKimiDesktopSessionCaches
} = require('../../src/shared/kimiDesktopSession');

const NOW_MS = Date.parse('2026-08-24T00:00:00Z');
const MASTER_KEY = Buffer.from('a'.repeat(32) + 'b'.repeat(32), 'hex');

function encodeSafeStorageV10(plain, key = MASTER_KEY) {
  const nonce = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce);
  const ciphertext = Buffer.concat([cipher.update(Buffer.from(plain, 'utf8')), cipher.final()]);
  return Buffer.concat([Buffer.from('v10', 'latin1'), nonce, ciphertext, cipher.getAuthTag()]);
}

function jwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: 'none', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify(payload)).toString('base64url'),
    'sig'
  ].join('.');
}

function freshTokens() {
  return {
    access_token: jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS + 15 * 60 * 1000) / 1000) }),
    refresh_token: jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS + 90 * 24 * 60 * 60 * 1000) / 1000) }),
    msh_user_id: 'user-1'
  };
}

// Builds the kimi-desktop layout under a temp root: Local State holds a
// DPAPI-shaped encrypted_key, and the unprotect step is faked to return the
// fixture master key, so no real OS crypto runs in tests.
function buildFixture({ tokens = freshTokens(), encryptedKeyValue } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-test-'));
  const appDir = path.join(root, 'kimi-desktop');
  fs.mkdirSync(path.join(appDir, 'bridge-store'), { recursive: true });
  const encryptedKey = encryptedKeyValue
    ?? Buffer.concat([Buffer.from('DPAPI', 'latin1'), crypto.randomBytes(32)]).toString('base64');
  fs.writeFileSync(path.join(appDir, 'Local State'), JSON.stringify({ os_crypt: { encrypted_key: encryptedKey } }));
  fs.writeFileSync(
    path.join(appDir, 'bridge-store', 'token-store.json'),
    JSON.stringify({
      encryption: 'safeStorage.v1',
      data: encodeSafeStorageV10(JSON.stringify({ origin: 'https://www.kimi.com', tokens })).toString('base64')
    })
  );
  const unprotectCalls = [];
  const deps = {
    env: { APPDATA: root },
    platform: 'win32',
    now: () => NOW_MS,
    unprotectDpapi: async (blob) => {
      unprotectCalls.push(String(blob));
      return MASTER_KEY;
    }
  };
  return { root, appDir, deps, unprotectCalls, rewriteTokens: (nextTokens, stamp) => {
    fs.writeFileSync(
      path.join(appDir, 'bridge-store', 'token-store.json'),
      JSON.stringify({
        encryption: 'safeStorage.v1',
        data: encodeSafeStorageV10(JSON.stringify({ origin: 'https://www.kimi.com', tokens: nextTokens })).toString('base64')
      })
    );
    const at = stamp ?? new Date(Date.now() + 10_000);
    fs.utimesSync(path.join(appDir, 'bridge-store', 'token-store.json'), at, at);
  } };
}

test('desktopSessionEnabled honours the disable switch', () => {
  assert.equal(desktopSessionEnabled({}), true);
  assert.equal(desktopSessionEnabled({ TOKEN_MONITOR_KIMI_DESKTOP_SESSION: '1' }), true);
  for (const value of ['0', 'false', 'off', 'no']) {
    assert.equal(desktopSessionEnabled({ TOKEN_MONITOR_KIMI_DESKTOP_SESSION: value }), false);
  }
});

test('decryptSafeStorageV10 round-trips and rejects wrong keys or prefixes', () => {
  const blob = encodeSafeStorageV10('{"tokens":{}}');
  assert.equal(decryptSafeStorageV10(blob, MASTER_KEY), '{"tokens":{}}');
  assert.equal(decryptSafeStorageV10(blob, Buffer.alloc(32, 7)), null);
  assert.equal(decryptSafeStorageV10(Buffer.concat([Buffer.from('v11'), blob.slice(3)]), MASTER_KEY), null);
  assert.equal(decryptSafeStorageV10(Buffer.alloc(8), MASTER_KEY), null);
});

test('readKimiDesktopSession decrypts the store and reports freshness', async () => {
  clearKimiDesktopSessionCaches();
  const { deps } = buildFixture();
  const session = await readKimiDesktopSession(deps);
  assert.equal(session.userId, 'user-1');
  assert.equal(session.accessToken.split('.').length, 3);
  assert.equal(session.accessIsStale, false);
  assert.equal(session.refreshIsDead, false);
  assert.equal(session.accessExpiresAtMs, NOW_MS + 15 * 60 * 1000);
});

test('readKimiDesktopSession marks a stale access token but keeps the session', async () => {
  clearKimiDesktopSessionCaches();
  const tokens = freshTokens();
  tokens.access_token = jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS - 1000) / 1000) });
  const { deps } = buildFixture({ tokens });
  const session = await readKimiDesktopSession(deps);
  assert.equal(session.accessIsStale, true);
  assert.equal(session.refreshIsDead, false);
});

test('readKimiDesktopSession reports a dead refresh token', async () => {
  clearKimiDesktopSessionCaches();
  const tokens = freshTokens();
  tokens.refresh_token = jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS - 1000) / 1000) });
  const { deps } = buildFixture({ tokens });
  const session = await readKimiDesktopSession(deps);
  assert.equal(session.refreshIsDead, true);
});

test('readKimiDesktopSession caches by file mtime', async () => {
  clearKimiDesktopSessionCaches();
  const { deps, unprotectCalls, rewriteTokens } = buildFixture();
  await readKimiDesktopSession(deps);
  await readKimiDesktopSession(deps);
  assert.equal(unprotectCalls.length, 1, 'master key is decrypted once per encrypted_key');
  const next = freshTokens();
  next.msh_user_id = 'user-2';
  rewriteTokens(next);
  const session = await readKimiDesktopSession(deps);
  assert.equal(session.userId, 'user-2');
  assert.equal(unprotectCalls.length, 1, 'cached master key survives a token rotation');
});

test('readKimiDesktopSession returns null for unreadable or malformed stores', async () => {
  clearKimiDesktopSessionCaches();
  const noAppdata = await readKimiDesktopSession({ env: {}, platform: 'win32', now: () => NOW_MS });
  assert.equal(noAppdata, null, 'no APPDATA means no store');
  const wrongPlatform = await readKimiDesktopSession({ env: { APPDATA: 'X:\\nowhere' }, platform: 'linux', now: () => NOW_MS });
  assert.equal(wrongPlatform, null, 'non-Windows never reads the store');
  const disabled = await readKimiDesktopSession({
    env: { APPDATA: 'X:\\nowhere', TOKEN_MONITOR_KIMI_DESKTOP_SESSION: '0' },
    platform: 'win32',
    now: () => NOW_MS
  });
  assert.equal(disabled, null, 'the env switch disables the reader');

  clearKimiDesktopSessionCaches();
  const { root, deps } = buildFixture();
  assert.equal(await readKimiDesktopSession({ ...deps, unprotectDpapi: async () => null }), null, 'DPAPI failure fails closed');
  fs.rmSync(path.join(root, 'kimi-desktop', 'bridge-store', 'token-store.json'));
  assert.equal(await readKimiDesktopSession(deps), null, 'missing store fails closed');
});

test('kimiDesktopTokenStoreExists only checks presence without decrypting', async () => {
  clearKimiDesktopSessionCaches();
  const { root } = buildFixture();
  assert.equal(kimiDesktopTokenStoreExists({ APPDATA: root }, 'win32'), true);
  assert.equal(kimiDesktopTokenStoreExists({ APPDATA: root }, 'darwin'), false);
  assert.equal(kimiDesktopTokenStoreExists({}, 'win32'), false);
  const emptyRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-desktop-empty-'));
  assert.equal(kimiDesktopTokenStoreExists({ APPDATA: emptyRoot }, 'win32'), false);
});

test('tasklistShowsKimiDesktop matches the install path, not any Kimi.exe', () => {
  assert.equal(tasklistShowsKimiDesktop('"Kimi.exe","1234","Console","1","123 K","C:\\Users\\a\\AppData\\Local\\Programs\\kimi-desktop\\Kimi.exe"'), true);
  assert.equal(tasklistShowsKimiDesktop('"Kimi.exe","1234","Console","1","123 K","C:\\Tools\\Kimi.exe"'), false);
  assert.equal(tasklistShowsKimiDesktop('INFO: No tasks are running which match the specified criteria.'), false);
  assert.equal(tasklistShowsKimiDesktop(null), false);
});

function nextTokens(afterMs) {
  const exp = Math.floor((NOW_MS + afterMs) / 1000);
  return {
    access_token: jwt({ sub: 'sub-1', exp: Math.floor(exp) }),
    refresh_token: jwt({ sub: 'sub-1', exp: Math.floor(exp) }),
    msh_user_id: 'user-1'
  };
}

function refreshResponse(tokens) {
  return {
    ok: true,
    status: 200,
    json: async () => ({
      accessToken: tokens.access_token,
      refreshToken: tokens.refresh_token
    })
  };
}

test('refreshKimiDesktopSession rotates the pair and writes the store back in-place', async () => {
  clearKimiDesktopSessionCaches();
  const { root, deps } = buildFixture();
  const rotated = nextTokens(30 * 60 * 1000);
  const calls = [];
  const session = await refreshKimiDesktopSession({
    ...deps,
    checkAppRunning: async () => false,
    fetch: async (url, init) => {
      calls.push({ url: String(url), body: JSON.parse(init.body) });
      return refreshResponse(rotated, NOW_MS);
    }
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, KIMI_AUTH_REFRESH_URL);
  assert.equal(calls[0].body.refreshToken.split('.').length, 3, 'the rotated refresh token is sent as the credential');
  assert.equal(session.accessToken, rotated.access_token);
  assert.equal(session.accessIsStale, false);
  // the file must now decrypt to the rotated pair and keep sibling fields
  const reread = await readKimiDesktopSession({ ...deps });
  assert.equal(reread.accessToken, rotated.access_token);
  assert.equal(reread.refreshToken, rotated.refresh_token);
  assert.equal(reread.userId, 'user-1');
  const store = JSON.parse(fs.readFileSync(path.join(root, 'kimi-desktop', 'bridge-store', 'token-store.json'), 'utf8'));
  assert.equal(store.encryption, 'safeStorage.v1');
});

test('refreshKimiDesktopSession refuses to run while the desktop app is running', async () => {
  clearKimiDesktopSessionCaches();
  let fetched = 0;
  const session = await refreshKimiDesktopSession({
    ...buildFixture().deps,
    checkAppRunning: async () => true,
    fetch: async () => {
      fetched += 1;
      return refreshResponse(nextTokens(30 * 60 * 1000), NOW_MS);
    }
  });
  assert.equal(session, null);
  assert.equal(fetched, 0, 'a running app means no refresh attempt at all');
});

test('refreshKimiDesktopSession leaves the store untouched on a rejected refresh token', async () => {
  clearKimiDesktopSessionCaches();
  const { root, deps } = buildFixture();
  const before = fs.readFileSync(path.join(root, 'kimi-desktop', 'bridge-store', 'token-store.json'), 'utf8');
  await assert.rejects(
    refreshKimiDesktopSession({
      ...deps,
      checkAppRunning: async () => false,
      fetch: async () => ({ ok: false, status: 401 })
    }),
    (error) => error.status === 'unauthorized'
  );
  const after = fs.readFileSync(path.join(root, 'kimi-desktop', 'bridge-store', 'token-store.json'), 'utf8');
  assert.equal(after, before, 'a rejected refresh never clears or rewrites the app-owned store');
});

test('refreshKimiDesktopSession cooldown blocks an immediate retry after a failure', async () => {
  clearKimiDesktopSessionCaches();
  const { deps } = buildFixture();
  let attempts = 0;
  const base = {
    ...deps,
    checkAppRunning: async () => false,
    fetch: async () => {
      attempts += 1;
      return { ok: false, status: 500 };
    }
  };
  assert.equal(await refreshKimiDesktopSession(base), null);
  assert.equal(await refreshKimiDesktopSession(base), null);
  assert.equal(attempts, 1, 'the cooldown suppresses the retry within 60s');
});

test('looksLikeKimiRefreshToken separates day-scale tokens from minute-scale ones', () => {
  const longLived = jwt({ sub: 'sub-1', iat: Math.floor(NOW_MS / 1000), exp: Math.floor((NOW_MS + 90 * 24 * 60 * 60 * 1000) / 1000) });
  const shortLived = jwt({ sub: 'sub-1', iat: Math.floor(NOW_MS / 1000), exp: Math.floor((NOW_MS + 15 * 60 * 1000) / 1000) });
  assert.equal(looksLikeKimiRefreshToken(longLived), true);
  assert.equal(looksLikeKimiRefreshToken(shortLived), false);
  assert.equal(looksLikeKimiRefreshToken('not-a-jwt'), false);
});

test('resolveKimiManualSession seeds from the pasted token and persists rotations', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-manual-'));
  const seedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  const rotatedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  const calls = [];
  const deps = {
    dataDir,
    now: () => NOW_MS,
    fetch: async (url, init) => {
      calls.push(JSON.parse(init.body).refreshToken);
      return refreshResponse(rotatedPair);
    }
  };
  const session = await resolveKimiManualSession(seedPair.refresh_token, deps);
  assert.equal(calls.length, 1, 'the seed is exchanged exactly once');
  assert.equal(calls[0], seedPair.refresh_token);
  assert.equal(session.accessToken, rotatedPair.access_token);
  assert.equal(session.userId, 'sub-1');
  const cache = JSON.parse(fs.readFileSync(path.join(dataDir, 'kimi-manual-session.json'), 'utf8'));
  assert.equal(cache.accessToken, rotatedPair.access_token);
  // a second resolve with a fresh access token must not hit the network again
  const again = await resolveKimiManualSession(seedPair.refresh_token, deps);
  assert.equal(calls.length, 1, 'the cached pair is reused while fresh');
  assert.equal(again.accessToken, rotatedPair.access_token);
});

test('resolveKimiManualSession rotates again once the cached access token goes stale', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-manual-'));
  const seedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  // the server hands out a short-lived access token with a long-lived refresh
  const firstPair = {
    access_token: jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS + 15 * 60 * 1000) / 1000) }),
    refresh_token: jwt({ sub: 'sub-1', exp: Math.floor((NOW_MS + 90 * 24 * 60 * 60 * 1000) / 1000) })
  };
  const secondPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  const seen = [];
  const deps = (nowMs) => ({
    dataDir,
    now: () => nowMs,
    fetch: async (_url, init) => {
      seen.push(JSON.parse(init.body).refreshToken);
      return refreshResponse(seen.length === 1 ? firstPair : secondPair);
    }
  });
  await resolveKimiManualSession(seedPair.refresh_token, deps(NOW_MS));
  const later = NOW_MS + 30 * 60 * 1000;
  const renewed = await resolveKimiManualSession(seedPair.refresh_token, deps(later));
  assert.equal(seen.length, 2, 'a stale cached access token triggers a new exchange');
  assert.equal(seen[1], firstPair.refresh_token, 'the cached refresh token is the exchange credential');
  assert.equal(renewed.accessToken, secondPair.access_token);
});

test('resolveKimiManualSession surfaces unauthorized without touching the cache', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-manual-'));
  const seedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  await assert.rejects(
    resolveKimiManualSession(seedPair.refresh_token, {
      dataDir,
      now: () => NOW_MS,
      fetch: async () => ({ ok: false, status: 401 })
    }),
    (error) => error.status === 'unauthorized'
  );
  assert.equal(fs.existsSync(path.join(dataDir, 'kimi-manual-session.json')), false);
});

test('resolveKimiManualSession falls back to the cached access token on transient failures', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kimi-manual-'));
  const seedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  const cachedPair = nextTokens(90 * 24 * 60 * 60 * 1000);
  await resolveKimiManualSession(seedPair.refresh_token, {
    dataDir,
    now: () => NOW_MS,
    fetch: async () => refreshResponse(cachedPair)
  });
  const later = NOW_MS + 30 * 60 * 1000;
  const session = await resolveKimiManualSession(seedPair.refresh_token, {
    dataDir,
    now: () => later,
    fetch: async () => { throw new Error('network down'); }
  });
  assert.ok(session, 'the stale-but-signed cached access token is still returned');
  assert.equal(session.accessToken, cachedPair.access_token);
});

test('a cache hit recomputes staleness against the current time', async () => {
  clearKimiDesktopSessionCaches();
  const { deps } = buildFixture();
  const freshNow = NOW_MS;
  const fresh = await readKimiDesktopSession({ ...deps, now: () => freshNow });
  assert.equal(fresh.accessIsStale, false);
  // same file (same mtime), but read 30 minutes later: the cached entry must
  // not keep serving the stale=false snapshot taken at the earlier read
  const later = await readKimiDesktopSession({ ...deps, now: () => freshNow + 30 * 60 * 1000 });
  assert.equal(later.accessIsStale, true, 'staleness must be evaluated per read, not per file version');
});
