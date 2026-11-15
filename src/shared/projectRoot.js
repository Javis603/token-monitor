'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { readJson, sharedDataDir, writeJsonAtomic } = require('./config');

// A linked git worktree is its own directory but not its own project: every
// worktree of a repository shares one common git dir, and that is the
// repository's identity. Resolving to it keeps a session run in
// `~/.t3/worktrees/app/fix-login` in the same project as one run in `app`.
//
// A worktree's `.git` is a file (`gitdir: <repo>/.git/worktrees/<name>`) and
// that directory's `commondir` file points back at the shared git dir. A
// submodule's `.git` file has no `commondir`, so it stays its own project.
//
// Worktrees are routinely deleted once their branch lands, and with them the
// files that prove the relationship. Every resolved mapping is therefore kept
// in a small file beside the other shared state, so history recorded from a
// worktree that is gone still groups with its repository.
const MAX_REMEMBERED = 2000;

function linkedWorktreeRoot(dir) {
  let gitFile;
  try {
    gitFile = path.join(dir, '.git');
    if (!fs.lstatSync(gitFile).isFile()) return { known: true, root: dir };
  } catch (_) { return { known: false }; }
  try {
    const pointer = /^gitdir:\s*(.+?)\s*$/m.exec(fs.readFileSync(gitFile, 'utf8'));
    if (!pointer) return { known: true, root: dir };
    const gitDir = path.resolve(dir, pointer[1]);
    const common = path.resolve(gitDir, fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim());
    return { known: true, root: path.basename(common) === '.git' ? path.dirname(common) : common };
  } catch (_) {
    // No readable commondir: a submodule, or a worktree whose git dir was pruned.
    return { known: false };
  }
}

function createProjectRootResolver({ cacheFile = () => path.join(sharedDataDir(), 'project-roots.json') } = {}) {
  let remembered = null;

  function loadRemembered() {
    if (remembered) return remembered;
    const saved = readJson(cacheFile(), null);
    remembered = new Map(saved && typeof saved === 'object' ? Object.entries(saved).filter(([, root]) => typeof root === 'string') : []);
    return remembered;
  }

  function remember(dir, root) {
    const map = loadRemembered();
    if (map.get(dir) === root) return;
    // Another process may have recorded worktrees since this one loaded.
    const onDisk = readJson(cacheFile(), null);
    for (const [key, value] of Object.entries(onDisk && typeof onDisk === 'object' ? onDisk : {})) {
      if (typeof value === 'string' && !map.has(key)) map.set(key, value);
    }
    map.delete(dir);
    map.set(dir, root);
    while (map.size > MAX_REMEMBERED) map.delete(map.keys().next().value);
    try { writeJsonAtomic(cacheFile(), Object.fromEntries(map), 0); } catch (_) { /* history grouping degrades; usage is unaffected */ }
  }

  return function resolveProjectRoot(dir) {
    if (!dir) return dir;
    const live = linkedWorktreeRoot(dir);
    if (!live.known) return loadRemembered().get(dir) || dir;
    if (live.root !== dir) remember(dir, live.root);
    return live.root;
  };
}

module.exports = { createProjectRootResolver, resolveProjectRoot: createProjectRootResolver() };
