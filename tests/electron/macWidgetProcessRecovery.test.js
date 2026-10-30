'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const test = require('node:test');

test('native Widget recovery distinguishes failed lookups from confirmed exit', {
  skip: process.platform !== 'darwin'
}, async (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'widget-recovery-test-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const source = fs.readFileSync(path.resolve(__dirname, '../../scripts/TokenMonitorWidgetReloader.swift'), 'utf8');
  const end = source.indexOf('private func recoverContainingHost()');
  assert.ok(end > 0, 'test the production process functions without running host registration');
  // Compile the real control flow with deterministic syscall faults. No app
  // bundles, LaunchServices calls or real process signals are used by this test.
  const functions = source.slice(0, end)
    .replace(/\b(proc_pidinfo|proc_pidpath|proc_listpids|sysctl|kill|usleep)\s*\(/g, 'fixture_$1(')
    .replaceAll('ProcessInfo.processInfo.systemUptime', 'fixtureTime');
  const fixture = fs.readFileSync(path.resolve(__dirname, '../mac-widget/ProcessRecoveryFixture.swift'), 'utf8');
  const main = path.join(directory, 'main.swift');
  const binary = path.join(directory, 'recovery-check');
  fs.writeFileSync(main, `${functions}\n${fixture}`);
  const compiled = spawnSync('swiftc', [main, '-o', binary], { encoding: 'utf8', timeout: 60000 });
  assert.equal(compiled.status, 0, compiled.error?.message || compiled.stderr);

  for (const [scenario, recovered, signals] of [
    ['normal', true, 1],
    ['path-fallback', true, 1],
    ['renamed-path', true, 1],
    ['launch-fail', false, 0],
    ['probe-denied', false, 0],
    ['unrelated-fallback', true, 0],
    ['paths-fail-scan', false, 0],
    ['paths-fail-recheck', false, 0],
    ['paths-fail-wait', false, 1],
    ['info-fail-scan', false, 0],
    ['info-fail-recheck', false, 0],
    ['info-fail-wait', false, 1],
    ['already-exited', true, 0],
    ['zombie-scan', true, 0],
    ['zombie-wait', true, 1],
    ['pid-reused', true, 0],
    ['foreign-owner', true, 0],
    ['signal-denied', false, 1],
    ['signal-exited', true, 1],
    ['still-running', false, 1]
  ]) {
    await t.test(scenario, () => {
      const result = spawnSync(binary, [scenario], { encoding: 'utf8', timeout: 5000 });
      assert.equal(result.status, recovered ? 0 : 1, result.error?.message || result.stderr);
      assert.equal(result.stdout.trim(), `signals=${signals}`);
    });
  }
});
