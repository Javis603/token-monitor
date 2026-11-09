'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  GROK_WEB_BILLING_GRPC_URL,
  resolveGrokHome,
  resolveGrokCredential,
  withGrokPathHints,
  grokRpcCommand,
  isRetryableNetworkError,
  validateGrokGrpcStatus
} = require('../../src/shared/providers/grok/limits');
const {
  grokCredential,
  readAuthJson,
  parseGrokBilling,
  parseGrokGrpcWebBilling,
  fetchGrokRpcBilling,
  fetchGrokLimits,
  parseLimitProviders
} = require('../../src/shared/limits/collector');

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

function fakeGrokRpcSpawn(assertArgs = ['agent', 'stdio'], assertCommand = 'grok') {
  return (command, args) => {
    assert.equal(command, assertCommand);
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
  const providers = parseLimitProviders();
  assert.ok(providers.includes('grok'));
  assert.ok(providers.includes('ollama'));
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

test('resolveGrokCredential selects the newest native or running-WSL auth.json on Windows', async () => {
  const nativePath = path.join(os.homedir(), '.grok', 'auth.json');
  const wslHomeRoot = '\\\\wsl$\\Ubuntu\\home';
  const wslPath = `${wslHomeRoot}\\alice\\.grok\\auth.json`;
  const rootPath = '\\\\wsl$\\Ubuntu\\root\\.grok\\auth.json';
  const credential = await resolveGrokCredential({}, {}, {
    platform: 'win32',
    listRunningWslDistros: () => ['Ubuntu'],
    readdirSync: (target) => {
      assert.equal(target, wslHomeRoot);
      return ['alice'];
    },
    stat: async (target) => {
      if (target === nativePath) return { mtimeMs: 100 };
      if (target === wslPath) return { mtimeMs: 200 };
      if (target === rootPath) throw Object.assign(new Error('missing'), { code: 'ENOENT' });
      throw new Error(`unexpected stat: ${target}`);
    },
    readFileSync: (target) => {
      if (target === nativePath) return JSON.stringify({ 'https://auth.x.ai::client': { key: 'native-token' } });
      if (target === wslPath) return JSON.stringify({ 'https://auth.x.ai::client': { key: 'wsl-token' } });
      throw new Error(`unexpected read: ${target}`);
    }
  });

  assert.equal(credential.token, 'wsl-token');
  assert.equal(credential.path, wslPath);
  assert.equal(credential.wsl, true);
});

test('resolveGrokCredential keeps explicit GROK_HOME ahead of WSL discovery', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-explicit-home-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'explicit-home-token' } });
  const credential = await resolveGrokCredential({ GROK_HOME: home }, {}, {
    platform: 'win32',
    listRunningWslDistros: () => {
      throw new Error('WSL discovery should not run for explicit GROK_HOME');
    }
  });

  assert.equal(credential.token, 'explicit-home-token');
  assert.equal(credential.wsl, undefined);
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

test('grokRpcCommand honours explicit commands without changing their environment', () => {
  const env = { GROK_CLI_PATH: ' "/env/grok" ', PATH: '/original/bin' };
  assert.equal(grokRpcCommand(env, { grokCommand: ' "/opt/custom/grok" ' }), '/opt/custom/grok');
  assert.equal(grokRpcCommand(env), '/env/grok');
  assert.strictEqual(withGrokPathHints(env), env);
  const customEnv = {};
  assert.strictEqual(withGrokPathHints(customEnv, { grokCommand: '/custom/grok' }), customEnv);
});

test('withGrokPathHints appends install directories without rewriting the original PATH', () => {
  const env = { PATH: './tools::/dir with spaces:/usr/bin:', HOME: '/Users/alice' };
  const result = withGrokPathHints(env, {}, { platform: 'darwin' });
  assert.equal(result.PATH, env.PATH + ':/Users/alice/.grok/bin:/Users/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.deepEqual(env, { PATH: './tools::/dir with spaces:/usr/bin:', HOME: '/Users/alice' });
});

test('withGrokPathHints distinguishes missing PATH from an intentionally empty PATH', () => {
  const deps = { platform: 'darwin', homeDir: '/Users/alice' };
  assert.equal(withGrokPathHints({}, {}, deps).PATH,
    '/usr/bin:/bin:/Users/alice/.grok/bin:/Users/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin');
  assert.equal(withGrokPathHints({ PATH: '' }, {}, deps).PATH,
    ':/Users/alice/.grok/bin:/Users/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin');
});

test('withGrokPathHints uses native home rules with an OS fallback and explicit test homes', () => {
  const env = { HOME: '/home/alice', USERPROFILE: '/other/home' };
  assert.equal(withGrokPathHints(env, {}, { platform: 'linux' }).PATH,
    '/usr/bin:/bin:/home/alice/.grok/bin:/home/alice/.local/bin:/opt/homebrew/bin:/usr/local/bin');
  const pathApi = process.platform === 'win32' ? path.win32 : path.posix;
  const pathKey = Object.keys(withGrokPathHints({})).find((key) => key.toLowerCase() === 'path');
  assert.ok(withGrokPathHints({})[pathKey].split(path.delimiter).includes(pathApi.join(os.homedir(), '.grok', 'bin')));
  assert.ok(withGrokPathHints({}, { homeDir: '/options' }, { platform: 'linux', homeDir: '/deps' }).PATH.includes('/deps/.grok/bin'));
});

test('withGrokPathHints preserves one Windows Path key and prioritizes USERPROFILE over HOME', () => {
  const env = { Path: 'D:\\Tools', USERPROFILE: 'C:\\Users\\alice', HOME: 'D:\\MSYSHome' };
  const result = withGrokPathHints(env, {}, { platform: 'win32' });
  assert.equal(result.Path, 'D:\\Tools;C:\\Users\\alice\\.grok\\bin;C:\\Users\\alice\\.local\\bin');
  assert.equal(Object.hasOwn(result, 'PATH'), false);
  const duplicate = withGrokPathHints({ ...env, PATH: 'C:\\First' }, {}, { platform: 'win32' });
  assert.deepEqual(Object.keys(duplicate).filter((key) => key.toLowerCase() === 'path'), ['PATH']);
  assert.ok(duplicate.PATH.startsWith('C:\\First;'));
  assert.deepEqual(env, { Path: 'D:\\Tools', USERPROFILE: 'C:\\Users\\alice', HOME: 'D:\\MSYSHome' });
});

test('withGrokPathHints preserves Windows inherited PATH when a custom env omits it', () => {
  const inheritedKey = Object.keys(process.env).find((key) => key.toLowerCase() === 'path');
  const inherited = inheritedKey === undefined ? undefined : process.env[inheritedKey];
  const result = withGrokPathHints({}, {}, { platform: 'win32', homeDir: 'C:\\Users\\alice' });
  assert.equal(result.PATH, [...(inherited === undefined ? [] : [inherited]),
    'C:\\Users\\alice\\.grok\\bin', 'C:\\Users\\alice\\.local\\bin'].join(';'));
});

test('fetchGrokRpcBilling speaks Grok agent stdio x.ai/billing JSON-RPC', async () => {
  const body = await fetchGrokRpcBilling({}, {
    env: {},
    homeDir: '',
    spawn: fakeGrokRpcSpawn(),
    rpcTimeoutMs: 100
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(body.usage.totalUsed.val, 4200);
});

function createNativeGrokRpcFixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-rpc-path-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const script = path.join(root, 'billing.cjs');
  fs.writeFileSync(script, `
    const readline = require('node:readline');
    readline.createInterface({ input: process.stdin }).on('line', (line) => {
      const request = JSON.parse(line);
      const result = request.method === 'initialize' ? {} : {
        executable: process.execPath,
        rpcArgs: process.argv.slice(2),
        monthlyLimit: { val: 10000 }, usage: { totalUsed: { val: 4200 } }
      };
      process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\\n');
    });
  `);
  function install(directory) {
    fs.mkdirSync(directory, { recursive: true });
    const executable = path.join(directory, process.platform === 'win32' ? 'grok.exe' : 'grok');
    fs.copyFileSync(process.execPath, executable, fs.constants.COPYFILE_FICLONE);
    return fs.realpathSync(executable);
  }
  async function run(pathValue, options = {}, extraEnv = {}) {
    const env = { ...process.env, HOME: root, USERPROFILE: root };
    for (const key of Object.keys(env)) {
      if (key.toLowerCase() === 'path' || key === 'GROK_CLI_PATH') delete env[key];
    }
    if (pathValue !== undefined) env[process.platform === 'win32' ? 'Path' : 'PATH'] = pathValue;
    Object.assign(env, extraEnv);
    let closed;
    try {
      return await fetchGrokRpcBilling({ grokRpcArgs: [script, 'fixture'], ...options }, {
        env,
        rpcTimeoutMs: 5000,
        spawn: (command, args, init) => {
          const child = spawn(command, args, { ...init, cwd: root });
          closed = new Promise((resolve) => child.once('close', resolve));
          return child;
        }
      });
    } finally {
      await closed;
    }
  }
  return { root, install, run };
}

test('fetchGrokRpcBilling resolves a real native CLI through the child PATH', async (t) => {
  const fixture = createNativeGrokRpcFixture(t);
  const homeCli = fixture.install(path.join(fixture.root, '.grok', 'bin'));
  const originalDir = path.join(fixture.root, 'original tools');
  const originalCli = fixture.install(originalDir);
  const customCli = fixture.install(path.join(fixture.root, 'custom tools'));
  const cwdCli = process.platform === 'win32' ? null : fixture.install(fixture.root);

  await t.test('GUI PATH omits the installed CLI', async () => {
    const body = await fixture.run(path.join(fixture.root, 'missing'));
    assert.equal(body.executable, homeCli);
    assert.deepEqual(body.rpcArgs, ['fixture']);
    assert.equal(body.usage.totalUsed.val, 4200);
  });
  await t.test('original PATH wins over the home installation', async () => {
    assert.equal((await fixture.run(originalDir)).executable, originalCli);
  });
  await t.test('relative PATH keeps its precedence', async () => {
    assert.equal((await fixture.run(path.relative(fixture.root, originalDir))).executable, originalCli);
  });
  await t.test('explicit options command overrides the environment and PATH', async () => {
    assert.equal((await fixture.run(originalDir, { grokCommand: customCli }, { GROK_CLI_PATH: homeCli })).executable, customCli);
  });
  await t.test('GROK_CLI_PATH overrides PATH', async () => {
    assert.equal((await fixture.run(originalDir, {}, { GROK_CLI_PATH: customCli })).executable, customCli);
  });
  await t.test('Windows spawn receives one PATH key and uses USERPROFILE', {
    skip: process.platform !== 'win32' && 'Windows native executable lookup'
  }, async () => {
    assert.equal((await fixture.run(path.dirname(homeCli), {}, { PATH: originalDir })).executable, originalCli);
    assert.equal((await fixture.run(path.join(fixture.root, 'missing'), {}, {
      HOME: path.join(fixture.root, 'other-home')
    })).executable, homeCli);
  });
  await t.test('missing PATH does not introduce a current-directory search on POSIX', {
    skip: process.platform === 'win32' && 'Windows natively searches the current directory'
  }, async () => {
    assert.equal((await fixture.run(undefined)).executable, homeCli);
  });
  await t.test('explicitly empty PATH retains current-directory search on POSIX', {
    skip: process.platform === 'win32' && 'POSIX empty PATH semantics'
  }, async () => {
    assert.equal((await fixture.run('')).executable, cwdCli);
  });
  await t.test('a CLI symlink on PATH remains usable on POSIX', {
    skip: process.platform === 'win32' && 'POSIX symlink fixture'
  }, async () => {
    const links = path.join(fixture.root, 'links');
    fs.mkdirSync(links);
    fs.symlinkSync(originalCli, path.join(links, 'grok'));
    assert.equal((await fixture.run(links)).executable, originalCli);
  });
  await t.test('non-executable files and directories do not block a later CLI on POSIX', {
    skip: process.platform === 'win32' && 'POSIX executable permissions'
  }, async () => {
    const blocked = path.join(fixture.root, 'blocked');
    const directory = path.join(fixture.root, 'directory');
    fs.mkdirSync(blocked);
    fs.writeFileSync(path.join(blocked, 'grok'), 'not executable', { mode: 0o644 });
    fs.mkdirSync(path.join(directory, 'grok'), { recursive: true });
    assert.equal((await fixture.run([blocked, directory, originalDir].join(path.delimiter))).executable, originalCli);
  });
});

test('fetchGrokRpcBilling kills the CLI when the parent signal aborts', async () => {
  const controller = new AbortController();
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = () => { killed = true; };

  const pending = fetchGrokRpcBilling({}, {
    env: {},
    signal: controller.signal,
    spawn: () => child,
    rpcTimeoutMs: 60_000
  });
  controller.abort(new Error('stop grok probe'));

  await assert.rejects(pending, /stop grok probe/);
  assert.equal(killed, true);
});

test('fetchGrokRpcBilling rejects when the CLI stdin pipe breaks', async () => {
  let killed = false;
  const child = new EventEmitter();
  child.stdout = new PassThrough();
  child.stderr = new PassThrough();
  child.stdin = new Writable({ write(_chunk, _encoding, callback) { callback(); } });
  child.kill = () => { killed = true; };
  const pending = fetchGrokRpcBilling({}, {
    env: {},
    spawn: () => child,
    rpcTimeoutMs: 60_000
  });
  const error = Object.assign(new Error('write EPIPE'), { code: 'EPIPE' });

  child.stdin.emit('error', error);

  await assert.rejects(pending, /write EPIPE/);
  assert.equal(killed, true);
});

test('fetchGrokLimits does not start web fallback after the RPC parent signal aborts', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-abort-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'eyJsecret.signature' } });
  const controller = new AbortController();
  let webCalls = 0;
  const pending = fetchGrokLimits({}, {
    env: {},
    grokHome: home,
    signal: controller.signal,
    fetchRpcBilling: async () => {
      controller.abort(new Error('grok probe superseded'));
      throw new Error('RPC aborted');
    },
    fetchWebGrpcBilling: async () => {
      webCalls += 1;
      return [];
    }
  });

  await assert.rejects(pending, /grok probe superseded/);
  assert.equal(webCalls, 0);
});

test('fetchGrokLimits preserves cancellation after a successful web billing read', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-web-abort-'));
  writeAuthJson(home, { 'https://auth.x.ai::client': { key: 'eyJsecret.signature' } });
  const controller = new AbortController();

  await assert.rejects(fetchGrokLimits({}, {
    env: {},
    grokHome: home,
    signal: controller.signal,
    fetchRpcBilling: async () => {
      throw new Error('RPC unavailable');
    },
    fetchWebGrpcBilling: async () => {
      controller.abort(new Error('web result superseded'));
      return [];
    }
  }), /web result superseded/);
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

test('fetchGrokLimits uses a WSL auth.json without requiring a Windows Grok CLI', async () => {
  const wslHomeRoot = '\\\\wsl$\\Ubuntu\\home';
  const wslPath = `${wslHomeRoot}\\alice\\.grok\\auth.json`;
  let webCredential = null;
  const result = await fetchGrokLimits({}, {
    env: {},
    platform: 'win32',
    listRunningWslDistros: () => ['Ubuntu'],
    readdirSync: () => ['alice'],
    stat: async (target) => {
      if (target === wslPath) return { mtimeMs: 200 };
      throw Object.assign(new Error('missing'), { code: 'ENOENT' });
    },
    readFileSync: (target) => {
      assert.equal(target, wslPath);
      return JSON.stringify({
        'https://auth.x.ai::client': { key: 'wsl-token', email: 'wsl@example.com' }
      });
    },
    spawn: () => {
      throw new Error('Windows Grok CLI should not run for a WSL credential');
    },
    fetchWebGrpcBilling: async (credential) => {
      webCredential = credential;
      return [{
        kind: 'billing',
        label: 'Monthly',
        usedPercent: 42,
        resetsAt: '2026-09-01T00:00:00.000Z',
        showMeter: true
      }];
    }
  });

  assert.equal(webCredential.token, 'wsl-token');
  assert.equal(result.status, 'ok');
  assert.equal(result.source, 'web');
  assert.equal(result.accountEmail, 'wsl@example.com');
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

function oidcToken(claims, signature = 'signature') {
  return `${Buffer.from(JSON.stringify({ alg: 'RS256' })).toString('base64url')}.${Buffer.from(JSON.stringify(claims)).toString('base64url')}.${signature}`;
}

async function identityReading(token, source, email = 'same@example.test', now = Date.UTC(2026, 10, 9, 9)) {
  const billing = { creditUsagePercent: 0, currentPeriod: { start: '2026-11-03T00:00:00Z', end: '2026-11-10T00:00:00Z' } };
  return fetchGrokLimits({}, {
    env: {}, now: () => now, grokHome: path.join(os.tmpdir(), 'grok-identity-fixture'),
    readFileSync: () => JSON.stringify({ 'https://auth.x.ai::fixture': { key: token, email } }),
    fetchRpcBilling: async () => { if (source === 'web') throw new Error('RPC unavailable'); return billing; },
    fetch: async () => ({ status: 200, ok: true, arrayBuffer: async () => arrayBufferFrom(grpcFrame(
      billingCycleProtobufPayload({ usedPercent: 0, startEpoch: Date.UTC(2026, 10, 3) / 1000, endEpoch: Date.UTC(2026, 10, 10) / 1000 })
    )) })
  });
}

for (const source of ['rpc', 'web']) {
  test(`Grok ${source} identity survives OIDC rotation and separates subjects sharing an email`, async () => {
    const claims = { iss: 'https://auth.x.ai', sub: 'user-a', iat: 1, jti: 'first' };
    const first = await identityReading(oidcToken(claims), source);
    const rotated = await identityReading(oidcToken({ ...claims, iat: 2, jti: 'second' }, 'rotated'), source, 'renamed@example.test');
    const other = await identityReading(oidcToken({ ...claims, sub: 'user-b' }), source);
    assert.equal(first.status, 'ok');
    assert.equal(first.source, source);
    assert.equal(rotated.accountKey, first.accountKey);
    assert.notEqual(other.accountKey, first.accountKey);
  });

  test(`Grok ${source} unknown and malformed identities retain isolated token keys`, async () => {
    const { hashKey } = require('../../src/shared/hashKey');
    const identity = oidcToken({ iss: 'https://auth.x.ai', sub: 'user-a' }).split('.').slice(1).join('.');
    const malformedHeaders = ['a', ...[null, [], {}, { alg: null }, { alg: '' }, { alg: 'none' }].map(header => Buffer.from(JSON.stringify(header)).toString('base64url'))];
    const tokens = [...malformedHeaders.map(header => `${header}.${identity}`), 'opaque-token', 'a.invalid!.c', 'a.b.c', oidcToken(null), oidcToken([]),
      ...[undefined, null, '', ' ', 12, {}, []].map(sub => oidcToken({ iss: 'https://auth.x.ai', sub })),
      ...[undefined, null, '', 'https://other.test', 12, {}].map(iss => oidcToken({ iss, sub: 'user-a' }))];
    for (const token of tokens) {
      const row = await identityReading(token, source);
      assert.equal(row.accountKey, hashKey('grok', token));
    }
  });

  test(`Grok ${source} rotated records keep one SQLite history segment at 100% remaining`, async t => {
    const { createLimitsHistoryStore } = require('../../src/electron/limits/historyStore');
    const { segments } = require('../../src/electron/renderer/limits/historyModel');
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'grok-identity-'));
    const start = Date.UTC(2026, 10, 9, 9);
    const errors = [];
    const store = createLimitsHistoryStore(path.join(directory, 'history.sqlite'), { now: () => start + 300000, onError: e => errors.push(e) });
    t.after(async () => { await store.close(); fs.rmSync(directory, { recursive: true, force: true }); });
    let latest;
    for (let i = 0; i < 2; i++) {
      latest = await identityReading(oidcToken({ iss: 'https://auth.x.ai', sub: 'user-a', iat: i }), source, '', start + i * 300000);
      await store.record('fixture', { providers: [latest] });
    }
    const result = await store.query('fixture', latest);
    assert.equal(result.persistent, true);
    assert.deepEqual(errors, []);
    assert.deepEqual(segments(result.windows[0].points).map(run => run.map(p => [p.at, 100 - p.value])),
      [[[start, 100], [start + 300000, 100]]]);
    const other = await identityReading(oidcToken({ iss: 'https://auth.x.ai', sub: 'user-b' }), source, '', start + 300000);
    assert.deepEqual((await store.query('fixture', other)).windows[0].points, []);
  });
}
