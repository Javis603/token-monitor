'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const vm = require('node:vm');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createWorkbuddyLocalAuth, WORKBUDDY_AUTH_FILE_NAME } = require('../../src/electron/providers/workbuddy/localAuth');
const { RUNTIME_SCRIPT, createWorkbuddyCredentialDecoder, isEncryptedAccessToken,
  resolveWorkbuddyExecutable } = require('../../src/electron/providers/workbuddy/credentialDecoder');
const fixture = require('./workbuddy-codec-synthetic-fixture.json');

// The fixture was sealed by the original WorkBuddy codec, not this decoder.
// The AAD is a fixed protocol vector from that comparison. This helper creates
// authenticated but otherwise invalid tokens/context for negative tests.
function seal(plain, aadHex = fixture.aadHex) {
  const key = crypto.createHash('sha256').update(fixture.payload.atRestSecretKey, 'utf8').digest();
  const cipher = crypto.createCipheriv('aes-256-gcm', key, Buffer.alloc(12, 0x23), { authTagLength: 16 });
  cipher.setAAD(Buffer.from(aadHex, 'hex'));
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()]);
  const envelope = JSON.parse(Buffer.from(fixture.wrapper.envelope, 'base64').toString());
  envelope.ciphertext = ciphertext.toString('base64');
  envelope.authTag = cipher.getAuthTag().toString('base64');
  key.fill(0);
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope)).toString('base64') };
}

function envelopeWith(change) {
  const envelope = JSON.parse(Buffer.from(fixture.wrapper.envelope, 'base64').toString());
  change(envelope);
  return { $wbEncrypted: 1, envelope: Buffer.from(JSON.stringify(envelope)).toString('base64') };
}

function runRuntime(wrapper = fixture.wrapper, payload = fixture.payload, options = {}) {
  let output = '', nativeCalls = 0, error = null;
  const sensitiveBuffers = [];
  const cryptoApi = {
    createHash(algorithm) {
      const hash = crypto.createHash(algorithm);
      const digest = hash.digest.bind(hash);
      hash.digest = (...args) => {
        const result = digest(...args);
        if (Buffer.isBuffer(result)) sensitiveBuffers.push(result);
        return result;
      };
      return hash;
    },
    createDecipheriv(...args) {
      const decipher = crypto.createDecipheriv(...args);
      const update = decipher.update.bind(decipher);
      decipher.update = (...values) => {
        const result = update(...values);
        sensitiveBuffers.push(result);
        return result;
      };
      return decipher;
    }
  };
  const sandbox = {
    Buffer,
    require(name) {
      if (name === 'node:fs') return { readFileSync(fd) {
        assert.equal(fd, 0);
        return options.input ?? JSON.stringify(wrapper);
      } };
      if (name === 'node:crypto') return cryptoApi;
      throw new Error('Unexpected module required');
    },
    process: {
      _linkedBinding(name) {
        nativeCalls += 1;
        assert.equal(name, 'electron_browser_workbuddy_storage');
        if (options.bindingError) throw new Error('native unavailable');
        return { loggerGet: () => options.rawPayload ?? JSON.stringify(payload) };
      },
      stdout: { write(value) { output += value; } }
    }
  };
  try { new vm.Script(RUNTIME_SCRIPT).runInNewContext(sandbox, { timeout: 1000 }); }
  catch (caught) { error = caught; }
  return { output, nativeCalls, error, sensitiveBuffers };
}

function rejectRuntime(wrapper, payload, options) {
  const result = runRuntime(wrapper, payload, options);
  assert.ok(result.error);
  assert.equal(result.output, '');
  assert.ok(result.sensitiveBuffers.every(buffer => buffer.every(byte => byte === 0)));
  return result;
}

test('Original-codec suite1 field vector opens with legacy version1 symmetric-only payload', () => {
  const result = runRuntime();
  assert.equal(result.error, null);
  assert.equal(result.output, fixture.expected);
  assert.equal(result.nativeCalls, 1);
  assert.ok(result.sensitiveBuffers.every(buffer => buffer.every(byte => byte === 0)));
});

test('Same field vector supports the newer optional developer public key capability', () => {
  const result = runRuntime(fixture.wrapper, { ...fixture.payload, atRestDeveloperPublicKey: { alg: 'RSA-OAEP-256' } });
  // Like the original normalizer, an unavailable optional asymmetric capability
  // must not disable the separate valid symmetric capability.
  assert.equal(result.error, null);
  assert.equal(result.output, fixture.expected);
});

test('Runtime rejects wrong wrapper marker, fields, empty input and excessive input before native access', () => {
  for (const wrapper of [null, [], {}, { ...fixture.wrapper, $wbEncrypted: 2 },
    { ...fixture.wrapper, extra: 1 }, { $wbEncrypted: 1, envelope: '' }]) {
    assert.equal(rejectRuntime(wrapper).nativeCalls, 0);
  }
  assert.equal(rejectRuntime(undefined, undefined, { input: 'x'.repeat(16385) }).nativeCalls, 0);
});

test('Runtime rejects noncanonical outer base64 and malformed envelope JSON', () => {
  for (const envelope of [`${fixture.wrapper.envelope}\n`, 'e30', 'not-base64', Buffer.from('{').toString('base64')]) {
    assert.equal(rejectRuntime({ $wbEncrypted: 1, envelope }).nativeCalls, 0);
  }
});

test('Runtime rejects unknown envelope suite and fields before native access', () => {
  for (const change of [e => { e.suite = 2; }, e => { e.suite = '1'; },
    e => { e.scheme = 'asym-v1'; }, e => { delete e.nonce; }, e => { e.keyId = 'A'.repeat(16); }]) {
    assert.equal(rejectRuntime(envelopeWith(change)).nativeCalls, 0);
  }
});

test('Runtime requires canonical nonce, tag and ciphertext with exact supported sizes', () => {
  for (const change of [e => { e.nonce = Buffer.alloc(11).toString('base64'); },
    e => { e.authTag = Buffer.alloc(15).toString('base64'); }, e => { e.ciphertext += '\n'; },
    e => { e.nonce = 42; }, e => { e.authTag = 'invalid'; }]) {
    assert.equal(rejectRuntime(envelopeWith(change)).nativeCalls, 0);
  }
});

test('Runtime refuses unknown or malformed native key schemas', () => {
  for (const payload of [null, [], {}, { ...fixture.payload, version: 2 },
    { ...fixture.payload, version: '1' }, { ...fixture.payload, futureCapability: 1 }]) {
    rejectRuntime(fixture.wrapper, payload);
  }
  rejectRuntime(fixture.wrapper, undefined, { rawPayload: '{' });
  rejectRuntime(fixture.wrapper, undefined, { bindingError: true });
});

test('Runtime rejects missing, zero sentinel, noncanonical or wrong-size secret keys', () => {
  for (const secret of [undefined, '', Buffer.alloc(32).toString('base64'),
    Buffer.alloc(31, 0x41).toString('base64'), `${fixture.payload.atRestSecretKey}\n`, 42]) {
    rejectRuntime(fixture.wrapper, { version: 1, atRestSecretKey: secret });
  }
});

test('Runtime refuses a mismatched key ID without attempting ciphertext plaintext', () => {
  const result = rejectRuntime(envelopeWith(e => { e.keyId = '0'.repeat(16); }));
  assert.equal(result.sensitiveBuffers.length, 1);
});

test('GCM integrity failures produce no plaintext and clear key and pending plaintext buffers', () => {
  for (const field of ['nonce', 'authTag', 'ciphertext']) {
    rejectRuntime(envelopeWith(e => {
      const bytes = Buffer.from(e[field], 'base64'); bytes[0] ^= 1; e[field] = bytes.toString('base64');
    }));
  }
});

test('An authenticated different framing context cannot be opened as an access token', () => {
  const incorrectFieldId = fixture.aadHex.slice(0, -6) + '010000';
  rejectRuntime(seal(Buffer.from(fixture.expected), incorrectFieldId));
});

test('Authenticated empty, CR/LF/NUL or invalid UTF8 tokens produce no output', () => {
  for (const bytes of [Buffer.alloc(0), Buffer.from('token\nlog'), Buffer.from('token\rlog'),
    Buffer.from('token\0log'), Buffer.from([0xff, 0xfe])]) rejectRuntime(seal(bytes));
});

const resolvedApp = { exe: 'C:/WorkBuddy/WorkBuddy.exe', asar: 'C:/WorkBuddy/resources/app.asar' };
test('Decoder accepts only the exact encrypted wrapper shape', () => {
  assert.equal(isEncryptedAccessToken(fixture.wrapper), true);
  for (const wrapper of ['token', null, { ...fixture.wrapper, extra: true },
    { ...fixture.wrapper, $wbEncrypted: 2 }, { $wbEncrypted: 1, envelope: 7 }]) assert.equal(isEncryptedAccessToken(wrapper), false);
});

test('Decoder passes sealed input in anonymous stdin and no key, token or envelope in argv/environment', () => {
  let calls = 0;
  const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', resolveExecutable: () => resolvedApp,
    execFileSync(exe, args, options) {
      calls += 1;
      assert.equal(exe, resolvedApp.exe);
      assert.deepEqual(args, ['-e', RUNTIME_SCRIPT]);
      assert.equal(options.input, JSON.stringify(fixture.wrapper));
      assert.equal(options.shell, false);
      assert.equal(options.windowsHide, true);
      assert.deepEqual(options.stdio, ['pipe', 'pipe', 'ignore']);
      assert.equal(options.env.ELECTRON_RUN_AS_NODE, '1');
      assert.equal(options.env.NODE_OPTIONS, '');
      assert.ok(!args.join(' ').includes(fixture.wrapper.envelope));
      assert.ok(!Object.values(options.env).includes(fixture.wrapper.envelope));
      return fixture.expected;
    } });
  assert.equal(decode(fixture.wrapper), fixture.expected);
  assert.equal(calls, 1);
});

test('Decoder preserves required system paths and excludes all unrelated parent environment secrets', () => {
  const required = {
    SystemRoot: 'C:\\Windows', WINDIR: 'C:\\Windows', SystemDrive: 'C:',
    USERPROFILE: 'C:\\Users\\fixture', HOMEDRIVE: 'C:', HOMEPATH: '\\Users\\fixture',
    LOCALAPPDATA: 'C:\\Users\\fixture\\AppData\\Local', APPDATA: 'C:\\Users\\fixture\\AppData\\Roaming',
    TEMP: 'C:\\Temp', TMP: 'C:\\Temp'
  };
  const unrelated = {
    OPENAI_API_KEY: 'dummy-openai-sentinel', ANTHROPIC_API_KEY: 'dummy-anthropic-sentinel',
    ARBITRARY_PROVIDER_SECRET: 'dummy-arbitrary-sentinel',
    PRIVATE_TOKEN_SENTINEL: fixture.expected, PRIVATE_KEY_SENTINEL: fixture.payload.atRestSecretKey,
    PRIVATE_ENVELOPE_SENTINEL: fixture.wrapper.envelope,
    NODE_PATH: 'C:\\UntrustedModules', PATH: 'C:\\UntrustedExecutables',
    ELECTRON_RUN_AS_NODE: '0', NODE_OPTIONS: '--dummy-options-sentinel'
  };
  const injected = { ...required, ...unrelated };
  const previous = Object.fromEntries(Object.keys(injected).map(name => [name, process.env[name]]));
  try {
    for (const [name, value] of Object.entries(injected)) process.env[name] = value;
    const decode = createWorkbuddyCredentialDecoder({ platform: 'win32', resolveExecutable: () => resolvedApp,
      execFileSync(_exe, _args, options) {
        const byUpperCase = Object.fromEntries(Object.entries(options.env).map(([name, value]) => [name.toUpperCase(), value]));
        for (const [name, value] of Object.entries(required)) assert.equal(byUpperCase[name.toUpperCase()], value);
        assert.equal(byUpperCase.ELECTRON_RUN_AS_NODE, '1');
        assert.equal(byUpperCase.NODE_OPTIONS, '');
        assert.equal(Object.keys(byUpperCase).length, Object.keys(required).length + 2);
        for (const [name, value] of Object.entries(unrelated)) {
          if (!['ELECTRON_RUN_AS_NODE', 'NODE_OPTIONS'].includes(name)) assert.equal(byUpperCase[name], undefined);
          assert.ok(!Object.values(options.env).includes(value));
        }
        return fixture.expected;
      } });
    assert.equal(decode(fixture.wrapper), fixture.expected);
  } finally {
    for (const [name, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[name]; else process.env[name] = value;
    }
  }
});

test('Decoder suppresses runtime exceptions, timeout, missing codec and malformed output', () => {
  const base = { platform: 'win32', resolveExecutable: () => resolvedApp };
  for (const execFileSync of [() => { throw Object.assign(new Error('private fixture'), { code: 'ETIMEDOUT' }); },
    () => '', () => 'token\nlog', () => 'token\rlog', () => 'token\0log', () => 'x'.repeat(65537)]) {
    assert.equal(createWorkbuddyCredentialDecoder({ ...base, execFileSync })(fixture.wrapper), null);
  }
  assert.equal(createWorkbuddyCredentialDecoder({ ...base, resolveExecutable: () => null })(fixture.wrapper), null);
});

test('Decoder rejects oversized input and non-Windows platforms without launching anything', () => {
  let calls = 0;
  const execFileSync = () => { calls += 1; return fixture.expected; };
  for (const deps of [{ platform: 'darwin' }, { platform: 'linux' }, { platform: 'win32', maxInputBytes: 16 }]) {
    const decode = createWorkbuddyCredentialDecoder({ ...deps, resolveExecutable: () => resolvedApp, execFileSync });
    assert.equal(decode(fixture.wrapper), null);
  }
  assert.equal(calls, 0);
});

test('Registry discovery continues after a failed uninstall root and resolves a custom install', () => {
  let queries = 0;
  const fs = { lstatSync(file) {
    if (!['C:\\WorkBuddy\\WorkBuddy.exe', 'C:\\WorkBuddy\\resources\\app.asar'].includes(file)) throw new Error('missing');
    return { isFile: () => true, isSymbolicLink: () => false };
  } };
  assert.deepEqual(resolveWorkbuddyExecutable({ platform: 'win32', fs, regExecFileSync() {
    queries += 1;
    if (queries === 1) throw new Error('root unavailable');
    return 'HKEY_LOCAL_MACHINE\\Software\\WorkBuddy\n    DisplayName    REG_SZ    WorkBuddy 5.7.6\n    DisplayIcon    REG_SZ    C:\\WorkBuddy\\WorkBuddy.exe,0\n';
  } }), { exe: 'C:\\WorkBuddy\\WorkBuddy.exe', asar: 'C:\\WorkBuddy\\resources\\app.asar' });
  assert.equal(queries, 2);
});

function authFixture(t, accessToken = fixture.wrapper) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-workbuddy-codec-test-'));
  const authPath = path.join(root, WORKBUDDY_AUTH_FILE_NAME);
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const document = { account: { uid: 'fixture-user', accountType: 'personal' },
    auth: { accessToken, domain: 'copilot.tencent.com', expiresAt: Date.now() + 3600000 } };
  const write = () => fs.writeFileSync(authPath, JSON.stringify(document));
  write();
  let codecCalls = 0, requests = 0;
  const auth = createWorkbuddyLocalAuth({ platform: 'win32', authDirectory: root,
    resolveExecutable: () => resolvedApp,
    execFileSync(_exe, _args, options) {
      codecCalls += 1;
      const result = runRuntime(JSON.parse(options.input));
      if (result.error) throw result.error;
      return result.output;
    },
    fetch: async (_url, init) => {
      requests += 1;
      assert.equal(init.headers.Authorization, `Bearer ${typeof accessToken === 'string' ? accessToken : fixture.expected}`);
      assert.equal(init.redirect, 'error');
      return { ok: true, status: 200 };
    }
  });
  return { root, authPath, document, write, auth, counts: () => ({ codecCalls, requests }) };
}

test('Legacy plaintext app sessions bypass the encrypted codec and still use the allowlisted billing lane', async t => {
  const f = authFixture(t, 'legacy-fixture-token');
  assert.equal(f.auth.getSessionInfo().authenticated, true);
  await f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' });
  assert.deepEqual(f.counts(), { codecCalls: 0, requests: 1 });
});

test('Encrypted sessions expose only metadata and open the original-codec vector just for billing', async t => {
  const f = authFixture(t);
  const before = fs.readFileSync(f.authPath);
  const expected = f.auth.getSessionInfo();
  assert.equal(expected.authenticated, true);
  assert.equal(Object.hasOwn(expected, 'accessToken'), false);
  assert.equal(Object.hasOwn(expected, 'encryptedAccessToken'), false);
  assert.deepEqual(f.counts(), { codecCalls: 0, requests: 0 });
  await f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }, expected);
  assert.deepEqual(f.counts(), { codecCalls: 1, requests: 1 });
  assert.deepEqual(fs.readFileSync(f.authPath), before);
});

test('Encrypted authentication does not decode or request billing after expiry, logout or account switch', async t => {
  const f = authFixture(t);
  const expected = f.auth.getSessionInfo();
  f.document.account.uid = 'different-user'; f.write();
  await assert.rejects(f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }, expected), /session changed/);
  f.document.auth.expiresAt = Date.now() - 60000; f.write();
  await assert.rejects(f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }), e => e.status === 'unauthorized');
  fs.writeFileSync(`${f.authPath}.logged-out`, 'logged-out');
  await assert.rejects(f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }), e => e.status === 'notConfigured');
  assert.deepEqual(f.counts(), { codecCalls: 0, requests: 0 });
});

test('Unknown encrypted format retains the codec-unavailable reason and never reaches cloud billing', async t => {
  const f = authFixture(t, envelopeWith(e => { e.suite = 999; }));
  assert.equal(f.auth.getSessionInfo().authenticated, true);
  await assert.rejects(f.auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }),
    e => e.status === 'unavailable' && e.workbuddySessionReason === 'encrypted');
  assert.deepEqual(f.counts(), { codecCalls: 1, requests: 0 });
});

test('Disallowed billing URLs cannot invoke the credential decoder or transport', async t => {
  const f = authFixture(t);
  for (const url of ['https://example.com/v2/billing/meter/get-user-resource',
    'https://copilot.tencent.com/v2/billing/meter/get-user-resource?redirect=1']) {
    await assert.rejects(f.auth.request(url, { method: 'POST' }), e => e.status === 'unavailable');
  }
  assert.deepEqual(f.counts(), { codecCalls: 0, requests: 0 });
});

test('Encrypted app session changes during the response remain rejected', async t => {
  const f = authFixture(t);
  const auth = createWorkbuddyLocalAuth({ platform: 'win32', authDirectory: f.root,
    decryptAccessToken: () => fixture.expected,
    fetch: async () => {
      f.document.account.uid = 'new-user'; f.write();
      return { ok: true, status: 200 };
    } });
  const expected = auth.getSessionInfo();
  await assert.rejects(auth.request('https://copilot.tencent.com/v2/billing/meter/get-user-resource', { method: 'POST' }, expected), /session changed/);
});
