'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  clineApiKey,
  clineProvidersPath,
  fetchClineLimits,
  parseClineLimits,
  readClineSession,
  resolveClineCredential,
  tokenExpiryMs
} = require('../../src/shared/providers/cline/limits');
const { parseLimitProviders, providerFetchers } = require('../../src/shared/limits/collector');

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0);

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-limits-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeProviders(dataDir, providers) {
  const settings = path.join(dataDir, 'settings');
  fs.mkdirSync(settings, { recursive: true });
  fs.writeFileSync(path.join(settings, 'providers.json'), JSON.stringify({ version: 1, providers }));
}

function clineAuth(overrides = {}) {
  return {
    settings: {
      auth: {
        accessToken: 'workos:token-1',
        expiresAt: NOW + 3_600_000,
        accountId: 'usr-1',
        metadata: { userInfo: { email: 'User@Example.com' } },
        ...overrides
      }
    }
  };
}

function okBody(limits) {
  return { success: true, data: { limits } };
}

function okFetch(payload, sink = []) {
  return async (url, init) => {
    sink.push({ url, init });
    return { ok: true, status: 200, json: async () => payload };
  };
}

test('collector wires Cline and includes it in the default provider set', () => {
  assert.equal(typeof providerFetchers().cline, 'function');
  assert.ok(parseLimitProviders().includes('cline'));
});

test('clineProvidersPath follows the CLINE_* precedence the session roots use', () => {
  assert.equal(
    clineProvidersPath({ CLINE_SESSION_DATA_DIR: '/relocated/data/sessions', CLINE_DIR: '/ignored' }),
    path.join('/relocated/data', 'settings', 'providers.json')
  );
  assert.equal(
    clineProvidersPath({ CLINE_DATA_DIR: '/data', CLINE_DIR: '/ignored' }),
    path.join('/data', 'settings', 'providers.json')
  );
  assert.equal(clineProvidersPath({ CLINE_DIR: '/dir' }), path.join('/dir', 'data', 'settings', 'providers.json'));
  // No variable set: the default install. A relocation never falls through to it.
  assert.equal(clineProvidersPath({}), path.join(os.homedir(), '.cline', 'data', 'settings', 'providers.json'));
});

test('tokenExpiryMs reads milliseconds, seconds, numeric and ISO strings', () => {
  assert.equal(tokenExpiryMs({ expiresAt: NOW }), NOW);
  assert.equal(tokenExpiryMs({ expiresAt: Math.floor(NOW / 1000) }), Math.floor(NOW / 1000) * 1000);
  assert.equal(tokenExpiryMs({ expiresAt: String(Math.floor(NOW / 1000)) }), Math.floor(NOW / 1000) * 1000);
  assert.equal(tokenExpiryMs({ expiresAt: '2026-09-21T13:00:00.000Z' }), Date.UTC(2026, 8, 21, 13));
  assert.equal(tokenExpiryMs({}), null);
  assert.equal(tokenExpiryMs({ expiresAt: 'not-a-date' }), null);
});

test('readClineSession prefers cline-pass, falls back to cline, skips tokenless sections', (t) => {
  const dataDir = tempDir(t);
  const env = { CLINE_DATA_DIR: dataDir };
  writeProviders(dataDir, {
    cline: clineAuth({ accessToken: 'workos:base' }),
    'cline-pass': clineAuth({ accessToken: 'workos:pass' })
  });
  assert.equal(readClineSession(env).accessToken, 'workos:pass');

  writeProviders(dataDir, { cline: clineAuth({ accessToken: 'workos:base' }), 'cline-pass': { settings: { auth: {} } } });
  assert.equal(readClineSession(env).accessToken, 'workos:base');
  // The reader reports what the file holds; the wire record normalizes the case.
  assert.equal(readClineSession(env).email, 'User@Example.com');
});

test('readClineSession reports nothing for a missing or unreadable file', (t) => {
  const dataDir = tempDir(t);
  assert.equal(readClineSession({ CLINE_DATA_DIR: dataDir }), null);
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings', 'providers.json'), '{ not json');
  assert.equal(readClineSession({ CLINE_DATA_DIR: dataDir }), null);
  // A readable file whose sections carry no token is equally "not signed in",
  // rather than a failed request.
  writeProviders(dataDir, { cline: { settings: { auth: {} } }, 'cline-pass': { settings: {} } });
  assert.equal(readClineSession({ CLINE_DATA_DIR: dataDir }), null);
});

test('clineApiKey takes the explicit option, then CLINE_API_KEY, then CLINEPASS_API_KEY', () => {
  assert.equal(clineApiKey({ CLINE_API_KEY: 'from-cline', CLINEPASS_API_KEY: 'from-pass' }, {}), 'from-cline');
  assert.equal(clineApiKey({ CLINEPASS_API_KEY: '  "from-pass"  ' }, {}), 'from-pass');
  assert.equal(clineApiKey({}, { clineApiKey: 'explicit' }), 'explicit');
  assert.equal(clineApiKey({}, {}), '');
});

test('a configured key wins over a stale stored sign-in', (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth({ expiresAt: NOW - 1000 }) });
  const env = { CLINE_DATA_DIR: dataDir, CLINE_API_KEY: 'cline-key' };
  const credential = resolveClineCredential({}, env);
  assert.equal(credential.accessToken, 'cline-key');
  // An API key has no expiry to check, so the stale stored token cannot veto it.
  assert.equal(credential.expiresAt, null);
});

test('fetchClineLimits reports notConfigured without a stored sign-in', async (t) => {
  const result = await fetchClineLimits({}, { env: { CLINE_DATA_DIR: tempDir(t) }, now: () => NOW });
  assert.equal(result.provider, 'cline');
  assert.equal(result.status, 'notConfigured');
  assert.deepEqual(result.windows, []);
});

test('a stale stored token is refused locally instead of costing a request', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth({ expiresAt: NOW - 1000 }) });
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: okFetch(okBody([]), calls)
  });
  assert.equal(result.status, 'unauthorized');
  // A discovered sign-in is the `oauth` lane, and a failure still names it.
  assert.equal(result.source, 'oauth');
  // A failure names the source it failed on and nothing else — the account is
  // not read out of a credential file to decorate an error.
  assert.equal(result.accountKey, '');
  assert.equal(result.accountEmail, '');
  assert.deepEqual(calls, []);
});

test('fetchClineLimits maps the three ClinePass windows onto the shared kinds', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth() });
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: okFetch(okBody([
      { type: 'five_hour', percentUsed: 12.5, resetsAt: '2026-09-21T15:00:00Z' },
      { type: 'weekly', percentUsed: 101, resetsAt: 1790000000000 },
      { type: 'monthly', percentUsed: 0 }
    ]), calls)
  });

  assert.equal(result.status, 'ok');
  // The reading came from a discovered sign-in, so it is the `oauth` lane.
  assert.equal(result.source, 'oauth');
  assert.deepEqual(result.windows.map((w) => w.kind), ['session', 'weekly', 'billing']);
  assert.deepEqual(result.windows.map((w) => w.windowMinutes), [300, 10_080, null]);
  // A billing window is labelled rather than timed, as Kimi's and Command Code's
  // monthly windows are; only the two fixed-duration windows carry minutes.
  // The shared normalizer reports an absent label as ''.
  assert.deepEqual(result.windows.map((w) => w.label), ['', '', 'Monthly']);
  assert.equal(result.windows[0].usedPercent, 12.5);
  assert.equal(result.windows[0].resetsAt, '2026-09-21T15:00:00.000Z');
  // A provider that reports past 100 must not paint a negative remainder.
  assert.equal(result.windows[1].usedPercent, 100);
  assert.equal(result.windows[1].resetsAt, new Date(1790000000000).toISOString());
  assert.equal(result.windows[2].resetsAt, null);
  assert.equal(result.accountEmail, 'user@example.com');

  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.cline.bot/api/v1/users/me/plan/usage-limits');
  // The stored form goes out verbatim: the API rejects the bare JWT (verified
  // live: bare -> 401, `workos:<jwt>` -> authenticated).
  assert.equal(calls[0].init.headers.Authorization, 'Bearer workos:token-1');
});

test('a reset that is present but invalid voids the reading in either spelling', () => {
  // The guard has to look at the value that was read, not at one of its spellings.
  const withReset = (value) => parseClineLimits({
    success: true,
    data: { limits: [{ type: 'weekly', percentUsed: 1, ...value }] }
  });
  assert.equal(withReset({ resetsAt: 'soon' }), null);
  assert.equal(withReset({ resets_at: 'soon' }), null);
  // Absent stays absent, in every spelling, and does not void the window.
  for (const value of [{}, { resetsAt: null }, { resets_at: null }, { resetsAt: '' }, { resets_at: '  ' }]) {
    const windows = withReset(value);
    assert.equal(windows.length, 1);
    assert.equal(windows[0].resetsAt, null);
  }
});

test('an unknown window type is skipped and a broken known one voids the reading', () => {
  assert.deepEqual(
    parseClineLimits({ success: true, data: { limits: [{ type: 'yearly', percentUsed: 5 }] } }),
    []
  );
  // A field that is present but wrong is a broken contract, not a row to skip
  // past: reporting the rest would show a quota that silently lost a window.
  assert.equal(parseClineLimits({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 'lots' }] } }), null);
  assert.equal(parseClineLimits({ success: true, data: { limits: [{ type: 'weekly', percentUsed: 1, resetsAt: 'soon' }] } }), null);
  assert.equal(parseClineLimits({ success: false, data: { limits: [] } }), null);
  assert.equal(parseClineLimits({ data: {} }), null);
});

test('a window with no percentage is kept without inventing a reading', () => {
  // Cline's own dashboard shows 0 here, but a fabricated 0 would render as a
  // real quota; the window is reported with no percentage instead.
  const windows = parseClineLimits({
    success: true,
    data: { limits: [{ type: 'five_hour' }, { type: 'weekly', percentUsed: null }, { type: 'monthly', percentUsed: '  ' }] }
  });
  assert.deepEqual(windows.map((w) => w.kind), ['session', 'weekly', 'billing']);
  assert.deepEqual(windows.map((w) => w.usedPercent), [null, null, null]);
});

test('a repeated window replaces the earlier one and the order is fixed', () => {
  const windows = parseClineLimits({
    success: true,
    data: {
      limits: [
        { type: 'monthly', percentUsed: 9 },
        { type: 'weekly', percentUsed: 1 },
        { type: 'weekly', percentUsed: 2 },
        { type: 'five_hour', percentUsed: 3 }
      ]
    }
  });
  assert.deepEqual(windows.map((w) => w.kind), ['session', 'weekly', 'billing']);
  assert.deepEqual(windows.map((w) => w.usedPercent), [3, 2, 9]);
});


function routedFetch({ refreshToken, refreshed, sink = [] }) {
  return async (url, init = {}) => {
    sink.push({ url, method: init.method || 'GET', init });
    if (String(url).endsWith('/api/v1/auth/refresh')) {
      if (refreshed.status && refreshed.status !== 200) {
        return { ok: false, status: refreshed.status, json: async () => ({}) };
      }
      return {
        ok: true,
        status: 200,
        json: async () => ({
          success: true,
          data: {
            accessToken: refreshed.accessToken,
            expiresAt: refreshed.expiresAt,
            refreshToken,
            userInfo: {}
          }
        })
      };
    }
    return { ok: true, status: 200, json: async () => okBody([{ type: 'weekly', percentUsed: 7 }]) };
  };
}

test('an expired stored sign-in is refreshed in memory and never written back', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, {
    'cline-pass': clineAuth({ refreshToken: 'refresh-expired-1', expiresAt: NOW - 1000 })
  });
  const providersFile = path.join(dataDir, 'settings', 'providers.json');
  const before = fs.readFileSync(providersFile, 'utf8');
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({
      refreshToken: 'refresh-expired-1',
      // The endpoint hands back the bare JWT; the wire form adds the prefix.
      refreshed: { accessToken: 'fresh', expiresAt: NOW + 3_600_000 },
      sink: calls
    })
  });

  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].usedPercent, 7);
  assert.equal(calls.length, 2);
  assert.equal(calls[0].method, 'POST');
  assert.equal(calls[0].url, 'https://api.cline.bot/api/v1/auth/refresh');
  // Cline's own refresh body spells the grant this way, not as OAuth grant_type.
  assert.deepEqual(JSON.parse(calls[0].init.body), { refreshToken: 'refresh-expired-1', grantType: 'refresh_token' });
  assert.equal(calls[1].init.headers.Authorization, 'Bearer workos:fresh');
  assert.match(calls[0].init.headers['user-agent'], /^token-monitor\//);
  // The credential file belongs to Cline: a refresh must not rewrite it.
  assert.equal(fs.readFileSync(providersFile, 'utf8'), before);
});

test('a refused refresh is a credential problem and costs no usage request', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, {
    'cline-pass': clineAuth({ refreshToken: 'refresh-refused-1', expiresAt: NOW - 1000 })
  });
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({
      refreshToken: 'refresh-refused-1',
      refreshed: { status: 401 },
      sink: calls
    })
  });
  assert.equal(result.status, 'unauthorized');
  assert.equal(calls.length, 1);
});

test('a refresh with no readable expiry is used once and not cached', async (t) => {
  const dataDir = tempDir(t);
  const calls = [];
  const deps = () => {
    writeProviders(dataDir, {
      'cline-pass': clineAuth({ refreshToken: 'refresh-no-expiry', expiresAt: NOW - 1000 })
    });
    return {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: async (url, init = {}) => {
        calls.push({ url, method: init.method || 'GET' });
        if (String(url).endsWith('/api/v1/auth/refresh')) {
          // No expiresAt in the envelope.
          return { ok: true, status: 200, json: async () => ({ success: true, data: { accessToken: 'workos:noexp' } }) };
        }
        return { ok: true, status: 200, json: async () => okBody([{ type: 'weekly', percentUsed: 2 }]) };
      }
    };
  };
  assert.equal((await fetchClineLimits({}, deps())).status, 'ok');
  assert.equal((await fetchClineLimits({}, deps())).status, 'ok');
  // Unknown expiry is treated as "refresh again", which is what Cline's own
  // rotation guard does with an unknown one, so the second scan refreshes too.
  assert.equal(calls.filter((call) => call.method === 'POST').length, 2);
});

test('every refresh failure mode maps to a status, not to a silent reading', async (t) => {
  const dataDir = tempDir(t);
  const stale = (suffix) => {
    writeProviders(dataDir, {
      'cline-pass': clineAuth({ refreshToken: `refresh-fail-${suffix}`, expiresAt: NOW - 1000 })
    });
  };
  const failingRefresh = (response, suffix) => {
    stale(suffix);
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: async () => response
    });
  };

  assert.equal((await failingRefresh({ ok: false, status: 429, json: async () => ({}) }, 'a')).status, 'sourceRateLimited');
  // A 400 is ambiguous and the body decides: an invalid grant is the sign-in
  // being gone, a validation failure is not (both observed live).
  const invalidGrant = (suffix) => {
    stale(suffix);
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: async () => ({ ok: false, status: 400, text: async () => '{"error":"failed to refresh token: invalid_grant"}' })
    });
  };
  const validationFailure = (suffix) => {
    stale(suffix);
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: async () => ({ ok: false, status: 400, text: async () => '{"error":"Validation failed"}' })
    });
  };
  assert.equal((await invalidGrant('e')).status, 'unauthorized');
  assert.equal((await validationFailure('f')).status, 'unavailable');
  // A 400 whose error is not the invalid-grant family must not be reported as an
  // expired sign-in — this is why the decision reads the `error` field narrowly.
  stale('g');
  const unauthorizedClient = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => ({ ok: false, status: 400, text: async () => '{"error":"unauthorized_client"}' })
  });
  assert.equal(unauthorizedClient.status, 'unavailable');
  assert.equal((await failingRefresh({ ok: false, status: 500, json: async () => ({}) }, 'b')).status, 'unavailable');
  // A 200 whose envelope carries no token is not a usable refresh.
  assert.equal((await failingRefresh({ ok: true, status: 200, json: async () => ({ success: true, data: {} }) }, 'c')).status, 'unavailable');
  // A refresh that never answers (timeout / collector abort) is an outage, not a
  // credential problem: the user must not be told to sign in again for it.
  stale('d');
  const aborted = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => { throw Object.assign(new Error('aborted'), { name: 'AbortError' }); }
  });
  assert.equal(aborted.status, 'unavailable');
});

test('one refresh serves the scans until it expires, and a new sign-in refreshes again', async (t) => {
  const dataDir = tempDir(t);
  const run = (refreshToken) => {
    writeProviders(dataDir, { 'cline-pass': clineAuth({ refreshToken, expiresAt: NOW - 1000 }) });
    const calls = [];
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: routedFetch({ refreshToken, refreshed: { accessToken: `workos:${refreshToken}`, expiresAt: NOW + 3_600_000 }, sink: calls })
    }).then((result) => ({ result, calls }));
  };

  const first = await run('refresh-reuse-1');
  const second = await run('refresh-reuse-1');
  assert.equal(first.result.status, 'ok');
  assert.equal(second.result.status, 'ok');
  assert.equal(first.calls.filter((c) => c.method === 'POST').length, 1);
  // The second scan reused the first scan's token instead of refreshing again.
  assert.equal(second.calls.filter((c) => c.method === 'POST').length, 0);
  assert.equal(second.calls[0].init.headers.Authorization, 'Bearer workos:refresh-reuse-1');

  // A different refresh token means a different sign-in: no reuse.
  const third = await run('refresh-reuse-2');
  assert.equal(third.calls.filter((c) => c.method === 'POST').length, 1);
});

test('an account without a plan reads as no data, not as a failure to authenticate', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth() });
  // Verified live: a signed-in account with no ClinePass subscription answers
  // 404 `{"error":"no plan history found for user","success":false}`.
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => ({ ok: false, status: 404, json: async () => ({ success: false, data: null, error: 'no plan history found for user' }) })
  });
  assert.equal(result.status, 'unavailable');
});

test('an empty plan reports no data rather than a live zero', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth() });
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: okFetch(okBody([]))
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});

test('accountKey identifies the account, not the token that was stored', async (t) => {
  const dataDir = tempDir(t);
  const run = async (token) => {
    writeProviders(dataDir, { 'cline-pass': clineAuth({ accessToken: token }) });
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: okFetch(okBody([{ type: 'weekly', percentUsed: 1 }]))
    });
  };
  const first = await run('workos:token-1');
  const second = await run('workos:token-2');
  assert.match(first.accountKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.accountKey, second.accountKey);
});

test('identity survives a token refresh and is never invented from one', async (t) => {
  const dataDir = tempDir(t);
  const run = async (auth) => {
    writeProviders(dataDir, { 'cline-pass': clineAuth(auth) });
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: okFetch(okBody([{ type: 'weekly', percentUsed: 1 }]))
    });
  };

  // No account id, but the refresh token survives refreshes, so it identifies
  // the sign-in while the access token churns.
  const first = await run({ accountId: '', refreshToken: 'refresh-identity-1', accessToken: 'workos:a1' });
  const second = await run({ accountId: '', refreshToken: 'refresh-identity-1', accessToken: 'workos:a2' });
  assert.match(first.accountKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.accountKey, second.accountKey);

  // Nothing stable left: report no identity rather than keying off a value that
  // is replaced hourly, which the hub would read as a new account each scan.
  const anonymous = await run({ accountId: '', refreshToken: '', accessToken: 'workos:a3' });
  assert.equal(anonymous.status, 'ok');
  assert.equal(anonymous.accountKey, '');
});

test('an API key identifies the account without any local sign-in', async (t) => {
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: tempDir(t), CLINEPASS_API_KEY: 'cline-key' },
    now: () => NOW,
    fetch: okFetch(okBody([{ type: 'five_hour', percentUsed: 3 }]), calls)
  });
  // An API key is not a WorkOS token and is sent exactly as configured.
  assert.equal(calls[0].init.headers.Authorization, 'Bearer cline-key');
  assert.equal(result.source, 'api');
  assert.equal(result.status, 'ok');
  assert.equal(result.windows[0].kind, 'session');
  assert.match(result.accountKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(result.accountEmail, '');
});

test('transport failures map onto the shared provider statuses', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth() });
  const failing = (status) => ({
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => ({ ok: false, status, json: async () => ({}) })
  });
  assert.equal((await fetchClineLimits({}, failing(401))).status, 'unauthorized');
  assert.equal((await fetchClineLimits({}, failing(429))).status, 'sourceRateLimited');
  assert.equal((await fetchClineLimits({}, failing(500))).status, 'unavailable');
});

test('a 200 that is not the API payload is unavailable, never a reading', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { 'cline-pass': clineAuth() });
  const body = (payload) => ({
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => ({ ok: true, status: 200, json: async () => payload })
  });
  // A proxy or login page answering 200 with HTML.
  const html = await fetchClineLimits({}, {
    ...body(null),
    fetch: async () => ({
      ok: true,
      status: 200,
      json: async () => { throw new SyntaxError('Unexpected token <'); }
    })
  });
  assert.equal(html.status, 'unavailable');
  assert.deepEqual(html.windows, []);
  // Numeric strings are accepted; a broken envelope is not.
  const strings = await fetchClineLimits({}, body({ success: true, data: { limits: [{ type: 'weekly', percentUsed: '4.5' }] } }));
  assert.equal(strings.windows[0].usedPercent, 4.5);
  const envelope = await fetchClineLimits({}, body({ success: false, error: 'nope' }));
  assert.equal(envelope.status, 'unavailable');
});
