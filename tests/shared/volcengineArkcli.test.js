'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { fetchVolcengineLimits } = require('../../src/shared/providers/volcengine/limits');
const { parseArkcliPlan, runArkcli } = require('../../src/shared/providers/volcengine/arkcli');
const now = '2026-09-10T06:00:00Z';
function response() {
  return { viewer: { account_id: 'account', user_id: 'user', region: 'cn-beijing' }, items: [
    { product: 'agent-plan', subscribed: true, tier: 'medium', periods: [
      { label: '5h', used: 25, total: 100, reset_at: '2026-09-10T16:00:00+08:00' },
      { label: 'weekly', used: 0, total: 500 },
      { label: 'monthly', used: 600, total: 500 }
    ] }
  ] };
}
const auth = { logged_in: true, auth_method: 'sso', active_profile: { name: 'personal' } };
test('logged-in CLI reports normalized quotas and pins the authenticated profile', async () => {
  const calls = [];
  const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async args => {
    calls.push(args); return calls.length === 1 ? auth : response();
  } });
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
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async () =>
      ++count === 1 ? { ...auth, logged_in, auth_method: 'sts' } : response() });
    assert.equal(count, logged_in ? 2 : 1);
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
    let count = 0;
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async () => ++count === 1 ? auth : body });
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
    const row = parseArkcliPlan(body, now);
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
    ...[undefined, null, '100', -1, NaN, Infinity, 0].map(total => ({ total, percent: 0 }))
  ];
  for (const period of invalidPeriods) {
    const body = resetResponse();
    body.items[0].periods = [{ label: '5h', ...period }];
    assert.throws(() => parseArkcliPlan(body, now), /arkcli quota probe failed/);
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
      runArkcli: async args => args[0] === 'auth' ? auth : body
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
  const first = parseArkcliPlan(response(), now);
  const other = response(); other.viewer.user_id = 'different';
  assert.notEqual(parseArkcliPlan(other, now).accountKey, first.accountKey);
  const upgraded = response(); upgraded.items[0].tier = 'max';
  assert.equal(parseArkcliPlan(upgraded, now).accountKey, first.accountKey);
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
