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

test('fetchGoApi maps HTTP codes onto provider statuses', async () => {
  const statusFor = async (code) => (await fetchGoApi('k', {
    fetch: async () => jsonResponse(code, { type: 'error' })
  })).status;

  // 403 is EntitlementError — no Go subscription. Not an error: it has to fall
  // through to the cookie and local paths quietly.
  assert.strictEqual(await statusFor(403), 'notConfigured');
  assert.strictEqual(await statusFor(401), 'unauthorized');
  assert.strictEqual(await statusFor(429), 'sourceRateLimited');
  assert.strictEqual(await statusFor(500), 'unavailable');
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
