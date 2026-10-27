'use strict';

const assert = require('node:assert/strict');
const { spawn, spawnSync, execFileSync } = require('node:child_process');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createRequire } = require('node:module');
const vm = require('node:vm');
const { sharedDataDir, writeJsonAtomic } = require('../../src/shared/config');
const { claudeProbeDir, prepareClaudeProbeDir, isClaudeProbeCwd } = require('../../src/shared/providers/claude/probe');
const { fetchClaudeLimits, touchClaudeAuthPath } = require('../../src/shared/providers/claude/limits');

function fixture(t) {
  // Tests replace the OS profile lookup; never prepare a real user's probe.
  const temp = process.platform === 'win32' ? os.homedir() : os.tmpdir();
  const root = fs.realpathSync(fs.mkdtempSync(path.join(temp, 'claude-probe-test-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  fs.mkdirSync(home, { mode: 0o700 });
  if (process.platform === 'win32') t.mock.method(os, 'userInfo', () => ({ homedir: home }));
  return { root, env: { HOME: home, CLAUDE_CONFIG_DIR: path.join(home, '.claude'), PATH: '/usr/bin:/bin' } };
}

function fakeChild(output = 'Account: fixture', code = 0) {
  const child = new EventEmitter();
  child.stdout = new EventEmitter(); child.stderr = new EventEmitter();
  child.stdin = { end() {} }; child.kill = () => {};
  process.nextTick(() => { child.stdout.emit('data', output); child.emit('close', code); });
  return child;
}

function windowsProbeModule(profile, env = {}, pathApi = path) {
  const filename = require.resolve('../../src/shared/providers/claude/probe');
  const localRequire = createRequire(filename);
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    module, Buffer, process: { platform: 'win32', env },
    require: id => {
      if (id === 'node:os') return { ...os, userInfo: () => {
        if (profile instanceof Error) throw profile;
        return { homedir: profile };
      } };
      if (id === 'node:path') return pathApi;
      if (id === 'node:child_process') return { execFile() { throw new Error('probe must not launch an ACL helper'); } };
      return localRequire(id);
    }
  }, { filename });
  return module.exports;
}

test('Windows probe path ignores data and home overrides in favour of the OS profile', () => {
  const profile = 'C:\\Users\\fixture';
  const env = { TOKEN_MONITOR_SHARED_DIR: '\\server\\shared', APPDATA: 'D:\\shared-appdata',
    LOCALAPPDATA: 'D:\\shared-local', USERPROFILE: 'D:\\shared-profile', HOME: 'D:\\shared-home' };
  const original = { ...env };
  const api = windowsProbeModule(profile, env, path.win32);
  const options = { platform: 'win32', env, homeDir: 'D:\\override-home', claudeProbeDir: 'D:\\override-probe' };
  assert.equal(api.claudeProbeDir(options), path.win32.join(profile, 'AppData', 'Local', 'Token Monitor', 'claude-probe'));
  assert.equal(sharedDataDir(options), env.TOKEN_MONITOR_SHARED_DIR, 'only the probe cwd stops using the override');
  assert.deepEqual(env, original);
});

test('Windows probe filtering retains filesystem case aliases', t => {
  const api = windowsProbeModule('C:\\Users\\fixture', {}, path.win32);
  const probe = api.claudeProbeDir();
  const parent = path.win32.dirname(probe);
  t.mock.method(fs, 'lstatSync', () => ({ isDirectory: () => true, isSymbolicLink: () => false }));
  t.mock.method(fs, 'realpathSync', file => file === parent ? parent : probe.toUpperCase());
  assert.equal(api.isClaudeProbeCwd(probe, probe), true);
});

test('Windows prepares a fixed profile leaf without a shell or touching shared overrides', async t => {
  const f = fixture(t);
  const shared = path.join(f.root, 'shared');
  fs.mkdirSync(shared);
  fs.writeFileSync(path.join(shared, 'keep'), 'untouched');
  const env = { ...f.env, TOKEN_MONITOR_SHARED_DIR: shared, APPDATA: shared, LOCALAPPDATA: shared,
    PSModulePath: 'incompatible modules', pSmOdUlEpAtH: 'mixed-case modules' };
  const original = { ...env };
  const api = windowsProbeModule(f.env.HOME, env);
  const options = { env, claudeProbeDir: path.join(shared, 'probe') };
  const expected = path.join(f.env.HOME, 'AppData', 'Local', 'Token Monitor', 'claude-probe');
  const { dir } = await api.prepareClaudeProbeDir(options);
  assert.equal(dir, expected);
  assert.equal(fs.statSync(dir).isDirectory(), true);
  const settings = path.join(dir, '.claude', 'settings.local.json');
  fs.mkdirSync(path.dirname(settings));
  fs.writeFileSync(settings, '{"fixture":"untouched"}');
  assert.equal((await api.prepareClaudeProbeDir(options)).dir, expected);
  assert.equal(fs.readFileSync(settings, 'utf8'), '{"fixture":"untouched"}');
  assert.deepEqual(fs.readdirSync(shared), ['keep']);
  assert.deepEqual(env, original);
});

test('Windows missing or nonlocal OS profiles disable the probe without a fallback', async t => {
  const f = fixture(t);
  for (const profile of ['', 'relative-profile', '\\\\server\\profiles\\fixture', '//server/share/fixture', new Error('profile lookup failed')]) {
    const api = windowsProbeModule(profile, {}, path.win32);
    const options = { env: { TOKEN_MONITOR_SHARED_DIR: f.root }, homeDir: f.env.HOME,
      claudeProbeDir: path.join(f.root, 'fallback') };
    assert.equal(api.claudeProbeDir(options), null);
    await assert.rejects(api.prepareClaudeProbeDir(options), error => error.status === 'unavailable');
    assert.equal(api.isClaudeProbeCwd(path.join(os.tmpdir(), 'token-monitor-claude-probe'), null), true);
    assert.equal(api.isClaudeProbeCwd(path.join(f.root, 'project'), null), false);
  }
  assert.equal(fs.existsSync(path.join(f.root, 'fallback')), false);
});

test('Windows filesystem failure retains diagnostics without serializing them publicly', async t => {
  const f = fixture(t);
  const api = windowsProbeModule(f.env.HOME);
  const dir = api.claudeProbeDir();
  const lstat = fs.lstatSync;
  const failure = Object.assign(new Error('fixture access denied'), { code: 'EACCES' });
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    if (file === dir) throw failure;
    return lstat(file, ...args);
  });
  await assert.rejects(api.prepareClaudeProbeDir(), error => {
    assert.equal(error.status, 'unavailable');
    assert.equal(error.cause, failure);
    assert.deepEqual(JSON.parse(JSON.stringify(error)), { status: 'unavailable' });
    return true;
  });
});

test('probe cwd uses private app data and retains legacy and canonical alias filtering', async t => {
  const f = fixture(t);
  const options = { env: { TOKEN_MONITOR_SHARED_DIR: path.join(f.root, 'app') } };
  const current = claudeProbeDir(options);
  assert.equal(current, process.platform === 'win32'
    ? path.join(f.env.HOME, 'AppData', 'Local', 'Token Monitor', 'claude-probe')
    : path.join(f.root, 'app', 'claude-probe'));
  const { dir: prepared } = await prepareClaudeProbeDir(options);
  assert.equal(isClaudeProbeCwd(prepared, current), true);
  assert.equal(isClaudeProbeCwd(path.join(os.tmpdir(), 'token-monitor-claude-probe'), current), true);
  assert.equal(isClaudeProbeCwd(`${current}-project`, current), false);
  if (process.platform !== 'win32') assert.equal(fs.statSync(prepared).mode & 0o777, 0o700);
  if (process.platform === 'darwin') {
    assert.equal(isClaudeProbeCwd('/private/var/not-yet-created-probe', '/var/not-yet-created-probe'), true);
  }
});

test('agent-first app data created under umask 002 permits a private probe without repair', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const options = { platform: 'linux', homeDir: f.env.HOME, env: f.env };
  const dataDir = sharedDataDir(options);
  const stateFile = path.join(dataDir, 'fixture-state.json');
  const previousUmask = process.umask(0o002);
  try { writeJsonAtomic(stateFile, { fixture: true }); }
  finally { process.umask(previousUmask); }
  const parents = [path.dirname(dataDir), dataDir];
  for (const dir of parents) assert.equal(fs.statSync(dir).mode & 0o777, 0o775);

  const { dir: prepared } = await prepareClaudeProbeDir(options);
  assert.equal(prepared, path.join(dataDir, 'claude-probe'));
  assert.equal(fs.statSync(prepared).mode & 0o777, 0o700);
  for (const dir of parents) assert.equal(fs.statSync(dir).mode & 0o777, 0o775);
  assert.deepEqual(JSON.parse(fs.readFileSync(stateFile, 'utf8')), { fixture: true });
});

test('unsafe probe leaves fail before either PTY or direct CLI starts without deleting data', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const cases = [];
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  fs.writeFileSync(path.join(target, 'keep'), 'untouched');
  const link = path.join(f.root, 'link');
  fs.symlinkSync(target, link);
  cases.push(link);
  const file = path.join(f.root, 'file');
  fs.writeFileSync(file, 'untouched'); cases.push(file);
  for (const mode of [0o755, 0o770, 0o775, 0o777]) {
    const dir = path.join(f.root, `mode-${mode}`);
    fs.mkdirSync(dir); fs.chmodSync(dir, mode); cases.push(dir);
  }
  for (const claudeProbeDir of cases) {
    assert.equal(isClaudeProbeCwd(claudeProbeDir, claudeProbeDir), false);
    let starts = 0;
    const deps = { env: f.env, claudeProbeDir, existsSync: () => false,
      spawn: () => { starts++; return fakeChild(); } };
    await assert.rejects(touchClaudeAuthPath(deps), error => error.status === 'unavailable', claudeProbeDir);
    await assert.rejects(fetchClaudeLimits({}, { ...deps, platform: process.platform,
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      readWindowsCredential: false, readMacKeychain: false, isClaudeCliAuthenticated: async () => true }), /Claude credentials not found/);
    assert.equal(starts, 0, claudeProbeDir);
  }
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'untouched');
  assert.equal(fs.readFileSync(file, 'utf8'), 'untouched');
});

test('unowned directory fails without changing permissions', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'unowned');
  fs.mkdirSync(dir, { mode: 0o700 });
  const lstat = fs.lstatSync;
  t.mock.method(fs, 'lstatSync', (p, ...args) => {
    const stat = lstat(p, ...args);
    if (p === dir) stat.uid = process.getuid() + 1;
    return stat;
  });
  await assert.rejects(prepareClaudeProbeDir({ claudeProbeDir: dir }), /unavailable or unsafe/);
  assert.equal(isClaudeProbeCwd(dir, dir), false);
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
});

test('shared parent permissions do not relax private leaf checks or change existing data', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  for (const mode of [0o775, 0o777]) {
    const parent = path.join(f.root, `shared-${mode}`);
    fs.mkdirSync(parent); fs.chmodSync(parent, mode);
    fs.writeFileSync(path.join(parent, 'keep'), 'untouched');
    const { dir } = await prepareClaudeProbeDir({ claudeProbeDir: path.join(parent, 'probe') });
    assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
    assert.equal(fs.statSync(parent).mode & 0o777, mode);
    assert.equal(fs.readFileSync(path.join(parent, 'keep'), 'utf8'), 'untouched');
    fs.chmodSync(dir, 0o775);
    await assert.rejects(prepareClaudeProbeDir({ claudeProbeDir: dir }), /unavailable or unsafe/);
  }
});

test('macOS extended ACL grants fail closed at the leaf despite mode 0700', { skip: process.platform !== 'darwin' }, async t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'acl');
  fs.mkdirSync(dir, { mode: 0o700 });
  execFileSync('/bin/chmod', ['+a', 'everyone allow read,write,add_file,add_subdirectory,delete_child', dir]);
  await assert.rejects(prepareClaudeProbeDir({ claudeProbeDir: dir }), /unavailable or unsafe/);
});

const python = process.platform === 'win32' ? null : '/usr/bin/python3';
const hasPython = python && spawnSync(python, ['--version'], { env: { PATH: '/usr/bin:/bin' } }).status === 0;

test('real Python accepts a private setgid leaf without changing its permissions', { skip: !hasPython }, async t => {
  const f = fixture(t);
  const parent = path.join(f.root, 'setgid-parent');
  fs.mkdirSync(parent); fs.chmodSync(parent, 0o2775);
  const { dir } = await prepareClaudeProbeDir({ claudeProbeDir: path.join(parent, 'probe') });
  // Linux inherits this bit on mkdir; emulate only the resulting leaf on macOS.
  if (process.platform !== 'linux') fs.chmodSync(dir, 0o2700);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o2700);
  const fake = path.join(f.root, 'setgid-cli.py');
  const receipt = path.join(f.root, 'started');
  fs.writeFileSync(fake, `#!/usr/bin/python3
import os
with open(os.environ['RECEIPT'], 'w') as out:
    out.write(os.getcwd())
print('Account: fixture', flush=True)
`, { mode: 0o700 });
  const output = await touchClaudeAuthPath({
    env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, RECEIPT: receipt },
    claudeProbeDir: dir, pythonCommand: python, claudeStatusTimeoutSeconds: 1,
    spawn: (command, args, options) => {
      assert.equal(command, python);
      return spawn(command, args, options);
    }
  });
  assert.match(output, /Account: fixture/);
  assert.equal(fs.readFileSync(receipt, 'utf8'), dir);
  assert.equal(isClaudeProbeCwd(dir, dir), true);
  assert.equal(fs.statSync(dir).mode & 0o7777, 0o2700);
  assert.equal(fs.statSync(parent).mode & 0o7777, 0o2775);
});

test('redirected and shared parents resolve while linked leaves still fail', { skip: process.platform === 'win32' }, async t => {
  const f = fixture(t);
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target, { mode: 0o700 });
  const alias = path.join(f.root, 'alias');
  fs.symlinkSync(target, alias);
  const { dir: actual } = await prepareClaudeProbeDir({ claudeProbeDir: path.join(alias, 'probe') });
  assert.equal(actual, path.join(target, 'probe'));
  fs.chmodSync(target, 0o777);
  assert.equal((await prepareClaudeProbeDir({ claudeProbeDir: path.join(alias, 'probe') })).dir, actual);
  fs.chmodSync(target, 0o700);
  await assert.rejects(prepareClaudeProbeDir({ claudeProbeDir: alias }), /unavailable or unsafe/);
});

test('a legacy symlink cannot hide a real project through canonical filtering', t => {
  const f = fixture(t);
  const project = path.join(f.root, 'project');
  fs.mkdirSync(project);
  const legacy = path.join(os.tmpdir(), 'token-monitor-claude-probe');
  const realpath = fs.realpathSync;
  t.mock.method(fs, 'realpathSync', (dir, ...args) => dir === legacy ? project : realpath(dir, ...args));
  assert.equal(isClaudeProbeCwd(project, path.join(f.root, 'new-probe')), false);
  assert.equal(isClaudeProbeCwd(legacy, path.join(f.root, 'new-probe')), true);
});

test('a probe leaf swapped after inspection cannot hide its link target', t => {
  const f = fixture(t);
  const probe = path.join(f.root, 'probe');
  const project = path.join(f.root, 'project');
  fs.mkdirSync(probe, { mode: 0o700 });
  fs.mkdirSync(project, { mode: 0o700 });
  const lstat = fs.lstatSync;
  let swapped = false;
  t.mock.method(fs, 'lstatSync', (file, ...args) => {
    const stat = lstat(file, ...args);
    if (file === probe && !swapped) {
      swapped = true;
      fs.rmdirSync(probe);
      fs.symlinkSync(project, probe, 'junction');
    }
    return stat;
  });
  assert.equal(isClaudeProbeCwd(project, probe), false);
  assert.equal(swapped, true);
});

test('real PTY keeps concurrent usage/status restricted and accepts intentional SIGTERM exit 143', { skip: !hasPython }, async t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'probe');
  fs.mkdirSync(dir, { mode: 0o700 });
  fs.mkdirSync(path.join(dir, '.claude'));
  const planted = '{"disableAllHooks":false,"auditSentinel":"retained","hooks":{"SessionStart":[]}}';
  fs.writeFileSync(path.join(dir, '.claude', 'settings.local.json'), planted);
  fs.writeFileSync(path.join(dir, '.mcp.json'), '{"mcpServers":{"inert":{"command":"never-run"}}}');
  const fake = path.join(f.root, 'claude.py');
  fs.writeFileSync(fake, `#!/usr/bin/python3
import json, os, signal, sys, time
signal.signal(signal.SIGTERM, lambda *args: sys.exit(143))
args = sys.argv[1:]
print('Press Enter to continue', flush=True)
first = sys.stdin.readline()
print('Claude Code v2.1.309\\r\\n❯ ', flush=True)
while True:
    command = sys.stdin.readline().strip()
    if command.startswith('/'):
        break
receipt = {'args': args, 'first': first, 'command': command, 'cwd': os.getcwd(), 'history': os.environ.get('CLAUDE_CODE_SKIP_PROMPT_HISTORY')}
with open(os.path.join(os.environ['RECEIPTS'], command[1:] + '.json'), 'w') as out:
    json.dump(receipt, out)
print('Current session 12% left' if command == '/usage' else 'Account: fixture', flush=True)
time.sleep(10)
`, { mode: 0o700 });
  const deps = { env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, RECEIPTS: f.root },
    claudeProbeDir: dir, platform: process.platform, pythonCommand: python,
    readMacKeychain: false, readWindowsCredential: false,
    stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
    isClaudeCliAuthenticated: async () => true, runClaudeVersion: async () => '',
    fetch: async () => { throw new Error('network forbidden'); },
    spawn: (command, args, options) => { assert.equal(command, python); assert.equal(options.env.HOME, f.env.HOME); return spawn(command, args, options); } };
  const [usage] = await Promise.all([fetchClaudeLimits({}, deps), touchClaudeAuthPath(deps)]);
  assert.equal(usage.source, 'cli');
  assert.equal(usage.windows[0].usedPercent, 88);
  for (const command of ['usage', 'status']) {
    const receipt = JSON.parse(fs.readFileSync(path.join(f.root, `${command}.json`)));
    const args = receipt.args;
    assert.equal(args[args.indexOf('--setting-sources') + 1], 'user');
    assert.equal(JSON.parse(args[args.indexOf('--settings') + 1]).disableAllHooks, true);
    assert.ok(args.includes('--strict-mcp-config'));
    assert.equal(args[args.indexOf('--allowed-tools') + 1], '');
    assert.equal(receipt.first, '\n');
    assert.equal(receipt.command, `/${command}`);
    assert.equal(receipt.history, '1');
    assert.equal(receipt.cwd, dir);
  }
  assert.equal(fs.readFileSync(path.join(dir, '.claude', 'settings.local.json'), 'utf8'), planted);
});

test('PTY trust selection waits for a complete menu and selected Yes before confirming', { skip: !hasPython }, async t => {
  for (const mode of ['default-no', 'default-yes', 'fragmented', 'paused-after-menu', 'paused-during-guard', 'premature-input', 'slow-start', 'no-color-env', 'trusted']) {
    for (const command of ['slow-start', 'no-color-env', 'paused-after-menu', 'premature-input'].includes(mode) ? ['status'] : ['usage', 'status']) await t.test(`${mode}: /${command}`, async t => {
      const f = fixture(t);
      const fake = path.join(f.root, 'trust-menu.py');
      const receipt = path.join(f.root, 'trust.json');
      fs.writeFileSync(fake, `#!/usr/bin/python3
import json, os, select, signal, sys, time, tty
tty.setraw(0)
signal.signal(signal.SIGTERM, lambda *args: sys.exit(143))
mode = os.environ['TRUST_MODE']
keys = []
def read_key():
    if not select.select([0], [], [], 12)[0]:
        sys.exit(8)
    key = os.read(0, 128)
    keys.append(key.decode())
    return key
def quiet_until(deadline, pause=False):
    remaining = deadline - time.monotonic()
    if pause:
        # Model descheduling after computing the timeout but before select.
        time.sleep(0.5)
        # Leave input queued so the guarded select must observe readiness.
        if not select.select([0], [], [], 12)[0]:
            sys.exit(8)
    # Readiness can be delivered after the deadline if the process is paused
    # around select. A queued key has no timestamp, so only reject input while
    # the guard is still active when we actually observe it.
    if remaining > 0 and select.select([0], [], [], remaining)[0] and time.monotonic() < deadline:
        sys.stderr.write('probe sent input before the trust fixture was ready\\n')
        sys.exit(9)
def quiet(delay):
    quiet_until(time.monotonic() + delay)
def menu(yes):
    if yes and mode == 'no-color-env' and ('NO_COLOR' in os.environ or os.environ.get('FORCE_COLOR') != '1'):
        # An unstyled Ink selection changes only the marker, not its label.
        print('\\x1b[4A \\r\\x1b[1B❯\\r', flush=True)
        return
    print('\\x1b[2J\\x1b[HQuick safety check: Is this a project you created or one you trust?\\r', flush=True)
    print(('  ' if yes else '❯ ') + 'No,\\x1b[8Gexit\\r', flush=True)
    print(('❯ ' if yes else '  ') + 'Yes,\\x1b[9GI\\x1b[11Gtrust\\x1b[17Gthis\\x1b[22Gfolder\\r', flush=True)
    print('Enter\\x1b[8Gto\\x1b[11Gconfirm · Esc to cancel\\r', flush=True)
if mode != 'trusted':
    if mode == 'slow-start':
        quiet(5.2)
    if mode in ('fragmented', 'paused-after-menu'):
        print('Ready to code here?\\r', flush=True)
        quiet(0.2)
        print('❯ No, exit\\r', flush=True)
        quiet(0.2)
        print('  Yes, I trust this folder\\r', flush=True)
        quiet(0.2)
    # Anchor the mount guard before publishing the menu. If this fixture is
    # descheduled after flush, a key queued after the guard is legitimate.
    # The faulty-probe control checks rejection, not subsecond scheduling.
    confirm_after = time.monotonic() + (12 if mode == 'premature-input' else 0.15)
    menu(mode == 'default-yes')
    if mode == 'paused-after-menu':
        time.sleep(0.5)
    quiet_until(confirm_after, pause=mode == 'paused-during-guard')
    if mode != 'default-yes':
        if read_key() != b'\\x1b[B':
            sys.exit(1)
        # The keypress and selection render are separate events, as in the real UI.
        quiet(0.2)
        menu(True)
    if read_key() != b'\\r':
        sys.exit(2)
    # Confirmation alone is not evidence that the dialog has gone away.
    quiet(0.2)
print('\\x1b[2J\\x1b[HWelcome to Claude Code v2.1.309\\r\\n\\x1b[1B❯\\u00a0 \\r', flush=True)
raw = b''
while not raw.endswith(b'\\r'):
    raw += read_key()
slash = raw.decode().strip()
with open(os.environ['TRUST_RECEIPT'], 'w') as out:
    json.dump({'keys': keys, 'command': slash, 'forceColor': os.environ.get('FORCE_COLOR'), 'noColor': 'NO_COLOR' in os.environ, 'user': os.environ.get('USER')}, out)
if slash not in ('/usage', '/status'):
    sys.exit(3)
print('Current session 12% left' if slash == '/usage' else 'Account: fixture', flush=True)
time.sleep(10)
`, { mode: 0o700 });
      let probeExitCode = null;
      const deps = {
        env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, TRUST_MODE: mode, TRUST_RECEIPT: receipt },
        claudeProbeDir: path.join(f.root, 'probe'), pythonCommand: python,
        readMacKeychain: false, readWindowsCredential: false,
        stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
        isClaudeCliAuthenticated: async () => true, runClaudeVersion: async () => '',
        fetch: async () => { throw new Error('network forbidden'); },
        spawn: (cmd, args, options) => {
          assert.equal(cmd, python);
          if (mode === 'premature-input') {
            // Negative control: the real probe with its mount wait disabled
            // must still be rejected by the fixture's quiet guard.
            assert.ok(args[2].includes('if now - trust_ready_at < 0.25:'));
            args = [...args];
            args[2] = args[2].replace('if now - trust_ready_at < 0.25:', 'if False:');
          }
          const child = spawn(cmd, args, options);
          let output = '';
          child.stdout.on('data', chunk => { output += chunk; });
          child.stderr.on('data', chunk => { output += chunk; });
          child.on('close', code => {
            probeExitCode = code;
            if (code && !(mode === 'premature-input' && code === 9)) t.diagnostic(`PTY fixture exited ${code}: ${output}`);
          });
          return child;
        }
      };
      if (mode === 'no-color-env') {
        Object.assign(deps.env, { NO_COLOR: '1', FORCE_COLOR: '0', USER: 'fixture-user' });
        deps.claudeStatusTimeoutSeconds = 6;
      }
      const parentEnv = { ...deps.env };
      if (mode === 'premature-input') {
        await assert.rejects(touchClaudeAuthPath(deps), error => error.status === 'unavailable');
        assert.equal(probeExitCode, 9);
        return;
      }
      if (command === 'usage') {
        const usage = await fetchClaudeLimits({}, deps);
        assert.equal(usage.source, 'cli');
        assert.equal(usage.windows[0].usedPercent, 88);
      } else assert.match(await touchClaudeAuthPath(deps), /Account: fixture/);
      const observed = JSON.parse(fs.readFileSync(receipt));
      assert.deepEqual(deps.env, parentEnv, 'terminal negotiation is child-only');
      if (mode === 'no-color-env') {
        assert.equal(observed.forceColor, '1');
        assert.equal(observed.noColor, false);
        assert.equal(observed.user, 'fixture-user');
      }
      assert.equal(observed.command, `/${command}`);
      const trustKeys = mode === 'trusted' ? [] : mode === 'default-yes' ? ['\r'] : ['\x1b[B', '\r'];
      assert.deepEqual(observed.keys.slice(0, trustKeys.length), trustKeys);
      assert.equal(observed.keys.slice(trustKeys.length).join('').trim(), `/${command}`);
    });
  }
});

test('an incomplete trust menu times out without receiving Enter or a slash command', { skip: !hasPython }, async t => {
  const f = fixture(t);
  const fake = path.join(f.root, 'partial-menu.py');
  const receipt = path.join(f.root, 'input');
  fs.writeFileSync(receipt, '');
  fs.writeFileSync(fake, `#!/usr/bin/python3
import os, select, time, tty
tty.setraw(0)
print('Quick safety check: Is this a project you created or one you trust?\\r\\n❯ No, exit', flush=True)
while True:
    if select.select([0], [], [], 0.1)[0]:
        with open(os.environ['RECEIPT'], 'ab') as out:
            out.write(os.read(0, 128))
`, { mode: 0o700 });
  await assert.rejects(touchClaudeAuthPath({
    env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, RECEIPT: receipt },
    claudeProbeDir: path.join(f.root, 'probe'), pythonCommand: python,
    claudeStatusTimeoutSeconds: 6,
    spawn: (cmd, args, options) => { assert.equal(cmd, python); return spawn(cmd, args, options); }
  }), /workspace trust did not complete/);
  // Cleanup's /exit is allowed after the timeout; nothing should approve trust
  // or run /status while the menu is incomplete.
  assert.ok(['', '/exit\r'].includes(fs.readFileSync(receipt, 'utf8')));
});

test('unsupported probe flags fail once without an unsafe retry', { skip: !hasPython }, async t => {
  const f = fixture(t);
  const fake = path.join(f.root, 'old-claude.py');
  const receipt = path.join(f.root, 'calls');
  fs.writeFileSync(fake, `#!/usr/bin/python3
import os, sys
with open(os.environ['RECEIPT'], 'a') as out:
    out.write('called\\n')
print('unsupported --setting-sources', flush=True)
sys.exit(1)
`, { mode: 0o700 });
  await assert.rejects(touchClaudeAuthPath({ platform: process.platform,
    env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, RECEIPT: receipt },
    claudeProbeDir: path.join(f.root, 'probe'), pythonCommand: python,
    spawn: (command, args, options) => { assert.equal(command, python); return spawn(command, args, options); }
  }), error => error.status === 'unavailable');
  assert.equal(fs.readFileSync(receipt, 'utf8'), 'called\n');
});

test('native macOS PTY EOF stops reading and collects delayed early exits', { skip: process.platform !== 'darwin' || !hasPython }, async t => {
  for (const [command, exit, code] of [
    ['status', 'sys.exit(7)', 7],
    ['usage', 'sys.exit(7)', 7],
    ['status', 'os.kill(os.getpid(), signal.SIGKILL)', 137]
  ]) await t.test(`${command}: ${exit}`, async t => {
    const f = fixture(t);
    const fake = path.join(f.root, 'native-eof.py');
    const receipt = path.join(f.root, 'reads.json');
    fs.writeFileSync(fake, `#!/usr/bin/python3
import os, signal, sys, time
print('Current session 12% left', flush=True)
for fd in (0, 1, 2):
    os.close(fd)
time.sleep(0.3)
${exit}
`, { mode: 0o700 });
    let pythonExit;
    const deps = {
      env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, EOF_RECEIPT: receipt },
      claudeProbeDir: path.join(f.root, 'probe'), pythonCommand: python,
      claudeStatusTimeoutSeconds: 5, claudeCliTimeoutSeconds: 5,
      readMacKeychain: false, readWindowsCredential: false,
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      isClaudeCliAuthenticated: async () => true, runClaudeVersion: async () => '',
      fetch: async () => { throw new Error('network forbidden'); },
      spawn: (command, args, options) => {
        assert.equal(command, python);
        assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
        // Observe the native bytes without changing EOF into EIO or vice versa.
        const script = args[2].replace('buf = b""', `
import atexit
read_counts = {"eof": 0}
real_read = os.read
def observed_read(fd, size):
    chunk = real_read(fd, size)
    if fd == master and chunk == b"":
        read_counts["eof"] += 1
    return chunk
os.read = observed_read
def save_reads():
    with open(os.environ["EOF_RECEIPT"], "w") as out:
        json.dump(read_counts, out)
atexit.register(save_reads)
buf = b""`);
        const child = spawn(command, [...args.slice(0, 2), script], options);
        child.once('close', code => { pythonExit = code; });
        return child;
      }
    };
    await assert.rejects(command === 'usage' ? fetchClaudeLimits({}, deps) : touchClaudeAuthPath(deps),
      error => error.status === (command === 'usage' ? 'notConfigured' : 'unavailable'));
    assert.equal(pythonExit, code, 'collect the child exit after its PTY descriptors close');
    assert.equal(JSON.parse(fs.readFileSync(receipt)).eof, 1, 'stop at the first native EOF');
  });
});

test('PTY EIO preserves early nonzero and signal exits before shutdown', { skip: !hasPython }, async t => {
  for (const [command, exit, code] of [
    ['status', 'sys.exit(7)', 7],
    ['status', 'os.kill(os.getpid(), signal.SIGTERM)', 143],
    ['status', 'os.kill(os.getpid(), signal.SIGKILL)', 137],
    ['usage', 'os.kill(os.getpid(), signal.SIGKILL)', 137]
  ]) await t.test(`${command}: ${exit}`, async t => {
    const f = fixture(t);
    const fake = path.join(f.root, 'early-close.py');
    fs.writeFileSync(fake, `#!/usr/bin/python3
import os, signal, sys, time
print('Current session 12% left', flush=True)
for fd in (0, 1, 2):
    os.close(fd)
time.sleep(0.3)
${exit}
`, { mode: 0o700 });
    let pythonExit;
    const deps = {
      env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake },
      claudeProbeDir: path.join(f.root, 'probe'), pythonCommand: python,
      readMacKeychain: false, readWindowsCredential: false,
      stat: async () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }); },
      isClaudeCliAuthenticated: async () => true, runClaudeVersion: async () => '',
      fetch: async () => { throw new Error('network forbidden'); },
      spawn: (command, args, options) => {
        assert.equal(command, python);
        // Darwin returns EOF where Linux returns EIO after the PTY slave closes.
        // Translate only that EOF to exercise Linux's exit/poll race on this host.
        assert.deepEqual(args.slice(0, 2), ['-I', '-c']);
        const script = args[2].replace('buf = b""', `
real_read = os.read
def linux_pty_read(fd, size):
    chunk = real_read(fd, size)
    if fd == master and not chunk:
        raise OSError(5, "fixture PTY EIO")
    return chunk
os.read = linux_pty_read
buf = b""`);
        const child = spawn(command, [...args.slice(0, 2), script], options);
        child.once('close', code => { pythonExit = code; });
        return child;
      }
    };
    await assert.rejects(command === 'usage' ? fetchClaudeLimits({}, deps) : touchClaudeAuthPath(deps),
      error => error.status === (command === 'usage' ? 'notConfigured' : 'unavailable'));
    assert.equal(pythonExit, code);
  });
});

test('isolated Python refuses a replaced cwd without importing its planted module or starting CLI', { skip: !hasPython }, async t => {
  const f = fixture(t);
  const dir = path.join(f.root, 'probe');
  const fake = path.join(f.root, 'never-start.py');
  const receipt = path.join(f.root, 'started');
  const imported = path.join(f.root, 'module-imported');
  fs.writeFileSync(fake, `#!/usr/bin/python3
import os
with open(os.environ['RECEIPT'], 'w') as out:
    out.write('started')
print('Yes, I trust this folder', flush=True)
`, { mode: 0o700 });
  await assert.rejects(touchClaudeAuthPath({ env: { ...f.env, TOKEN_MONITOR_CLAUDE_COMMAND: fake, RECEIPT: receipt },
    claudeProbeDir: dir, pythonCommand: python,
    spawn: (command, args, options) => {
      assert.equal(command, python);
      fs.renameSync(dir, `${dir}-old`);
      fs.mkdirSync(dir, { mode: 0o700 });
      fs.writeFileSync(path.join(dir, 'json.py'), `open(${JSON.stringify(imported)}, 'w').write('imported')\n`);
      return spawn(command, args, options);
    }
  }), /changed before launch/);
  assert.equal(fs.existsSync(receipt), false);
  assert.equal(fs.existsSync(imported), false);
});

test('Windows fixed leaf refuses files and junctions without repairing or deleting data', async t => {
  const f = fixture(t);
  const api = windowsProbeModule(f.env.HOME);
  const dir = api.claudeProbeDir();
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const target = path.join(f.root, 'target');
  fs.mkdirSync(target);
  fs.writeFileSync(path.join(target, 'keep'), 'untouched');
  fs.writeFileSync(dir, 'untouched file');
  await assert.rejects(api.prepareClaudeProbeDir(), error => error.status === 'unavailable');
  assert.equal(fs.readFileSync(dir, 'utf8'), 'untouched file');
  fs.unlinkSync(dir);
  for (const destination of [target, path.join(f.root, 'absent')]) {
    fs.symlinkSync(destination, dir, 'junction');
    await assert.rejects(api.prepareClaudeProbeDir(), error => error.status === 'unavailable');
    assert.equal(api.isClaudeProbeCwd(target, dir), false);
    assert.equal(api.isClaudeProbeCwd(target, `${dir}${path.sep}`), false);
    assert.equal(fs.lstatSync(dir).isSymbolicLink(), true);
    fs.unlinkSync(dir);
  }
  assert.equal(fs.readFileSync(path.join(target, 'keep'), 'utf8'), 'untouched');
  assert.equal(fs.existsSync(path.join(f.root, 'absent')), false);
});
