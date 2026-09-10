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
  for (const variant of ['none', 'error', 'missing', 'null-used', 'bad-total']) {
    const body = response();
    if (variant === 'none') body.items[0].subscribed = false;
    if (variant === 'error') body.items[0].error = 'sensitive upstream response';
    if (variant === 'missing') body.items = [];
    if (variant === 'null-used') body.items[0].periods[0].used = null;
    if (variant === 'bad-total') body.items[0].periods[0].total = '100';
    let count = 0;
    const rows = await fetchVolcengineLimits({}, { env: {}, runArkcli: async () => ++count === 1 ? auth : body });
    assert.equal(rows[0].status, variant === 'none' ? 'notConfigured' : 'unavailable');
    assert.ok(!JSON.stringify(rows).includes('sensitive'));
  }
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
  assert.equal(resolveArkcliCommand({ TOKEN_MONITOR_ARKCLI_COMMAND: launcher }, 'linux', 'x64'), binary);
});
