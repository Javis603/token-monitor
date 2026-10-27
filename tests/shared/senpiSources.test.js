'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots, clientSourceChecks, watchPathsForClients,
  clientsForWatchPath, watchIgnoreMatcher, watchAttributionRootsForClients, startCollector } = require('../../src/shared/collector');
const { resolveSessionDetailForPlatform } = require('../../src/shared/sessionDetailResolver');
const { senpiSourceRoots } = require('../../src/shared/providers/senpi/paths');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');
const { installInProcessWatchHost } = require('../helpers/watchHost');

installSourceEnvGuard(test);
installInProcessWatchHost(test);

function fixture(t) {
  // Windows runners expose an 8.3 TEMP path, while watcher events use its
  // canonical long spelling. Synthesize events in that same path space.
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-senpi-sources-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const project = path.join(root, 'project');
  fs.mkdirSync(home);
  fs.mkdirSync(project);
  return { root, home, project, options: { homeDir: home, env: {}, cwdDir: root } };
}

function header(home, project, name = 'parent', tree = '.omo/agent/sessions') {
  const dir = path.join(home, tree, '--colliding-projects--');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-25_${name}.jsonl`);
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: name, cwd: project }) + '\n');
  return file;
}

function children(project) { return path.join(project, '.omo', 'senpi-task', 'children'); }

test('Senpi reuses unchanged headers but discovers appended and rewritten headers', t => {
  const { home, project, root, options } = fixture(t);
  const file = header(home, project);
  const foreign = header(home, 'relative', 'foreign');
  const open = fs.openSync;
  const reads = [];
  t.mock.method(fs, 'openSync', (name, ...args) => {
    if (name === file || name === foreign) reads.push(name);
    return open(name, ...args);
  });
  const scan = () => senpiSourceRoots(home, {}, options).map(([, dir]) => dir);
  assert.ok(scan().includes(children(project)));
  scan();
  assert.deepEqual(reads.toSorted(), [foreign, file].toSorted(), 'successful headers, including ignored cwd values, are reused');
  fs.appendFileSync(file, '{"type":"message"}\n');
  assert.ok(scan().includes(children(project)));
  assert.equal(reads.length, 3, 'file size invalidates only the appended transcript');
  const other = path.join(root, 'another'); // same length as "project"
  const previous = fs.statSync(file);
  const dirTime = fs.statSync(path.dirname(file));
  const text = fs.readFileSync(file, 'utf8').replace(JSON.stringify(project), JSON.stringify(other));
  fs.writeFileSync(file, text);
  fs.utimesSync(file, previous.atime, new Date(previous.mtimeMs + 2000));
  fs.utimesSync(path.dirname(file), dirTime.atime, dirTime.mtime);
  assert.equal(fs.statSync(file).size, previous.size);
  const dirs = scan();
  assert.ok(dirs.includes(children(other)), 'in-place rewrites do not rely on directory mtime');
  assert.ok(!dirs.includes(children(project)));
  assert.equal(reads.length, 4);
});

for (const failure of ['open', 'read', 'parse']) {
  test(`Senpi retries a failed header ${failure} with unchanged file metadata`, t => {
    const { home, project, options } = fixture(t);
    const file = header(home, project);
    const previous = fs.statSync(file);
    const open = fs.openSync;
    const read = fs.readSync;
    let fail = true;
    let headerFd;
    let opens = 0;
    t.mock.method(fs, 'openSync', (name, ...args) => {
      if (name === file) {
        opens++;
        if (fail && failure === 'open') { fail = false; throw new Error('temporary open failure'); }
      }
      const fd = open(name, ...args);
      if (name === file) headerFd = fd;
      return fd;
    });
    t.mock.method(fs, 'readSync', (fd, buffer, ...args) => {
      if (fd === headerFd && fail) {
        fail = false;
        if (failure === 'read') throw new Error('temporary read failure');
        if (failure === 'parse') { buffer.write('{\n'); return 2; }
      }
      return read(fd, buffer, ...args);
    });
    const scan = () => senpiSourceRoots(home, {}, options).map(([, dir]) => dir);
    assert.ok(!scan().includes(children(project)));
    assert.equal(fs.statSync(file).mtimeMs, previous.mtimeMs);
    assert.equal(fs.statSync(file).size, previous.size);
    assert.ok(scan().includes(children(project)), 'the next scan retries the failed header');
    scan();
    assert.equal(opens, 2, 'only a successful retry enters the cache');
  });
}

test('Senpi evicts removed headers before their paths are reused', t => {
  const { home, project, root, options } = fixture(t);
  const file = header(home, project);
  const stat = fs.statSync;
  const previous = stat(file);
  // Reproduce path reuse with an identical cache signature on any filesystem.
  t.mock.method(fs, 'statSync', (name, ...args) => {
    const current = stat(name, ...args);
    return name === file ? previous : current;
  });
  const scan = () => senpiSourceRoots(home, {}, options).map(([, dir]) => dir);
  assert.ok(scan().includes(children(project)));
  fs.unlinkSync(file);
  assert.ok(!scan().includes(children(project)));
  const other = path.join(root, 'another');
  fs.writeFileSync(file, JSON.stringify({ type: 'session', id: 'parent', cwd: other }) + '\n');
  const dirs = scan();
  assert.ok(dirs.includes(children(other)));
  assert.ok(!dirs.includes(children(project)));
});

test('Senpi bounds its header cache across large session trees', t => {
  const { home, project, options } = fixture(t);
  for (let i = 0; i < 4097; i++) header(home, project, `parent-${String(i).padStart(4, '0')}`);
  const open = fs.openSync;
  let reads = 0;
  t.mock.method(fs, 'openSync', (name, ...args) => {
    reads++;
    return open(name, ...args);
  });
  const scan = () => senpiSourceRoots(home, {}, options);
  scan();
  scan(); // fill any slots freed when the first scan prunes a previous source tree
  reads = 0;
  scan();
  assert.equal(reads, 1, 'only the overflow header is reread, without flushing the admitted entries');
});

test('Senpi discovers every project header and attributes task-child writes', t => {
  const { home, project, root, options } = fixture(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(children(project), { recursive: true });
  fs.mkdirSync(children(other), { recursive: true });
  header(home, project);
  header(home, other, 'other'); // same lossy directory name, distinct header cwd
  const roots = watchAttributionRootsForClients('senpi', null, options);
  for (const dir of [children(project), children(other)]) {
    assert.deepEqual(clientsForWatchPath(path.join(dir, 'task/sessions/child.jsonl'), roots), ['senpi']);
  }
  assert.ok(clientSourceChecks('senpi', options).senpi.some(c => c.id === 'senpi-task-children' && c.exists));
});

test('Senpi watches future child directories through a narrowly filtered ancestor', t => {
  const { home, project, options } = fixture(t);
  header(home, project);
  const roots = watchPathsForClients('senpi', options);
  assert.ok(roots.includes(project), 'existing project watches only the future .omo path');
  assert.ok(!roots.includes(home), 'never recursively watch the home');
  const ignored = watchIgnoreMatcher('senpi', options);
  assert.equal(ignored(path.join(project, '.omo')), false);
  assert.equal(ignored(children(project)), false);
  assert.equal(ignored(path.join(children(project), 'task/sessions/child.jsonl')), false);
  assert.equal(ignored(path.join(project, 'node_modules')), true);
  assert.equal(ignored(path.join(project, '.omo', 'unrelated-cache')), true);
  assert.deepEqual(clientsForWatchPath(path.join(project, 'src/index.js'),
    watchAttributionRootsForClients('senpi', null, options)), []);
  assert.equal(watchIgnoreMatcher('senpi', { ...options, customScanPaths: { senpi: [project] } })(path.join(project, 'src')), false,
    'a user-selected recursive root keeps its own scanning contract');
});

test('Senpi follows JSONC state_dir precedence and whole task-block replacement', t => {
  const { home, project, root, options } = fixture(t);
  header(home, project);
  const userState = path.join(root, 'user-state');
  const projectState = path.join(root, 'project-state');
  fs.mkdirSync(path.join(home, '.omo'), { recursive: true });
  fs.writeFileSync(path.join(home, '.omo/omo.jsonc'), `{// user\n"task":{"state_dir":${JSON.stringify(userState)},},}`);
  let dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.ok(dirs.includes(path.join(userState, 'children')));
  fs.mkdirSync(path.join(project, '.omo'));
  fs.writeFileSync(path.join(project, '.omo/omo.jsonc'), `{"task":{"state_dir":${JSON.stringify(projectState)}}}`);
  dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.ok(dirs.includes(path.join(projectState, 'children')));
  fs.writeFileSync(path.join(project, '.omo/omo.jsonc'), '{"task":{}}');
  dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.ok(dirs.includes(children(project)), 'an empty project task block suppresses the user state_dir');
});

test('Senpi rejects relative and oversized headers and follows supported session links', t => {
  const { home, project, options } = fixture(t);
  const file = header(home, 'relative/project');
  let dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.ok(!dirs.some(dir => dir.includes('relative/project')));
  fs.writeFileSync(file, JSON.stringify({ type: 'session', padding: 'x'.repeat(8192), cwd: project }));
  dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.ok(!dirs.includes(children(project)));
  fs.writeFileSync(file, JSON.stringify({ type: 'session', cwd: project }) + '\n');
  const link = path.join(home, '.omo/agent/sessions/--linked--');
  fs.symlinkSync(path.dirname(file), link, process.platform === 'win32' ? 'junction' : 'dir');
  dirs = clientSourceRoots('senpi', options).senpi.map(r => r.dir);
  assert.equal(dirs.filter(dir => dir === children(project)).length, 1);
});

test('Senpi discovers child roots through env and custom agent/session directories', t => {
  const { home, project, root, options } = fixture(t);
  fs.mkdirSync(children(project), { recursive: true });
  const agent = path.join(root, 'relocated-agent');
  header(root, project, 'env-parent', 'relocated-agent/sessions');
  for (const config of [
    { env: { SENPI_CODING_AGENT_DIR: agent } },
    { env: { SENPI_CODING_AGENT_SESSION_DIR: path.join(agent, 'sessions') } },
    { customScanPaths: { senpi: [agent] } },
    { customScanPaths: { senpi: [path.join(agent, 'sessions')] } }
  ]) {
    const dirs = clientSourceRoots('senpi', { ...options, ...config }).senpi.map(r => r.dir);
    assert.ok(dirs.includes(children(project)), JSON.stringify(config));
  }
  assert.ok(!clientSourceRoots('codex', { ...options, homeDir: home }).senpi);
});

test('Senpi JSONC preserves strings and falls back from malformed JSONC to JSON', t => {
  const { home, project, root, options } = fixture(t);
  header(home, project);
  fs.mkdirSync(path.join(project, '.omo'));
  const state = path.join(root, 'state,}');
  const config = path.join(project, '.omo/omo.jsonc');
  fs.writeFileSync(config, `{"url":"https://example.com/a/*b*/",/* comment */"task":{"state_dir":${JSON.stringify(state)},},}`);
  assert.ok(clientSourceRoots('senpi', options).senpi.some(r => r.dir === path.join(state, 'children')));
  fs.writeFileSync(config, '{ invalid');
  fs.writeFileSync(path.join(project, '.omo/omo.json'), JSON.stringify({ task: { state_dir: state } }));
  assert.ok(clientSourceRoots('senpi', options).senpi.some(r => r.dir === path.join(state, 'children')));
  fs.writeFileSync(config, '{"task":{"state_dir":"relative"}}');
  assert.ok(clientSourceRoots('senpi', options).senpi.some(r => r.dir === children(project)));
});

test('Senpi Windows HOME redirects roots while scoped WSL detail ignores host overrides', async () => {
  const roots = clientSourceRoots('senpi', {
    homeDir: 'C:/Users/Profile', platform: 'win32', env: { HOME: 'D:/OmOHome' }
  }).senpi;
  assert.equal(roots.find(r => r.id === 'senpi-omo-sessions').dir, path.join('D:/OmOHome', '.omo/agent/sessions'));
  const calls = [];
  await resolveSessionDetailForPlatform({ client: 'senpi', sessionId: 'missing' }, {
    platform: 'win32', homedir: () => 'C:/Users/Profile',
    env: { HOME: 'D:/OmOHome', SENPI_CODING_AGENT_DIR: 'D:/Agent' },
    wslUsageHomes: () => ['/wsl/home'],
    readSessionDetail: args => { calls.push(args); return { found: false }; }
  });
  assert.equal(calls[0].home, 'D:/OmOHome');
  assert.equal(calls[1].home, '/wsl/home');
  assert.equal(calls[1].useEnvRoots, false);
  assert.deepEqual(calls[1].env, {});
});

test('a Senpi parent watch tick installs newly discovered child roots before the next interval', async t => {
  const { home, project, options } = fixture(t);
  const parent = header(home, project);
  const chokidar = require('chokidar');
  const { EventEmitter } = require('node:events');
  const hosts = [];
  t.mock.method(chokidar, 'watch', dirs => {
    const host = new EventEmitter();
    host.close = () => {};
    hosts.push({ dirs, host });
    return host;
  });
  const updates = [];
  const runtime = startCollector({ ...options, clients: 'senpi', deviceId: 'senpi-watch',
    historyEnabled: false, sessionActivityPolling: false, anchorPersistenceEnabled: false, watchEnabled: true,
    intervalMs: 60000, watchDebounceMs: 5,
    runTokscale: async () => ({ entries: [] }),
    onUpdate: (_summary, reason) => updates.push(reason)
  });
  t.after(() => runtime.stop());
  const until = async predicate => {
    const deadline = Date.now() + 2000;
    while (!predicate()) {
      if (Date.now() > deadline) throw new Error('collector did not install the discovered child root');
      await new Promise(resolve => setTimeout(resolve, 5));
    }
  };
  await until(() => updates.length > 0);
  const newProject = path.join(project, 'new-project');
  fs.mkdirSync(children(newProject), { recursive: true });
  header(home, newProject, 'new-parent');
  hosts.at(-1).host.emit('all', 'add', parent);
  await until(() => updates.some(reason => reason.startsWith('watch:')));
  assert.ok(hosts.at(-1).dirs.includes(children(newProject)), 'anchored watch ticks refresh the root snapshot');
});
