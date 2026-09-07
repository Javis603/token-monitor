'use strict';

// The native macOS watcher has no `ignored` option, so `watchIgnoreMatcher()`
// runs once per delivered event instead of once per traversal entry (see
// `src/shared/nativeWatcher.js`). chokidar never descends into a directory it
// ignores, so the two agree only while every policy in `watchPolicyEntries()`
// is prefix-closed: if a directory is ignored, everything under it must be
// ignored too.
//
// A policy that pruned a directory while keeping a path underneath it would be
// correct for chokidar and would leak those events on macOS. This walks a real
// synthetic tree under every watch root — real, because the reasonix and
// commandcode policies stat the path, so nonexistent probes would answer
// differently from live events — and fails on the first parent/child pair that
// breaks closure.

const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

// Kept deliberately small, and directories only. Only the reasonix and
// commandcode policies touch the filesystem, and both stat purely to answer
// "is this a directory?" — a path that does not exist takes their catch branch
// and lands on the same answer a real non-transcript file would, so the file
// names below are generated as strings and never written. That matters: an
// earlier version wrote ~34k files into the temp dir and saturated fseventsd
// hard enough to starve the FSEvents-backed tests running in parallel.
const DIR_NAMES = ['storage', 'message', 'projects', 'other'];
const FILE_NAMES = [
  'a.jsonl', 'a.checkpoints.jsonl', 'a.json', 'a.db', 'a.db-shm',
  'unified.jsonl', 'workspace.json', 'a.txt'
];
const MAX_DEPTH = 3;

// Every directory under `root`, created; plus every file path under each of
// them, as a string. Returned as [parent, child] pairs so the caller does not
// have to re-derive the parent for a path it generated.
function candidatePairs(root, depth = 0, out = []) {
  if (depth >= MAX_DEPTH) return out;
  for (const name of DIR_NAMES) {
    const child = path.join(root, name);
    try { fs.mkdirSync(child, { recursive: true }); } catch (_) { continue; }
    out.push([root, child]);
    for (const file of FILE_NAMES) out.push([child, path.join(child, file)]);
    candidatePairs(child, depth + 1, out);
  }
  return out;
}

test('every watch ignore policy is prefix-closed', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-prefix-closure-'));
  const realHomedir = os.homedir;
  const realHome = process.env.HOME;
  const realXdg = process.env.XDG_DATA_HOME;
  os.homedir = () => home;
  process.env.HOME = home;
  process.env.XDG_DATA_HOME = path.join(home, '.local', 'share');
  // Stubbing os.homedir() is not enough, and none of these are in
  // SOURCE_ENV_KEYS. Several roots prefer an absolute env path over the home
  // they are handed, so on a real runner they resolve into the actual profile
  // and this test would create directories there: `tokscaleConfigDir()` takes
  // XDG_CONFIG_HOME ahead of homeDir on Linux (that is how a leaked
  // `<XDG_CONFIG_HOME>/tokscale/antigravity-cache` made a later
  // `clientStatus.test.js` run see Antigravity as present), TOKSCALE_CONFIG_DIR
  // wins outright, and %APPDATA%/%LOCALAPPDATA% carry Kiro, Cline and Zed on
  // Windows. Redirect them all into the temp home, and refuse below to create
  // anything outside it.
  const REDIRECTED = {
    APPDATA: path.join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: path.join(home, 'AppData', 'Local'),
    XDG_CONFIG_HOME: path.join(home, '.config'),
    XDG_CACHE_HOME: path.join(home, '.cache'),
    TOKSCALE_CONFIG_DIR: path.join(home, '.config', 'tokscale')
  };
  const savedRedirects = new Map(Object.keys(REDIRECTED).map((key) => [key, process.env[key]]));
  for (const [key, value] of Object.entries(REDIRECTED)) process.env[key] = value;
  try {
    // Required after the home is redirected: the module reads os.homedir() at
    // call time, but keeping the order explicit matches the other watch tests.
    const collector = require('../../src/shared/collector');
    // KNOWN_CLIENTS is already the CSV the collector speaks, not a list.
    const { KNOWN_CLIENTS: clientsCsv } = require('../../src/shared/clientTracking');

    // Materialise every declared source root so watchPathsForClients() keeps
    // them, then grow a synthetic subtree under each.
    const inside = (target) => path.resolve(target).startsWith(path.resolve(home) + path.sep);
    for (const roots of Object.values(collector.clientSourceRoots(clientsCsv))) {
      for (const root of roots) {
        // Belt and braces on top of the env redirect above: this test must
        // never write outside the directory it cleans up.
        if (!inside(root.dir)) continue;
        try { fs.mkdirSync(root.dir, { recursive: true }); } catch (_) { continue; }
        if (root.sourcePath) {
          try { fs.writeFileSync(root.sourcePath, ''); } catch (_) { /* parent may be a file */ }
        }
      }
    }

    const watchRoots = collector.watchPathsForClients(clientsCsv);
    assert.ok(watchRoots.length > 0, 'expected the synthetic home to produce watch roots');

    const ignore = collector.watchIgnoreMatcher(clientsCsv);
    assert.ok(typeof ignore === 'function', 'expected a bounded matcher for the full client set');

    let checked = 0;
    const violations = [];
    for (const root of watchRoots) {
      if (!inside(root)) continue;
      for (const [parent, child] of candidatePairs(root)) {
        // A watch root is a source in its own right and `watchIgnoreMatcher`
        // never ignores it, so pairs rooted at it carry no information.
        if (path.resolve(parent) === path.resolve(root)) continue;
        checked += 1;
        if (ignore(parent) && !ignore(child)) {
          violations.push({
            root,
            parent: path.relative(root, parent),
            child: path.relative(root, child)
          });
        }
      }
    }

    assert.ok(checked > 0, 'expected the synthetic tree to produce parent/child pairs');
    assert.deepEqual(
      violations.slice(0, 10),
      [],
      `a policy prunes a directory but keeps a path under it, which chokidar hides and the macOS native watcher would leak (${violations.length} pair(s), first 10 shown)`
    );
  } finally {
    os.homedir = realHomedir;
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome;
    if (realXdg === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = realXdg;
    for (const [key, previous] of savedRedirects) {
      if (previous === undefined) delete process.env[key]; else process.env[key] = previous;
    }
    fs.rmSync(home, { recursive: true, force: true });
  }
});
