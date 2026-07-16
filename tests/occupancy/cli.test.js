'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const http = require('node:http');
const { EventEmitter } = require('node:events');

const {
  CliError,
  accountPayload,
  connectionConfig,
  createHubClient,
  execute,
  parseCommandLine,
  runWithLease
} = require('../../src/occupancy/cli');

test('connectionConfig reuses the existing Token Monitor Hub settings', () => {
  assert.deepEqual(connectionConfig({}, {
    TOKEN_MONITOR_HUB_URL: 'http://hub.local:17321/',
    TOKEN_MONITOR_SECRET: 'shared',
    TOKEN_MONITOR_DEVICE_ID: 'desktop-a',
    TOKEN_MONITOR_DEVICE_NAME: 'Desktop A'
  }), {
    hubUrl: 'http://hub.local:17321',
    secret: 'shared',
    deviceId: 'desktop-a',
    deviceName: 'Desktop A',
    json: false
  });
});

function outputBuffer() {
  const output = { stdout: '', stderr: '' };
  return {
    output,
    io: {
      stdout: { write(value) { output.stdout += value; } },
      stderr: { write(value) { output.stderr += value; } }
    }
  };
}

test('parseCommandLine accepts global connection flags and preserves child arguments after --', () => {
  const parsed = parseCommandLine([
    '--hub-url', 'http://hub.test:17321', '--json', 'run',
    '--account', 'Claude Main', '--task=review', '--', 'claude', '--dangerously-skip-permissions'
  ]);

  assert.equal(parsed.command, 'run');
  assert.equal(parsed.options['hub-url'], 'http://hub.test:17321');
  assert.equal(parsed.options.json, true);
  assert.equal(parsed.options.account, 'Claude Main');
  assert.equal(parsed.options.task, 'review');
  assert.deepEqual(parsed.childCommand, ['claude', '--dangerously-skip-permissions']);
});

test('parseCommandLine recognizes account subcommands and references', () => {
  const parsed = parseCommandLine(['account', 'update', 'work', '--max-concurrency', '3', '--disabled']);
  assert.equal(parsed.command, 'account');
  assert.equal(parsed.subcommand, 'update');
  assert.deepEqual(parsed.positionals, ['work']);
  assert.equal(parsed.options['max-concurrency'], '3');
  assert.equal(parsed.options.disabled, true);
});

test('accountPayload validates create fields and builds partial updates', () => {
  assert.deepEqual(accountPayload({
    provider: 'claude', alias: 'work', 'max-concurrency': '2', identity: 'w***@example.com'
  }), {
    provider: 'claude', alias: 'work', maxConcurrency: 2, maskedIdentity: 'w***@example.com'
  });
  assert.deepEqual(accountPayload({ alias: 'personal', enabled: 'false' }, { partial: true }), {
    alias: 'personal', enabled: false
  });
  assert.throws(
    () => accountPayload({ provider: 'claude', alias: 'bad', 'max-concurrency': '0' }),
    /positive integer/
  );
  assert.throws(() => accountPayload({}, { partial: true }), /No account fields/);
});

test('accountPayload accepts the canonical advisory threshold name', () => {
  assert.deepEqual(accountPayload({
    provider: 'chatgpt', alias: 'main', 'advisory-threshold': '3'
  }), {
    provider: 'chatgpt', alias: 'main', maxConcurrency: 3
  });
});

test('accountPayload accepts an explicit quota provider and stable account key', () => {
  assert.deepEqual(accountPayload({
    provider: 'chatgpt',
    alias: 'GPT Pro',
    'advisory-threshold': '2',
    'quota-provider': 'codex',
    'quota-account-key': 'sha256:account-one'
  }), {
    provider: 'chatgpt',
    alias: 'GPT Pro',
    maxConcurrency: 2,
    quotaLink: {
      provider: 'codex',
      accountKey: 'sha256:account-one',
      accountEmail: ''
    }
  });
});

test('Hub client uses canonical occupancy endpoints and bearer authentication', async () => {
  const requests = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.setEncoding('utf8');
    req.on('data', (chunk) => { body += chunk; });
    req.on('end', () => {
      requests.push({ method: req.method, url: req.url, authorization: req.headers.authorization, body: body ? JSON.parse(body) : null });
      res.writeHead(200, { 'content-type': 'application/json' });
      if (req.url === '/api/occupancy/accounts') res.end(JSON.stringify({ accounts: [{ id: 'acct-1', alias: 'work' }] }));
      else if (req.url === '/api/occupancy/leases') res.end(JSON.stringify({ leaseId: 'lease-1', fenceToken: 'fence-1' }));
      else res.end(JSON.stringify({ ok: true }));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const client = createHubClient({ hubUrl: `http://127.0.0.1:${server.address().port}`, secret: 'shared-secret' });
    await client.listAccounts();
    await client.startLease({ accountId: 'acct-1', deviceId: 'dev-1' });
    await client.heartbeat('lease/one', { fenceToken: 'fence-1' });
    await client.stopLease('lease/one', { fenceToken: 'fence-1' });

    assert.deepEqual(requests.map(({ method, url }) => [method, url]), [
      ['GET', '/api/occupancy/accounts'],
      ['POST', '/api/occupancy/leases'],
      ['POST', '/api/occupancy/leases/lease%2Fone/heartbeat'],
      ['DELETE', '/api/occupancy/leases/lease%2Fone']
    ]);
    assert.ok(requests.every((request) => request.authorization === 'Bearer shared-secret'));
    assert.deepEqual(requests[1].body, { accountId: 'acct-1', deviceId: 'dev-1' });
    assert.deepEqual(requests[3].body, { fenceToken: 'fence-1' });
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test('Hub client exposes structured capacity errors', async () => {
  const client = createHubClient({
    hubUrl: 'http://hub.test',
    secret: '',
    fetchImpl: async () => new Response(JSON.stringify({ error: 'capacity_exceeded', message: 'Account is full' }), {
      status: 409,
      headers: { 'content-type': 'application/json' }
    })
  });

  await assert.rejects(
    client.startLease({ accountId: 'full' }),
    (error) => error instanceof CliError && error.status === 409 && error.code === 'capacity_exceeded'
  );
});

test('execute resolves an account alias before starting a manual lease', async () => {
  const calls = [];
  const client = {
    async listAccounts() { return { accounts: [{ id: 'acct-1', alias: 'Claude Main' }] }; },
    async startLease(payload) { calls.push(payload); return { leaseId: 'lease-1', fenceToken: 'fence-1' }; }
  };
  const { io, output } = outputBuffer();
  const parsed = parseCommandLine(['start', '--account', 'claude main', '--task', 'API work', '--project', 'Dashboard']);
  const code = await execute(parsed, { client, io, env: { TOKEN_MONITOR_DEVICE_ID: 'desktop-a' } });

  assert.equal(code, 0);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].accountId, 'acct-1');
  assert.equal(calls[0].deviceId, 'desktop-a');
  assert.equal(calls[0].taskLabel, 'API work');
  assert.equal(calls[0].projectLabel, 'Dashboard');
  assert.equal(calls[0].source, 'manual');
  assert.match(output.stdout, /lease-1/);
});

test('runWithLease releases exactly once after the child exits and preserves its exit code', async () => {
  const calls = [];
  const client = {
    async startLease(payload) {
      calls.push(['start', payload]);
      return { leaseId: 'lease-1', fenceToken: 'fence-1' };
    },
    async heartbeat(id, payload) { calls.push(['heartbeat', id, payload]); },
    async stopLease(id, payload) { calls.push(['stop', id, payload]); return { ok: true }; }
  };
  const child = new EventEmitter();
  child.kill = () => true;
  const spawnImpl = (command, args, options) => {
    calls.push(['spawn', command, args, options.shell]);
    process.nextTick(() => child.emit('close', 7, null));
    return child;
  };
  const signalEmitter = new EventEmitter();
  const { io } = outputBuffer();

  const code = await runWithLease({
    client,
    accountId: 'acct-1',
    command: ['fake-ai', '--task'],
    labels: { project: 'Dashboard' },
    connection: { deviceId: 'desktop-a', deviceName: 'Desktop A' },
    env: { TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS: '1000', TOKEN_MONITOR_OCCUPANCY_TTL_MS: '3000' },
    io,
    spawnImpl,
    signalEmitter
  });

  assert.equal(code, 7);
  assert.equal(calls.filter(([name]) => name === 'stop').length, 1);
  assert.equal(calls.find(([name]) => name === 'start')[1].source, 'wrapper');
  assert.equal(calls.find(([name]) => name === 'stop')[2].fenceToken, 'fence-1');
  assert.equal(calls.find(([name]) => name === 'stop')[2].reason, 'exit_7');
  assert.deepEqual(calls.find(([name]) => name === 'spawn').slice(1, 4), [
    'fake-ai',
    ['--task'],
    process.platform === 'win32'
  ]);
  assert.equal(signalEmitter.listenerCount('SIGINT'), 0);
});

test('runWithLease starts the original command when occupancy reporting fails', async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let spawned = false;
  const { io, output } = outputBuffer();

  const code = await runWithLease({
    client: {
      async startLease() { throw new Error('Hub offline'); },
      async heartbeat() { throw new Error('should not heartbeat'); },
      async stopLease() { throw new Error('should not release'); }
    },
    accountId: 'acct-1',
    command: ['fake-ai'],
    labels: {},
    connection: { deviceId: 'desktop-a', deviceName: 'Desktop A' },
    env: { TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS: '1000', TOKEN_MONITOR_OCCUPANCY_TTL_MS: '3000' },
    io,
    spawnImpl: () => {
      spawned = true;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    },
    signalEmitter: new EventEmitter()
  });

  assert.equal(code, 0);
  assert.equal(spawned, true);
  assert.match(output.stderr, /starting command without it: Hub offline/);
});

test('runWithLease starts the original command when occupancy timing is invalid', async () => {
  const child = new EventEmitter();
  child.kill = () => true;
  let spawned = false;
  const { io, output } = outputBuffer();

  const code = await runWithLease({
    client: { async startLease() { throw new Error('should not start a lease'); } },
    accountId: 'acct-1',
    command: ['fake-ai'],
    labels: {},
    connection: { deviceId: 'desktop-a', deviceName: 'Desktop A' },
    env: { TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS: '5000', TOKEN_MONITOR_OCCUPANCY_TTL_MS: '3000' },
    io,
    spawnImpl: () => {
      spawned = true;
      process.nextTick(() => child.emit('close', 0, null));
      return child;
    },
    signalEmitter: new EventEmitter()
  });

  assert.equal(code, 0);
  assert.equal(spawned, true);
  assert.match(output.stderr, /invalid occupancy timing configuration; starting command without reporting/);
});

test('runWithLease forwards an interrupt and releases the lease only once', async () => {
  const stops = [];
  let finishRelease;
  const client = {
    async startLease() { return { lease: { id: 'lease-signal', fenceToken: 'long-fence-token-value' } }; },
    async heartbeat() {},
    async stopLease(id, payload) {
      stops.push({ id, payload });
      return new Promise((resolve) => { finishRelease = resolve; });
    }
  };
  const child = new EventEmitter();
  const killed = [];
  child.kill = (signal) => {
    killed.push(signal);
    process.nextTick(() => child.emit('close', null, signal));
    return true;
  };
  const signalEmitter = new EventEmitter();
  const { io } = outputBuffer();
  const pending = runWithLease({
    client,
    accountId: 'acct-1',
    command: ['fake-ai'],
    labels: {},
    connection: { deviceId: 'desktop-a', deviceName: 'Desktop A' },
    env: { TOKEN_MONITOR_OCCUPANCY_HEARTBEAT_MS: '1000', TOKEN_MONITOR_OCCUPANCY_TTL_MS: '3000' },
    io,
    spawnImpl: () => child,
    signalEmitter
  });
  await new Promise((resolve) => setImmediate(resolve));
  signalEmitter.emit('SIGINT');
  await new Promise((resolve) => setImmediate(resolve));

  assert.deepEqual(killed, ['SIGINT']);
  assert.equal(stops.length, 1);
  assert.equal(stops[0].payload.fenceToken, 'long-fence-token-value');
  assert.equal(stops[0].payload.reason, 'signal_sigint');
  finishRelease({ ok: true });
  assert.equal(await pending, 130);
});

test('manual stop requires a fence token', async () => {
  const parsed = parseCommandLine(['stop', 'lease-1']);
  await assert.rejects(
    execute(parsed, { client: {}, io: outputBuffer().io, env: {} }),
    /Missing required option --fence-token/
  );
});
