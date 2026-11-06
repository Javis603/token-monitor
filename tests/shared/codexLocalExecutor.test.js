'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');
const { executorIdsFromProcesses, localExecutorIds } = require('../../src/shared/providers/codex/localExecutor');

function fakeProcess() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.signals = [];
  child.kill = (signal) => { child.signals.push(signal); return true; };
  return child;
}

test('Windows executor config values can contain escaped quotes', () => {
  for (const command of [
    String.raw`codex.exe -c forced_login_method=\"chatgpt\" exec-server --environment-id actual`,
    String.raw`"C:\Program Files\Codex\codex.exe" -c features.example=true -c forced_login_method=\"chatgpt\" exec-server --environment-id "actual"`,
    String.raw`codex.exe --config "forced_login_method=\"chatgpt\"" exec-server --environment-id actual`,
    String.raw`codex.exe -c example="text with \"quotes\"" exec-server --environment-id actual`
  ]) assert.deepEqual([...executorIdsFromProcesses(command)], ['actual']);
});

test('escaped config values do not admit wrappers or a subcommand inside config', () => {
  for (const command of [
    String.raw`wrapper.exe codex.exe -c forced_login_method=\"chatgpt\" exec-server --environment-id fake`,
    String.raw`codex.exe -c key="text exec-server --environment-id fake" app-server`,
    String.raw`codex.exe -c "key=\"exec-server --environment-id fake\"" app-server`,
    String.raw`codex.exe -c forced_login_method=\"chatgpt\" app-server --command exec-server --environment-id fake`,
    String.raw`codex.exe --unknown value exec-server --environment-id fake`,
    String.raw`codex.exe -c "key=\"--environment-id fake\"" exec-server --remote https://registry.test/api`
  ]) assert.deepEqual([...executorIdsFromProcesses(command)], []);
  assert.deepEqual([...executorIdsFromProcesses(
    String.raw`codex.exe -c "key=\"--environment-id fake\"" exec-server --environment-id actual`
  )], ['actual']);
});

test('Windows discovery permits a measured five-second PowerShell cold start', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  const probe = localExecutorIds({ platform: 'win32', spawn: () => child });
  t.mock.timers.tick(5100);
  assert.deepEqual(child.signals, []);
  child.stdout.emit('data', 'codex.exe exec-server --environment-id actual');
  child.emit('close', 0);
  assert.deepEqual([...(await probe)], ['actual']);
  t.mock.timers.tick(30000);
  assert.deepEqual(child.signals, [], 'closed process is no longer a termination target');
});

test('discovery keeps platform deadlines and waits for process closure after timeout', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  for (const [platform, deadline] of [['win32', 15000], ['linux', 2000]]) {
    const child = fakeProcess();
    let resolved = false;
    const probe = localExecutorIds({ platform, spawn: () => child }).then((ids) => { resolved = true; return ids; });
    t.mock.timers.tick(deadline - 1);
    assert.deepEqual(child.signals, []);
    t.mock.timers.tick(1);
    assert.deepEqual(child.signals, ['SIGTERM']);
    await Promise.resolve();
    assert.equal(resolved, false);
    child.emit('close', 0);
    assert.equal(await probe, null, 'timeout is unavailable, not an empty process list');
  }
});

test('Windows discovery cancellation still requests immediate termination', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  const controller = new AbortController();
  const probe = localExecutorIds({ platform: 'win32', spawn: () => child, signal: controller.signal });
  controller.abort();
  assert.deepEqual(child.signals, ['SIGTERM']);
  child.emit('close', 0);
  assert.equal(await probe, null);
  t.mock.timers.tick(30000);
  assert.deepEqual(child.signals, ['SIGTERM']);
});

test('Windows discovery retains bounded escalation for an unconfirmed process exit', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const child = fakeProcess();
  const probe = localExecutorIds({ platform: 'win32', spawn: () => child });
  t.mock.timers.tick(15000);
  assert.deepEqual(child.signals, ['SIGTERM']);
  t.mock.timers.tick(2000);
  assert.deepEqual(child.signals, ['SIGTERM', 'SIGKILL']);
  t.mock.timers.tick(5000);
  assert.equal(await probe, null);
  child.emit('close', 0);
});
