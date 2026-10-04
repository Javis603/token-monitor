'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { options, outputDirectory, saveSnapshot, readBindings } = require('../../scripts/codex-live-usage');
const cli = path.resolve(__dirname, '../../scripts/codex-live-usage.js');
const fixture = path.resolve(__dirname, '../fixtures/codexUsageRpc.cjs');
test('help and invalid options do not attempt model execution', () => {
  const help = spawnSync(process.execPath, [cli, '--help', '--codex-binary', '/missing'], { encoding: 'utf8' });
  assert.equal(help.status, 0); assert.ok(help.stdout.includes('account'));
  for (const args of [['--watch'], ['--interval', '1'], ['--timeout', '121'], ['--oops']]) assert.throws(() => options(args));
});
test('private output directory and atomic snapshots refuse existing directory', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-output-'));
  try {
    const output = outputDirectory(path.join(root, 'reports')); assert.throws(() => outputDirectory(output));
    saveSnapshot(output, { state: 'unavailable', report: null }, 0);
    saveSnapshot(output, { state: 'stale', report: null }, 60);
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'report.json'))).state, 'stale');
    assert.ok(fs.readFileSync(path.join(output, 'report.html'), 'utf8').includes('已断线'));
    if (process.platform !== 'win32') {
      assert.equal(fs.statSync(output).mode & 0o777, 0o700);
      assert.equal(fs.statSync(path.join(output, 'report.json')).mode & 0o777, 0o600);
    }
    assert.deepEqual(fs.readdirSync(output).sort(), ['report.html', 'report.json']);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('bindings reject malformed, oversized and nonregular input', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-binding-'));
  try {
    const p = path.join(root, 'b.json'); fs.writeFileSync(p, '{'); assert.throws(() => readBindings(p));
    fs.writeFileSync(p, ' '.repeat(1024 * 1024 + 1)); assert.throws(() => readBindings(p));
    assert.throws(() => readBindings(root));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('CLI to synthetic peer to account and children to private JSON and HTML', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cli-'));
  try {
    const output = path.join(root, 'report');
    const result = spawnSync(process.execPath, [cli, '--codex-binary', fixture, '--thread', 'root', '--json', '--output-dir', output],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout); assert.equal(report.state, 'fresh'); assert.equal(report.report.inventory.selectedThreads, 3);
    assert.equal(report.report.inventory.unavailableThreads, 1); assert.ok(!result.stdout.includes('SECRET_MARKER'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'report.json'))).report.account.report.summary.lifetimeTokens, 12345);
    assert.ok(fs.existsSync(path.join(output, 'report.html')));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('failed CLI writes unavailable, not zero-success', { skip: process.platform === 'win32' }, () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-fail-'));
  try {
    const output = path.join(root, 'report');
    const result = spawnSync(process.execPath, [cli, '--codex-binary', fixture, '--output-dir', output],
      { encoding: 'utf8', timeout: 10000, env: { ...process.env, TM_USAGE_FIXTURE_MODE: 'error' } });
    assert.equal(result.status, 1); assert.ok(!result.stderr.includes('SECRET_MARKER'));
    assert.equal(JSON.parse(fs.readFileSync(path.join(output, 'report.json'))).state, 'unavailable');
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});
test('original codex:usage dispatches live mode without local logs', { skip: process.platform === 'win32' }, () => {
  const existing = path.resolve(__dirname, '../../scripts/codex-task-usage.js');
  const result = spawnSync(process.execPath, [existing, '--live', '--codex-binary', fixture, '--thread', 'root', '--json'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, CODEX_HOME: '/not-a-local-log-root' } });
  assert.equal(result.status, 0, result.stderr); assert.equal(JSON.parse(result.stdout).report.inventory.selectedThreads, 3);
});
test('JSON callers receive structured failures without an output directory', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [cli, '--codex-binary', fixture, '--json'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, TM_USAGE_FIXTURE_MODE: 'error' } });
  assert.equal(result.status, 1);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.state, 'unavailable'); assert.equal(snapshot.report, null); assert.equal(snapshot.lastSuccessAt, null);
  assert.equal(snapshot.errorCode, 'ALL_USAGE_UNAVAILABLE'); assert.ok(!result.stdout.includes('SECRET_MARKER'));
});


test('failed new connection never exposes an earlier account report as current data', () => {
  const { unavailableSnapshot } = require('../../scripts/codex-live-usage');
  const previous = { observedAt: '2026-10-04T10:00:00Z', account: { privateMarker: 'PREVIOUS_ACCOUNT' } };
  const failure = unavailableSnapshot(previous, 'RPC_REQUEST_FAILED', '2026-10-04T10:01:00Z');
  assert.equal(failure.state, 'unavailable'); assert.equal(failure.report, null);
  assert.equal(failure.lastSuccessAt, previous.observedAt);
  assert.ok(!JSON.stringify(failure).includes('PREVIOUS_ACCOUNT'));
  assert.equal(unavailableSnapshot(previous, 'ACCOUNT_CHANGED_DURING_SYNC', 'now').lastSuccessAt, null);
});


test('account notification discards a whole sample then recollects on same connection', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [cli, '--codex-binary', fixture, '--json'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, TM_USAGE_FIXTURE_MODE: 'account-update-once' } });
  assert.equal(result.status, 0, result.stderr);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.state, 'fresh');
  assert.equal(snapshot.report.account.report.summary.lifetimeTokens, 22345);
  assert.ok(!result.stdout.includes('12345'));
});

test('a second account update aborts instead of retrying forever', { skip: process.platform === 'win32' }, () => {
  const result = spawnSync(process.execPath, [cli, '--codex-binary', fixture, '--json'],
    { encoding: 'utf8', timeout: 10000, env: { ...process.env, TM_USAGE_FIXTURE_MODE: 'account-update-always' } });
  assert.equal(result.status, 1);
  const snapshot = JSON.parse(result.stdout);
  assert.equal(snapshot.state, 'unavailable'); assert.equal(snapshot.report, null);
  assert.equal(snapshot.errorCode, 'ACCOUNT_CHANGED_DURING_SYNC');
});
