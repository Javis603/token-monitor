'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const test = require('node:test');
const net = require('node:net');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHub } = require('../../src/hub/server');

function workerState() {
  const map = new Map();
  const clone = (value) => value === undefined ? value : JSON.parse(JSON.stringify(value));
  const state = {
    map, gates: 0, resets: 0, reads: [],
    async blockConcurrencyWhile(callback) {
      state.gates += 1;
      try { return await callback(); } catch (error) { state.resets += 1; throw error; }
    },
    storage: {
      async get(key) { state.reads.push(key); await new Promise((resolve) => setTimeout(resolve, 1)); return clone(map.get(key)); },
      async put(key, value) { await new Promise((resolve) => setTimeout(resolve, 1)); map.set(key, clone(value)); },
      async delete(key) { await new Promise((resolve) => setTimeout(resolve, 1)); return map.delete(key); },
      async list({ prefix }) { return new Map([...map].filter(([key]) => key.startsWith(prefix)).map(([key, value]) => [key, clone(value)])); },
      async transaction(callback) {
        const previous = new Map([...map].map(([key, value]) => [key, clone(value)]));
        try { return await callback(state.storage); } catch (error) {
          map.clear(); for (const [key, value] of previous) map.set(key, value);
          throw error;
        }
      }
    }
  };
  return state;
}

async function fixture(t, runtime, enabled = false) {
  let hub;
  let origin = 'https://hub.example';
  let state;
  let dataFile;
  let WorkerHub;
  const secret = 'secret';
  if (runtime === 'Node') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-content-'));
    dataFile = path.join(directory, 'devices.json');
    hub = createHub({ port: 0, host: '127.0.0.1', secret, syncSessionTitles: enabled, dataFile });
    await hub.start();
    origin = `http://127.0.0.1:${hub.server.address().port}`;
    t.after(async () => { await hub.stop(); fs.rmSync(directory, { recursive: true, force: true }); });
  } else {
    ({ HubDO: WorkerHub } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href));
    state = workerState();
    hub = new WorkerHub(state, { TOKEN_MONITOR_SECRET: secret, TOKEN_MONITOR_SYNC_SESSION_TITLES: String(enabled), PUBLIC_STATS_ENABLED: 'true' });
  }
  const send = (endpoint, method = 'GET', body, authenticated = true, signal) => {
    const options = {
      method, signal,
      headers: { 'content-type': 'application/json', ...(authenticated ? { authorization: `Bearer ${secret}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {})
    };
    return runtime === 'Node' ? fetch(`${origin}${endpoint}`, options) : hub.fetch(new Request(`${origin}${endpoint}`, options));
  };
  const restart = async (serverEnabled) => {
    if (runtime === 'Node') {
      await hub.stop();
      hub = createHub({ port: 0, host: '127.0.0.1', secret, syncSessionTitles: serverEnabled, dataFile });
      await hub.start();
      origin = `http://127.0.0.1:${hub.server.address().port}`;
    } else {
      hub = new WorkerHub(state, { TOKEN_MONITOR_SECRET: secret, TOKEN_MONITOR_SYNC_SESSION_TITLES: String(serverEnabled), PUBLIC_STATS_ENABLED: 'true' });
      await hub.ready;
    }
  };
  const sendRaw = (endpoint, body) => {
    const options = { method: 'PUT', headers: { 'content-type': 'application/json', authorization: `Bearer ${secret}` }, body };
    return runtime === 'Node' ? fetch(`${origin}${endpoint}`, options) : hub.fetch(new Request(`${origin}${endpoint}`, options));
  };
  return { send, sendRaw, restart, state, dataFile, get hub() { return hub; } };
}

function titledPayload(generation, title = ' private\n title ') {
  const session = {
    client: 'codex', sessionId: 'a', totalTokens: 4, title,
    preview: 'secret preview', firstUserMessage: 'secret message', sessionTitle: 'secret legacy', name: 'secret name'
  };
  return { deviceId: 'a', ...(generation === undefined ? {} : { sessionTitleSyncGeneration: generation }),
    today: { totalTokens: 4, sessions: { 'codex:a': session } },
    month: { totalTokens: 4, sessions: { 'codex:a': session } } };
}

async function readDevice(client) {
  return (await (await client.send('/api/devices')).json()).devices[0];
}

for (const runtime of ['Node', 'Worker']) {
  test(`${runtime}: capability, settings and policy share authentication and default off`, async (t) => {
    const client = await fixture(t, runtime);
    assert.deepEqual(await (await client.send('/api/sync/content')).json(), {
      ok: true, version: 1, sessionTitles: { enabled: false }, sharedSettings: true
    });
    for (const [endpoint, method, body] of [
      ['/api/sync/content', 'GET'], ['/api/sync/settings/modelAliases', 'GET'],
      ['/api/sync/settings/customPricing', 'PUT', { baseRevision: 0, value: [] }],
      ['/api/sync/titles/a', 'PUT', { enabled: false }]
    ]) assert.equal((await client.send(endpoint, method, body, false)).status, 401);
    assert.equal((await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).status, 403);
    await client.send('/api/ingest', 'POST', titledPayload(1));
    assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title|secret preview|secret message|secret legacy|secret name/);
    for (const kind of ['modelAliases', 'customPricing']) {
      assert.deepEqual(await (await client.send(`/api/sync/settings/${kind}`)).json(), {
        ok: true, version: 1, revision: 0, updatedAt: '', value: null
      });
    }
    const privateStats = await (await client.send('/api/stats')).json();
    assert.deepEqual(privateStats.syncSettingsRevisions, { modelAliases: 0, customPricing: 0 });
    if (runtime === 'Node') assert.equal((await client.send('/api/public/stats', 'GET', undefined, false)).status, 401);
  });

  test(`${runtime}: server, device and exact integer generation are independent requirements`, async (t) => {
    const client = await fixture(t, runtime, true);
    await client.send('/api/ingest', 'POST', titledPayload(1));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    const enabled = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    assert.deepEqual(enabled, { ok: true, enabled: true, generation: 1 });
    assert.deepEqual(await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json(), enabled);
    await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
    let record = await readDevice(client);
    assert.equal(record.periods.today.sessions['codex:a'].title, 'private title');
    assert.equal(Object.hasOwn(record, 'sessionTitleSyncGeneration'), false);
    assert.doesNotMatch(JSON.stringify(record), /secret preview|secret message|secret legacy|secret name/);
    for (const invalid of [undefined, String(enabled.generation), 0.5, enabled.generation + 1]) {
      await client.send('/api/ingest', 'POST', titledPayload(invalid));
      assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    }
    await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
    const missing = titledPayload(enabled.generation);
    delete missing.today.sessions['codex:a'].title;
    delete missing.month.sessions['codex:a'].title;
    await client.send('/api/ingest', 'POST', missing);
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
    await client.send('/api/ingest', 'POST', { deviceId: 'a', limitsOnly: true, limits: { providers: [] } });
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '', 'limits-only uploads must also revoke old titles');
    await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
    await client.send('/api/ingest', 'POST', { ...titledPayload(enabled.generation, 'current limits title'), limitsOnly: true });
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, 'current limits title');
    for (const generation of [enabled.generation, enabled.generation + 1]) {
      for (const marker of [undefined, { today: 1, month: 1 }, { today: '1' }, { today: -1 }]) {
        await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
        await client.send('/api/ingest', 'POST', { deviceId: 'a', limitsOnly: true,
          sessionTitleSyncGeneration: generation, ...(marker === undefined ? {} : { sessionDetailsOmitted: marker }) });
        const omitted = await readDevice(client);
        assert.equal(omitted.periods.today.sessions['codex:a'].totalTokens, 4);
        assert.equal(omitted.periods.today.sessions['codex:a'].title, '', 'omission never reauthorizes a previously saved title');
      }
    }
    await client.send('/api/ingest', 'POST', titledPayload(enabled.generation));
    for (const malformed of [{}, { enabled: 'false' }, { enabled: null }, { enabled: false, settings: {} }, null, []]) {
      assert.equal((await client.send('/api/sync/titles/a', 'PUT', malformed)).status, 400);
    }
    record = await readDevice(client);
    assert.equal(record.periods.today.sessions['codex:a'].title, 'private title', 'bad policy bodies must not clear');
    if (runtime === 'Worker') {
      const publicStats = await (await client.send('/api/public/stats', 'GET', undefined, false)).json();
      assert.doesNotMatch(JSON.stringify(publicStats), /private title|syncSettings|subscriptions|generation|modelAliases|customPricing/);
      assert.equal(Object.hasOwn(await client.hub.getStats(), 'syncSettingsRevisions'), false);
    }
  });

  test(`${runtime}: disabling offline records, restart and deletion permanently revoke old generations`, async (t) => {
    const client = await fixture(t, runtime, true);
    const first = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    await client.send('/api/ingest', 'POST', titledPayload(first.generation));
    const disabled = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: false })).json();
    assert.ok(disabled.generation > first.generation);
    assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title/);
    const again = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: false })).json();
    assert.ok(again.generation > disabled.generation);
    const second = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    assert.ok(second.generation > again.generation);
    await client.send('/api/ingest', 'POST', titledPayload(first.generation));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    await client.send('/api/ingest', 'POST', titledPayload(second.generation));
    await client.restart(false);
    assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title/);
    const persisted = runtime === 'Node' ? fs.readFileSync(client.dataFile, 'utf8') : JSON.stringify([...client.state.map]);
    assert.doesNotMatch(persisted, /private title/);
    await client.restart(true);
    await client.send('/api/ingest', 'POST', titledPayload(second.generation));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    const third = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    assert.ok(third.generation > second.generation);
    await client.send('/api/ingest', 'POST', titledPayload(third.generation));
    await client.send('/api/devices/a', 'DELETE');
    await client.send('/api/ingest', 'POST', titledPayload(third.generation));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
    const fourth = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    assert.ok(fourth.generation > third.generation);
    await client.send('/api/ingest', 'POST', titledPayload(fourth.generation));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, 'private title');
  });

  test(`${runtime}: legacy offline text without a policy is cleaned before reads, even with server opt-in`, async (t) => {
    const client = await fixture(t, runtime, true);
    const legacy = { version: 1, devices: { a: titledPayload(undefined) } };
    if (runtime === 'Node') {
      await client.hub.stop();
      fs.writeFileSync(client.dataFile, JSON.stringify(legacy));
    } else client.state.map.set('dev:a', titledPayload(undefined));
    await client.restart(true);
    assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title|secret preview|secret message|secret legacy|secret name/);
    const persisted = runtime === 'Node' ? fs.readFileSync(client.dataFile, 'utf8') : JSON.stringify([...client.state.map]);
    assert.doesNotMatch(persisted, /private|secret/);
  });

  test(`${runtime}: group CAS conflicts, concurrent writes, malformed bodies and restart persistence`, async (t) => {
    const client = await fixture(t, runtime);
    const aliases = { modelAliases: { a: 'bee' }, modelAliasGrouping: 'prefix' };
    const pathAliases = '/api/sync/settings/modelAliases';
    const pathPrices = '/api/sync/settings/customPricing';
    const responses = await Promise.all([
      client.send(pathAliases, 'PUT', { baseRevision: 0, value: aliases }),
      client.send(pathAliases, 'PUT', { baseRevision: 0, value: { modelAliases: {}, modelAliasGrouping: 'off' } })
    ]);
    assert.deepEqual(responses.map((response) => response.status).sort(), [200, 409]);
    const current = await (await client.send(pathAliases)).json();
    assert.equal(current.revision, 1);
    const conflict = await responses.find((response) => response.status === 409).json();
    assert.deepEqual(conflict, { error: 'stale_write', version: 1, revision: 1, updatedAt: current.updatedAt, value: current.value });
    const prices = [{ modelId: 'gpt', inputPerM: 0, outputPerM: '', cacheReadPerM: 2, cacheWritePerM: 3, cacheWrite1hPerM: 4 }];
    const written = await (await client.send(pathPrices, 'PUT', { baseRevision: 0, value: prices })).json();
    assert.deepEqual(written.value, [{ modelId: 'gpt', inputPerM: 0, cacheReadPerM: 2, cacheWritePerM: 3, cacheWrite1hPerM: 4 }]);
    for (const bad of [null, [], {}, { baseRevision: '1', value: [] }, { baseRevision: 1 }, { baseRevision: 1, value: null },
      { baseRevision: 1, value: [{ modelId: 'gpt', inputPerM: -1 }] }, { baseRevision: 1, value: [], credentials: 'secret' }]) {
      assert.equal((await client.send(pathPrices, 'PUT', bad)).status, 400);
    }
    assert.equal((await client.sendRaw(pathPrices, '{"baseRevision":1,"value":[')).status, 400);
    assert.deepEqual(await (await client.send(pathPrices)).json(), written);
    const empty = await (await client.send(pathPrices, 'PUT', { baseRevision: 1, value: [] })).json();
    assert.equal(empty.revision, 2);
    assert.deepEqual(empty.value, []);
    assert.equal((await client.send(pathPrices, 'PUT', { baseRevision: 1, value: prices })).status, 409);
    assert.equal((await client.send('/api/sync/settings/credentials', 'PUT', { baseRevision: 0, value: {} })).status, 404);
    await client.restart(false);
    assert.deepEqual(await (await client.send(pathPrices)).json(), empty);
    assert.deepEqual((await (await client.send('/api/stats')).json()).syncSettingsRevisions, { modelAliases: 1, customPricing: 2 });
    if (runtime === 'Worker') {
      assert.ok(client.state.gates > 5, 'compound operations use the DO gate');
      assert.equal(client.state.resets, 0, 'normal validation and CAS conflicts must not reset the DO');
      const reads = client.state.reads.length;
      const publicStats = await (await client.send('/api/public/stats', 'GET', undefined, false)).json();
      assert.doesNotMatch(JSON.stringify(publicStats), /syncSettings|modelAliases|customPricing|subscriptionsUpdatedAt|gpt|cacheWrite1hPerM/);
      assert.ok(client.state.reads.slice(reads).every((key) => !key.startsWith('sync-settings:') && key !== 'subscriptions'));
    }
  });

  test(`${runtime}: settings and title disable immediately broadcast private stats including offline purges`, async (t) => {
    const client = await fixture(t, runtime, true);
    const policy = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
    await client.send('/api/ingest', 'POST', titledPayload(policy.generation));
    const abort = new AbortController();
    const stream = await client.send('/api/stats/stream', 'GET', undefined, true, abort.signal);
    const reader = stream.body.getReader();
    t.after(async () => { abort.abort(); try { await reader.cancel(); } catch (_) {} });
    let buffer = '';
    async function event(reason) {
      const deadline = setTimeout(() => {
        abort.abort(new Error(`SSE event timed out: ${reason}`));
        void reader.cancel().catch(() => {});
      }, 5000);
      try {
        for (;;) {
          let boundary;
          while ((boundary = buffer.indexOf('\n\n')) >= 0) {
            const frame = buffer.slice(0, boundary);
            buffer = buffer.slice(boundary + 2);
            const data = frame.match(/^data: (.+)$/m)?.[1];
            if (data) { const value = JSON.parse(data); if (value.reason === reason) return value; }
          }
          const chunk = await reader.read();
          assert.equal(chunk.done, false, `SSE ended before ${reason}: ${String(abort.signal.reason || '')}`);
          buffer += new TextDecoder().decode(chunk.value);
        }
      } finally { clearTimeout(deadline); }
    }
    assert.equal((await event('snapshot')).stats.periods.today.sessions['codex:a'].title, 'private title');
    await client.send('/api/sync/settings/customPricing', 'PUT', { baseRevision: 0, value: [] });
    assert.equal((await event('sync-settings')).stats.syncSettingsRevisions.customPricing, 1);
    await client.send('/api/sync/titles/a', 'PUT', { enabled: false });
    const purged = await event('sync-titles');
    assert.doesNotMatch(JSON.stringify(purged), /private title/);
    await client.send('/api/ingest', 'POST', titledPayload(policy.generation));
    assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
  });
}

test('Worker: overlapping title upload and disable cannot restore a revoked generation', async (t) => {
  const client = await fixture(t, 'Worker', true);
  const policy = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
  await Promise.all([
    client.send('/api/ingest', 'POST', titledPayload(policy.generation)),
    client.send('/api/sync/titles/a', 'PUT', { enabled: false }),
    client.send('/api/ingest', 'POST', titledPayload(policy.generation))
  ]);
  assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title/);
  const savedPolicy = client.state.map.get('title-policy:a');
  assert.equal(savedPolicy.enabled, false);
  assert.ok(savedPolicy.generation > policy.generation);
});

test('Worker: server permission changes purge offline titles at read time and revoke policy', async (t) => {
  const client = await fixture(t, 'Worker', true);
  const policy = await (await client.send('/api/sync/titles/a', 'PUT', { enabled: true })).json();
  await client.send('/api/ingest', 'POST', titledPayload(policy.generation));
  client.hub.env.TOKEN_MONITOR_SYNC_SESSION_TITLES = 'false';
  assert.doesNotMatch(JSON.stringify(await readDevice(client)), /private title/);
  const disabled = client.state.map.get('title-policy:a');
  assert.equal(disabled.enabled, false);
  assert.ok(disabled.generation > policy.generation);
  client.hub.env.TOKEN_MONITOR_SYNC_SESSION_TITLES = 'true';
  await client.send('/api/ingest', 'POST', titledPayload(policy.generation));
  assert.equal((await readDevice(client)).periods.today.sessions['codex:a'].title, '');
});

test('Node: failed persistence rolls shared group and title policy back in memory', () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-sync-write-failure-'));
  const dataFile = path.join(directory, 'devices.json');
  const hub = createHub({ dataFile, syncSessionTitles: true });
  try {
    const first = hub.setSyncTitlePolicy('a', true);
    hub.ingest(titledPayload(first.generation));
    hub.setSyncSettings('customPricing', { baseRevision: 0, value: [] });
    fs.mkdirSync(`${dataFile}.tmp`);
    assert.throws(() => hub.setSyncSettings('customPricing', { baseRevision: 1, value: [{ modelId: 'gpt', inputPerM: 0 }] }));
    assert.equal(hub.getSyncSettings('customPricing').revision, 1);
    assert.throws(() => hub.setSyncTitlePolicy('a', false));
    assert.deepEqual(hub.setSyncTitlePolicy('a', true), first);
    assert.equal(hub.getDevices()[0].periods.today.sessions['codex:a'].title, 'private title');
  } finally { fs.rmSync(directory, { recursive: true, force: true }); }
});

test('Node CLI: camel/kebab flags override server environment with explicit false', async (t) => {
  for (const scenario of [
    { flags: ['--sync-session-titles=false'], env: 'true', enabled: false },
    { flags: ['--syncSessionTitles=0'], env: 'true', enabled: false },
    { flags: ['--sync-session-titles'], env: 'false', enabled: true },
    { flags: [], env: 'true', enabled: true }
  ]) {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-hub-sync-cli-'));
    t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
    let child;
    let port;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      const socket = net.createServer();
      socket.listen(0, '127.0.0.1');
      try {
        await once(socket, 'listening', { signal: AbortSignal.timeout(5000) });
        port = socket.address().port;
      } finally { await new Promise((resolve) => socket.close(resolve)); }
      child = spawn(process.execPath, [path.resolve(__dirname, '../../src/hub/server.js'),
        '--host=127.0.0.1', `--port=${port}`, `--dataFile=${path.join(directory, 'devices.json')}`, ...scenario.flags], {
        env: { ...process.env, TOKEN_MONITOR_SECRET: 'secret', TOKEN_MONITOR_SYNC_SESSION_TITLES: scenario.env },
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const launched = child;
      t.after(async () => {
        if (launched.exitCode !== null || launched.signalCode !== null) return;
        const exited = once(launched, 'exit', { signal: AbortSignal.timeout(5000) });
        launched.kill();
        await exited;
      });
      try {
        await new Promise((resolve, reject) => {
          let output = '';
          let errors = '';
          const finish = (error) => {
            clearTimeout(timeout);
            child.stdout.off('data', stdout);
            child.stderr.off('data', stderr);
            child.off('error', onError);
            child.off('exit', onExit);
            if (error) reject(error); else resolve();
          };
          const stdout = (chunk) => { output += chunk; if (output.includes('hub listening')) finish(); };
          const stderr = (chunk) => { errors += chunk; };
          const onError = (error) => finish(error);
          const onExit = (code) => {
            const error = new Error(`CLI exited ${code}: ${errors}`);
            if (/EADDRINUSE/.test(errors)) error.code = 'EADDRINUSE';
            finish(error);
          };
          const timeout = setTimeout(() => { child.kill(); finish(new Error(`CLI startup timed out: ${errors}`)); }, 5000);
          child.stdout.on('data', stdout);
          child.stderr.on('data', stderr);
          child.on('error', onError);
          child.on('exit', onExit);
        });
        break;
      } catch (error) {
        // The child CLI reports its requested port, so port=0 cannot reveal its
        // actual listener here. Retry only the bind race, with a bounded budget.
        if (error.code !== 'EADDRINUSE' || attempt === 2) throw error;
      }
    }
    const response = await fetch(`http://127.0.0.1:${port}/api/sync/content`, {
      headers: { authorization: 'Bearer secret' }, signal: AbortSignal.timeout(5000)
    });
    assert.equal((await response.json()).sessionTitles.enabled, scenario.enabled);
    const exited = once(child, 'exit', { signal: AbortSignal.timeout(5000) }); child.kill(); await exited;
  }
});

test('Worker: rejected startup cleanup retries once for concurrent reads and never escapes the input gate', async () => {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const state = workerState();
  state.map.set('dev:a', titledPayload(1));
  state.map.set('title-policy:a', { enabled: true, generation: 1 });
  const list = state.storage.list;
  let scans = 0;
  let failures = 2;
  state.storage.list = async (options) => {
    if (options.prefix === 'title-policy:') {
      scans += 1;
      await new Promise((resolve) => setTimeout(resolve, 10));
      if (failures > 0) { failures -= 1; throw new Error('transient storage failure'); }
    }
    return list(options);
  };
  const env = { TOKEN_MONITOR_SECRET: 'secret', PUBLIC_STATS_ENABLED: 'true' };
  const hub = new HubDO(state, env);
  // Let startup reject before attaching a request handler: node:test would report
  // an unhandled rejection if the constructor had no immediate rejection handler.
  await new Promise((resolve) => setTimeout(resolve, 30));
  await assert.rejects(hub.ready, /transient storage failure/);
  const read = (endpoint) => hub.fetch(new Request(`https://hub.example${endpoint}`, { headers: { authorization: 'Bearer secret' } }));
  const failed = await Promise.allSettled([read('/api/health'), read('/api/devices'), read('/api/public/stats')]);
  assert.ok(failed.every((result) => result.status === 'rejected'));
  assert.equal(scans, 2, 'one serialized retry shared by concurrent readers');
  assert.match(JSON.stringify(state.map.get('dev:a')), /private/);
  const responses = await Promise.all([read('/api/health'), read('/api/devices'), read('/api/public/stats')]);
  assert.ok(responses.every((response) => response.status === 200));
  assert.equal(scans, 3);
  assert.doesNotMatch(JSON.stringify([...state.map]), /private title|secret preview|secret message|secret legacy|secret name/);
  assert.deepEqual(state.map.get('title-policy:a'), { enabled: false, generation: 2 });
  assert.equal(state.resets, 0, 'storage rejection is thrown outside blockConcurrencyWhile');
  await Promise.all([read('/api/health'), read('/api/devices')]);
  assert.equal(scans, 3, 'unchanged requests do not rescan policies');
  const restarted = new HubDO(state, { ...env, TOKEN_MONITOR_SYNC_SESSION_TITLES: 'true' });
  await restarted.ready;
  await restarted.fetch(new Request('https://hub.example/api/ingest', {
    method: 'POST', headers: { authorization: 'Bearer secret', 'content-type': 'application/json' }, body: JSON.stringify(titledPayload(1))
  }));
  assert.doesNotMatch(JSON.stringify(state.map.get('dev:a')), /private title/);
});


test('Worker: a scrub write failure rolls policy revocation back and the next read retries safely', async () => {
  const { HubDO } = await import(pathToFileURL(path.resolve(__dirname, '../../worker/src/index.js')).href);
  const state = workerState();
  state.map.set('dev:a', titledPayload(1));
  state.map.set('title-policy:a', { enabled: true, generation: 1 });
  const put = state.storage.put;
  let failed = false;
  state.storage.put = async (key, value) => {
    if (!failed && key === 'dev:a') { failed = true; throw new Error('scrub write failed'); }
    return put(key, value);
  };
  const hub = new HubDO(state, { TOKEN_MONITOR_SECRET: 'secret' });
  await assert.rejects(hub.ready, /scrub write failed/);
  assert.deepEqual(state.map.get('title-policy:a'), { enabled: true, generation: 1 });
  assert.equal(state.resets, 0);
  const response = await hub.fetch(new Request('https://hub.example/api/health'));
  assert.equal(response.status, 200);
  assert.deepEqual(state.map.get('title-policy:a'), { enabled: false, generation: 2 });
  assert.doesNotMatch(JSON.stringify(state.map.get('dev:a')), /private title|secret preview/);
});
