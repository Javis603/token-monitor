'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const { EventEmitter } = require('node:events');

const { runCodexLogin } = require('../../src/shared/limitCollector');

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.killed = false;
  child.kill = () => { child.killed = true; return true; };
  return child;
}

// A no-op timer so the success/failure paths never arm a real timeout.
const noopTimers = { setTimeout: () => 0, clearTimeout: () => {} };

test('runCodexLogin spawns codex login with the scoped CODEX_HOME and streams output', async () => {
  let spawnArgs = null;
  const streamed = [];
  const child = fakeChild();
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/home-1', onOutput: (text) => streamed.push(text) },
    {
      ...noopTimers,
      platform: 'darwin',
      codexCommand: 'codex',
      env: { PATH: '/usr/bin' },
      spawn: (command, args, opts) => {
        spawnArgs = { command, args, opts };
        return child;
      }
    }
  );

  child.stdout.emit('data', 'Visit https://auth.openai.com/device\n');
  child.emit('close', 0);
  const result = await promise;

  assert.equal(spawnArgs.command, 'codex');
  assert.deepEqual(spawnArgs.args, ['login']);
  assert.equal(spawnArgs.opts.env.CODEX_HOME, '/tmp/managed/home-1');
  assert.equal(result.outcome, 'success');
  assert.equal(result.exitCode, 0);
  assert.match(result.output, /auth\.openai\.com/);
  assert.deepEqual(streamed, ['Visit https://auth.openai.com/device\n']);
});

test('runCodexLogin selects the ChatGPT-bundled Codex binary when the legacy app is absent', async () => {
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  let spawnArgs = null;
  const child = fakeChild();
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/chatgpt-home' },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === chatgptCodex,
      spawn: (command, args, opts) => {
        spawnArgs = { command, args, opts };
        return child;
      }
    }
  );

  child.emit('close', 0);
  const result = await promise;

  assert.equal(spawnArgs.command, chatgptCodex);
  assert.deepEqual(spawnArgs.args, ['login']);
  assert.equal(spawnArgs.opts.env.CODEX_HOME, '/tmp/managed/chatgpt-home');
  assert.equal(result.outcome, 'success');
});

test('runCodexLogin retries the next candidate only after a launch failure', async () => {
  const legacyCodex = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const commands = [];
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/retry-home' },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === legacyCodex || candidate === chatgptCodex,
      spawn: (command) => {
        commands.push(command);
        return commands.length === 1 ? firstChild : secondChild;
      }
    }
  );

  firstChild.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }));
  await new Promise((resolve) => setImmediate(resolve));
  secondChild.emit('close', 0);
  const result = await promise;

  assert.deepEqual(commands, [legacyCodex, chatgptCodex]);
  assert.equal(result.outcome, 'success');
});

test('runCodexLogin does not retry after a started login exits unsuccessfully', async () => {
  const legacyCodex = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const child = fakeChild();
  const commands = [];
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/no-retry-home' },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === legacyCodex || candidate === chatgptCodex,
      spawn: (command) => {
        commands.push(command);
        return child;
      }
    }
  );

  child.stderr.emit('data', 'login cancelled');
  child.emit('close', 1);
  const result = await promise;

  assert.deepEqual(commands, [legacyCodex]);
  assert.equal(result.outcome, 'failed');
  assert.match(result.output, /cancelled/);
});

test('runCodexLogin reports a failed outcome for a non-zero exit', async () => {
  const child = fakeChild();
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/home-2' },
    { ...noopTimers, platform: 'darwin', codexCommand: 'codex', env: {}, spawn: () => child }
  );
  child.stderr.emit('data', 'login cancelled');
  child.emit('close', 1);
  const result = await promise;

  assert.equal(result.outcome, 'failed');
  assert.equal(result.exitCode, 1);
  assert.match(result.output, /cancelled/);
});

test('runCodexLogin times out and kills the login process', async () => {
  let timeoutCb = null;
  const child = fakeChild();
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/home-3', timeoutMs: 50 },
    {
      platform: 'darwin',
      codexCommand: 'codex',
      env: {},
      spawn: () => child,
      setTimeout: (cb) => { timeoutCb = cb; return 7; },
      clearTimeout: () => {}
    }
  );

  assert.equal(typeof timeoutCb, 'function');
  timeoutCb();
  const result = await promise;

  assert.equal(result.outcome, 'timedOut');
  assert.equal(child.killed, true);
});

test('runCodexLogin tree-kills the login process with taskkill on Windows timeout', async () => {
  let timeoutCb = null;
  const killCalls = [];
  const child = fakeChild();
  child.pid = 4321;
  const promise = runCodexLogin(
    { homePath: 'C:/managed/home', timeoutMs: 50 },
    {
      platform: 'win32',
      codexCommand: 'codex.cmd',
      env: {},
      spawn: (command, args) => {
        if (command === 'taskkill') { killCalls.push(args); return fakeChild(); }
        return child;
      },
      setTimeout: (cb) => { timeoutCb = cb; return 9; },
      clearTimeout: () => {}
    }
  );

  timeoutCb();
  const result = await promise;

  assert.equal(result.outcome, 'timedOut');
  assert.equal(killCalls.length, 1);
  assert.deepEqual(killCalls[0], ['/pid', '4321', '/t', '/f']);
});

test('runCodexLogin reports launchFailed when spawning throws', async () => {
  const result = await runCodexLogin(
    { homePath: '/tmp/managed/home-4' },
    {
      ...noopTimers,
      platform: 'darwin',
      codexCommand: 'codex',
      env: {},
      spawn: () => { throw new Error('spawn ENOENT'); }
    }
  );
  assert.equal(result.outcome, 'launchFailed');
  assert.match(result.output, /ENOENT/);
});

test('runCodexLogin tries the next discovered command after spawn ENOENT', async () => {
  const legacyCodex = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const child = fakeChild();
  const spawnCalls = [];
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/fallback-home' },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === legacyCodex || candidate === chatgptCodex,
      spawn: (command, args) => {
        spawnCalls.push({ command, args });
        if (command === legacyCodex) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
        return child;
      }
    }
  );

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(spawnCalls.map((call) => call.command), [legacyCodex, chatgptCodex]);
  child.emit('close', 0);

  const result = await promise;
  assert.equal(result.outcome, 'success');
});

test('runCodexLogin tries the next Windows command after cmd reports it missing', async () => {
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const spawnCalls = [];
  const promise = runCodexLogin(
    { homePath: 'C:/managed/fallback-home' },
    {
      ...noopTimers,
      platform: 'win32',
      env: {},
      existsSync: () => false,
      spawn: (command, args) => {
        spawnCalls.push({ command, args });
        return spawnCalls.length === 1 ? firstChild : secondChild;
      }
    }
  );

  firstChild.stderr.emit('data', "'codex.cmd' is not recognized as an internal or external command.\n");
  firstChild.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));

  assert.equal(spawnCalls.length, 2);
  assert.equal(spawnCalls[0].command, 'cmd.exe');
  assert.match(spawnCalls[0].args.at(-1), /codex\.cmd login/);
  assert.equal(spawnCalls[1].command, 'codex.exe');
  secondChild.emit('close', 0);

  const result = await promise;
  assert.equal(result.outcome, 'success');
});

test('runCodexLogin does not retry a normal login failure', async () => {
  const legacyCodex = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const firstChild = fakeChild();
  const secondChild = fakeChild();
  const spawnCalls = [];
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/login-failure-home' },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === legacyCodex || candidate === chatgptCodex,
      spawn: (command) => {
        spawnCalls.push(command);
        return spawnCalls.length === 1 ? firstChild : secondChild;
      }
    }
  );

  firstChild.stderr.emit('data', 'Codex account not found.');
  firstChild.emit('close', 1);
  await new Promise((resolve) => setImmediate(resolve));
  if (spawnCalls.length > 1) secondChild.emit('close', 0);

  const result = await promise;
  assert.deepEqual(spawnCalls, [legacyCodex]);
  assert.equal(result.outcome, 'failed');
  assert.match(result.output, /account not found/);
});

test('runCodexLogin aborts the active process without trying another candidate', async () => {
  const legacyCodex = '/Applications/Codex.app/Contents/Resources/codex';
  const chatgptCodex = '/Applications/ChatGPT.app/Contents/Resources/codex';
  const controller = new AbortController();
  const child = fakeChild();
  const spawnCalls = [];
  const promise = runCodexLogin(
    { homePath: '/tmp/managed/cancel-home', signal: controller.signal },
    {
      ...noopTimers,
      platform: 'darwin',
      env: {},
      existsSync: (candidate) => candidate === legacyCodex || candidate === chatgptCodex,
      spawn: (command) => {
        spawnCalls.push(command);
        return child;
      }
    }
  );

  controller.abort();
  const result = await promise;

  assert.equal(result.outcome, 'cancelled');
  assert.equal(child.killed, true);
  assert.deepEqual(spawnCalls, [legacyCodex]);
});

test('runCodexLogin does not spawn when already cancelled', async () => {
  const controller = new AbortController();
  controller.abort();
  let spawned = false;

  const result = await runCodexLogin(
    { homePath: '/tmp/managed/cancelled-home', signal: controller.signal },
    {
      ...noopTimers,
      platform: 'darwin',
      codexCommand: 'codex',
      env: {},
      spawn: () => { spawned = true; return fakeChild(); }
    }
  );

  assert.equal(result.outcome, 'cancelled');
  assert.equal(spawned, false);
});
