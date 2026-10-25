'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawn, spawnSync, execFile } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { fetchClaudeLimits } = require('../../src/shared/providers/claude/limits');
const { CLAUDE_PROBE_ARGS } = require('../../src/shared/providers/claude/probe');

const printed = 'Current session: 12% used · resets 6pm\nCurrent week (all models): 34% used · resets Oct 29, 6pm';
const legacy = 'Current session\n44% used\nResets 6pm\nCurrent week (all models)\n55% used\nResets Oct 29, 6pm';

function fixture(t, platform = process.platform) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'claude-print-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  if (platform === 'win32') t.mock.method(os, 'userInfo', () => ({ homedir: home }));
  return { root, deps: {
    platform, claudeProbeDir: path.join(root, 'probe'),
    env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), USER: 'fixture',
      TOKEN_MONITOR_CLAUDE_COMMAND: platform === 'win32' ? 'C:\\fixture\\claude.exe' : '/fixture/claude' },
    existsSync: () => true,
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    readMacKeychain: false, readWindowsCredential: false,
    isClaudeCliAuthenticated: async () => true,
    fetch: async () => { throw new Error('network forbidden'); }
  } };
}

function simulatedCli(deps, { version = '2.1.309 (Claude Code)', output = printed, code = 0, stderr = '' } = {}) {
  const calls = [];
  deps.execFile = (command, args, options, done) => {
    const argv = deps.platform === 'win32' ? args : JSON.parse(options.env.TOKEN_MONITOR_CLAUDE_PROBE_ARGS);
    const kind = argv.includes('--version') ? 'version' : 'print';
    calls.push({ kind, command, argv, options });
    const child = { stdin: { end() {} } };
    process.nextTick(() => {
      const text = kind === 'version' ? version : output;
      const overflow = Buffer.byteLength(text) > options.maxBuffer;
      const error = overflow ? { code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' } : kind === 'print' && code ? { code } : null;
      done(error, text, kind === 'print' ? stderr : '');
    });
    return child;
  };
  deps.spawn = (command, args, options) => {
    const argv = deps.platform === 'win32' ? args : JSON.parse(options.env.TOKEN_MONITOR_CLAUDE_PROBE_ARGS);
    calls.push({ kind: 'legacy', command, argv, options });
    const child = new EventEmitter();
    child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
    child.stdin = { end() {} }; child.kill = () => {};
    process.nextTick(() => { child.stdout.emit('data', legacy); child.emit('close', 0); });
    return child;
  };
  return calls;
}

test('supported CLI print usage wins without a PTY and keeps launch restrictions', async t => {
  for (const platform of ['darwin', 'linux', 'win32']) await t.test(platform, async t => {
    const { deps } = fixture(t, platform);
    const originalEnv = { ...deps.env };
    const calls = simulatedCli(deps);
    const result = await fetchClaudeLimits({}, deps);
    assert.equal(result.source, 'cli');
    assert.deepEqual(result.windows.map(w => w.usedPercent), [12, 34]);
    assert.deepEqual(calls.map(c => c.kind), ['version', 'print']);
    for (const { argv, options } of calls) {
      assert.deepEqual(argv.slice(0, CLAUDE_PROBE_ARGS.length), [...CLAUDE_PROBE_ARGS]);
      assert.equal(options.env.USER, 'fixture');
      assert.equal(options.env.CLAUDE_CODE_SKIP_PROMPT_HISTORY, '1');
      assert.equal(fs.statSync(options.cwd).isDirectory(), true);
      // CLI selection is simulated; permission bits belong to the host filesystem.
      if (process.platform !== 'win32') assert.equal(fs.statSync(options.cwd).mode & 0o777, 0o700);
    }
    assert.deepEqual(calls[1].argv.slice(CLAUDE_PROBE_ARGS.length), ['--tools', '', '--no-session-persistence', '-p', '--', '/usage']);
    assert.deepEqual(deps.env, originalEnv);
  });
});

test('version gate uses print only at the conservative release boundary', async t => {
  for (const [version, usePrint] of [
    ['2.1.177 (Claude Code)', false], ['2.1.178 (Claude Code)', true],
    ['2.1.309 (Claude Code)', true], ['unrecognized build', false], ['', false],
    ['2.1.178-beta.1 (Claude Code)', false]
  ]) await t.test(version, async t => {
    const { deps } = fixture(t, process.platform === 'win32' ? 'win32' : 'linux');
    const calls = simulatedCli(deps, { version });
    const result = await fetchClaudeLimits({}, deps);
    assert.equal(result.windows[0].usedPercent, usePrint ? 12 : 44);
    assert.deepEqual(calls.map(c => c.kind), ['version', usePrint ? 'print' : 'legacy']);
  });
});

test('unusable print results fall back once to the original usage path', async t => {
  for (const [name, options] of [
    ['cost is not quota', { output: 'Total cost: $0.0000\nUsage: 0 input, 0 output' }],
    ['subscription notice is not quota', { output: 'You are currently using your subscription' }],
    ['empty output', { output: '' }], ['early failure', { code: 7 }]
  ]) await t.test(name, async t => {
    const { deps } = fixture(t, process.platform === 'win32' ? 'win32' : 'linux');
    const calls = simulatedCli(deps, options);
    const result = await fetchClaudeLimits({}, deps);
    assert.equal(result.windows[0].usedPercent, 44);
    assert.deepEqual(calls.map(c => c.kind), ['version', 'print', 'legacy']);
    assert.deepEqual(calls[2].argv, deps.platform === 'win32'
      ? [...CLAUDE_PROBE_ARGS, '--', '/usage'] : [...CLAUDE_PROBE_ARGS]);
  });
});

test('zero percent is valid quota and does not fall back', async t => {
  const { deps } = fixture(t, 'linux');
  const calls = simulatedCli(deps, { output: 'Current session: 0% used' });
  const result = await fetchClaudeLimits({}, deps);
  assert.equal(result.windows[0].usedPercent, 0);
  assert.deepEqual(calls.map(c => c.kind), ['version', 'print']);
});

test('unsafe launch or rejected security flags cannot trigger a fallback', async t => {
  for (const stderr of [
    'TOKEN_MONITOR_UNSAFE_PROBE: Claude probe directory changed before launch',
    "error: unknown option '--setting-sources'",
    'unsupported --strict-mcp-config', "error: unknown option '--allowed-tools'"
  ]) await t.test(stderr, async t => {
    const { deps } = fixture(t, process.platform === 'win32' ? 'win32' : 'linux');
    const calls = simulatedCli(deps, { code: 1, stderr });
    await assert.rejects(fetchClaudeLimits({}, deps));
    assert.deepEqual(calls.map(c => c.kind), ['version', 'print']);
  });
});

test('security refusal on stdout and during version detection also stops', async t => {
  for (const phase of ['version', 'print']) await t.test(phase, async t => {
    const { deps } = fixture(t, 'linux');
    const refusal = "error: unknown option '--settings'";
    const calls = simulatedCli(deps, phase === 'version' ? { version: refusal } : { output: refusal, stderr: 'fixture warning' });
    await assert.rejects(fetchClaudeLimits({}, deps));
    assert.deepEqual(calls.map(c => c.kind), phase === 'version' ? ['version'] : ['version', 'print']);
  });
});

test('fallback revalidates the leaf instead of using a now-unsafe cwd', { skip: process.platform === 'win32' }, async t => {
  const { deps } = fixture(t, 'linux');
  const calls = simulatedCli(deps, { output: 'Total cost: $0.0000' });
  const execute = deps.execFile;
  deps.execFile = (cmd, args, options, done) => execute(cmd, args, options, (...result) => {
    if (calls.at(-1).kind === 'print') fs.chmodSync(deps.claudeProbeDir, 0o755);
    done(...result);
  });
  await assert.rejects(fetchClaudeLimits({}, deps));
  assert.deepEqual(calls.map(c => c.kind), ['version', 'print']);
  assert.equal(fs.statSync(deps.claudeProbeDir).mode & 0o777, 0o755, 'never repair the leaf');
});

test('cancelled version detection does not start print or fallback', async t => {
  const { deps } = fixture(t, 'linux');
  const calls = simulatedCli(deps);
  const controller = new AbortController();
  controller.abort();
  deps.signal = controller.signal;
  await assert.rejects(fetchClaudeLimits({}, deps));
  assert.deepEqual(calls, []);
});

const python = '/usr/bin/python3';
const hasPython = process.platform !== 'win32' && spawnSync(python, ['--version']).status === 0;

function assertStopped(pid) {
  try { process.kill(pid, 0); }
  catch (error) { assert.equal(error.code, 'ESRCH'); return; }
  // A killed wrapper's non-child can briefly remain a zombie awaiting OS reaping.
  // It must not still be executing when fallback starts.
  const state = spawnSync('/bin/ps', ['-o', 'stat=', '-p', String(pid)], { encoding: 'utf8' });
  assert.equal(state.error, undefined);
  assert.match(state.stdout.trim(), /^Z|^$/, 'print descendant must have stopped before fallback');
}


test('native print timeout and cancellation kill a SIGTERM-ignoring CLI; overflow stops', { skip: !hasPython }, async t => {
  for (const mode of ['timeout', 'overflow', 'abort', 'wrapper-timeout', 'wrapper-abort']) await t.test(mode, async t => {
    const { root, deps } = fixture(t);
    const cli = path.join(root, 'claude.py');
    const pidFile = path.join(root, 'pid');
    fs.writeFileSync(cli, `#!/usr/bin/python3
import os, signal, sys, time
if '--version' in sys.argv:
    print('2.1.309 (Claude Code)')
else:
    signal.signal(signal.SIGTERM, signal.SIG_IGN)
    open(os.environ['PID_FILE'], 'w').write(str(os.getpid()))
    if os.environ['CASE'] == 'overflow':
        print('x' * (256 * 1024) + "error: unknown option '--allowed-tools'", flush=True)
    time.sleep(30)
`, { mode: 0o700 });
    const wrapper = path.join(root, 'claude-wrapper');
    fs.writeFileSync(wrapper, `#!/bin/sh\n"${python}" "${cli}" "$@"\n`, { mode: 0o700 });
    deps.env = { ...deps.env, TOKEN_MONITOR_CLAUDE_COMMAND: mode.startsWith('wrapper-') ? wrapper : cli,
      PID_FILE: pidFile, CASE: mode, PATH: '/usr/bin:/bin' };
    deps.pythonCommand = python;
    deps.claudePrintedCliTimeoutMs = 2000;
    const legacyCalls = [];
    deps.spawn = (_cmd, _args, options) => {
      legacyCalls.push(options);
      const pid = Number(fs.readFileSync(pidFile, 'utf8'));
      assertStopped(pid);
      const child = new EventEmitter();
      child.stdout = new EventEmitter(); child.stderr = new EventEmitter(); child.kill = () => {};
      process.nextTick(() => { child.stdout.emit('data', legacy); child.emit('close', 0); });
      return child;
    };
    let lastPid, descendantPid;
    deps.execFile = (cmd, args, options, done) => {
      const child = execFile(cmd, args, options, (...result) => {
        if (fs.existsSync(pidFile)) descendantPid = Number(fs.readFileSync(pidFile, 'utf8'));
        done(...result);
      });
      lastPid = child.pid;
      return child;
    };
    t.after(() => {
      for (const pid of [lastPid, descendantPid]) if (pid) { try { process.kill(pid, 'SIGKILL'); } catch (_) {} }
    });
    const controller = new AbortController();
    if (mode.endsWith('abort')) deps.signal = controller.signal;
    const poll = mode.endsWith('abort') ? setInterval(() => {
      if (fs.existsSync(pidFile) && /^\d+$/.test(fs.readFileSync(pidFile, 'utf8'))) controller.abort();
    }, 10) : null;
    try {
      if (mode.endsWith('timeout')) {
        assert.equal((await fetchClaudeLimits({}, deps)).windows[0].usedPercent, 44);
        assert.equal(legacyCalls.length, 1);
      } else {
        await assert.rejects(fetchClaudeLimits({}, deps));
        assert.equal(legacyCalls.length, 0);
      }
      assertStopped(Number(fs.readFileSync(pidFile, 'utf8')));
    } finally {
      clearInterval(poll);
    }
  });
});

test('Windows shim timeout kills the process tree, and failed cleanup cannot fall back', async t => {
  for (const [failed, omitted, closeFirst] of [[false, false, false], [true, false, false], [false, true, false], [true, false, true]]) await t.test(`cleanup failed: ${failed}, platform omitted: ${omitted}, close first: ${closeFirst}`, async t => {
    const { deps } = fixture(t, 'win32');
    deps.env.TOKEN_MONITOR_CLAUDE_COMMAND = 'claude.cmd';
    const calls = [];
    const legacySpawn = simulatedCli(deps);
    let parentStopped = false, closePrint;
    deps.execFile = (cmd, args, options, done) => {
      if (cmd.endsWith('taskkill.exe')) {
        calls.push('tree');
        assert.deepEqual(Array.from(args), ['/pid', '12345', '/t', '/f']);
        assert.equal(options.timeout, 2000);
        if (closeFirst) process.nextTick(() => closePrint());
        setImmediate(() => done(failed ? new Error('fixture denied') : null));
        return {};
      }
      const version = args[3].includes('--version');
      calls.push(version ? 'version' : 'print');
      let closed = false;
      const close = () => { if (!closed) { closed = true; done({ killed: true }, '', ''); } };
      if (!version) closePrint = close;
      const child = { pid: 12345, stdin: { end() {} }, kill: () => {
        parentStopped = true;
        close();
      } };
      process.nextTick(() => version ? done(null, '2.1.309 (Claude Code)', '') : child.kill('SIGKILL'));
      return child;
    };
    let collect = fetchClaudeLimits;
    const options = { ...deps };
    if (omitted) {
      delete options.platform;
      const filename = require.resolve('../../src/shared/providers/claude/limits');
      const localRequire = createRequire(filename);
      const module = { exports: {} };
      vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
        module, Buffer, process: { platform: 'win32', env: {} },
        require: id => id === './probe' ? {
          CLAUDE_PROBE_ARGS,
          prepareClaudeProbeDir: value => localRequire(id).prepareClaudeProbeDir({ ...value, platform: 'win32' })
        } : localRequire(id)
      }, { filename });
      collect = module.exports.fetchClaudeLimits;
    }
    if (failed) {
      await assert.rejects(collect({}, options));
      assert.equal(legacySpawn.length, 0);
    } else {
      assert.equal((await collect({}, options)).windows[0].usedPercent, 44);
      assert.equal(legacySpawn.length, 1);
    }
    assert.deepEqual(calls, ['version', 'print', 'tree']);
    assert.equal(parentStopped, true);
  });
});

test('real Python print execution pins cwd, suppresses history and closes stdin', { skip: !hasPython }, async t => {
  const { root, deps } = fixture(t);
  const cli = path.join(root, 'claude.py');
  const receipt = path.join(root, 'receipt.json');
  fs.writeFileSync(cli, `#!/usr/bin/python3
import json, os, sys
if '--version' in sys.argv:
    print('2.1.309 (Claude Code)')
else:
    assert '-p' in sys.argv, 'PTY must not start'
    assert sys.stdin.read() == ''
    with open(os.environ['RECEIPT'], 'w') as out:
        json.dump({'cwd': os.getcwd(), 'args': sys.argv[1:], 'history': os.environ.get('CLAUDE_CODE_SKIP_PROMPT_HISTORY')}, out)
    print(${JSON.stringify(printed)})
`, { mode: 0o700 });
  deps.env = { ...deps.env, TOKEN_MONITOR_CLAUDE_COMMAND: cli, RECEIPT: receipt, PATH: '/usr/bin:/bin' };
  deps.pythonCommand = python;
  deps.spawn = spawn;
  const result = await fetchClaudeLimits({}, deps);
  const saved = JSON.parse(fs.readFileSync(receipt));
  assert.deepEqual(result.windows.map(w => w.usedPercent), [12, 34]);
  assert.equal(saved.cwd, fs.realpathSync(deps.claudeProbeDir));
  assert.equal(saved.history, '1');
  assert.equal(saved.args[saved.args.indexOf('--tools') + 1], '');
});

test('a swapped print cwd stops before CLI launch or PTY fallback', { skip: !hasPython }, async t => {
  const { root, deps } = fixture(t);
  const receipt = path.join(root, 'started');
  const imported = path.join(root, 'imported');
  const cli = path.join(root, 'claude.py');
  fs.writeFileSync(cli, `#!/usr/bin/python3
import os, sys
if '--version' in sys.argv:
    print('2.1.309 (Claude Code)')
else:
    open(os.environ['RECEIPT'], 'w').write('started')
`, { mode: 0o700 });
  deps.env = { ...deps.env, TOKEN_MONITOR_CLAUDE_COMMAND: cli, RECEIPT: receipt, PATH: '/usr/bin:/bin' };
  deps.pythonCommand = python;
  let starts = 0;
  deps.execFile = (cmd, args, options, done) => {
    starts++;
    assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
    if (starts === 2) {
      fs.renameSync(deps.claudeProbeDir, deps.claudeProbeDir + '-saved');
      fs.mkdirSync(deps.claudeProbeDir, { mode: 0o700 });
      fs.writeFileSync(path.join(deps.claudeProbeDir, 'json.py'), `open(${JSON.stringify(imported)}, 'w').write('imported')\n`);
    }
    return execFile(cmd, args, options, done);
  };
  await assert.rejects(fetchClaudeLimits({}, deps));
  assert.equal(starts, 2);
  assert.equal(fs.existsSync(receipt), false);
  assert.equal(fs.existsSync(imported), false);
});

test('native Windows cmd print keeps JSON, empty arguments and the fixed cwd', { skip: process.platform !== 'win32' }, async t => {
  const { root, deps } = fixture(t, 'win32');
  const cli = path.join(root, 'claude.cmd');
  const handler = path.join(root, 'cli.cjs');
  const receipt = path.join(root, 'calls.jsonl');
  fs.writeFileSync(cli, `@echo off\r\n"${process.execPath}" "${handler}" %*\r\n`);
  fs.writeFileSync(handler, `
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(process.env.RECEIPT, JSON.stringify({ args, cwd: process.cwd() }) + '\\n');
if (args.includes('--version')) console.log('2.1.309 (Claude Code)');
else if (args.includes('-p') && process.env.CASE === 'timeout') {
  fs.writeFileSync(process.env.PID_FILE, String(process.pid));
  setInterval(() => {}, 1000);
}
else if (args.includes('-p')) console.log(${JSON.stringify(printed)});
else console.log(${JSON.stringify(legacy)});
`);
  Object.assign(deps.env, { TOKEN_MONITOR_CLAUDE_COMMAND: cli, RECEIPT: receipt,
    SystemRoot: process.env.SystemRoot, ComSpec: process.env.ComSpec });
  deps.spawn = spawn;
  const result = await fetchClaudeLimits({}, deps);
  assert.deepEqual(result.windows.map(w => w.usedPercent), [12, 34]);
  const calls = fs.readFileSync(receipt, 'utf8').trim().split('\n').map(row => JSON.parse(row));
  assert.equal(calls.length, 2);
  for (const { args, cwd } of calls) {
    assert.deepEqual(args.slice(0, CLAUDE_PROBE_ARGS.length), [...CLAUDE_PROBE_ARGS]);
    assert.equal(fs.realpathSync(cwd), fs.realpathSync(path.join(deps.env.HOME, 'AppData', 'Local', 'Token Monitor', 'claude-probe')));
  }
  assert.deepEqual(calls[1].args.slice(CLAUDE_PROBE_ARGS.length), ['--tools', '', '--no-session-persistence', '-p', '--', '/usage']);
  const pidFile = path.join(root, 'print.pid');
  Object.assign(deps.env, { CASE: 'timeout', PID_FILE: pidFile });
  deps.claudePrintedCliTimeoutMs = 2000;
  try {
    assert.equal((await fetchClaudeLimits({}, deps)).windows[0].usedPercent, 44);
    assertStopped(Number(fs.readFileSync(pidFile, 'utf8')));
  } finally {
    if (fs.existsSync(pidFile)) {
      try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch (_) {}
    }
  }
});
