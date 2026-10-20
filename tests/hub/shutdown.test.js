'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const { createHub } = require('../../src/hub/server');

function fixture(t, options = {}) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shutdown-'));
  const dataFile = path.join(directory, 'devices.json');
  const hub = createHub({ port: 0, host: '127.0.0.1', dataFile, persistIntervalMs: 300000, ...options });
  const sockets = [];
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    hub.server.closeAllConnections();
    await hub.stop();
    fs.rmSync(directory, { recursive: true, force: true });
  });
  return {
    hub, dataFile,
    read: () => JSON.parse(fs.readFileSync(dataFile, 'utf8')),
    async connect() {
      const connected = once(hub.server, 'connection');
      const socket = net.connect({ host: '127.0.0.1', port: hub.server.address().port });
      sockets.push(socket);
      socket.on('error', () => {});
      await Promise.all([once(socket, 'connect'), connected]);
      return socket;
    }
  };
}

function incompleteUpload(hub) {
  const requested = once(hub.server, 'request');
  const request = http.request({
    host: '127.0.0.1', port: hub.server.address().port, agent: false,
    path: '/api/ingest', method: 'POST', headers: { 'content-type': 'application/json' }
  });
  request.on('error', () => {});
  request.write('{"deviceId":"in-flight","today":');
  return { request, requested };
}

test('stop saves accepted uploads before waiting for a stuck request', async (t) => {
  const { hub, read } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const { request, requested } = incompleteUpload(hub);
  t.after(() => request.destroy());
  await requested;
  const stopped = hub.stop();
  try {
    assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
  } finally {
    request.destroy();
    hub.server.closeAllConnections();
    await stopped;
  }
});

test('stop keeps an admitted upload and saves its final data after draining', async (t) => {
  const { hub, read } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const { request, requested } = incompleteUpload(hub);
  t.after(() => request.destroy());
  const response = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
  });
  await requested;
  const stopped = hub.stop();
  request.end('{"totalTokens":17}}');
  assert.equal(await response, 200);
  await stopped;
  const devices = read().devices;
  assert.equal(devices.accepted.periods.today.totalTokens, 42);
  assert.equal(devices['in-flight'].periods.today.totalTokens, 17);
});

test('drained keep-alive uploads close without waiting for the force-close deadline', async (t) => {
  const { hub, read } = fixture(t);
  await hub.start();
  const agent = new http.Agent({ keepAlive: true });
  const requested = once(hub.server, 'request');
  const request = http.request({
    host: '127.0.0.1', port: hub.server.address().port, agent,
    path: '/api/ingest', method: 'POST', headers: { 'content-type': 'application/json' }
  });
  const response = new Promise((resolve, reject) => {
    request.once('error', reject);
    request.once('response', (res) => {
      res.resume();
      res.once('end', () => resolve(res.statusCode));
    });
  });
  request.write('{"deviceId":"keep-alive","today":');
  await requested;
  const stopped = hub.stop();
  let timeout;
  try {
    request.end('{"totalTokens":17}}');
    assert.equal(await response, 200);
    await Promise.race([
      stopped,
      new Promise((_, reject) => {
        timeout = setTimeout(() => reject(new Error('drained keep-alive socket blocked shutdown')), 2000);
      })
    ]);
    assert.equal(read().devices['keep-alive'].periods.today.totalTokens, 17);
  } finally {
    clearTimeout(timeout);
    request.destroy();
    agent.destroy();
    hub.server.closeAllConnections();
    await stopped;
  }
});

test('concurrent stops share completion and force-close a stuck upload after the drain deadline', async (t) => {
  const { hub, read } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const { request, requested } = incompleteUpload(hub);
  t.after(() => request.destroy());
  await requested;
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const forceClose = t.mock.method(hub.server, 'closeAllConnections');
  const stopped = hub.stop();
  try {
    t.mock.timers.tick(4999);
    assert.equal(forceClose.mock.callCount(), 0);
    t.mock.timers.tick(1);
    assert.equal(forceClose.mock.callCount(), 1);
    assert.equal(hub.stop(), stopped);
    await stopped;
    assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
    t.mock.timers.tick(300000);
    assert.equal(forceClose.mock.callCount(), 1);
  } finally {
    t.mock.timers.reset();
    request.destroy();
    hub.server.closeAllConnections();
    await stopped;
  }
});

for (const endpoint of ['/api/stats/stream', '/api/ingest']) {
  test(`a request on an existing connection cannot enter ${endpoint} after stop begins`, async (t) => {
    const { hub, connect, read } = fixture(t);
    await hub.start();
    hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
    const socket = await connect();
    let response = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => { response += chunk; });
    const closed = once(socket, 'close');
    const method = endpoint.endsWith('stream') ? 'GET' : 'POST';
    const body = JSON.stringify({ deviceId: 'late-upload', today: { totalTokens: 100 } });
    socket.write(`${method} ${endpoint} HTTP/1.1\r\nHost: localhost\r\nContent-Length: ${method === 'POST' ? Buffer.byteLength(body) : 0}\r\n`);
    const stopped = hub.stop();
    const requested = once(hub.server, 'request');
    socket.write(`\r\n${method === 'POST' ? body : ''}`);
    await requested;
    try {
      // Wait for the response data without relying on a wall-clock sleep. The old
      // SSE path stays open, so seeing its first frame also lets this test fail.
      while (!response.includes('\r\n\r\n')) await once(socket, 'data');
      assert.match(response, /^HTTP\/1\.1 503 /);
      assert.doesNotMatch(response, /text\/event-stream/);
      await Promise.all([closed, stopped]);
      assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
      assert.equal(read().devices['late-upload'], undefined);
    } finally {
      socket.destroy();
      hub.server.closeAllConnections();
      await stopped;
    }
  });
}

test('direct ingests cannot add pending data after stop; restarting restores admission', async (t) => {
  const { hub, read } = fixture(t);
  await hub.start();
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const stopped = hub.stop();
  assert.throws(() => hub.ingest({ deviceId: 'late' }), { code: 'hub_stopping' });
  await stopped;
  assert.throws(() => hub.ingest({ deviceId: 'late' }), { code: 'hub_stopping' });
  await hub.start();
  hub.ingest({ deviceId: 'restarted', today: { totalTokens: 7 } });
  await hub.stop();
  assert.equal(read().devices.restarted.periods.today.totalTokens, 7);
  assert.equal(read().devices.late, undefined);
});

test('start cannot reopen admission while stop is draining', async (t) => {
  const { hub } = fixture(t);
  await hub.start();
  const { request, requested } = incompleteUpload(hub);
  t.after(() => request.destroy());
  await requested;
  const stopped = hub.stop();
  try {
    await assert.rejects(hub.start(), /Hub is stopping/);
  } finally {
    request.destroy();
    hub.server.closeAllConnections();
    // The pre-fix control can reopen its listener while the first close waits.
    hub.server.close();
    await stopped;
  }
});

test('a failed pre-drain save is retried at final flush', async (t) => {
  const errors = [];
  const { hub, dataFile, read } = fixture(t, { logger: { error: (...args) => errors.push(args) } });
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const write = fs.writeFileSync;
  let attempts = 0;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === `${dataFile}.tmp` && ++attempts === 1) throw new Error('synthetic transient write failure');
    return write(file, ...args);
  });
  try {
    await hub.stop();
    assert.equal(attempts, 2);
    assert.equal(errors.length, 1);
    assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
  } finally {
    mocked.mock.restore();
  }
});

test('a final save failure rejects stop and a later stop can retry without losing pending data', async (t) => {
  const { hub, dataFile, read } = fixture(t, { logger: { error() {} } });
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === `${dataFile}.tmp`) throw new Error('synthetic persistent write failure');
    return write(file, ...args);
  });
  try {
    await assert.rejects(hub.stop(), /synthetic persistent write failure/);
  } finally {
    mocked.mock.restore();
  }
  await hub.stop();
  assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
});

test('restarting after a failed stop schedules retained pending data without another ingest', async (t) => {
  const { hub, dataFile, read } = fixture(t, { logger: { error() {} } });
  hub.ingest({ deviceId: 'accepted', today: { totalTokens: 42 } });
  const write = fs.writeFileSync;
  const mocked = t.mock.method(fs, 'writeFileSync', (file, ...args) => {
    if (file === `${dataFile}.tmp`) throw new Error('synthetic persistent write failure');
    return write(file, ...args);
  });
  try {
    await assert.rejects(hub.stop(), /synthetic persistent write failure/);
  } finally {
    mocked.mock.restore();
  }
  t.mock.timers.enable({ apis: ['setTimeout'] });
  await hub.start();
  t.mock.timers.tick(299999);
  assert.equal(fs.existsSync(dataFile), false);
  t.mock.timers.tick(1);
  assert.equal(read().devices.accepted.periods.today.totalTokens, 42);
});

async function waitFor(predicate, message, timeoutMs = 5000) {
  const deadline = Date.now() + timeoutMs;
  while (!await predicate()) {
    if (Date.now() >= deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function connectionRefused(port) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port });
    socket.once('connect', () => { socket.destroy(); resolve(false); });
    socket.once('error', () => { socket.destroy(); resolve(true); });
  });
}

for (const stalledRequest of ['unfinished POST', 'late SSE']) {
  test(`standalone SIGTERM saves and exits with ${stalledRequest}`, {
    skip: process.platform === 'win32', timeout: 15000
  }, async (t) => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-shutdown-signal-'));
    const dataFile = path.join(directory, 'devices.json');
    const listener = net.createServer();
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
    const port = listener.address().port;
    await new Promise((resolve) => listener.close(resolve));
    const child = spawn(process.execPath, [
      path.resolve(__dirname, '../../src/hub/server.js'), '--host=127.0.0.1',
      `--port=${port}`, `--dataFile=${dataFile}`, '--persistIntervalMs=300000'
    ], { env: { ...process.env, TOKEN_MONITOR_SECRET: 'synthetic-shutdown-secret' } });
    const exited = once(child, 'exit');
    let output = '', stderr = '', socket;
    child.stdout.on('data', (chunk) => { output += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    t.after(async () => {
      socket?.destroy();
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
      await exited;
      fs.rmSync(directory, { recursive: true, force: true });
    });
    await waitFor(() => {
      assert.equal(child.exitCode, null, stderr);
      return output.includes('hub listening');
    }, 'standalone Hub did not start');
    const response = await fetch(`http://127.0.0.1:${port}/api/ingest`, {
      method: 'POST', headers: { authorization: 'Bearer synthetic-shutdown-secret', 'content-type': 'application/json' },
      body: JSON.stringify({ deviceId: 'accepted', today: { totalTokens: 42 } })
    });
    assert.equal(response.status, 200);
    await response.json();
    assert.equal(fs.existsSync(dataFile), false);
    socket = net.connect({ host: '127.0.0.1', port });
    socket.on('error', () => {});
    socket.setEncoding('utf8');
    let reply = '';
    socket.on('data', (chunk) => { reply += chunk; });
    await once(socket, 'connect');
    const headers = `Host: localhost\r\nAuthorization: Bearer synthetic-shutdown-secret\r\n`;
    if (stalledRequest === 'unfinished POST') {
      socket.write(`POST /api/ingest HTTP/1.1\r\n${headers}Expect: 100-continue\r\nContent-Length: 1000\r\n\r\n{"deviceId":"unfinished",`);
      await waitFor(() => reply.includes('100 Continue'), 'stalled upload was not admitted');
    } else {
      socket.write(`GET /api/stats/stream HTTP/1.1\r\n${headers}`);
    }
    child.kill('SIGTERM');
    await waitFor(() => fs.existsSync(dataFile), 'shutdown did not flush before draining');
    assert.equal(JSON.parse(fs.readFileSync(dataFile)).devices.accepted.periods.today.totalTokens, 42);
    if (stalledRequest === 'late SSE') {
      await waitFor(() => connectionRefused(port), 'Hub did not stop listening');
      socket.write('\r\n');
    }
    const [code, signal] = await exited;
    assert.equal(code, 0, stderr);
    assert.equal(signal, null);
    assert.doesNotMatch(reply, /text\/event-stream/);
    assert.equal(JSON.parse(fs.readFileSync(dataFile)).devices.accepted.periods.today.totalTokens, 42);
  });
}
