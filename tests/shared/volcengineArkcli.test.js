'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fetchVolcengineLimits } = require('../../src/shared/providers/volcengine/limits');
const { parseArkcliPlan, runArkcli } = require('../../src/shared/providers/volcengine/arkcli');
const now = '2026-09-10T06:00:00Z';
function response(product = 'agent-plan') {
  return { viewer: { account_id: 'account', user_id: 'user', region: 'cn-beijing' }, items: [
    product === 'coding-plan'
      ? { product, subscribed: false }
      : { product, subscribed: true, tier: 'medium', periods: [
        { label: '5h', used: 25, total: 100, reset_at: '2026-09-10T16:00:00+08:00' },
        { label: 'weekly', used: 0, total: 500 },
        { label: 'monthly', used: 600, total: 500 }
      ] }
  ] };
}
function codingResponse() {
  const body = response();
  body.items = [{ product: 'coding-plan', edition: 'personal', subscribed: true, periods: [
    { label: 'session', percent: 0, reset_at: '2026-09-10T16:00:00+08:00' },
    { label: 'weekly', percent: 12.5 },
    { label: 'monthly', percent: 24.6787843, reset_at: '2026-10-09T23:59:59+08:00' }
  ] }];
  return body;
}
const auth = { logged_in: true, auth_method: 'sso', active_profile: { name: 'personal' } };
// `usage plan` reports subscribed:true for products the account never bought,
// so the subscription list drives which products a test allows through.
function subscriptions(...keys) {
  return { plans: keys.map(key => ({ key, scope: 'personal', status: 'Running' })) };
}
function cliMock(handler, keys = ['agent-plan', 'coding-plan']) {
  return async args => args[0] === 'plans' ? subscriptions(...keys) : handler(args);
}
test('logged-in CLI reports normalized quotas and pins the authenticated profile', async () => {
  const calls = [];
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args => {
    calls.push(args); return args[0] === 'auth' ? auth : response(args[3]);
  }) });
  assert.equal(rows[0].source, 'cli');
  assert.equal(rows[0].status, 'ok');
  assert.equal(rows[0].accountLabel, 'Agent Plan');
  assert.equal(rows[0].windows[0].remaining, 75);
  assert.equal(rows[0].windows[0].resetsAt, '2026-09-10T08:00:00.000Z');
  assert.equal(rows[0].windows[1].usedPercent, 0);
  assert.equal(rows[0].windows[2].remaining, 0);
  assert.deepEqual(calls[1], ['usage', 'plan', '--product', 'agent-plan', '--format', 'json', '--profile', 'personal']);
  assert.ok(!JSON.stringify(rows).includes('account_id'));
});
test('STS-only login is accepted; absent login never queries quota', async () => {
  for (const logged_in of [true, false]) {
    let count = 0;
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args => {
      count += 1;
      return args[0] === 'auth' ? { ...auth, logged_in, auth_method: 'sts' } : response(args[3]);
    }) });
    if (!logged_in) assert.equal(count, 1);
    assert.equal(rows[0].status, logged_in ? 'ok' : 'notConfigured');
  }
});
test('missing executable and explicit opt-out stay unconfigured', async () => {
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async () => {
    throw Object.assign(new Error('private output'), { status: 'notConfigured' });
  } });
  assert.equal(rows[0].status, 'notConfigured');
  await fetchVolcengineLimits({}, { env: { TOKEN_MONITOR_VOLCENGINE_ARKCLI: '0' },
    runArkcli: () => assert.fail('must not invoke') });
});
test('incomplete explicit account never falls through to a different CLI identity', async () => {
  const rows = await fetchVolcengineLimits({ volcengineAccessKeyId: 'AKLT-test' }, {
    env: {}, runArkcli: () => assert.fail('must not invoke') });
  assert.equal(rows[0].status, 'notConfigured');
});
test('no subscription is hidden, while errors and malformed quota are unavailable', async () => {
  for (const variant of ['none', 'error', 'missing', 'null-used', 'bad-total', 'empty', 'unknown', 'zero']) {
    const body = response();
    if (variant === 'none') body.items[0].subscribed = false;
    if (variant === 'error') body.items[0].error = 'sensitive upstream response';
    if (variant === 'missing') body.items = [];
    if (variant === 'null-used') body.items[0].periods[0].used = null;
    if (variant === 'bad-total') body.items[0].periods[0].total = '100';
    if (variant === 'empty') body.items[0].periods = [];
    if (variant === 'unknown') body.items[0].periods = [{ label: 'unsupported', used: 1, total: 10 }];
    if (variant === 'zero') body.items[0].periods = [{ label: '5h', used: 0, total: 0 }];
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args =>
      args[0] === 'auth' ? auth : args[3] === 'coding-plan' ? response('coding-plan') : body) });
    assert.equal(rows[0].status, variant === 'none' ? 'notConfigured' : 'unavailable');
    assert.ok(!JSON.stringify(rows).includes('sensitive'));
  }
});
// Match the CLI's actual post-reset JSON: zero usage and reset_at are omitted.
function resetResponse() {
  const body = response();
  body.items[0].periods[0] = { label: '5h', total: 100, percent: 0 };
  return body;
}
test('omitted zero usage is accepted for every recognized window', () => {
  for (const label of ['5h', 'daily', 'weekly', 'monthly']) {
    const body = resetResponse();
    body.items[0].periods = [{ label, total: 100, percent: 0 }];
    const row = parseArkcliPlan(body, now, 'agent-plan');
    assert.equal(row.status, 'ok');
    assert.equal(row.updatedAt, new Date(now).toISOString());
    assert.equal(row.windows[0].used, 0);
    assert.equal(row.windows[0].remaining, 100);
    assert.equal(row.windows[0].usedPercent, 0);
    assert.equal(row.windows[0].resetsAt, null);
  }
});
test('zero percent does not turn unknown or invalid amounts into zero usage', () => {
  const invalidPeriods = [
    { total: 100 },
    ...[null, '0', 1, -1].map(percent => ({ total: 100, percent })),
    ...[null, '0', -1, NaN, Infinity].map(used => ({ total: 100, percent: 0, used })),
    ...[null, '100', -1, NaN, Infinity, 0].map(total => ({ total, percent: 0 }))
  ];
  for (const period of invalidPeriods) {
    const body = resetResponse();
    body.items[0].periods = [{ label: '5h', ...period }];
    assert.throws(() => parseArkcliPlan(body, now, 'agent-plan'), /arkcli quota probe failed/);
  }
});
test('a CLI zero-usage refresh replaces retained stale quota after a failure', async (t) => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  let body = response();
  let time = Date.parse(now);
  const runtime = createLimitsRuntime({ limitProviders: ['volcengine'] }, {
    autoStart: false,
    now: () => time,
    probeProvider: () => fetchVolcengineLimits({}, {
      env: {}, now: () => time,
      runArkcli: cliMock(async args => args[0] === 'auth' ? auth : args[3] === 'coding-plan' ? response('coding-plan') : body)
    })
  });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'manual');
  const first = runtime.getSnapshot().providers[0];
  assert.equal(first.status, 'ok');
  body = resetResponse();
  body.items[0].periods[0].used = null;
  time += 300_000;
  await runtime.refresh({}, 'manual');
  const failed = runtime.getSnapshot().providers[0];
  assert.equal(failed.status, 'unavailable');
  assert.equal(failed.updatedAt, first.updatedAt);
  assert.deepEqual(failed.windows, first.windows);
  body = resetResponse();
  time += 300_000;
  await runtime.refresh({}, 'manual');
  const recovered = runtime.getSnapshot().providers[0];
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.accountKey, first.accountKey);
  assert.equal(recovered.updatedAt, new Date(time).toISOString());
  assert.equal(recovered.windows[0].used, 0);
  assert.equal(recovered.windows[0].remaining, 100);
  assert.equal(recovered.windows[0].resetsAt, null);
  assert.deepEqual(recovered.windows.slice(1), first.windows.slice(1));
});
test('CLI identities remain distinct between users and stable across plan upgrades', () => {
  const first = parseArkcliPlan(response(), now, 'agent-plan');
  const other = response(); other.viewer.user_id = 'different';
  assert.notEqual(parseArkcliPlan(other, now, 'agent-plan').accountKey, first.accountKey);
  const upgraded = response(); upgraded.items[0].tier = 'max';
  assert.equal(parseArkcliPlan(upgraded, now, 'agent-plan').accountKey, first.accountKey);
});
test('personal Coding Plan reports authoritative percentages without invented absolute quota', async () => {
  const unsubscribed = response(); unsubscribed.items[0].subscribed = false;
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args =>
    args[0] === 'auth' ? auth : args[3] === 'coding-plan' ? codingResponse() : unsubscribed) });
  assert.equal(rows.length, 1);
  const [row] = rows;
  assert.equal(row.status, 'ok');
  assert.equal(row.accountLabel, 'Coding Plan');
  assert.deepEqual(row.windows.map(window => window.kind), ['session', 'weekly', 'billing']);
  assert.deepEqual(row.windows.map(window => window.usedPercent), [0, 12.5, 24.6787843]);
  assert.equal(row.windows[0].resetsAt, '2026-09-10T08:00:00.000Z');
  assert.equal(row.windows[1].resetsAt, null);
  for (const window of row.windows) {
    assert.equal(window.used, null);
    assert.equal(window.limit, null);
    assert.equal(window.remaining, null);
    assert.ok(Math.abs(window.remainingPercent - (100 - window.usedPercent)) < 0.001);
  }
});
test('Coding and Agent Plans coexist with distinct stable identities', async () => {
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args =>
    args[0] === 'auth' ? auth : args[3] === 'coding-plan' ? codingResponse() : response()) });
  assert.deepEqual(rows.map(row => row.accountLabel), ['Agent Plan', 'Coding Plan']);
  assert.equal(rows[0].accountKey, parseArkcliPlan(response(), now, 'agent-plan').accountKey);
  assert.notEqual(rows[0].accountKey, rows[1].accountKey);
  const upgraded = codingResponse(); upgraded.items[0].tier = 'max';
  assert.equal(parseArkcliPlan(upgraded, now, 'coding-plan').accountKey, rows[1].accountKey);
});
test('a plan missing from the subscription list is never shown as a phantom quota', async () => {
  // `usage plan --product agent-plan` claims subscribed:true with all-zero
  // periods on an account that only bought Coding Plan.
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args => {
    if (args[0] === 'auth') return auth;
    return args[3] === 'coding-plan' ? codingResponse() : response();
  }, ['coding-plan']) });
  assert.deepEqual(rows.map(row => row.accountLabel), ['Coding Plan']);
  assert.deepEqual(rows[0].windows.map(window => window.kind), ['session', 'weekly', 'billing']);
});
test('an account owning no personal plan reports unconfigured without probing quotas', async () => {
  const calls = [];
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async args => {
    calls.push(args);
    return args[0] === 'plans' ? subscriptions() : auth;
  } });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].status, 'notConfigured');
  assert.deepEqual(calls, [
    ['auth', 'status', '--format', 'json'],
    ['plans', 'get', '--format', 'json', '--profile', 'personal']
  ]);
});
test('CLI builds without a subscription command still probe both personal plans', async () => {
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async args => {
    if (args[0] === 'plans') throw new Error('unknown command');
    if (args[0] === 'auth') return auth;
    return args[3] === 'coding-plan' ? codingResponse() : response();
  } });
  assert.deepEqual(rows.map(row => row.accountLabel), ['Agent Plan', 'Coding Plan']);
});
test('a failed sibling query does not hide a healthy personal plan', async () => {
  for (const product of ['agent-plan', 'coding-plan']) {
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: cliMock(async args => {
      if (args[0] === 'auth') return auth;
      if (args[3] !== product) throw new Error('private upstream error');
      return product === 'coding-plan' ? codingResponse() : response();
    }) });
    assert.equal(rows.length, 1);
    assert.equal(rows[0].status, 'ok');
    assert.equal(rows[0].accountLabel, product === 'coding-plan' ? 'Coding Plan' : 'Agent Plan');
    assert.ok(!JSON.stringify(rows).includes('private'));
  }
});
test('percentage-only CLI periods reject missing or invalid quota rather than showing zero', () => {
  for (const percent of [undefined, null, '0', -1, NaN, Infinity]) {
    const body = codingResponse();
    body.items[0].periods[0].percent = percent;
    assert.throws(() => parseArkcliPlan(body, now, 'coding-plan'), /arkcli quota probe failed/);
  }
  const body = codingResponse();
  body.items[0].periods[0].percent = 110;
  assert.equal(parseArkcliPlan(body, now, 'coding-plan').windows[0].usedPercent, 100);
});
test('current Agent Plan percentage-only periods retain unknown amounts and reset times', () => {
  const body = response();
  body.items[0].periods = [{ label: '5h', percent: 0 }, { label: 'weekly', percent: 25 }];
  const row = parseArkcliPlan(body, now, 'agent-plan');
  assert.equal(row.windows[0].usedPercent, 0);
  assert.equal(row.windows[0].resetsAt, null);
  assert.equal(row.windows[0].limit, null);
  assert.equal(row.windows[1].remainingPercent, 75);
});
test('a failed Coding Plan retains stale quota without staling a healthy Agent Plan', async (t) => {
  const { createLimitsRuntime } = require('../../src/shared/limits/runtime');
  let time = Date.parse(now);
  let failCoding = false;
  let coding = codingResponse();
  const runtime = createLimitsRuntime({ limitProviders: ['volcengine'] }, {
    autoStart: false,
    now: () => time,
    probeProvider: () => fetchVolcengineLimits({}, {
      env: {}, now: () => time, runArkcli: cliMock(async args => {
        if (args[0] === 'auth') return auth;
        if (args[3] === 'agent-plan') return response();
        if (failCoding) throw new Error('private upstream error');
        return coding;
      })
    })
  });
  t.after(() => runtime.stop());
  await runtime.refresh({}, 'manual');
  const first = runtime.getSnapshot().providers.find(row => row.accountLabel === 'Coding Plan');
  assert.equal(first.status, 'ok');
  time += 300_000;
  failCoding = true;
  await runtime.refresh({}, 'manual');
  const partial = runtime.getSnapshot().providers;
  const stale = partial.find(row => row.accountLabel === 'Coding Plan');
  assert.equal(stale.status, 'unavailable');
  assert.equal(stale.updatedAt, first.updatedAt);
  assert.deepEqual(stale.windows, first.windows);
  assert.equal(partial.find(row => row.accountLabel === 'Agent Plan').status, 'ok');
  time += 300_000;
  failCoding = false;
  coding = codingResponse();
  coding.items[0].periods[2].percent = 30;
  await runtime.refresh({}, 'manual');
  const recovered = runtime.getSnapshot().providers.find(row => row.accountLabel === 'Coding Plan');
  assert.equal(recovered.status, 'ok');
  assert.equal(recovered.accountKey, first.accountKey);
  assert.equal(recovered.updatedAt, new Date(time).toISOString());
  assert.equal(recovered.windows[2].usedPercent, 30);
});
function mockChild() {
  const child = new EventEmitter(); child.stdout = new PassThrough();
  child.kill = () => { setImmediate(() => child.emit('close', null)); return true; };
  return child;
}
test('process invocation is shell-free, noninteractive and suppresses implicit CLI updates', async () => {
  const value = await runArkcli(['auth', 'status'], { env: {}, spawn: (command, args, options) => {
    assert.equal(command, 'arkcli'); assert.equal(options.shell, false);
    assert.equal(options.stdio[0], 'ignore'); assert.equal(options.stdio[2], 'ignore');
    assert.equal(options.env.ARKCLI_NO_UPDATE_NOTIFIER, '1');
    const child = mockChild(); setImmediate(() => { child.stdout.write('{"ok":true}'); child.emit('close', 0); });
    return child;
  } });
  assert.equal(value.ok, true);
});
test('timeout terminates child and waits for close', async () => {
  let closed = false;
  const child = mockChild(); child.kill = () => {
    setTimeout(() => { closed = true; child.emit('close', null); }, 5); return true;
  };
  await assert.rejects(runArkcli([], { env: {}, arkcliTimeoutMs: 5, spawn: () => child }));
  assert.equal(closed, true);
});
test('cancellation before spawn prevents execution', async () => {
  const controller = new AbortController(); controller.abort();
  await assert.rejects(runArkcli([], { signal: controller.signal, spawn: () => assert.fail() }));
});
test('oversized output is terminated without reflecting output in the error', async () => {
  const child = mockChild();
  const result = runArkcli([], { env: {}, spawn: () => child });
  child.stdout.write('s'.repeat(1024 * 1024 + 1));
  await assert.rejects(result, /arkcli quota probe failed/);
});
test('npm launcher resolves to the native binary so cancellation targets the query', (t) => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { resolveArkcliCommand } = require('../../src/shared/providers/volcengine/arkcli');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-arkcli-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const pkg = path.join(root, 'ark-cli');
  fs.mkdirSync(path.join(pkg, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(pkg, 'bin'));
  const launcher = path.join(pkg, 'scripts', 'run.js');
  const binary = path.join(pkg, 'bin', 'arkcli-linux-amd64');
  fs.writeFileSync(launcher, ''); fs.writeFileSync(binary, '');
  const canonicalBinary = fs.realpathSync(binary);
  assert.equal(resolveArkcliCommand({ TOKEN_MONITOR_ARKCLI_COMMAND: launcher }, 'linux', 'x64'), canonicalBinary);
  // macOS temp roots themselves can be symlinks (/var -> /private/var).
  // Exercise that distinction on every platform, not just the macOS runner.
  const alias = path.join(root, 'linked-package');
  fs.symlinkSync(pkg, alias, process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(resolveArkcliCommand({
    TOKEN_MONITOR_ARKCLI_COMMAND: path.join(alias, 'scripts', 'run.js')
  }, 'linux', 'x64'), canonicalBinary);
});
test('known npm install locations survive Electron-style truncated PATH', (t) => {
  const fs = require('node:fs'); const path = require('node:path'); const os = require('node:os');
  const { resolveArkcliCommand } = require('../../src/shared/providers/volcengine/arkcli');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-arkcli-known-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const targetPlatform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[process.platform];
  const targetArch = { x64: 'amd64', arm64: 'arm64' }[process.arch];
  const env = process.platform === 'win32'
    ? { APPDATA: root, PATH: 'C:\\Windows\\System32' }
    : { HOME: root, PATH: '/usr/bin:/bin' };
  const shimDir = process.platform === 'win32'
    ? path.join(root, 'npm')
    : path.join(root, '.npm-global', 'bin');
  const pkg = process.platform === 'win32'
    ? path.join(shimDir, 'node_modules', '@volcengine', 'ark-cli')
    : path.join(root, '.npm-global', 'lib', 'node_modules', '@volcengine', 'ark-cli');
  const launcher = path.join(pkg, 'scripts', 'run.js');
  const binary = path.join(pkg, 'bin', `arkcli-${targetPlatform}-${targetArch}${process.platform === 'win32' ? '.exe' : ''}`);
  fs.mkdirSync(path.dirname(launcher), { recursive: true });
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(launcher, '');
  fs.writeFileSync(binary, '');
  fs.mkdirSync(shimDir, { recursive: true });
  if (process.platform === 'win32') {
    fs.writeFileSync(path.join(shimDir, 'arkcli.cmd'), '@echo off\r\n');
  } else {
    fs.symlinkSync(launcher, path.join(shimDir, 'arkcli'));
  }
  assert.equal(resolveArkcliCommand(env), fs.realpathSync(binary));
});
