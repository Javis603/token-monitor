'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  CLINE_API_BASE,
  USAGE_LIMITS_PATH,
  USERS_ME_PATH,
  balancePath,
  usagesDailyPath,
  clineApiKey,
  clineProvidersPath,
  fetchClineLimits,
  parseClineLimits,
  readClineSession,
  resolveClineCredential
} = require('../../src/shared/providers/cline/limits');
const { parseLimitProviders, providerFetchers } = require('../../src/shared/limits/collector');
const { TRANSIENT_STATUSES } = require('../../src/shared/limits/runtime');

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

// The plan read and the credit read are different endpoints, so they are routed
// apart: a fixture that answers one payload for every URL cannot tell which call
// carried the account id.
function routedFetch({
  limits = [{ type: 'weekly', percentUsed: 7 }],
  usageStatus = 200,
  balance,
  balanceStatus = 200,
  usages,
  usagesStatus = 200,
  usagesQuery = null,
  me,
  sink = []
} = {}) {
  const reply = (status, body) => ({
    ok: status >= 200 && status < 300,
    status,
    headers: { get: () => null },
    json: async () => body,
    text: async () => JSON.stringify(body)
  });
  return async (url, init = {}) => {
    const path = String(url).replace(CLINE_API_BASE, '');
    sink.push({ path, auth: (init.headers || {}).Authorization || '' });
    if (path.includes('/usages/daily')) {
      if (usagesQuery) usagesQuery.push(path.slice(path.indexOf('?')));
      return reply(usagesStatus, usages);
    }
    if (path.endsWith('/balance')) return reply(balanceStatus, balance);
    if (path === USERS_ME_PATH) return reply(200, me);
    return reply(
      usageStatus,
      usageStatus === 200 ? okBody(limits) : { success: false, data: null, error: 'no plan history found for user' }
    );
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

test('readClineSession reads cline first and falls back to cline-pass', (t) => {
  const dataDir = tempDir(t);
  const env = { CLINE_DATA_DIR: dataDir };
  // Cline stores the ClinePass selection's credentials under `cline` as well, so
  // `cline` is authoritative and an older `cline-pass` entry must not mask it.
  writeProviders(dataDir, {
    cline: clineAuth({ accessToken: 'workos:current' }),
    'cline-pass': clineAuth({ accessToken: 'workos:stale' })
  });
  assert.equal(readClineSession(env).accessToken, 'workos:current');

  // A file an older version wrote still reads through the legacy section.
  writeProviders(dataDir, { 'cline-pass': clineAuth({ accessToken: 'workos:legacy' }) });
  assert.equal(readClineSession(env).accessToken, 'workos:legacy');
  // The reader reports what the file holds; the wire record normalizes the case.
  assert.equal(readClineSession(env).email, 'User@Example.com');
});

test('a request uses the cline entry when both sections exist', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, {
    cline: clineAuth({ accessToken: 'workos:current' }),
    'cline-pass': clineAuth({ accessToken: 'workos:stale' })
  });
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: okFetch(okBody([{ type: 'weekly', percentUsed: 5 }]), calls)
  });
  assert.equal(result.status, 'ok');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer workos:current');
});

test('a store missing, unreadable or signed out is refused with the right status', (t) => {
  const dataDir = tempDir(t);
  // No file at all: nothing is configured on this machine.
  assert.throws(() => readClineSession({ CLINE_DATA_DIR: dataDir }), (error) => error.status === 'notConfigured');
  // A file that cannot be parsed is the same answer.
  fs.mkdirSync(path.join(dataDir, 'settings'), { recursive: true });
  fs.writeFileSync(path.join(dataDir, 'settings', 'providers.json'), '{ not json');
  assert.throws(() => readClineSession({ CLINE_DATA_DIR: dataDir }), (error) => error.status === 'notConfigured');
  // A readable file whose sections carry no token is Cline being signed out, not
  // an unconfigured provider — the distinction `readCodexOAuthAuth` draws too.
  writeProviders(dataDir, { cline: { settings: { auth: {} } }, 'cline-pass': { settings: {} } });
  assert.throws(() => readClineSession({ CLINE_DATA_DIR: dataDir }), (error) => error.status === 'unauthorized');
  // A file that parses to something other than an object holds no token either,
  // and is refused rather than throwing a TypeError out of the provider.
  fs.writeFileSync(path.join(dataDir, 'settings', 'providers.json'), 'null');
  assert.throws(() => readClineSession({ CLINE_DATA_DIR: dataDir }), (error) => error.status === 'unauthorized');
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
  assert.equal(credential.source, 'api');
  assert.equal(credential.accountSeed, 'cline-key');
});

test('a missing store is notConfigured and a signed-out one is unauthorized', async (t) => {
  const missing = await fetchClineLimits({}, { env: { CLINE_DATA_DIR: tempDir(t) }, now: () => NOW });
  assert.equal(missing.provider, 'cline');
  assert.equal(missing.status, 'notConfigured');
  assert.equal(missing.source, 'oauth');
  assert.deepEqual(missing.windows, []);

  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: { settings: { auth: {} } } });
  const signedOut = await fetchClineLimits({}, { env: { CLINE_DATA_DIR: dataDir }, now: () => NOW });
  assert.equal(signedOut.status, 'unauthorized');
  assert.equal(signedOut.source, 'oauth');
  assert.deepEqual(signedOut.windows, []);
});

test('an expired stored sign-in is sent as-is: no refresh request, file untouched', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth({ expiresAt: NOW - 1000, refreshToken: 'refresh-should-stay' }) });
  const providersFile = path.join(dataDir, 'settings', 'providers.json');
  const before = fs.readFileSync(providersFile, 'utf8');
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async (url, init) => {
      calls.push({ url, init });
      return { ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) };
    }
  });
  assert.equal(result.status, 'unauthorized');
  assert.equal(result.source, 'oauth');
  // The credential lifecycle is Cline's: its token response may carry a
  // replacement refresh token and its auth service writes the rotated credentials
  // back itself, so refreshing from here could only strand Cline with a token the
  // server has retired. Exactly one request goes out, and it is the usage call.
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${CLINE_API_BASE}${USAGE_LIMITS_PATH}`);
  assert.equal(calls[0].init.headers.Authorization, 'Bearer workos:token-1');
  assert.equal(fs.readFileSync(providersFile, 'utf8'), before);
});

test('a stored token goes out in the form the API accepts', async (t) => {
  const dataDir = tempDir(t);
  const calls = [];
  const run = async (accessToken) => {
    writeProviders(dataDir, { cline: clineAuth({ accessToken }) });
    calls.length = 0;
    await fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: okFetch(okBody([{ type: 'five_hour', percentUsed: 1 }]), calls)
    });
  };
  // Live A/B against the API: `Bearer <bare jwt>` answers 401 while the prefixed
  // form authenticates, so a store holding the bare token must not send it bare —
  // and one that already carries the prefix must not be prefixed twice.
  await run('jwt-bare');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer workos:jwt-bare');
  await run('workos:jwt-stored');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer workos:jwt-stored');
  // The form is recognised regardless of case; it is passed through as stored.
  await run('WorkOS:jwt-mixed');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer WorkOS:jwt-mixed');
});

test('a failure names the source it failed on and nothing else', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const refused = {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async () => ({ ok: false, status: 401, headers: { get: () => null }, json: async () => ({}) })
  };
  const result = await fetchClineLimits({}, refused);
  assert.equal(result.status, 'unauthorized');
  // The rejected credential is the one thing a failure keeps saying, and the status
  // pill is picked from it: a refused sign-in and a refused key are recovered in
  // different places, so both lanes have to name themselves here.
  assert.equal(result.source, 'oauth');
  assert.equal(result.accountKey, '');
  assert.equal(result.accountEmail, '');
  assert.equal((await fetchClineLimits({ clineApiKey: 'sk-refused' }, refused)).source, 'api');
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

  // The plan windows first, then the account's credit, keyed by the user id the
  // stored sign-in carries (`usr-1` in this fixture), then that id's month-to-date
  // usage report.
  assert.equal(calls.length, 3);
  assert.equal(calls[0].url, `${CLINE_API_BASE}${USAGE_LIMITS_PATH}`);
  assert.equal(calls[1].url, `${CLINE_API_BASE}${balancePath('usr-1')}`);
  // The third read is the month-to-date usage report, which is what carries the
  // spend line when the account has one.
  assert.ok(calls[2].url.startsWith(`${CLINE_API_BASE}${usagesDailyPath('usr-1')}?`));
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
  // The type field sits on the same line: a wrong JSON type is that broken
  // contract — CodexBar and CodeBurn both fail the reading there — while an
  // absent or blank one is only a window this repository cannot name, and is
  // skipped with the reading intact.
  assert.equal(
    parseClineLimits({ success: true, data: { limits: [{ type: 7, percentUsed: 1 }, { type: 'weekly', percentUsed: 1 }] } }),
    null
  );
  assert.equal(parseClineLimits({ success: true, data: { limits: [{ type: {}, percentUsed: 1 }] } }), null);
  assert.deepEqual(
    parseClineLimits({ success: true, data: { limits: [{ type: '  ', percentUsed: 1 }, { type: 'weekly', percentUsed: 2 }] } })
      ?.map((window) => window.kind),
    ['weekly']
  );
  assert.equal(parseClineLimits({ success: false, data: { limits: [] } }), null);
  assert.equal(parseClineLimits({ data: {} }), null);
});

test('a window with no percentage is left out, and the rest of the reading survives', () => {
  // Cline's own dashboard shows 0% for a window the account has not touched; a
  // fabricated 0 would render here as a real quota, so that window is left out of
  // the report instead. It is dropped rather than voiding the reading: the windows
  // that do carry a percentage are still true.
  assert.deepEqual(
    parseClineLimits({
      success: true,
      data: { limits: [{ type: 'five_hour' }, { type: 'weekly', percentUsed: null }, { type: 'monthly', percentUsed: '  ' }] }
    }),
    []
  );
  const windows = parseClineLimits({
    success: true,
    data: { limits: [{ type: 'five_hour', percentUsed: 12 }, { type: 'weekly', percentUsed: null }] }
  });
  assert.deepEqual(windows.map((w) => w.kind), ['session']);
  assert.deepEqual(windows.map((w) => w.usedPercent), [12]);
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

test('identity is the account id, and nothing is invented without one', async (t) => {
  const dataDir = tempDir(t);
  const run = async (auth) => {
    writeProviders(dataDir, { cline: clineAuth(auth) });
    return fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: okFetch(okBody([{ type: 'weekly', percentUsed: 1 }]))
    });
  };

  // Cline replaces the access token hourly, so it is never the identity: two
  // scans that differ only by the token hash to the same account.
  const first = await run({ accountId: 'usr-identity', accessToken: 'workos:a1' });
  const second = await run({ accountId: 'usr-identity', accessToken: 'workos:a2' });
  assert.match(first.accountKey, /^sha256:[0-9a-f]{64}$/);
  assert.equal(first.accountKey, second.accountKey);

  // Nothing stable left: report no identity rather than keying off a value the
  // hub would read as a new account on every scan.
  const anonymous = await run({ accountId: '', accessToken: 'workos:a3' });
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
  // A 403 keeps the shared default rather than becoming a credential problem: this
  // API has only ever answered 401 for a rejected credential, so a forbidden status
  // reads as an outage and the last reading survives, the way it does for every
  // provider that does not ask for the 401/403 collapse (providers/claude,
  // providers/codex) — and a challenge on the way in is `unavailable` either way.
  assert.equal((await fetchClineLimits({}, failing(403))).status, 'unavailable');
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

test('the account credit is read beside the plan and reported as a credits window', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({ sink: calls, balance: { success: true, data: { userId: 'usr-1', balance: 500000 } } })
  });
  assert.equal(result.status, 'ok');
  // The plan window survives beside the credit: an account can hold both.
  assert.deepEqual(result.windows.map((w) => w.kind), ['weekly', 'billing']);
  const credits = result.windows.find((w) => w.metric === 'credits');
  assert.equal(credits.label, 'Credits');
  assert.equal(credits.currency, 'CREDITS');
  // 500000 is the "Credits: 0.5000" Cline's own account page prints, and its
  // dashboard divides by 1e6 before printing it.
  assert.equal(credits.remaining, 0.5);
  assert.equal(credits.showMeter, false);
  assert.deepEqual(calls.map((c) => c.path).slice(0, 2), [USAGE_LIMITS_PATH, balancePath('usr-1')]);
  assert.match(calls[2].path, /^\/api\/v1\/users\/usr-1\/usages\/daily\?startdate=/);
});

test('a key with no local sign-in learns the account id from the profile endpoint', async (t) => {
  const calls = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: tempDir(t), CLINE_API_KEY: 'sk-only' },
    now: () => NOW,
    fetch: routedFetch({
      sink: calls,
      me: { success: true, data: { id: 'usr-key', email: 'Key@Example.com' } },
      balance: { success: true, data: { userId: 'usr-key', balance: 250000 } }
    })
  });
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'api');
  // A key carries no id, so the balance is reached through the profile read — and
  // the id comes from the credential in use, never from another lane's file.
  // Four reads: the plan, the id lookup (a key carries none), the balance for that
  // id, then the same month-to-date usage report — the id is resolved once.
  assert.deepEqual(calls.map((c) => c.path).slice(0, 3), [USAGE_LIMITS_PATH, USERS_ME_PATH, balancePath('usr-key')]);
  assert.match(calls[3].path, /^\/api\/v1\/users\/usr-key\/usages\/daily\?startdate=/);
  assert.equal(calls[1].auth, 'Bearer sk-only');
  assert.equal(result.windows.find((w) => w.metric === 'credits').remaining, 0.25);
});

test('a key supplied as an option works without any local sign-in', async (t) => {
  const calls = [];
  const result = await fetchClineLimits({ clineApiKey: 'sk-settings' }, {
    env: { CLINE_DATA_DIR: tempDir(t) },
    now: () => NOW,
    fetch: routedFetch({
      sink: calls,
      me: { success: true, data: { id: 'usr-settings' } },
      balance: { success: true, data: { userId: 'usr-settings', balance: 1000000 } }
    })
  });
  // The settings field reaches the provider as the option, ahead of the env vars —
  // this is the lane the settings page saves into, and it needs nothing installed.
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'api');
  assert.deepEqual(calls.map((c) => c.auth), ['Bearer sk-settings', 'Bearer sk-settings', 'Bearer sk-settings', 'Bearer sk-settings']);
  assert.equal(result.windows.find((w) => w.metric === 'credits').remaining, 1);
});

test('a planless account that has credit reads as live, not as unavailable', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    // Verified live: a signed-in account with no subscription answers 404.
    fetch: routedFetch({ usageStatus: 404, balance: { success: true, data: { userId: 'usr-1', balance: 500000 } } })
  });
  // docs/providers/zai.md fixes the same rule: a successful no-plan answer beside a
  // valid balance is `ok`, because there is a reading to show.
  assert.equal(result.status, 'ok');
  assert.deepEqual(result.windows.map((w) => w.metric), ['credits']);
  assert.equal(result.windows[0].remaining, 0.5);
});

test('the monthly spend is reported beside the credit, in its own unit', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const calls = [];
  const queries = [];
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({
      sink: calls,
      limits: [],
      usagesQuery: queries,
      balance: { success: true, data: { userId: 'usr-1', balance: 500000 } },
      usages: {
        success: true,
        data: {
          // Captured live, including the units: `costUsd` is hundred-millionths of a
          // dollar, so the two paid calls are $0.0236 and $0.0021 — the same money the
          // balance moved by, 0.025777 credits.
          items: [
            { date: '2026-09-22', operation: 'chat_completion', aiModelTypeName: 'moonshotai', aiModelName: 'kimi-k3', costUsd: 2364975, promptTokens: 6028, completionTokens: 70 },
            { date: '2026-09-22', operation: 'chat_completion', aiModelTypeName: 'deepseek', aiModelName: 'deepseek-v4.1-flash', costUsd: 212819, promptTokens: 7006, completionTokens: 22 },
            { date: '2026-09-22', operation: 'chat_completion', aiModelTypeName: 'cline-free', aiModelName: 'cline-free/kimi-k3', costUsd: 2179200, promptTokens: 12460, completionTokens: 298 },
            { date: '2026-09-22', operation: 'chat_completion', aiModelName: 'broken-cost', costUsd: 'not-a-number' }
          ]
        }
      }
    })
  });
  assert.equal(result.status, 'ok');
  // The balance is credits and the usage report is money, so they stay in two
  // windows rather than being mixed into one number.
  assert.deepEqual(result.windows.map((w) => w.metric), ['credits', 'spend']);
  const spend = result.windows.find((w) => w.metric === 'spend');
  // The two paid calls only: the free one cost nothing (the balance never moved for
  // it, and the ledger books it as 0 credits) and a cost that is not a number is
  // skipped rather than counted as zero.
  assert.equal(spend.used, 0.02577794);
  assert.equal(spend.limit, null);
  assert.equal(spend.currency, 'USD');
  assert.equal(spend.showMeter, false);
  // The range is the local month to date, the window the API expects. Asserted
  // through the test's own local clock rather than a pinned UTC instant: a fixed
  // string would be green on a UTC runner by construction and red at +14, which is
  // what the CI offset matrix exists to catch.
  const local = new Date(NOW);
  const pad = (value) => String(value).padStart(2, '0');
  const localMonth = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-01`;
  const localToday = `${local.getFullYear()}-${pad(local.getMonth() + 1)}-${pad(local.getDate())}`;
  assert.deepEqual(queries, [`?startdate=${localMonth}&enddate=${localToday}`]);
});

test('a free-tier model is usage, not spend', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const read = async (items) => {
    const result = await fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: routedFetch({
        limits: [],
        balance: { success: true, data: { userId: 'usr-1', balance: 500000 } },
        usages: { success: true, data: { items } }
      })
    });
    return result.windows.find((w) => w.metric === 'spend') || null;
  };
  // Live, a free-tier call answers a would-be price with nothing charged for it:
  // counting that price would report money nobody paid.
  assert.equal(await read([{ date: '2026-09-22', aiModelName: 'cline-free/kimi-k3', costUsd: 2179200 }]), null);
  // The tier is spelled twice in that report and either spelling has to be enough.
  assert.equal(await read([{ date: '2026-09-22', aiModelTypeName: 'cline-free', aiModelName: 'kimi-k3', costUsd: 2179200 }]), null);
  assert.equal(await read([{ date: '2026-09-22', aiModelTypeName: 'CLINE-FREE', aiModelName: 'kimi-k3', costUsd: 2179200 }]), null);
  const paid = await read([
    { date: '2026-09-22', aiModelName: 'cline-free/kimi-k3', costUsd: 2179200 },
    { date: '2026-09-22', aiModelName: 'kimi-k3', costUsd: 2364975 }
  ]);
  assert.equal(paid.used, 0.02364975);
});

test('a month with no recorded spend adds no spend line', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({
      limits: [],
      balance: { success: true, data: { userId: 'usr-1', balance: 500000 } },
      // Verified live: this account answers an empty items list.
      usages: { success: true, data: { items: [] } }
    })
  });
  assert.deepEqual(result.windows.map((w) => w.metric), ['credits']);
});

test('an unreadable usage report leaves the credit reading alone', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  for (const route of [
    { usagesStatus: 500 },
    { usagesStatus: 401 },
    { usages: { success: false, data: null } },
    { usages: { success: true, data: { items: null } } }
  ]) {
    const result = await fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: routedFetch({ limits: [], ...route, balance: { success: true, data: { userId: 'usr-1', balance: 500000 } } })
    });
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.windows.map((w) => w.metric), ['credits']);
  }
});

test('no plan and no readable credit keeps the plan request status', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const result = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({ usageStatus: 404, balanceStatus: 500 })
  });
  assert.equal(result.status, 'unavailable');
  assert.deepEqual(result.windows, []);
});

test('a failed plan read keeps its status without costing the credit lane', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const calls = [];
  const run = (route) => fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: routedFetch({ sink: calls, balance: { success: true, data: { userId: 'usr-1', balance: 500000 } }, ...route })
  });
  // The lanes are independent, the shape providers/zai gives its quota and balance
  // lanes: an error decides the status and nothing else. The credit line is read
  // either way and rides along on the failed row, so a green pill can never hide an
  // outage and an outage can never cost the account its balance reading.
  for (const [usageStatus, expected] of [[403, 'unavailable'], [429, 'sourceRateLimited'], [500, 'unavailable']]) {
    const result = await run({ usageStatus });
    assert.equal(result.status, expected, `plan ${usageStatus} should report ${expected}`);
    assert.ok(TRANSIENT_STATUSES.has(expected), `${expected} must be transient for the last good reading to survive`);
    assert.deepEqual(result.windows.map((w) => w.metric), ['credits'], `plan ${usageStatus} should keep the credit`);
    assert.equal(result.source, 'oauth');
    // The credit lane is still asked: the plan request, then the balance for the id
    // the stored sign-in carries and the month-to-date usage report beside it.
    assert.equal(calls.length, 3, `plan ${usageStatus} should not stop the credit lane`);
    assert.equal(calls[0].path, USAGE_LIMITS_PATH);
    assert.equal(calls[1].path, balancePath('usr-1'));
    calls.length = 0;
  }
  // A transport failure is the same shape, and carries no HTTP status to read.
  const offline = await fetchClineLimits({}, {
    env: { CLINE_DATA_DIR: dataDir },
    now: () => NOW,
    fetch: async (url) => {
      if (String(url).includes('/plan/usage-limits')) throw new TypeError('fetch failed');
      if (String(url).includes('/balance')) {
        return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, data: { userId: 'usr-1', balance: 500000 } }) };
      }
      return { ok: true, status: 200, headers: { get: () => null }, json: async () => ({ success: true, data: { items: [] } }) };
    }
  });
  assert.equal(offline.status, 'unavailable');
  assert.deepEqual(offline.windows.map((w) => w.metric), ['credits']);
});

test('a credit that cannot be read leaves the plan reading alone', async (t) => {
  const dataDir = tempDir(t);
  writeProviders(dataDir, { cline: clineAuth() });
  const broken = [
    { balanceStatus: 500 },
    { balanceStatus: 401 },
    { balance: { success: false, data: null } },
    { balance: { success: true, data: { userId: 'usr-1', balance: 'lots' } } },
    { balance: { success: true, data: { userId: 'usr-1', balance: -1 } } }
  ];
  for (const route of broken) {
    const result = await fetchClineLimits({}, {
      env: { CLINE_DATA_DIR: dataDir },
      now: () => NOW,
      fetch: routedFetch(route)
    });
    // Best effort: a balance endpoint that is down or answers nonsense must not
    // take the plan reading down with it, and a rejected balance call must not
    // turn the row into a credential problem.
    assert.equal(result.status, 'ok');
    assert.deepEqual(result.windows.map((w) => w.kind), ['weekly']);
  }
});
