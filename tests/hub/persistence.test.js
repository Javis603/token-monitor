'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { createHub } = require('../../src/hub/server');

function fixture(t, persistIntervalMs = 300000, options = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-persistence-'));
  const dataFile = path.join(dir, 'devices.json');
  const hub = createHub({ port: 0, host: '127.0.0.1', dataFile, persistIntervalMs, ...options });
  t.after(async () => {
    await hub.stop();
    fs.rmSync(dir, { recursive: true });
  });
  return { hub, dataFile };
}

function readStore(dataFile) {
  return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
}

test('continuous uploads stay live and share the first save deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 1 } });
  t.mock.timers.tick(299999);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 9 } });
  hub.ingest({ deviceId: 'b', today: { totalTokens: 4 } });
  assert.equal(fs.existsSync(dataFile), false);
  assert.equal(hub.getStats().periods.today.totalTokens, 13);
  t.mock.timers.tick(1);
  const store = readStore(dataFile);
  assert.equal(store.devices.a.periods.today.totalTokens, 9);
  assert.equal(store.devices.b.periods.today.totalTokens, 4);
  const inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(600000);
  assert.equal(fs.statSync(dataFile).ino, inode);
});

test('normal stop saves pending records and they survive reopening', async (t) => {
  const { hub, dataFile } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'a', today: { totalTokens: 7 } });
  await hub.stop();
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 7);
  const restored = createHub({ dataFile });
  assert.equal(restored.getDevices()[0].periods.today.totalTokens, 7);
});

test('subscription edits and device deletion save pending uploads immediately', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 3 } });
  hub.setSubscriptions([], hub.getSubscriptions().updatedAt);
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 3);
  let inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(300000);
  assert.equal(fs.statSync(dataFile).ino, inode);
  hub.ingest({ deviceId: 'b', today: { totalTokens: 5 } });
  hub.deleteDevice('a');
  const store = readStore(dataFile);
  assert.equal(store.devices.a, undefined);
  assert.equal(store.devices.b.periods.today.totalTokens, 5);
  inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(300000);
  assert.equal(fs.statSync(dataFile).ino, inode);
});

test('default persistence stays synchronous and uses compact JSON', (t) => {
  const { hub, dataFile } = fixture(t, 0);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 3 } });
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 3);
  const text = fs.readFileSync(dataFile, 'utf8');
  assert.equal(text, `${JSON.stringify(JSON.parse(text))}\n`);
  assert.equal(fs.existsSync(`${dataFile}.tmp`), false);
});

for (const recovery of ['next upload', 'shutdown']) {
  test(`a failed timer save keeps pending records for ${recovery}`, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout'] });
    const errors = [];
    const { hub, dataFile } = fixture(t, 300000, {
      logger: { error: (_message, error) => errors.push(error) }
    });
    hub.ingest({ deviceId: 'a', today: { totalTokens: 7 } });
    const blockedTempFile = `${dataFile}.tmp`;
    fs.mkdirSync(blockedTempFile);
    t.mock.timers.tick(300000);
    assert.equal(errors.length, 1);
    assert.ok(errors[0] instanceof Error);
    assert.equal(fs.existsSync(dataFile), false);
    assert.equal(hub.getStats().periods.today.totalTokens, 7);
    t.mock.timers.tick(600000);
    assert.equal(errors.length, 1);
    fs.rmdirSync(blockedTempFile);

    if (recovery === 'next upload') {
      hub.ingest({ deviceId: 'b', today: { totalTokens: 3 } });
      t.mock.timers.tick(299999);
      assert.equal(fs.existsSync(dataFile), false);
      t.mock.timers.tick(1);
      assert.equal(readStore(dataFile).devices.b.periods.today.totalTokens, 3);
    } else {
      await hub.stop();
    }
    assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 7);
  });
}

for (const mutation of ['subscription', 'deletion']) {
  for (const recovery of ['timer', 'shutdown']) {
    test(`failed ${mutation} rolls back while accepted uploads survive ${recovery}`, async (t) => {
      t.mock.timers.enable({ apis: ['setTimeout'] });
      const { hub, dataFile } = fixture(t);
      const subscription = (id) => ({ id, provider: 'codex', startDate: '2026-05-31', currency: 'USD' });
      hub.ingest({ deviceId: 'existing', today: { totalTokens: 1 } });
      hub.setSubscriptions([subscription('original')], '');
      const before = readStore(dataFile);
      const previousSubscriptions = hub.getSubscriptions();
      hub.ingest({ deviceId: 'existing', today: { totalTokens: 9 } });
      hub.ingest({ deviceId: 'pending', today: { totalTokens: 4 } });
      const blockedTempFile = `${dataFile}.tmp`;
      fs.mkdirSync(blockedTempFile);
      try {
        assert.throws(() => {
          if (mutation === 'subscription') {
            hub.setSubscriptions([subscription('replacement')], previousSubscriptions.updatedAt);
          } else {
            hub.deleteDevice('existing');
          }
        });
        assert.deepEqual(hub.getSubscriptions(), previousSubscriptions);
        assert.equal(hub.getDevices().find((device) => device.deviceId === 'existing').periods.today.totalTokens, 9);
        assert.equal(hub.getStats().periods.today.totalTokens, 13);
        assert.deepEqual(readStore(dataFile), before);
      } finally {
        fs.rmdirSync(blockedTempFile);
      }
      if (recovery === 'timer') t.mock.timers.tick(300000);
      else await hub.stop();
      const saved = readStore(dataFile);
      assert.equal(saved.devices.existing.periods.today.totalTokens, 9);
      assert.equal(saved.devices.pending.periods.today.totalTokens, 4);
      assert.deepEqual(saved.subscriptions, before.subscriptions);
      assert.deepEqual(saved.syncTitlePolicies, before.syncTitlePolicies);
    });
  }
}

test('createHub rejects intervals that Node would coerce to a one-millisecond timer', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-invalid-interval-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const dataFile = path.join(dir, 'devices.json');
  for (const persistIntervalMs of [NaN, Infinity, -Infinity, -1, 2147483648]) {
    assert.throws(() => createHub({ dataFile, persistIntervalMs }), {
      name: 'RangeError', message: /persistIntervalMs.*0.*2147483647/
    });
  }
  assert.equal(fs.existsSync(dataFile), false);
});

test('the maximum supported interval keeps its full save deadline', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t, 2147483647);
  hub.ingest({ deviceId: 'a', today: { totalTokens: 5 } });
  t.mock.timers.tick(2147483646);
  assert.equal(fs.existsSync(dataFile), false);
  t.mock.timers.tick(1);
  assert.equal(readStore(dataFile).devices.a.periods.today.totalTokens, 5);
});

test('invalid CLI and environment intervals fail before the standalone Hub starts', () => {
  const serverFile = path.resolve(__dirname, '../../src/hub/server.js');
  for (const { args, value } of [
    { args: ['--persistIntervalMs=invalid'], value: '3600000' },
    { args: [], value: '2147483648' }
  ]) {
    const result = spawnSync(process.execPath, [serverFile, '--port=0', ...args], {
      env: { ...process.env, TOKEN_MONITOR_SECRET: 'test-secret', TOKEN_MONITOR_PERSIST_INTERVAL_MS: value },
      encoding: 'utf8', timeout: 5000
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, /persistIntervalMs must be a finite number/);
    assert.doesNotMatch(result.stdout, /hub listening/);
  }
});

test('a missing CLI persistence value fails startup even with a valid environment fallback', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-missing-interval-'));
  t.after(() => fs.rmSync(dir, { recursive: true }));
  const dataFile = path.join(dir, 'devices.json');
  const serverFile = path.resolve(__dirname, '../../src/hub/server.js');
  for (const value of ['', '300000']) {
    for (const args of [
      ['--persistIntervalMs'],
      ['--persistIntervalMs', '--syncSessionTitles'],
      ['--persistIntervalMs='],
      ['--persistIntervalMs', '   ']
    ]) {
      const result = spawnSync(process.execPath, [serverFile, '--host=127.0.0.1', '--port=0', `--dataFile=${dataFile}`, ...args], {
        env: { ...process.env, TOKEN_MONITOR_SECRET: 'test-secret', TOKEN_MONITOR_PERSIST_INTERVAL_MS: value },
        encoding: 'utf8', timeout: 5000
      });
      assert.doesNotMatch(result.stdout, /hub listening|Persistence interval:/);
      assert.equal(result.error, undefined);
      assert.equal(result.status, 1);
      assert.match(result.stderr, /--persistIntervalMs requires a numeric value/);
      assert.equal(fs.existsSync(dataFile), false);
    }
  }
});

test('shared settings and title revocation save immediately during a pending batch', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const { hub, dataFile } = fixture(t, 300000, { syncSessionTitles: true });
  const policy = hub.setSyncTitlePolicy('a', true);
  hub.ingest({
    deviceId: 'a', sessionTitleSyncGeneration: policy.generation,
    today: { totalTokens: 2, sessions: {
      'codex:a': { client: 'codex', sessionId: 'a', totalTokens: 2, title: 'shared title' }
    } }
  });
  hub.setSyncSettings('customPricing', { baseRevision: 0, value: [] });
  let stored = readStore(dataFile);
  assert.equal(stored.syncSettings.customPricing.revision, 1);
  assert.equal(stored.devices.a.periods.today.sessions['codex:a'].title, 'shared title');
  hub.ingest({ deviceId: 'b', today: { totalTokens: 3 } });
  hub.setSyncTitlePolicy('a', false);
  stored = readStore(dataFile);
  assert.equal(stored.syncTitlePolicies.a.enabled, false);
  assert.equal(stored.devices.a.periods.today.sessions['codex:a'].title, undefined);
  assert.equal(stored.devices.b.periods.today.totalTokens, 3);
  const inode = fs.statSync(dataFile).ino;
  t.mock.timers.tick(300000);
  assert.equal(fs.statSync(dataFile).ino, inode);
});

test('startup title cleanup saves immediately even when batching is enabled', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-startup-cleanup-'));
  const dataFile = path.join(dir, 'devices.json');
  fs.writeFileSync(dataFile, JSON.stringify({
    version: 1,
    devices: {
      a: { deviceId: 'a', today: { sessions: {
        'codex:a': { client: 'codex', sessionId: 'a', title: 'old shared title' }
      } } }
    },
    syncTitlePolicies: { a: { enabled: true, generation: 1 } }
  }));
  const hub = createHub({ dataFile, persistIntervalMs: 300000, syncSessionTitles: false });
  t.after(async () => {
    await hub.stop();
    fs.rmSync(dir, { recursive: true });
  });
  const stored = readStore(dataFile);
  assert.equal(stored.syncTitlePolicies.a.enabled, false);
  assert.doesNotMatch(fs.readFileSync(dataFile, 'utf8'), /old shared title/);
});

test('stop waits for an in-flight upload before saving the final snapshot', async (t) => {
  const { hub, dataFile } = fixture(t);
  await hub.start();
  const requested = once(hub.server, 'request');
  const request = http.request({
    host: '127.0.0.1', port: hub.server.address().port,
    path: '/api/ingest', method: 'POST', headers: { 'content-type': 'application/json' }
  });
  const response = new Promise((resolve, reject) => {
    request.on('response', (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    request.on('error', reject);
  });
  request.write('{"deviceId":"in-flight","today":');
  await requested;
  const stopped = hub.stop();
  request.end('{"totalTokens":17}}');
  assert.equal(await response, 200);
  await stopped;
  assert.equal(readStore(dataFile).devices['in-flight'].periods.today.totalTokens, 17);
});

for (const consumeRequest of [false, true]) {
  test(`stop ends an open SSE response and saves pending records (request consumed: ${consumeRequest})`, async (t) => {
    const { hub, dataFile } = fixture(t);
    if (consumeRequest) hub.server.on('request', (req) => req.resume());
    await hub.start();
    let request;
    const response = await new Promise((resolve, reject) => {
      request = http.get(`http://127.0.0.1:${hub.server.address().port}/api/stats/stream`, (res) => {
        res.once('data', () => resolve(res));
      });
      request.on('error', reject);
    });
    const streamEnded = once(response, 'end');
    hub.ingest({ deviceId: 'sse-pending', today: { totalTokens: 19 } });
    assert.equal(fs.existsSync(dataFile), false);
    const stopped = hub.stop();
    let timeout;
    try {
      await Promise.race([
        Promise.all([stopped, streamEnded]),
        new Promise((_, reject) => {
          timeout = setTimeout(() => reject(new Error('SSE response blocked Hub shutdown')), 2000);
        })
      ]);
      assert.equal(readStore(dataFile).devices['sse-pending'].periods.today.totalTokens, 19);
    } finally {
      clearTimeout(timeout);
      request.destroy();
      await stopped;
    }
  });
}

test('standalone SIGTERM saves an accepted upload before exiting', { skip: process.platform === 'win32' }, async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-signal-'));
  const dataFile = path.join(dir, 'devices.json');
  const listener = net.createServer();
  listener.listen(0, '127.0.0.1');
  await once(listener, 'listening');
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  const child = spawn(process.execPath, [
    path.resolve(__dirname, '../../src/hub/server.js'),
    `--port=${port}`, '--host=127.0.0.1', `--dataFile=${dataFile}`,
    '--persistIntervalMs=300000'
  ], { env: { ...process.env, TOKEN_MONITOR_SECRET: 'test-secret' } });
  t.after(() => {
    child.kill('SIGKILL');
    fs.rmSync(dir, { recursive: true });
  });
  const exited = once(child, 'exit');
  await new Promise((resolve, reject) => {
    child.stdout.on('data', (chunk) => {
      if (String(chunk).includes('hub listening')) resolve();
    });
    child.once('error', reject);
    child.once('exit', (code) => reject(new Error(`Hub exited before listening: ${code}`)));
  });
  const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer test-secret' },
    body: JSON.stringify({ deviceId: 'signal-test', today: { totalTokens: 11 } })
  });
  assert.equal(response.status, 200);
  await response.json();
  assert.equal(fs.existsSync(dataFile), false);
  child.kill('SIGTERM');
  const [code, signal] = await exited;
  assert.equal(code, 0);
  assert.equal(signal, null);
  assert.equal(readStore(dataFile).devices['signal-test'].periods.today.totalTokens, 11);
});
