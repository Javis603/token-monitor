'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { launch, parse, askThread, readResult, privateDirectory } = require('../../scripts/codex-cloud-capture-desktop');
const tid = '01900000-0000-7000-8000-000000000001';
const other = '01900000-0000-7000-8000-000000000002';
function temp(t) { const p = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-capture-ui-'))); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; }
function stub(root, overrides = {}) {
  const trace = []; const opened = [];
  return { trace, opened, dataRoot: root, execute: async (file, args) => { opened.push({ file, args }); },
    spawn: (binary, args, options) => {
      trace.push({ binary, args, options });
      const child = new EventEmitter(); child.pid = 456; child.kill = (signal) => { trace.push({ signal }); return true; };
      setImmediate(() => {
        const pick = (flag) => args[args.indexOf(flag) + 1];
        const r = { kind: 'codex-cloud-live-token-count', threadId: tid, status: 'observed', total: { totalTokens: 123 }, ...overrides };
        fs.writeFileSync(pick('--output'), JSON.stringify(r), { mode: 0o600 });
        fs.writeFileSync(pick('--html'), '<!doctype html><title>Synthetic offline report</title>', { mode: 0o600 });
        fs.writeFileSync(pick('--events'), '', { mode: 0o600 });
        child.emit('close', 0, null);
      });
      return child;
    }
  };
}
test('help runs without authentication, cloud traffic or a desktop dialog', () => {
  const result = spawnSync(process.execPath, [path.resolve(__dirname, '../../scripts/codex-cloud-capture-desktop.js'), '--help'], { encoding: 'utf8', env: { ...process.env, CODEX_HOME: '/not-an-auth-home' } });
  assert.equal(result.status, 0); assert.ok(result.stdout.includes('No automatic model task'));
});
test('thread and duration are validated before process creation', () => {
  assert.throws(() => parse(['--headless']), { code: 'HEADLESS_REQUIRES_THREAD' });
  for (const seconds of ['0', '121', '0.5', 'NaN']) assert.throws(() => parse(['--seconds', seconds]), { code: 'INVALID_DURATION' });
  assert.throws(() => parse(['--thread', '$(echo unsafe)']));
  assert.equal(parse(['--thread', ` ${tid} `]).thread, tid);
});
test('dialog uses a fixed script and validates the returned value', async () => {
  const result = await askThread(60, async (binary, args) => {
    assert.equal(binary, '/usr/bin/osascript'); assert.equal(args[0], '-e'); assert.ok(!args[1].includes('do shell script')); return { stdout: tid + '\n' };
  });
  assert.equal(result, tid);
  await assert.rejects(askThread(60, async () => ({ stdout: 'bad input' })), { code: 'INVALID_ID' });
});
test('dialog cancellation leaves data directory and observer untouched', async (t) => {
  const root = path.join(temp(t), 'not-created'); let spawned = false;
  const r = await launch([], { dataRoot: root, askThread: async () => null, spawn: () => { spawned = true; } });
  assert.equal(r.status, 'cancelled'); assert.equal(spawned, false); assert.equal(fs.existsSync(root), false);
  assert.equal(await askThread(60, async () => { throw { stderr: 'User canceled. (-128)' }; }), null);
});
test('packaging wrapper calls only the existing observer with explicit arguments', async (t) => {
  const deps = stub(temp(t)); const r = await launch(['--headless', '--thread', tid, '--seconds', '1'], deps);
  assert.equal(r.state, 'observed'); assert.equal(r.totalTokens, 123); assert.equal(deps.opened.length, 0);
  const call = deps.trace[0]; assert.equal(call.binary, process.execPath); assert.equal(call.options.shell, false); assert.equal(call.options.detached, process.platform !== 'win32');
  assert.ok(call.args[0].endsWith('codex-cloud-engine-usage.js')); assert.ok(call.args.includes('--attach-existing-thread'));
  assert.ok(!call.args.some((arg) => ['turn/start', '--cloud', '--discover', '--quotas'].includes(arg)));
  assert.equal(fs.statSync(r.runDirectory).mode & 0o777, 0o700);
  assert.equal(fs.statSync(path.join(r.runDirectory, 'capture.json')).mode & 0o777, 0o600);
});
test('unknown counters remain unknown even when process exits normally', async (t) => {
  const deps = stub(temp(t), { status: 'no-usage-notification', total: null });
  const r = await launch(['--headless', '--thread', tid], deps);
  assert.equal(r.state, 'no-usage-notification'); assert.equal(r.totalTokens, null); assert.equal(r.exitCode, 0);
});
test('distinct launches produce separate reports rather than overwrite or add totals', async (t) => {
  const deps = stub(temp(t));
  const [a, b] = await Promise.all([launch(['--headless', '--thread', tid], deps), launch(['--headless', '--thread', tid], deps)]);
  assert.notEqual(a.runDirectory, b.runDirectory); assert.equal(a.totalTokens, 123); assert.equal(b.totalTokens, 123);
});
test('native mode opens only its own completed HTML report', async (t) => {
  const deps = stub(temp(t)); const r = await launch(['--thread', tid], deps);
  assert.deepEqual(deps.opened, [{ file: '/usr/bin/open', args: [r.reportPath] }]);
});
test('wrong-thread report is rejected and never opened', async (t) => {
  const previous = process.exitCode;
  try {
    const deps = stub(temp(t), { threadId: other }); const r = await launch(['--thread', tid], deps);
    assert.equal(r.state, 'failed'); assert.equal(r.errorCode, 'CAPTURE_REPORT_INVALID'); assert.equal(r.totalTokens, null); assert.equal(deps.opened.length, 0);
  } finally { process.exitCode = previous; }
});
test('symlink output root is not accepted', (t) => {
  const root = temp(t), real = path.join(root, 'real'), link = path.join(root, 'link'); fs.mkdirSync(real); fs.symlinkSync(real, link, 'dir');
  assert.throws(() => privateDirectory(link), { code: 'UNSAFE_REPORT_DIRECTORY' });
});
test('oversized, malformed, and symbolic-link reports are rejected', (t) => {
  const root = temp(t), file = path.join(root, 'report.json');
  fs.writeFileSync(file, '{'); assert.throws(() => readResult(file, tid));
  fs.writeFileSync(file, 'x'.repeat(4_000_001)); assert.throws(() => readResult(file, tid));
  const link = path.join(root, 'link.json'); fs.symlinkSync(file, link); assert.throws(() => readResult(link, tid));
});
test('browser-open failure preserves the successful capture', async (t) => {
  const deps = stub(temp(t)); deps.execute = async () => { throw new Error('PRIVATE_DESKTOP_ERROR'); };
  const r = await launch(['--thread', tid], deps);
  assert.equal(r.state, 'observed'); assert.equal(r.openStatus, 'browser-open-failed'); assert.ok(!JSON.stringify(r).includes('PRIVATE_DESKTOP_ERROR'));
});
