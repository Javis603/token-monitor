'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough, Writable } = require('node:stream');
const test = require('node:test');

const {
  parseScutilProxy,
  readMacSystemProxy,
  primeMacSystemProxy,
  withSystemProxyEnv,
  resetSystemProxyCacheForTests
} = require('../../src/shared/systemProxyEnv');
const { fetchGrokRpcBilling } = require('../../src/shared/grokLimits');

function fakeScutilSpawn(output) {
  return (command, args) => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    if (command === 'scutil' && args[0] === '--proxy') {
      child.stdout.end(output);
    } else {
      child.stdout.end('');
    }
    setImmediate(() => child.emit('close', 0));
    return child;
  };
}

const CLASH_OUTPUT = [
  '<dictionary> {',
  '  HTTPEnable : 1',
  '  HTTPProxy : 127.0.0.1',
  '  HTTPPort : 7890',
  '  HTTPSEnable : 1',
  '  HTTPSProxy : 127.0.0.1',
  '  HTTPSPort : 7890',
  '  SOCKSEnable : 1',
  '  SOCKSProxy : 127.0.0.1',
  '  SOCKSPort : 7890',
  '}'
].join('\n');

const CLASH_PROXY = 'http://127.0.0.1:7890';

test('parseScutilProxy prefers the HTTPS proxy when enabled', () => {
  assert.equal(parseScutilProxy(CLASH_OUTPUT), CLASH_PROXY);
});

test('parseScutilProxy falls back to HTTP then SOCKS', () => {
  const httpOnly = CLASH_OUTPUT
    .replace('  HTTPSEnable : 1', '  HTTPSEnable : 0')
    .replace('  SOCKSEnable : 1', '  SOCKSEnable : 0');
  assert.equal(parseScutilProxy(httpOnly), CLASH_PROXY);
  const socksOnly = CLASH_OUTPUT
    .replace('  HTTPEnable : 1', '  HTTPEnable : 0')
    .replace('  HTTPSEnable : 1', '  HTTPSEnable : 0');
  assert.equal(parseScutilProxy(socksOnly), 'socks5://127.0.0.1:7890');
});

test('parseScutilProxy returns empty when every proxy is disabled', () => {
  const off = CLASH_OUTPUT
    .replace(/ {2}HTTPEnable : 1/, '  HTTPEnable : 0')
    .replace(/ {2}HTTPSEnable : 1/, '  HTTPSEnable : 0')
    .replace(/ {2}SOCKSEnable : 1/, '  SOCKSEnable : 0');
  assert.equal(parseScutilProxy(off), '');
  assert.equal(parseScutilProxy(''), '');
});

test('readMacSystemProxy resolves the scutil dictionary on darwin', async () => {
  resetSystemProxyCacheForTests();
  const value = await readMacSystemProxy({ spawn: fakeScutilSpawn(CLASH_OUTPUT), platform: 'darwin' });
  assert.equal(value, CLASH_PROXY);
});

test('readMacSystemProxy resolves empty off darwin', async () => {
  resetSystemProxyCacheForTests();
  const value = await readMacSystemProxy({ spawn: fakeScutilSpawn(CLASH_OUTPUT), platform: 'linux' });
  assert.equal(value, '');
});

test('withSystemProxyEnv injects the primed proxy when no env proxy exists', async () => {
  resetSystemProxyCacheForTests();
  await primeMacSystemProxy({ spawn: fakeScutilSpawn(CLASH_OUTPUT), platform: 'darwin' });
  const merged = withSystemProxyEnv({ PATH: '/usr/bin:/bin' });
  assert.equal(merged.HTTPS_PROXY, CLASH_PROXY);
  assert.equal(merged.https_proxy, CLASH_PROXY);
  assert.equal(merged.HTTP_PROXY, CLASH_PROXY);
  assert.equal(merged.http_proxy, CLASH_PROXY);
  assert.equal(merged.ALL_PROXY, CLASH_PROXY);
  assert.equal(merged.PATH, '/usr/bin:/bin');
  resetSystemProxyCacheForTests();
});

test('withSystemProxyEnv leaves an explicit env proxy untouched', () => {
  resetSystemProxyCacheForTests();
  const merged = withSystemProxyEnv(
    { HTTPS_PROXY: 'http://10.0.0.2:8123', PATH: '/usr/bin' },
    { cachedSystemProxy: CLASH_PROXY }
  );
  assert.equal(merged.HTTPS_PROXY, 'http://10.0.0.2:8123');
  assert.equal(merged.HTTP_PROXY, undefined);
});

test('withSystemProxyEnv preserves lowercase env precedence over the OS proxy', () => {
  const merged = withSystemProxyEnv(
    { https_proxy: 'http://10.0.0.3:8123' },
    { cachedSystemProxy: CLASH_PROXY }
  );
  assert.equal(merged.https_proxy, 'http://10.0.0.3:8123');
  assert.equal(merged.HTTPS_PROXY, undefined);
});

test('withSystemProxyEnv carries NO_PROXY through with the injected proxy', () => {
  const merged = withSystemProxyEnv(
    { NO_PROXY: 'localhost,127.0.0.1' },
    { cachedSystemProxy: CLASH_PROXY }
  );
  assert.equal(merged.NO_PROXY, 'localhost,127.0.0.1');
  assert.equal(merged.HTTPS_PROXY, CLASH_PROXY);
});

test('withSystemProxyEnv is a no-op before the cache is primed', () => {
  resetSystemProxyCacheForTests();
  const merged = withSystemProxyEnv({ PATH: '/usr/bin' });
  assert.equal(merged.HTTPS_PROXY, undefined);
  assert.deepEqual(merged, { PATH: '/usr/bin' });
});

test('withSystemProxyEnv is a no-op when the OS proxy is disabled', async () => {
  resetSystemProxyCacheForTests();
  await primeMacSystemProxy({ spawn: fakeScutilSpawn('  HTTPEnable : 0\n  HTTPSEnable : 0\n  SOCKSEnable : 0\n'), platform: 'darwin' });
  const merged = withSystemProxyEnv({ PATH: '/usr/bin' });
  assert.equal(merged.HTTPS_PROXY, undefined);
  resetSystemProxyCacheForTests();
});

test('withSystemProxyEnv survives an scutil failure without injecting', async () => {
  resetSystemProxyCacheForTests();
  const failingSpawn = () => {
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    setImmediate(() => child.emit('error', new Error('scutil missing')));
    return child;
  };
  await primeMacSystemProxy({ spawn: failingSpawn, platform: 'darwin' });
  const merged = withSystemProxyEnv({ PATH: '/usr/bin' });
  assert.equal(merged.HTTPS_PROXY, undefined);
  resetSystemProxyCacheForTests();
});

function fakeGrokRpcSpawn(envCapture) {
  return (command, args, options = {}) => {
    if (envCapture) envCapture.options = options;
    const child = new EventEmitter();
    child.stdout = new PassThrough();
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

test('fetchGrokRpcBilling spawns the CLI with the primed OS proxy injected', async () => {
  const cliEnv = {};
  const body = await fetchGrokRpcBilling({}, {
    env: { PATH: '/usr/bin:/bin' },
    cachedSystemProxy: CLASH_PROXY,
    spawn: fakeGrokRpcSpawn(cliEnv),
    rpcTimeoutMs: 500
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(cliEnv.options.env.HTTPS_PROXY, CLASH_PROXY);
  assert.equal(cliEnv.options.env.PATH, '/usr/bin:/bin');
});

test('fetchGrokRpcBilling keeps an explicit env proxy verbatim', async () => {
  const cliEnv = {};
  const body = await fetchGrokRpcBilling({}, {
    env: { PATH: '/usr/bin:/bin', HTTPS_PROXY: 'http://10.0.0.9:8123' },
    spawn: fakeGrokRpcSpawn(cliEnv),
    rpcTimeoutMs: 500
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(cliEnv.options.env.HTTPS_PROXY, 'http://10.0.0.9:8123');
});

test('fetchGrokRpcBilling can opt out of the system proxy injection', async () => {
  const cliEnv = {};
  const body = await fetchGrokRpcBilling({}, {
    env: { PATH: '/usr/bin:/bin' },
    systemProxyEnv: false,
    cachedSystemProxy: CLASH_PROXY,
    spawn: fakeGrokRpcSpawn(cliEnv),
    rpcTimeoutMs: 500
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(cliEnv.options.env.HTTPS_PROXY, undefined);
});

test('fetchGrokRpcBilling without a primed proxy spawns with the env unchanged', async () => {
  const cliEnv = {};
  const body = await fetchGrokRpcBilling({}, {
    env: { PATH: '/usr/bin:/bin' },
    spawn: fakeGrokRpcSpawn(cliEnv),
    rpcTimeoutMs: 500
  });
  assert.equal(body.monthlyLimit.val, 10000);
  assert.equal(cliEnv.options.env.HTTPS_PROXY, undefined);
});
