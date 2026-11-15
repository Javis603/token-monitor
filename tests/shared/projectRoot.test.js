'use strict';

const assert = require('node:assert/strict');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createProjectRootResolver } = require('../../src/shared/projectRoot');
const { projectIdentity } = require('../../src/shared/sessionMetadata');
const { projectRollupFromSessions } = require('../../src/shared/usage');

function tempRoot(t) {
  // Native realpath: git records the long form of a Windows 8.3 temp path (RUNNER~1).
  const root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-project-root-')));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  return root;
}

function git(cwd, ...args) {
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...args], { cwd, stdio: 'pipe' });
}

function repoWithWorktree(t) {
  const root = tempRoot(t);
  const main = path.join(root, 'app');
  fs.mkdirSync(main);
  git(main, 'init', '-q', '-b', 'main');
  git(main, 'commit', '-q', '--allow-empty', '-m', 'init');
  const worktree = path.join(root, 'worktrees', 'fix-login');
  git(main, 'worktree', 'add', '-q', '-b', 'fix-login', worktree);
  return { root, main, worktree, cacheFile: path.join(root, 'project-roots.json') };
}

test('a linked worktree resolves to the repository it was created from', (t) => {
  const { main, worktree, cacheFile } = repoWithWorktree(t);
  const resolve = createProjectRootResolver({ cacheFile: () => cacheFile });
  assert.equal(resolve(worktree), main);
  assert.equal(resolve(main), main);
});

test('a worktree of a bare repository resolves to the bare directory', (t) => {
  const root = tempRoot(t);
  const bare = path.join(root, 'app.git');
  git(root, 'init', '-q', '--bare', '-b', 'main', bare);
  const seed = path.join(root, 'seed');
  fs.mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  git(seed, 'commit', '-q', '--allow-empty', '-m', 'init');
  git(seed, 'push', '-q', bare, 'main');
  const worktree = path.join(root, 'checkout');
  git(bare, 'worktree', 'add', '-q', '--detach', worktree, 'main');
  const resolve = createProjectRootResolver({ cacheFile: () => path.join(root, 'project-roots.json') });
  assert.equal(resolve(worktree), bare);
});

test('a submodule checkout stays its own project', (t) => {
  const root = tempRoot(t);
  const submodule = path.join(root, 'super', 'vendor', 'lib');
  const gitDir = path.join(root, 'super', '.git', 'modules', 'lib');
  fs.mkdirSync(submodule, { recursive: true });
  fs.mkdirSync(gitDir, { recursive: true });
  fs.writeFileSync(path.join(submodule, '.git'), `gitdir: ${gitDir}\n`);
  const resolve = createProjectRootResolver({ cacheFile: () => path.join(root, 'project-roots.json') });
  assert.equal(resolve(submodule), submodule);
});

test('history from a deleted worktree still groups with its repository', (t) => {
  const { main, worktree, cacheFile } = repoWithWorktree(t);
  assert.equal(createProjectRootResolver({ cacheFile: () => cacheFile })(worktree), main);

  git(main, 'worktree', 'remove', '--force', worktree);
  assert.equal(fs.existsSync(worktree), false);
  // A fresh resolver is a restarted app: only the remembered mapping is left.
  assert.equal(createProjectRootResolver({ cacheFile: () => cacheFile })(worktree), main);
});

test('a missing directory that was never a worktree resolves to itself and records nothing', (t) => {
  const root = tempRoot(t);
  const cacheFile = path.join(root, 'project-roots.json');
  const resolve = createProjectRootResolver({ cacheFile: () => cacheFile });
  assert.equal(resolve('/work/never-existed'), '/work/never-existed');
  assert.equal(resolve('C:\\Code\\App'), 'C:\\Code\\App');
  assert.equal(fs.existsSync(cacheFile), false);
});

test('projectIdentity gives a worktree and its repository one project', (t) => {
  const { main, worktree, root } = repoWithWorktree(t);
  const previous = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = path.join(root, 'shared');
  t.after(() => {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previous;
  });

  const fromWorktree = projectIdentity(worktree);
  assert.deepEqual(fromWorktree, projectIdentity(main));
  assert.equal(fromWorktree.projectLabel, 'app');

  const rollup = projectRollupFromSessions({
    a: { client: 'claude', sessionId: 'a', totalTokens: 100, ...fromWorktree },
    b: { client: 'codex', sessionId: 'b', totalTokens: 50, ...projectIdentity(main) }
  });
  assert.deepEqual(Object.keys(rollup), ['app']);
  assert.equal(rollup.app.tokens, 150);
});

test('a path reused by another repository\'s worktree follows the live checkout', (t) => {
  const { root, main, worktree, cacheFile } = repoWithWorktree(t);
  const other = path.join(root, 'other');
  fs.mkdirSync(other);
  git(other, 'init', '-q', '-b', 'main');
  git(other, 'commit', '-q', '--allow-empty', '-m', 'init');
  const resolve = createProjectRootResolver({ cacheFile: () => cacheFile });
  assert.equal(resolve(worktree), main);

  git(main, 'worktree', 'remove', '--force', worktree);
  git(other, 'worktree', 'add', '-q', '-b', 'reused', worktree);
  assert.equal(resolve(worktree), other);
});

test('a deleted worktree still groups when a later session spells its path differently', (t) => {
  const { root, main, worktree } = repoWithWorktree(t);
  const previous = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = path.join(root, 'shared');
  t.after(() => {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = previous;
  });
  const repo = projectIdentity(main);
  assert.deepEqual(projectIdentity(worktree), repo);

  git(main, 'worktree', 'remove', '--force', worktree);
  assert.deepEqual(projectIdentity(`${worktree}/`), repo);
});

test('remembered worktrees are found again under the key the caller folds the path to', (t) => {
  const { main, worktree, cacheFile } = repoWithWorktree(t);
  const resolve = createProjectRootResolver({ cacheFile: () => cacheFile });
  const key = worktree.toLowerCase();
  assert.equal(resolve(worktree, key), main);

  git(main, 'worktree', 'remove', '--force', worktree);
  // A case-insensitive filesystem would reach the same directory through any casing.
  assert.equal(resolve(worktree.toUpperCase(), key), main);
});

test('a mapping whose write failed is written by a later resolve', (t) => {
  const { root, main, worktree } = repoWithWorktree(t);
  const blocker = path.join(root, 'blocker');
  fs.writeFileSync(blocker, '');
  // A file where the directory should be makes the first write fail.
  let cacheFile = path.join(blocker, 'project-roots.json');
  const resolve = createProjectRootResolver({ cacheFile: () => cacheFile });
  const warn = console.warn;
  console.warn = () => {};
  t.after(() => { console.warn = warn; });
  assert.equal(resolve(worktree), main);

  cacheFile = path.join(root, 'project-roots.json');
  assert.equal(resolve(worktree), main);
  assert.deepEqual(JSON.parse(fs.readFileSync(cacheFile, 'utf8')), { [worktree]: main });
});
