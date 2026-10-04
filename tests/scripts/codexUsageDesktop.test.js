'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const { launch, readSettings, localHtml } = require('../../scripts/codex-usage-desktop');
const fixture = path.resolve(__dirname, '../fixtures/codexUsageRpc.cjs');
const installer = path.resolve(__dirname, '../../scripts/deploy-codex-usage-test.py');
const temp = (t) => { const p = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-desktop-test-')); t.after(() => fs.rmSync(p, { recursive: true, force: true })); return p; };

test('desktop settings default to no implicit account-wide thread scan', (t) => {
  assert.deepEqual(readSettings(temp(t)), { threadIds: [] });
});
test('desktop settings reject invalid identifiers and deduplicate real identifiers', (t) => {
  const root = temp(t), file = path.join(root, 'settings.json');
  fs.writeFileSync(file, JSON.stringify({ threadIds: ['root', 'root'] }));
  assert.deepEqual(readSettings(root), { threadIds: ['root'] });
  fs.writeFileSync(file, JSON.stringify({ threadIds: ['root; echo BAD'] }));
  assert.throws(() => readSettings(root));
});
test('local report keeps missing usage unknown and escapes identifiers', () => {
  const report = { rootOwnUsage: { totalTokens: 100 }, descendantsKnownUsage: null, knownUsage: { totalTokens: 100 },
    threads: [{ threadId: '<script>bad</script>', ownUsage: null, status: 'unknown' }],
    coverage: { knownThreads: 2, measuredThreads: 1, missingUsageThreads: 1 }, warnings: ['<private>'] };
  const html = localHtml(report);
  assert.ok(html.includes('未知')); assert.ok(html.includes('&lt;script&gt;')); assert.ok(!html.includes('<script>'));
  assert.ok(html.includes("default-src 'none'")); assert.ok(!html.includes('http://'));
});
test('desktop entry produces a report and private lifecycle receipt using only synthetic RPC', { skip: process.platform === 'win32' }, async (t) => {
  const root = temp(t); let commands = 0;
  const result = await launch(['--headless', '--thread', 'root'], { dataRoot: root,
    spawn: (binary, args, options) => {
      commands += 1; assert.equal(options.shell, false);
      assert.equal(binary, process.execPath);
      return spawn(binary, [...args, '--codex-binary', fixture], options);
    } });
  assert.equal(commands, 1); assert.equal(result.exitCode, 0);
  assert.ok(fs.readFileSync(result.reportPath, 'utf8').includes('Codex'));
  const receipt = JSON.parse(fs.readFileSync(path.join(root, 'last-run.json')));
  assert.equal(receipt.state, 'finished');
  assert.ok(!JSON.stringify(receipt).includes('SECRET_MARKER'));
  assert.equal(fs.statSync(path.join(root, 'last-run.json')).mode & 0o777, 0o600);
});
test('local desktop entry requires exactly one root before spawning', async (t) => {
  let spawned = false;
  await assert.rejects(launch(['--local', '--headless'], { dataRoot: temp(t), spawn: () => { spawned = true; } }), /LOCAL_REQUIRES_ONE_ROOT/);
  assert.equal(spawned, false);
});
test('installer dry-run resolves a builtin-only source closure', { skip: process.platform === 'win32' }, () => {
  const r = spawnSync('python3', [installer], { encoding: 'utf8' });
  assert.equal(r.status, 0, r.stderr);
  const plan = JSON.parse(r.stdout); assert.equal(plan.dryRun, true); assert.ok(plan.files >= 3);
});
test('installer refuses any existing app without altering it', { skip: process.platform === 'win32' }, (t) => {
  const root = temp(t), dest = path.join(root, 'Token Monitor Usage Test.app'); fs.mkdirSync(dest);
  fs.writeFileSync(path.join(dest, 'keep.txt'), 'existing app');
  const r = spawnSync('python3', [installer, '--destination', dest, '--apply'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.equal(fs.readFileSync(path.join(dest, 'keep.txt'), 'utf8'), 'existing app');
});
test('installer refuses the production app name before writing', { skip: process.platform === 'win32' }, (t) => {
  const root = temp(t), dest = path.join(root, 'Token Monitor.app');
  const r = spawnSync('python3', [installer, '--destination', dest, '--apply'], { encoding: 'utf8' });
  assert.notEqual(r.status, 0); assert.equal(fs.existsSync(dest), false);
});
