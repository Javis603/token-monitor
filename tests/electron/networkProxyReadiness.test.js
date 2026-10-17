'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const proxy = require('../../src/electron/networkProxy');
const { createClaudeWebFetch } = require('../../src/electron/providers/claude/webFetch');
const { createElectronLimitsFetch } = require('../../src/electron/limits/fetch');
const { createMimoExchangeFetch } = require('../../src/electron/providers/mimo/exchangeFetch');
const { createLimitsRuntime } = require('../../src/shared/limits/runtime');

const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
const flush = () => new Promise((resolve) => setImmediate(resolve));

function deferred() {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

function harness(settings, setProxy, closeAllConnections = async () => {}) {
  const sent = [];
  const applied = [];
  let route = 'system';
  const session = { defaultSession: {
    async setProxy(config) { applied.push(config); await setProxy(config); route = config.proxyRules || 'system'; },
    closeAllConnections,
    async resolveProxy(url) { sent.push({ kind: 'resolve', url, route }); return 'DIRECT'; }
  } };
  const net = {
    async fetch(url, init) { sent.push({ kind: 'fetch', url, init, route }); return 'fetched'; },
    request(options) {
      const request = new EventEmitter();
      const headers = {};
      request.setHeader = (name, value) => { headers[name] = value; };
      request.abort = () => {};
      request.end = () => {
        sent.push({ kind: 'request', url: options.url, headers, route });
        process.nextTick(() => {
          const response = new EventEmitter();
          response.statusCode = 503;
          response.headers = {};
          request.emit('response', response);
          response.emit('end');
        });
      };
      return request;
    }
  };
  const context = vm.createContext({
    ...proxy, createClaudeWebFetch, createElectronLimitsFetch,
    createMimoExchangeFetch: (options) => createMimoExchangeFetch({ ...options,
      fetch: async (url) => { sent.push({ kind: 'mimo-request', url, route }); return 'exchanged'; }
    }),
    settings, process: { env: {} }, console: { log() {} }, session, net
  });
  // Execute the actual main-process transport wiring, including the lazy
  // callback used by transports constructed before sessionProxy is declared.
  const web = main.match(/^const electronClaudeWebFetch = .+;$/m)[0];
  const wiring = main.slice(main.indexOf('function electronLimitsFetch() {'), main.indexOf('function electronProviderDeps('));
  vm.runInContext(`${web}\n${wiring}`, context);
  return { context, sent, applied,
    apply: () => vm.runInContext('sessionProxy.apply()', context),
    web: (init) => vm.runInContext('electronClaudeWebFetch', context)('https://claude.ai/api/organizations', init),
    limits: () => vm.runInContext('electronLimitsFetch()', context),
    mimo: () => vm.runInContext('ensureMimoExchangeFetch()', context)
  };
}

for (const proxyUrl of ['http://127.0.0.1:7897', 'socks5://invalid']) {
  test(`Claude runtime waits for the session route at startup (${proxyUrl})`, async (t) => {
    const pending = deferred();
    const h = harness({ proxyUrl }, () => pending.promise);
    const startupApply = h.apply();
    const runtime = createLimitsRuntime({
      limitProviders: ['claude'], claudeWebCookie: 'sessionKey=sk-ant-synthetic-test-only', claudePrepaidBalanceEnabled: false
    }, {
      autoStart: false, autoRetry: false, env: {},
      claudeWebFetch: vm.runInContext('electronClaudeWebFetch', h.context),
      fetch: h.limits(), providerRuntimeState: new Map()
    });
    t.after(() => runtime.stop());
    const polling = runtime.refresh({ provider: 'claude' }, 'startup');
    await flush();
    assert.equal(h.sent.length, 0, 'no synthetic Cookie leaves net.request.end before setProxy settles');
    pending.resolve();
    await startupApply;
    await polling;
    assert.ok(h.sent.some((item) => item.kind === 'request'), 'the real collector reaches Claude Web');
    assert.equal(h.sent.find((item) => item.kind === 'request').headers.cookie, 'sessionKey=sk-ant-synthetic-test-only');
    const expected = proxyUrl.startsWith('http:') ? proxyUrl : 'http://proxy.invalid:1';
    assert.ok(h.sent.every((item) => item.route === expected));
  });

  test(`a rejected startup apply blocks the Claude runtime and preserves retries (${proxyUrl})`, async (t) => {
    const pending = deferred();
    let failing = true;
    const h = harness({ proxyUrl }, () => failing ? pending.promise : undefined);
    const startupApply = h.apply();
    const runtime = createLimitsRuntime({
      limitProviders: ['claude'], claudeWebCookie: 'sessionKey=sk-ant-synthetic-test-only', claudePrepaidBalanceEnabled: false
    }, {
      autoStart: false, autoRetry: false, env: {},
      claudeWebFetch: vm.runInContext('electronClaudeWebFetch', h.context), fetch: h.limits(),
      providerRuntimeState: new Map()
    });
    t.after(() => runtime.stop());
    const polling = runtime.refresh({ provider: 'claude' }, 'startup');
    await flush();
    pending.reject(new Error('injected startup setProxy failure'));
    assert.equal(await startupApply, false);
    await polling;
    assert.equal(h.sent.length, 0);
    assert.equal(runtime.getSnapshot().providers[0].status, 'unavailable');
    failing = false;
    await runtime.refresh({ provider: 'claude' }, 'settings-change');
    assert.ok(h.sent.some((item) => item.kind === 'request'));
    const expected = proxyUrl.startsWith('http:') ? proxyUrl : 'http://proxy.invalid:1';
    assert.ok(h.sent.every((item) => item.route === expected));
  });
}

test('failed setProxy blocks Claude requests and a later request can retry', async () => {
  let failing = true;
  const h = harness({ proxyUrl: 'http://127.0.0.1:7897' }, async () => {
    if (failing) throw new Error('injected setProxy failure');
  });
  assert.equal(await h.apply(), false);
  await assert.rejects(h.web({ headers: { Cookie: 'synthetic-test-only' } }), /proxy_session_not_ready/);
  assert.equal(h.sent.length, 0);
  failing = false;
  await h.web();
  assert.equal(h.sent.length, 1);
  assert.equal(h.sent[0].route, 'http://127.0.0.1:7897');
});

test('failed pooled-connection cleanup also blocks requests until retried', async () => {
  let failing = true;
  const h = harness({ proxyUrl: 'http://127.0.0.1:7897' }, async () => {}, async () => {
    if (failing) throw new Error('injected close failure');
  });
  await assert.rejects(h.web(), /proxy_session_not_ready/);
  assert.equal(h.sent.length, 0);
  failing = false;
  await h.web();
  assert.equal(h.applied.length, 1, 'only the failed cleanup is retried');
});

test('clearing the app proxy gates net.fetch and MiMo resolution until system routing is restored', async () => {
  const clear = deferred();
  const settings = { proxyUrl: 'http://127.0.0.1:7897' };
  const h = harness(settings, (config) => config.mode === 'system' ? clear.promise : undefined);
  await h.apply();
  settings.proxyUrl = '';
  const fetching = h.limits()('https://example.com/usage');
  const exchanging = h.mimo()('https://example.com/').catch(() => {});
  await flush();
  assert.equal(h.sent.length, 0);
  // Avoid a real MiMo network request after resolveProxy, while keeping the
  // production transport's route-resolution branch in this regression.
  h.context.session.defaultSession.resolveProxy = async (url) => {
    h.sent.push({ kind: 'resolve', url, route: 'system' });
    throw new Error('stop after route resolution');
  };
  clear.resolve();
  await Promise.all([fetching, exchanging]);
  assert.deepEqual(h.sent.map((item) => item.kind).sort(), ['fetch', 'resolve']);
  assert.ok(h.sent.every((item) => item.route === 'system'));
});

test('without an app setting Chromium requests work without touching the session', async () => {
  const h = harness({}, () => { throw new Error('must not setProxy'); });
  await h.web();
  await h.limits()('https://example.com/usage');
  assert.equal(h.applied.length, 0);
  assert.deepEqual(h.sent.map((item) => item.kind), ['request', 'fetch']);
});

test('an aborted readiness wait never sends the deferred request', async () => {
  const pending = deferred();
  const h = harness({ proxyUrl: 'http://127.0.0.1:7897' }, () => pending.promise);
  const controller = new AbortController();
  const request = h.web({ signal: controller.signal });
  await flush();
  controller.abort();
  await assert.rejects(request, { name: 'AbortError' });
  pending.resolve();
  await flush();
  assert.equal(h.sent.length, 0);
});
