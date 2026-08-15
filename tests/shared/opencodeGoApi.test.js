'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  GO_USAGE_URL,
  readGoApiKey,
  goApiIdentity,
  parseGoUsage,
  fetchGoApi,
  collectGoApi
} = require('../../src/shared/opencodeGoApi');

// A verbatim 200 body from https://opencode.ai/zen/go/v1/usage.
const LIVE_PAYLOAD = {
  usage: {
    rolling: { status: 'ok', percent: 0, resetsAt: '2026-08-13T15:11:49.412Z' },
    weekly: { status: 'ok', percent: 57, resetsAt: '2026-08-17T00:00:00.412Z' },
    monthly: { status: 'ok', percent: 30, resetsAt: '2026-09-04T11:42:50.412Z' }
  }
};

function withDataDir(contents) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opencode-api-'));
  const dataDir = path.join(dir, 'opencode');
  fs.mkdirSync(dataDir, { recursive: true });
  if (contents !== null) fs.writeFileSync(path.join(dataDir, 'auth.json'), contents);
  return { env: { XDG_DATA_HOME: dir }, dir };
}

function jsonResponse(status, body) {
  return { status, json: async () => body };
}

test('readGoApiKey reads the opencode-go entry from auth.json', () => {
  const { env } = withDataDir(JSON.stringify({
    'opencode-go': { type: 'api', key: 'go-key-123' }
  }));
  assert.strictEqual(readGoApiKey(env), 'go-key-123');
});

test('readGoApiKey ignores a Zen-only auth.json', () => {
  // The `opencode` provider id is the Zen key. This endpoint returns no
  // balance, so a Zen-only account must not be probed at all.
  const { env } = withDataDir(JSON.stringify({ opencode: { type: 'api', key: 'zen-key' } }));
  assert.strictEqual(readGoApiKey(env), '');
});

test('readGoApiKey survives a missing or corrupt auth.json', () => {
  assert.strictEqual(readGoApiKey(withDataDir(null).env), '');
  assert.strictEqual(readGoApiKey(withDataDir('{not json').env), '');
  assert.strictEqual(readGoApiKey(withDataDir('null').env), '');
  assert.strictEqual(readGoApiKey(withDataDir('{"opencode-go":{"type":"oauth"}}').env), '');
});

// OpenCode reads its own credentials from OPENCODE_AUTH_CONTENT before
// auth.json, and sets that variable itself when it spawns a workspace child
// process. It is also how credentials arrive in a container or a CI runner,
// which is where the headless agent runs and where there is no auth.json — so
// discovery has to mirror upstream rather than assume the file.
// Upstream decodes auth.json through a union discriminated on `type` and drops
// what does not match, so an entry OpenCode itself would ignore is not a
// credential the user configured — and sending an unconfirmed secret to the API
// as a Bearer token is the thing worth not doing.
test('auth.json entries OpenCode would drop are not probed', () => {
  const reject = [
    { 'opencode-go': { key: 'no-type' } },
    { 'opencode-go': { type: 'API', key: 'wrong-case' } },
    { 'opencode-go': { type: 'api', key: 12345 } },
    { 'opencode-go': { type: 'oauth', access: 'tok' } }
  ];
  for (const doc of reject) {
    assert.strictEqual(readGoApiKey(withDataDir(JSON.stringify(doc)).env), '', JSON.stringify(doc));
  }
  assert.strictEqual(
    readGoApiKey(withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'good' } })).env),
    'good'
  );
});

// The variable keeps upstream's looser handling on purpose: `Auth.all()` returns
// it straight from JSON.parse with no schema pass. Validating it here would
// reintroduce the bug the variable was added to fix — a credential OpenCode uses
// that we do not.
test('the inline credential set keeps upstream\'s unvalidated handling', () => {
  const { env } = withDataDir(null);
  const inline = JSON.stringify({ 'opencode-go': { key: 'no-type-inline' } });
  assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: inline }), 'no-type-inline');
  // A type that is present and is not an API key is still refused either way.
  assert.strictEqual(
    readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: JSON.stringify({ 'opencode-go': { type: 'oauth', key: 'x' } }) }),
    ''
  );
});

test('readGoApiKey reads the credential set OpenCode passes in the environment', () => {
  const { env } = withDataDir(null);
  const inline = JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-inline' } });
  assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: inline }), 'from-inline');
});

test('the inline credential set replaces auth.json rather than merging with it', () => {
  const { env } = withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-file' } }));
  const inline = JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-inline' } });
  assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: inline }), 'from-inline');

  // A restricted set that simply has no Go key must not fall back to the fuller
  // one on disk: upstream returns the parsed variable and never reads the file.
  assert.strictEqual(
    readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: JSON.stringify({ opencode: { type: 'api', key: 'zen' } }) }),
    ''
  );
});

test('unparseable inline credentials fall back to auth.json, as upstream does', () => {
  const { env } = withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-file' } }));
  for (const broken of ['{not json', '', '   ']) {
    assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: broken }), 'from-file', broken);
  }
  // Parseable but useless shapes are still the answer, not a fallback.
  assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: 'null' }), '');
  assert.strictEqual(readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: '{}' }), '');
  assert.strictEqual(
    readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: JSON.stringify({ 'opencode-go': { type: 'oauth' } }) }),
    ''
  );
});

test('our own override outranks both of OpenCode\'s credential sources', () => {
  const { env } = withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-file' } }));
  const inline = JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-inline' } });
  assert.strictEqual(
    readGoApiKey({ ...env, OPENCODE_AUTH_CONTENT: inline, TOKEN_MONITOR_OPENCODE_API_KEY: 'from-setting' }),
    'from-setting'
  );
});

test('readGoApiKey lets the env override win over auth.json', () => {
  const { env } = withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'from-file' } }));
  assert.strictEqual(
    readGoApiKey({ ...env, TOKEN_MONITOR_OPENCODE_API_KEY: 'from-env' }),
    'from-env'
  );
});

test('parseGoUsage maps rolling/weekly/monthly onto our window kinds', () => {
  const windows = parseGoUsage(LIVE_PAYLOAD);
  assert.deepStrictEqual(windows.map((w) => w.kind), ['session', 'weekly', 'monthly']);
  assert.deepStrictEqual(windows.map((w) => w.usedPercent), [0, 57, 30]);
  assert.strictEqual(windows[1].resetsAt, '2026-08-17T00:00:00.412Z');
  assert.strictEqual(windows[1].windowMinutes, 10080);
  // The dollar limits behind these percentages are server-side only.
  assert.strictEqual(windows[1].used, null);
  assert.strictEqual(windows[1].limit, null);
});

test('parseGoUsage treats rate-limited as a full window', () => {
  const [session] = parseGoUsage({
    usage: {
      rolling: { status: 'rate-limited', resetsAt: '2026-08-13T15:11:49.412Z' },
      weekly: { status: 'ok', percent: 4, resetsAt: '2026-08-17T00:00:00.412Z' }
    }
  });
  assert.strictEqual(session.usedPercent, 100);
});

test('parseGoUsage reports nothing when the payload shape changes', () => {
  assert.deepStrictEqual(parseGoUsage({}), []);
  assert.deepStrictEqual(parseGoUsage({ usage: {} }), []);
  // monthly alone is a shape change, not a partial account.
  assert.deepStrictEqual(parseGoUsage({ usage: { monthly: { status: 'ok', percent: 3 } } }), []);
  // The pre-release shape documented in issue #403 is not what shipped.
  assert.deepStrictEqual(parseGoUsage({ rollingUsage: { usagePercent: 12 } }), []);
});

test('fetchGoApi sends a bearer token to the official endpoint', async () => {
  const calls = [];
  const result = await fetchGoApi('go-key-123', {
    fetch: async (url, init) => {
      calls.push({ url, init });
      return jsonResponse(200, LIVE_PAYLOAD);
    }
  });
  assert.strictEqual(calls.length, 1);
  assert.strictEqual(calls[0].url, GO_USAGE_URL);
  assert.strictEqual(calls[0].init.headers.Authorization, 'Bearer go-key-123');
  assert.strictEqual(result.status, 'ok');
  assert.strictEqual(result.windows.length, 3);
});

// The body upstream actually returns for a workspace with no Go subscription.
const ENTITLEMENT_ERROR = {
  type: 'error',
  error: { type: 'EntitlementError', message: 'OpenCode Go subscription required.' }
};

test('fetchGoApi maps HTTP codes onto provider statuses', async () => {
  const statusFor = async (code, body = { type: 'error' }) => (await fetchGoApi('k', {
    fetch: async () => jsonResponse(code, body)
  })).status;

  // EntitlementError — no Go subscription. Not an error: it has to fall through
  // to the cookie and local paths quietly.
  assert.strictEqual(await statusFor(403, ENTITLEMENT_ERROR), 'notConfigured');
  assert.strictEqual(await statusFor(401), 'unauthorized');
  assert.strictEqual(await statusFor(429), 'sourceRateLimited');
  assert.strictEqual(await statusFor(500), 'unavailable');
});

// `entitled: false` is the server saying this account has no Go plan, and it
// also stops the local estimate taking over. Drawing that from the status code
// alone would let a proxy, a WAF or an edge policy in front of the endpoint —
// none of which know anything about the account — report "no subscription" and
// suppress the estimate that would have covered the outage.
test('only the upstream EntitlementError concludes the account has no Go plan', async () => {
  const entitlement = await fetchGoApi('k', {
    fetch: async () => jsonResponse(403, ENTITLEMENT_ERROR)
  });
  assert.strictEqual(entitlement.status, 'notConfigured');
  assert.strictEqual(entitlement.entitled, false);

  for (const body of [{ type: 'error' }, { error: { type: 'AuthError' } }, {}, null]) {
    const other = await fetchGoApi('k', { fetch: async () => jsonResponse(403, body) });
    assert.strictEqual(other.status, 'unavailable', `403 body ${JSON.stringify(body)}`);
    assert.strictEqual(other.entitled, undefined);
  }

  // A 403 that is not JSON at all, which is what an edge block usually is.
  const html = await fetchGoApi('k', {
    fetch: async () => ({ status: 403, json: async () => { throw new SyntaxError('Unexpected token <'); } })
  });
  assert.strictEqual(html.status, 'unavailable');
  assert.strictEqual(html.entitled, undefined);
});

test('fetchGoApi reports unavailable when the request throws', async () => {
  const result = await fetchGoApi('k', {
    fetch: async () => { throw new Error('network down'); }
  });
  assert.strictEqual(result.status, 'unavailable');
});

test('fetchGoApi rethrows an abort instead of publishing a status row', async () => {
  // The limits lane is latest-wins; swallowing the abort would let a cancelled
  // probe overwrite the answer that superseded it.
  const abort = Object.assign(new Error('aborted'), { name: 'AbortError' });
  await assert.rejects(
    () => fetchGoApi('k', { fetch: async () => { throw abort; } }),
    /aborted/
  );
});

test('fetchGoApi treats a 200 with an unusable body as unavailable', async () => {
  const bad = await fetchGoApi('k', {
    fetch: async () => ({ status: 200, json: async () => { throw new Error('not json'); } })
  });
  assert.strictEqual(bad.status, 'unavailable');

  const empty = await fetchGoApi('k', { fetch: async () => jsonResponse(200, { usage: {} }) });
  assert.strictEqual(empty.status, 'unavailable');
});

test('collectGoApi is notConfigured without a key and never calls out', async () => {
  let called = false;
  const result = await collectGoApi({
    env: withDataDir(null).env,
    fetch: async () => { called = true; return jsonResponse(200, LIVE_PAYLOAD); }
  });
  assert.strictEqual(result.status, 'notConfigured');
  assert.strictEqual(called, false);
});

test('collectGoApi keeps the identity across a failed probe', async () => {
  // The key names the account, so a 401 must not blank the identity: an empty
  // accountKey matches nothing already stored on the Hub.
  const ok = await collectGoApi({
    apiKey: 'go-key-123',
    fetch: async () => jsonResponse(200, LIVE_PAYLOAD)
  });
  assert.strictEqual(ok.identity, goApiIdentity('go-key-123'));

  const failed = await collectGoApi({
    apiKey: 'go-key-123',
    fetch: async () => jsonResponse(401, {})
  });
  assert.strictEqual(failed.status, 'unauthorized');
  assert.strictEqual(failed.identity, ok.identity);
});

test('an empty apiKey suppresses the ambient lookup instead of reading auth.json', async () => {
  const { env } = withDataDir(JSON.stringify({ 'opencode-go': { type: 'api', key: 'ambient' } }));
  let called = false;
  const result = await collectGoApi({
    env,
    apiKey: '',
    fetch: async () => { called = true; return jsonResponse(200, LIVE_PAYLOAD); }
  });
  assert.strictEqual(result.status, 'notConfigured');
  assert.strictEqual(called, false);
});

test('goApiIdentity is stable per key and distinct across keys', () => {
  assert.strictEqual(goApiIdentity('a'), goApiIdentity('a'));
  assert.notStrictEqual(goApiIdentity('a'), goApiIdentity('b'));
  // Full digest: truncating only narrows the space two accounts could collide in.
  assert.match(goApiIdentity('a'), /^go-api:[0-9a-f]{64}$/);
});

test('a runtime cancellation propagates even though it is a plain Error', async () => {
  // LimitsRuntime cancels with controller.abort(new Error('superseded')), and
  // fetch rejects with that exact object: no AbortError name, no ABORT_ERR
  // code. Matching on the error shape alone misses every real cancellation, so
  // the signal is what decides.
  const controller = new AbortController();
  const superseded = new Error('superseded');
  await assert.rejects(
    () => fetchGoApi('k', {
      signal: controller.signal,
      fetch: async () => {
        controller.abort(superseded);
        throw superseded;
      }
    }),
    /superseded/
  );
});

test('a plain failure with an untouched signal is still just unavailable', async () => {
  const controller = new AbortController();
  const result = await fetchGoApi('k', {
    signal: controller.signal,
    fetch: async () => { throw new Error('network down'); }
  });
  assert.strictEqual(result.status, 'unavailable');
});
