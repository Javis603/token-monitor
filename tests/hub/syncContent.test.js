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
      for (;;) {
        let boundary;
        while ((boundary = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          const data = frame.match(/^data: (.+)$/m)?.[1];
          if (data) { const value = JSON.parse(data); if (value.reason === reason) return value; }
        }
        const chunk = await reader.read();
        assert.equal(chunk.done, false);
        buffer += new TextDecoder().decode(chunk.value);
      }
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
    const socket = net.createServer();
    socket.listen(0, '127.0.0.1');
    await once(socket, 'listening');
    const port = socket.address().port;
    await new Promise((resolve) => socket.close(resolve));
    const child = spawn(process.execPath, [path.resolve(__dirname, '../../src/hub/server.js'),
      '--host=127.0.0.1', `--port=${port}`, `--dataFile=${path.join(directory, 'devices.json')}`, ...scenario.flags], {
      env: { ...process.env, TOKEN_MONITOR_SECRET: 'secret', TOKEN_MONITOR_SYNC_SESSION_TITLES: scenario.env },
      stdio: ['ignore', 'pipe', 'pipe']
    });
    t.after(async () => {
      if (child.exitCode !== null || child.signalCode !== null) return;
      const exited = once(child, 'exit'); child.kill(); await exited;
    });
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => { child.kill(); reject(new Error('CLI startup timed out')); }, 5000);
      let output = '';
      child.stdout.on('data', (chunk) => {
        output += chunk;
        if (output.includes('hub listening')) { clearTimeout(timeout); resolve(); }
      });
      child.on('error', (error) => { clearTimeout(timeout); reject(error); });
      child.on('exit', (code) => { clearTimeout(timeout); reject(new Error(`CLI exited ${code}`)); });
    });
    const response = await fetch(`http://127.0.0.1:${port}/api/sync/content`, { headers: { authorization: 'Bearer secret' } });
    assert.equal((await response.json()).sessionTitles.enabled, scenario.enabled);
    const exited = once(child, 'exit'); child.kill(); await exited;
  }
});
