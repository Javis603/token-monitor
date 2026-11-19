'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { createSessionTitleSyncNegotiator, syncSessionTitlesEnabled } = require('../../src/shared/syncContent');
const { postSyncPayload } = require('../../src/shared/syncPayload');

const request = { hubUrl: 'https://hub.example', headers: { authorization: 'Bearer secret' }, deviceId: 'a/b', enabled: true };
const capability = (enabled = true) => ({ ok: true, version: 1, sessionTitles: { enabled }, sharedSettings: true });

function fakeBackend({ supported = true, allowed = true } = {}) {
  const requests = [];
  let generation = 0;
  let enabled = false;
  const fetchFn = async (url, options = {}) => {
    requests.push({ url, ...options, ...(options.body ? { payload: JSON.parse(options.body) } : {}) });
    if (url.endsWith('/api/sync/content')) return supported ? Response.json(capability(allowed)) : new Response('legacy', { status: 404 });
    if (url.includes('/api/sync/titles/')) {
      const desired = JSON.parse(options.body).enabled;
      if (desired && !allowed) return new Response('forbidden', { status: 403 });
      if (!desired || !enabled) generation += 1;
      enabled = desired;
      return Response.json({ ok: true, enabled, generation });
    }
    return Response.json({ ok: true, deviceId: 'a/b' });
  };
  return { fetchFn, requests, get generation() { return generation; } };
}

test('agent never transmits titles to an old hub and sends text-free usage after failed probes', async () => {
  for (const failure of ['old', 'network', 'invalid', 'unauthorized']) {
    const backend = fakeBackend({ supported: false });
    const negotiator = createSessionTitleSyncNegotiator({ fetchFn: async (url, options) => {
      if (url.endsWith('/api/sync/content')) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'invalid') return Response.json({ ok: true, sessionTitles: { enabled: true } });
        if (failure === 'unauthorized') return new Response('no', { status: 401 });
      }
      return backend.fetchFn(url, options);
    } });
    const options = await negotiator.negotiate(request);
    await postSyncPayload(backend.fetchFn, `${request.hubUrl}/api/ingest`, {
      summary: { deviceId: 'a/b', today: { sessions: { a: { title: 'private title', preview: 'private preview' } } } }, ...options
    });
    assert.equal(options.syncSessionTitles, false);
    const ingests = backend.requests.filter((entry) => entry.url.endsWith('/api/ingest'));
    assert.equal(ingests.length, 1);
    assert.doesNotMatch(JSON.stringify(ingests), /private title|private preview/);
    assert.equal(backend.requests.some((entry) => entry.url.includes('/api/sync/titles/')), false);
  }
});

test('agent sends exact negotiated generation only after authenticated discovery, and caches by destination identity', async () => {
  const backend = fakeBackend();
  let time = 0;
  const negotiator = createSessionTitleSyncNegotiator({ fetchFn: backend.fetchFn, now: () => time });
  assert.deepEqual(await negotiator.negotiate(request), { syncSessionTitles: true, sessionTitleSyncGeneration: 1 });
  assert.equal(backend.requests[0].url, 'https://hub.example/api/sync/content');
  assert.equal(backend.requests[0].headers.authorization, 'Bearer secret');
  assert.equal(backend.requests[1].url, 'https://hub.example/api/sync/titles/a%2Fb');
  assert.equal(backend.requests[1].payload.enabled, true);
  assert.ok(backend.requests.every((entry) => entry.redirect === 'error'));
  await negotiator.negotiate(request);
  await negotiator.negotiate(request);
  assert.equal(backend.requests.length, 2);
  time = 60001;
  const options = await negotiator.negotiate(request);
  assert.deepEqual(options, { syncSessionTitles: true, sessionTitleSyncGeneration: 1 });
  assert.equal(backend.requests.length, 4);
  await negotiator.negotiate({ ...request, hubUrl: 'https://different.example' });
  await negotiator.negotiate({ ...request, headers: { authorization: 'Bearer new-secret' } });
  await negotiator.negotiate({ ...request, deviceId: 'different' });
  assert.equal(backend.requests.length, 10);
  const delivered = await postSyncPayload(backend.fetchFn, `${request.hubUrl}/api/ingest`, {
    summary: { deviceId: 'a/b', today: { sessions: { a: { title: ' private\n title ', firstUserMessage: 'never send' } } } }, ...options
  });
  assert.equal(delivered.payload.sessionTitleSyncGeneration, 1);
  assert.equal(delivered.payload.today.sessions.a.title, 'private title');
  assert.doesNotMatch(JSON.stringify(delivered.payload), /never send/);
});

test('agent consent default off disables the previous device policy and server permission remains independent', async () => {
  const backend = fakeBackend();
  const negotiator = createSessionTitleSyncNegotiator({ fetchFn: backend.fetchFn });
  await negotiator.negotiate(request);
  assert.deepEqual(await negotiator.negotiate({ ...request, enabled: false }), { syncSessionTitles: false });
  assert.deepEqual(backend.requests.at(-1).payload, { enabled: false });
  assert.equal(backend.generation, 2);
  await negotiator.negotiate(request);
  assert.equal(backend.generation, 3);
  negotiator.invalidate();
  await negotiator.negotiate(request);
  assert.equal(backend.generation, 3);
  const forbidden = fakeBackend({ allowed: false });
  const forbiddenNegotiator = createSessionTitleSyncNegotiator({ fetchFn: forbidden.fetchFn });
  assert.deepEqual(await forbiddenNegotiator.negotiate(request), { syncSessionTitles: false });
  assert.deepEqual(forbidden.requests.at(-1).payload, { enabled: false });
});

test('agent revalidation fails closed when server permission changes, and boolean options preserve explicit false', async () => {
  let allowed = true;
  let time = 0;
  const calls = [];
  const negotiator = createSessionTitleSyncNegotiator({ now: () => time, fetchFn: async (url, options) => {
    calls.push({ url, options });
    if (url.endsWith('/api/sync/content')) return Response.json(capability(allowed));
    const enabled = JSON.parse(options.body).enabled;
    return Response.json({ ok: true, enabled, generation: enabled ? 1 : 2 });
  } });
  assert.equal((await negotiator.negotiate(request)).syncSessionTitles, true);
  allowed = false; time = 60001;
  assert.equal((await negotiator.negotiate(request)).syncSessionTitles, false);
  assert.equal(JSON.parse(calls.at(-1).options.body).enabled, false);
  for (const value of [undefined, false, '', 'false', '0', 'off']) assert.equal(syncSessionTitlesEnabled(value), false);
  for (const value of [true, 'true', '1', 'yes', 'on']) assert.equal(syncSessionTitlesEnabled(value), true);
});

test('agent entrypoint honors default/CLI/env consent and wires safe negotiation into actual delivery', async (t) => {
  const filename = path.resolve(__dirname, '../../src/agent/agent.js');
  const agentRequire = createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8');
  for (const scenario of [
    { flags: [], consent: false },
    { flags: [], env: 'true', consent: true },
    { flags: ['--sync-session-titles=false'], env: 'true', consent: false },
    { flags: ['--syncSessionTitles=0'], env: 'true', consent: false },
    { flags: ['--sync-session-titles'], consent: true },
    { flags: ['--syncSessionTitles=true'], consent: true, old: true }
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-sync-content-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const backend = fakeBackend({ supported: !scenario.old });
    let resolveDelivery;
    let rejectDelivery;
    const delivered = new Promise((resolve, reject) => { resolveDelivery = resolve; rejectDelivery = reject; });
    const deliveryTimeout = setTimeout(() => rejectDelivery(new Error(`agent delivery timed out: ${JSON.stringify(scenario)}`)), 5000);
    t.after(() => clearTimeout(deliveryTimeout));
    const summary = { deviceId: 'a', today: { totalTokens: 1, sessions: { a: {
      client: 'codex', sessionId: 'a', totalTokens: 1, title: 'private title', preview: 'never send'
    } } }, month: { totalTokens: 1 }, allTime: { totalTokens: 1 } };
    const context = {
      require(id) {
        if (id === '../shared/config') return { ...agentRequire(id), loadDotEnv() {}, pidFilePath: () => path.join(directory, 'agent.pid') };
        if (id === './seedClients') return { seedAgentClients: (clients) => clients };
        if (id === '../shared/usage/sessionUsageArchiveStore') return { createSessionUsageArchiveStore: () => ({ close() {} }) };
        if (id === '../shared/providers/cursor/usageEvents') return { createCursorUsageEventIndex: () => ({}) };
        if (id === './runtime') return { async runAgentOnce(options) {
          try { await options.deliver(summary); resolveDelivery(); } catch (error) { rejectDelivery(error); throw error; }
        } };
        return agentRequire(id);
      },
      process: {
        argv: ['node', filename, '--once', ...scenario.flags], pid: 123,
        env: { TOKEN_MONITOR_HUB_URL: 'https://hub.example', TOKEN_MONITOR_SECRET: 'secret',
          TOKEN_MONITOR_DEVICE_ID: 'a', TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED: 'false',
          ...(scenario.env === undefined ? {} : { TOKEN_MONITOR_SYNC_SESSION_TITLES: scenario.env }) },
        on() {}
      },
      fetch: backend.fetchFn, console: { log() {}, warn() {}, error(error) { if (error instanceof Error) rejectDelivery(error); } }
    };
    vm.runInNewContext(source, context, { filename });
    try { await delivered; } finally { clearTimeout(deliveryTimeout); }
    const posts = backend.requests.filter((entry) => entry.url.endsWith('/api/ingest'));
    assert.equal(posts.length, 1);
    assert.equal(backend.requests[0].url, 'https://hub.example/api/sync/content');
    assert.equal(backend.requests[0].headers.authorization, 'Bearer secret');
    assert.equal(posts[0].redirect, 'error');
    assert.equal(posts[0].headers['x-token-monitor-response'], 'minimal');
    const titled = scenario.consent && !scenario.old;
    assert.equal(Boolean(posts[0].payload.today.sessions.a.title), titled);
    assert.equal(posts[0].payload.sessionTitleSyncGeneration, titled ? 1 : undefined);
    assert.doesNotMatch(JSON.stringify(posts), /never send/);
    if (!scenario.old) assert.equal(backend.requests[1].payload.enabled, scenario.consent);
  }
});


test('acknowledged local OFF survives TTL but destination, consent and invalidation revoke its cache', async () => {
  let time = 0;
  const backend = fakeBackend();
  const negotiator = createSessionTitleSyncNegotiator({ fetchFn: backend.fetchFn, now: () => time });
  const off = { ...request, enabled: false };
  await negotiator.negotiate(off);
  time = 60001;
  await negotiator.negotiate(off);
  time = 600001;
  await negotiator.negotiate(off);
  assert.equal(backend.requests.length, 2);
  await negotiator.negotiate(request);
  assert.equal(backend.generation, 2);
  await negotiator.negotiate(off);
  assert.equal(backend.generation, 3);
  negotiator.invalidate();
  await negotiator.negotiate(off);
  assert.equal(backend.generation, 4);
  for (const changed of [
    { ...off, hubUrl: 'https://other.example' },
    { ...off, headers: { authorization: 'Bearer other' } },
    { ...off, deviceId: 'other' }
  ]) {
    const previous = backend.requests.length;
    await negotiator.negotiate(changed);
    await negotiator.negotiate(off);
    assert.equal(backend.requests.length, previous + 4, 'returning to an old destination must negotiate again');
  }
});

test('failed OFF negotiation retries immediately and only exact acknowledged policies are cached', async () => {
  for (const failure of ['network', 'denied', 'enabled', 'generation', 'legacy']) {
    let failed = true;
    const backend = fakeBackend();
    const negotiator = createSessionTitleSyncNegotiator({ fetchFn: async (url, options) => {
      if (failed && (url.includes('/api/sync/titles/') || failure === 'legacy')) {
        if (failure === 'network') throw new Error('offline');
        if (failure === 'denied' || failure === 'legacy') return new Response('no', { status: 403 });
        return Response.json({ ok: true, enabled: failure === 'enabled', generation: failure === 'generation' ? '1' : 1 });
      }
      return backend.fetchFn(url, options);
    } });
    const off = { ...request, enabled: false };
    assert.deepEqual(await negotiator.negotiate(off), { syncSessionTitles: false });
    failed = false;
    await negotiator.negotiate(off);
    assert.equal(backend.generation, 1, failure);
    const count = backend.requests.length;
    await negotiator.negotiate(off);
    assert.equal(backend.requests.length, count);
  }
});

test('invalidation during an OFF request prevents that old acknowledgement from repopulating cache', async () => {
  const backend = fakeBackend();
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  const negotiator = createSessionTitleSyncNegotiator({ fetchFn: async (url, options) => {
    if (url.includes('/api/sync/titles/')) await held;
    return backend.fetchFn(url, options);
  } });
  const off = { ...request, enabled: false };
  const pending = negotiator.negotiate(off);
  negotiator.invalidate();
  release();
  await pending;
  await negotiator.negotiate(off);
  assert.equal(backend.requests.length, 4);
});


test('local ON keeps refreshing server-denied permission and invalidated ON requests cannot return title authorization', async () => {
  const backend = fakeBackend();
  let allowed = false;
  let time = 0;
  let release;
  let held;
  const negotiator = createSessionTitleSyncNegotiator({ now: () => time, fetchFn: async (url, options) => {
    if (url.endsWith('/api/sync/content')) return Response.json(capability(allowed));
    if (held) await held;
    return backend.fetchFn(url, options);
  } });
  assert.equal((await negotiator.negotiate(request)).syncSessionTitles, false);
  allowed = true;
  time = 60001;
  assert.equal((await negotiator.negotiate(request)).syncSessionTitles, true);
  time = 120002;
  held = new Promise((resolve) => { release = resolve; });
  const pending = negotiator.negotiate(request);
  negotiator.invalidate();
  release();
  assert.deepEqual(await pending, { syncSessionTitles: false });
});

test('actual agent startup reconciles the previous device before a failed scan, and dry runs leave journals untouched', async t => {
  const { createAgentTitleSync } = require('../../src/agent/titleSync');
  const filename = path.resolve(__dirname, '../../src/agent/agent.js');
  const agentRequire = createRequire(filename);
  const source = fs.readFileSync(filename, 'utf8');
  for (const dryRun of [false, true]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-agent-startup-journal-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    const backend = fakeBackend();
    await createAgentTitleSync({ dataDir: directory, fetchFn: backend.fetchFn }).negotiate(request);
    const journal = path.join(directory, 'agent-sync-credentials.json');
    const before = fs.readFileSync(journal, 'utf8');
    backend.requests.length = 0;
    let complete;
    const finished = new Promise(resolve => { complete = resolve; });
    const scanFailure = new Error('collector fixture failed');
    const context = {
      require(id) {
        if (id === '../shared/config') return { ...agentRequire(id), loadDotEnv() {}, pidFilePath: () => path.join(directory, 'agent.pid') };
        if (id === './seedClients') return { seedAgentClients: clients => clients };
        if (id === '../shared/usage/sessionUsageArchiveStore') return { createSessionUsageArchiveStore: () => ({ close() {} }) };
        if (id === '../shared/providers/cursor/usageEvents') return { createCursorUsageEventIndex: () => ({}) };
        if (id === './runtime') return { async runAgentOnce(options) {
          assert.equal(options.dryRun, dryRun);
          if (dryRun) assert.equal(backend.requests.length, 0);
          else {
            assert.equal(backend.requests[0].url, 'https://hub.example/api/sync/titles/a%2Fb');
            assert.deepEqual(backend.requests[0].payload, { enabled: false });
            assert.equal(backend.requests[0].headers.authorization, 'Bearer secret');
          }
          throw scanFailure;
        } };
        return agentRequire(id);
      },
      process: { argv: ['node', filename, '--once', '--sync-session-titles', ...(dryRun ? ['--dry-run'] : [])], pid: 123,
        env: { TOKEN_MONITOR_HUB_URL: 'https://hub.example', TOKEN_MONITOR_SECRET: 'secret', TOKEN_MONITOR_DEVICE_ID: 'replacement', TOKEN_MONITOR_SESSION_USAGE_ARCHIVE_ENABLED: 'false' }, on() {} },
      fetch: backend.fetchFn, console: { log() {}, warn() {}, error(error) { if (error instanceof Error) complete(error); } }
    };
    vm.runInNewContext(source, context, { filename });
    assert.equal(await finished, scanFailure);
    assert.equal(backend.requests.some(r => r.url.endsWith('/api/ingest')), false);
    if (dryRun) assert.equal(fs.readFileSync(journal, 'utf8'), before);
    else {
      const { CredentialStore } = require('../../src/shared/credentialStore');
      const state = new CredentialStore(directory, { filePath: journal }).readDocument().credentials.hub.titleSync;
      assert.equal(state.active.deviceId, 'replacement');
      assert.equal(state.pending.length, 0);
    }
  }
});
