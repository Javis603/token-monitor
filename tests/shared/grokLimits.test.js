'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  GROK_WEB_BILLING_GRPC_URL,
  resolveGrokHome,
  isRetryableNetworkError,
  validateGrokGrpcStatus
} = require('../../src/shared/grokLimits');
const {
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokLimits,
  parseLimitProviders
} = require('../../src/shared/limitCollector');

function writeAuthJson(homeDir, entries) {
  const filePath = path.join(homeDir, 'auth.json');
  fs.mkdirSync(homeDir, { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(entries));
  return filePath;
}

test('isRetryableNetworkError classifies transient undici failures only', () => {
  assert.equal(isRetryableNetworkError({ code: 'ECONNRESET' }), true);
  assert.equal(isRetryableNetworkError({ cause: { code: 'UND_ERR_CONNECT_TIMEOUT' } }), true);
  assert.equal(isRetryableNetworkError(new TypeError('fetch failed')), true);
  assert.equal(isRetryableNetworkError(Object.assign(new TypeError('fetch failed'), {
    cause: { code: 'ECONNREFUSED' }
  })), false);
  assert.equal(isRetryableNetworkError(Object.assign(new Error('rejected'), { status: 'unauthorized' })), false);
  assert.equal(isRetryableNetworkError(new Error('invalid proxy URL')), false);
});

function fakeGrokRpcSpawn(assertArgs = ['agent', 'stdio']) {
  return (command, args) => {
    assert.equal(command, 'grok');
    assert.deepEqual(args, assertArgs);
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stderr = new PassThrough();
    child.kill = () => {};
    child.stdin = new Writable({
      write(chunk, _encoding, callback) {
        const text = chunk.toString('utf8');
        for (const line of text.split(/\n+/).filter(Boolean)) {
          const message = JSON.parse(line);
          if (message.method === 'initialize') {
            child.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\n');
          }
          if (message.method === 'x.ai/billing') {
            child.stdout.write(JSON.stringify({
              jsonrpc: '2.0',
              id: message.id,
              result: {
                billingCycle: {
                  billingPeriodStart: '2026-06-01T00:00:00Z',
                  billingPeriodEnd: '2026-07-01T00:00:00Z'
                },
                monthlyLimit: { val: 10000 },
                usage: { totalUsed: { val: 4200 } }
              }
            }) + '\n');
          }
        }
        callback();
      }
    });
    return child;
  };
}

function varint(value) {
  let remaining = BigInt(value);
  const bytes = [];
  do {
    let byte = Number(remaining & 0x7fn);
    remaining >>= 7n;
    if (remaining !== 0n) byte |= 0x80;
    bytes.push(byte);
  } while (remaining !== 0n);
  return bytes;
}

function protoKey(field, wireType) {
  return varint((field << 3) | wireType);
}

function protoVarintField(field, value) {
  return Buffer.from([...protoKey(field, 0), ...varint(value)]);
}

function protoFixed32FloatField(field, value) {
  const data = Buffer.alloc(protoKey(field, 5).length + 4);
  Buffer.from(protoKey(field, 5)).copy(data, 0);
  data.writeFloatLE(value, protoKey(field, 5).length);
  return data;
}

function protoBytesField(field, payload) {
  return Buffer.concat([Buffer.from(protoKey(field, 2)), Buffer.from(varint(payload.length)), payload]);
}

function protoTimestamp(seconds) {
  return protoVarintField(1, seconds);
}

function protobufPayload({ usedPercent, resetEpoch }) {
  const data = Buffer.alloc(1 + 4 + 1 + varint(resetEpoch).length);
  data[0] = 0x0d; // field 1, fixed32
  data.writeFloatLE(usedPercent, 1);
  data[5] = 0x10; // field 2, varint
  Buffer.from(varint(resetEpoch)).copy(data, 6);
  return data;
}

function billingCycleProtobufPayload({ usedPercent, startEpoch, endEpoch }) {
  const billing = Buffer.concat([
    protoFixed32FloatField(1, usedPercent),
    protoBytesField(4, protoTimestamp(startEpoch)),
    protoBytesField(5, protoTimestamp(endEpoch))
  ]);
  return protoBytesField(1, billing);
}

function grpcFrame(payload) {
  const data = Buffer.alloc(5 + payload.length);
  data[0] = 0;
  data.writeUInt32BE(payload.length, 1);
  payload.copy(data, 5);
  return data;
}

function grpcTrailerFrame(fields) {
  const payload = Buffer.from(Object.entries(fields)
    .map(([key, value]) => `${key}: ${value}\r\n`)
    .join(''));
  const data = Buffer.alloc(5 + payload.length);
  data[0] = 0x80;
  data.writeUInt32BE(payload.length, 1);
  payload.copy(data, 5);
  return data;
}

function arrayBufferFrom(buffer) {
  return buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
}

function grpcBillingResponse({ usedPercent = 42.5, resetEpoch = 1_800_000_000 } = {}) {
  const frame = grpcFrame(protobufPayload({ usedPercent, resetEpoch }));
  return {
    status: 200,
    ok: true,
    arrayBuffer: async () => arrayBufferFrom(frame)
  };
}

test('parseLimitProviders includes grok and ollama in the default provider set', () => {
  assert.deepEqual(
    parseLimitProviders(),
    ['claude', 'codex', 'cursor', 'antigravity', 'opencode', 'deepseek', 'minimax', 'mimo', 'grok', 'copilot', 'kiro', 'zai', 'volcengine', 'qoder', 'zaiteam', 'kimi', 'ollama']
  );
});

test('grokCredential reads GROK_BEARER_TOKEN from env', () => {
  const c = grokCredential({ GROK_BEARER_TOKEN: 'eyJtest.eyJ.signature' }, {});
  assert.equal(c.token, 'eyJtest.eyJ.signature');
  assert.equal(c.source, 'env');
});

test('grokCredential strips quotes from env value', () => {
  const c = grokCredential({ GROK_BEARER_TOKEN: ' "eyJquoted.signature" ' }, {});
  assert.equal(c.token, 'eyJquoted.signature');
  assert.equal(c.source, 'env');
});

test('grokCredential reads from explicit grokBearerToken option', () => {
  const c = grokCredential({}, { grokBearerToken: 'eyJexplicit' });
  assert.equal(c.token, 'eyJexplicit');
  assert.equal(c.source, 'settings');
});

test('resolveGrokHome uses GROK_HOME for auth.json lookup', () => {
  const grokHome = path.join(os.tmpdir(), 'token-monitor-grok-home');

  assert.equal(resolveGrokHome({ GROK_HOME: grokHome }), path.resolve(grokHome));
});

test('grokCredential returns null when nothing is configured', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-test-'));
  const c = grokCredential({}, { grokHome: path.join(tmp, 'no-such-dir') });
  assert.equal(c, null);
});

test('readAuthJson prefers OIDC scope entries', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));
  writeAuthJson(home, {
    'https://auth.x.ai::client': { key: 'eyJ-oidc.signature' },
    'https://accounts.x.ai/sign-in': { key: 'eyJ-legacy.signature' }
  });
  const c = readAuthJson({}, { grokHome: home });
  assert.equal(c.token, 'eyJ-oidc.signature');
  assert.equal(c.source, 'auth.json-oidc');
});

test('readAuthJson falls back to legacy /sign-in when no OIDC entry', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));
  writeAuthJson(home, {
    'https://accounts.x.ai/sign-in': { key: 'eyJ-legacy.signature' }
  });
  const c = readAuthJson({}, { grokHome: home });
  assert.equal(c.token, 'eyJ-legacy.signature');
  assert.equal(c.source, 'auth.json-legacy');
});

test('readAuthJson falls back to any entry with a non-empty key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-auth-'));
  writeAuthJson(home, {
    'custom-scope://example': { key: 'eyJ-custom.signature' }
  });
  const c = readAuthJson({}, { grokHome: home });
  assert.equal(c.token, 'eyJ-custom.signature');
  assert.match(c.source, /^auth\.json:/);
});

test('readAuthJson returns null when file is missing', () => {
  const c = readAuthJson({}, { grokHome: path.join(os.tmpdir(), 'grok-missing-' + Date.now()) });
  assert.equal(c, null);
});

test('readAuthJson returns null when file contains invalid JSON', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-bad-'));
  fs.writeFileSync(path.join(home, 'auth.json'), 'not json');
  assert.equal(readAuthJson({}, { grokHome: home }), null);
});

test('readAuthJson returns null when no entry has a non-empty key', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-empty-'));
  writeAuthJson(home, { 'scope://x': { key: '' } });
  assert.equal(readAuthJson({}, { grokHome: home }), null);
});

test('parseGrokBilling produces a single monthly window from a typical response', () => {
  const body = {
    config: {
      monthlyLimit: 100,
      used: 67,
      onDemandCap: 50,
      onDemandUsed: 5,
      billingPeriodEnd: '2026-07-01T00:00:00Z',
      billingPeriodStart: '2026-06-01T00:00:00Z'
    }
  };
  const windows = parseGrokBilling(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].label, 'Monthly');
  assert.equal(windows[0].usedPercent, 67);
  assert.equal(windows[0].resetsAt, '2026-07-01T00:00:00.000Z');
});

test('parseGrokBilling accepts Grok CLI x.ai/billing RPC result shape', () => {
  const body = {
    billingCycle: {
      billingPeriodStart: '2026-06-01T00:00:00Z',
      billingPeriodEnd: '2026-07-01T00:00:00Z'
    },
    monthlyLimit: { val: 10000 },
    usage: {
      includedUsed: { val: 6400 },
      totalUsed: { val: 6700 }
    }
  };
  const windows = parseGrokBilling(body);
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].label, 'Monthly');
  assert.equal(windows[0].usedPercent, 67);
  assert.equal(windows[0].resetsAt, '2026-07-01T00:00:00.000Z');
  assert.equal(windows[0].windowMinutes, 30 * 24 * 60);
});

test('parseGrokGrpcWebBilling accepts CodexBar grok.com grpc-web billing frames', () => {
  const resetEpoch = 1_800_000_000;
  const windows = parseGrokGrpcWebBilling(
    grpcFrame(protobufPayload({ usedPercent: 42.5, resetEpoch })),
    1_799_000_000_000
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].usedPercent, 42.5);
  assert.equal(windows[0].resetsAt, '2027-01-15T08:00:00.000Z');
  assert.equal(windows[0].showMeter, true);
});

test('parseGrokGrpcWebBilling labels monthly cycles from protobuf start/end timestamps', () => {
  const startEpoch = Date.parse('2026-06-01T00:00:00Z') / 1000;
  const endEpoch = Date.parse('2026-07-01T00:00:00Z') / 1000;
  const nowMs = Date.parse('2026-06-28T00:00:00Z');
  const windows = parseGrokGrpcWebBilling(
    grpcFrame(billingCycleProtobufPayload({ usedPercent: 15, startEpoch, endEpoch })),
    nowMs
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].label, 'Monthly');
  assert.equal(windows[0].usedPercent, 15);
  assert.equal(windows[0].resetsAt, '2026-07-01T00:00:00.000Z');
  assert.equal(windows[0].windowMinutes, 30 * 24 * 60);
});

test('parseGrokGrpcWebBilling labels unknown positive cycles as Billing', () => {
  const startEpoch = Date.parse('2026-06-01T00:00:00Z') / 1000;
  const endEpoch = Date.parse('2026-06-15T00:00:00Z') / 1000;
  const nowMs = Date.parse('2026-06-07T00:00:00Z');
  const windows = parseGrokGrpcWebBilling(
    grpcFrame(billingCycleProtobufPayload({ usedPercent: 15, startEpoch, endEpoch })),
    nowMs
  );
  assert.equal(windows.length, 1);
  assert.equal(windows[0].kind, 'billing');
  assert.equal(windows[0].label, 'Billing');
  assert.equal(windows[0].usedPercent, 15);
  assert.equal(windows[0].resetsAt, '2026-06-15T00:00:00.000Z');
  assert.equal(windows[0].windowMinutes, 14 * 24 * 60);
});

test('parseGrokBilling throws when monthly window cannot be built', () => {
  // monthlyLimit present but 0 → no usable window
  const body = { config: { monthlyLimit: 0, used: 0, onDemandCap: 100, onDemandUsed: 200 } };
  assert.throws(() => parseGrokBilling(body), /no monthly quota/);
});

test('fetchGrokRpcBilling speaks Grok agent stdio x.ai/billing JSON-RPC', async () => {
  const body = await fetchGrokRpcBilling({}, {
    env: {},
    spawn: fakeGrokRpcSpawn(),
    rpcTimeoutMs: 100
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(body.usage.totalUsed.val, 4200);
});

test('fetchGrokLimits prefers Grok CLI RPC billing before bearer web fallback', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-rpc-'));
  writeAuthJson(home, {
    'https://auth.x.ai::client': {
      key: 'eyJsecret.signature',
      email: 'user@example.com'
    }
  });
  const body = {
    billingCycle: {
      billingPeriodStart: '2026-06-01T00:00:00Z',
      billingPeriodEnd: '2026-07-01T00:00:00Z'
    },
    monthlyLimit: { val: 10000 },
    usage: { totalUsed: { val: 2500 } }
  };
  let rpcCalled = false;
  const r = await fetchGrokLimits(
    {},
    {
      env: {},
      grokHome: home,
      now: () => 1_716_350_000_000,
      fetchRpcBilling: async () => {
        rpcCalled = true;
        return body;
      },
      fetch: async () => {
        throw new Error('web fallback should not run when CLI RPC succeeds');
      }
    }
  );
  assert.equal(r.provider, 'grok');
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'rpc');
  assert.equal(r.sourceDetail, 'cli');
  assert.equal(r.accountLabel, 'SuperGrok');
  assert.equal(r.accountEmail, 'user@example.com');
  assert.match(r.accountKey, /^sha256:/);
  assert.equal(r.windows.length, 1);
  assert.equal(r.windows[0].label, 'Monthly');
  assert.equal(r.windows[0].usedPercent, 25);
  assert.ok(rpcCalled);
  assert.ok(!JSON.stringify(r).includes('eyJsecret'));
});

test('fetchGrokLimits falls back to CodexBar grok.com grpc-web billing when CLI RPC is unavailable', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-rpc-fallback-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'eyJsecret.signature' } });
  const calls = [];
  let capturedAuth = '';
  let capturedBody = null;
  const r = await fetchGrokLimits(
    {},
    {
      env: {},
      grokHome: home,
      now: () => 1_799_000_000_000,
      fetchRpcBilling: async () => {
        calls.push('rpc');
        const error = new Error('grok binary not found');
        error.code = 'ENOENT';
        throw error;
      },
      fetch: async (url, init) => {
        calls.push(url);
        assert.equal(url, GROK_WEB_BILLING_GRPC_URL);
        assert.equal(init.method, 'POST');
        assert.equal(init.headers.Authorization, 'Bearer eyJsecret.signature');
        assert.equal(init.headers['Content-Type'], 'application/grpc-web+proto');
        assert.equal(init.headers.Origin, 'https://grok.com');
        assert.equal(init.headers.Referer, 'https://grok.com/?_s=usage');
        assert.equal(init.headers['x-grpc-web'], '1');
        capturedAuth = init.headers.Authorization;
        capturedBody = Buffer.from(init.body);
        return grpcBillingResponse({ usedPercent: 67, resetEpoch: 1_800_000_000 });
      }
    }
  );
  assert.deepEqual(calls, ['rpc', GROK_WEB_BILLING_GRPC_URL]);
  assert.equal(capturedAuth, 'Bearer eyJsecret.signature');
  assert.deepEqual(Array.from(capturedBody), [0, 0, 0, 0, 0]);
  assert.equal(r.status, 'ok');
  assert.equal(r.source, 'web');
  assert.equal(r.windows[0].usedPercent, 67);
});

test('fetchGrokLimits maps CLI RPC auth failure without bearer fallback to unauthorized', async () => {
  const r = await fetchGrokLimits(
    {},
    {
      env: {},
      grokHome: path.join(os.tmpdir(), 'grok-no-auth-' + Date.now()),
      fetchRpcBilling: async () => {
        const error = new Error('Grok billing requires authentication. Run `grok login`.');
        error.status = 'unauthorized';
        throw error;
      }
    }
  );
  assert.equal(r.status, 'unauthorized');
  assert.equal(r.source, 'rpc');
  assert.equal(r.sourceDetail, 'cli');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits returns notConfigured when no credential is available', async () => {
  const r = await fetchGrokLimits(
    {},
    { env: {}, grokHome: path.join(os.tmpdir(), 'grok-nonexistent-' + Date.now()), now: () => 1_716_350_000_000 }
  );
  assert.equal(r.provider, 'grok');
  assert.equal(r.status, 'notConfigured');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits does not fall back to legacy JSON when credits-config fails', async () => {
  const calls = [];
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJsecret.signature' },
    {
      env: {},
      now: () => 1_716_350_000_000,
      fetch: async (url) => {
        calls.push(url);
        return { status: 503, ok: false, arrayBuffer: async () => arrayBufferFrom(Buffer.alloc(0)) };
      }
    }
  );
  assert.deepEqual(calls, [GROK_WEB_BILLING_GRPC_URL]);
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});

test('validateGrokGrpcStatus maps bad OAuth credentials to unauthorized', () => {
  assert.throws(
    () => validateGrokGrpcStatus(new Map([
      ['grpc-status', '7'],
      ['grpc-message', 'The%20OAuth2%20access%20token%20could%20not%20be%20validated.%20[WKE=unauthenticated:bad-credentials]']
    ])),
    (error) => error.status === 'unauthorized' && /rejected credentials/.test(error.message)
  );
});

test('validateGrokGrpcStatus keeps non-auth RPC failures unavailable', () => {
  assert.throws(
    () => validateGrokGrpcStatus({ 'grpc-status': '13', 'grpc-message': 'internal' }),
    (error) => error.status === 'unavailable' && /status 13/.test(error.message)
  );
});

test('fetchGrokLimits maps grpc-web auth trailers to unauthorized', async () => {
  const trailer = grpcTrailerFrame({
    'grpc-status': '16',
    'grpc-message': 'Unauthenticated'
  });
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJsecret.signature' },
    {
      env: {},
      fetch: async () => ({
        status: 200,
        ok: true,
        headers: { get: () => null },
        arrayBuffer: async () => arrayBufferFrom(trailer)
      })
    }
  );
  assert.equal(r.status, 'unauthorized');
  assert.deepEqual(r.windows, []);
});

test('parseGrokBilling prefers creditUsagePercent + currentPeriod when present', () => {
  const windows = parseGrokBilling({
    config: {
      creditUsagePercent: 16.5,
      currentPeriod: {
        type: 'USAGE_PERIOD_TYPE_WEEKLY',
        start: '2026-07-14T02:07:01Z',
        end: '2026-07-21T02:07:01Z'
      },
      // Deprecated fields that would compute a different % if preferred first.
      monthlyLimit: { val: 15000 },
      used: { val: 8053 }
    }
  });
  assert.equal(windows.length, 1);
  assert.equal(windows[0].label, 'Weekly');
  assert.equal(windows[0].usedPercent, 16.5);
  assert.equal(windows[0].resetsAt, '2026-07-21T02:07:01.000Z');
});

test('fetchGrokLimits maps HTTP 401 to unauthorized', async () => {
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    { env: {}, fetch: async () => ({ status: 401, ok: false, json: async () => ({}) }) }
  );
  assert.equal(r.status, 'unauthorized');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits maps non-2xx (non-auth) to unavailable', async () => {
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    { env: {}, fetch: async () => ({ status: 500, ok: false, json: async () => ({}) }) }
  );
  assert.equal(r.status, 'unavailable');
});

test('fetchGrokLimits maps a body missing config to unavailable', async () => {
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    { env: {}, fetch: async () => ({ status: 200, ok: true, json: async () => ({}) }) }
  );
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits maps fetch network error to unavailable', async () => {
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    { env: {}, fetch: async () => { throw new Error('ECONNREFUSED'); } }
  );
  assert.equal(r.status, 'unavailable');
});

test('fetchGrokLimits aborts and returns unavailable when the fetch exceeds the timeout', async () => {
  // A fetch that ignores the abort signal and never resolves would hang the
  // test forever; instead we honor the signal so the AbortController path is
  // exercised end-to-end. A 10ms timeout proves the default 12s is wiring,
  // not a real wait.
  let receivedSignal = null;
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    {
      env: {},
      fetchTimeoutMs: 10,
      fetch: async (_url, init) => {
        receivedSignal = init.signal;
        return new Promise((_, reject) => {
          init.signal.addEventListener('abort', () => reject(new Error('aborted')));
        });
      }
    }
  );
  assert.ok(receivedSignal, 'fetch should receive an AbortSignal');
  assert.equal(r.status, 'unavailable');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits maps HTTP 403 to unauthorized (token rejected, not a server fault)', async () => {
  const r = await fetchGrokLimits(
    { grokBearerToken: 'eyJ' },
    { env: {}, fetch: async () => ({ status: 403, ok: false, json: async () => ({}) }) }
  );
  assert.equal(r.status, 'unauthorized');
  assert.deepEqual(r.windows, []);
});

test('fetchGrokLimits prefers explicit grokBearerToken over env', async () => {
  let capturedAuth = '';
  await fetchGrokLimits(
    { grokBearerToken: 'eyJsettings' },
    {
      env: { GROK_BEARER_TOKEN: 'eyJenv' },
      fetch: async (_url, init) => {
        capturedAuth = init.headers.Authorization;
        return { status: 200, ok: true, json: async () => ({ config: { monthlyLimit: 1, used: 0 } }) };
      }
    }
  );
  assert.equal(capturedAuth, 'Bearer eyJsettings');
});

test('fetchGrokLimits prefers env over ~/.grok/auth.json', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-fallback-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'eyJfromfile.signature' } });
  let capturedAuth = '';
  await fetchGrokLimits(
    {},
    {
      env: { GROK_BEARER_TOKEN: 'eyJenv' },
      grokHome: home,
      fetch: async (_url, init) => {
        capturedAuth = init.headers.Authorization;
        return { status: 200, ok: true, json: async () => ({ config: { monthlyLimit: 1, used: 0 } }) };
      }
    }
  );
  assert.equal(capturedAuth, 'Bearer eyJenv');
});

test('fetchGrokLimits falls back to ~/.grok/auth.json when no env or settings', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-fallback-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'eyJfromfile.signature' } });
  let capturedAuth = '';
  await fetchGrokLimits(
    {},
    {
      env: {},
      grokHome: home,
      fetch: async (_url, init) => {
        capturedAuth = init.headers.Authorization;
        return { status: 200, ok: true, json: async () => ({ config: { monthlyLimit: 1, used: 0 } }) };
      }
    }
  );
  assert.equal(capturedAuth, 'Bearer eyJfromfile.signature');
});

test('fetchGrokLimits returns notConfigured when real ~/.grok/auth.json has no usable key', async () => {
  // Point grokHome at a directory that does NOT contain an auth.json. This
  // is the only way to deterministically get notConfigured — any other path
  // could read the user's real ~/.grok/auth.json and return ok.
  const r = await fetchGrokLimits(
    {},
    { env: {}, grokHome: path.join(os.tmpdir(), 'grok-definitely-missing-' + Date.now() + '-' + Math.random()) }
  );
  assert.equal(r.status, 'notConfigured');
});
