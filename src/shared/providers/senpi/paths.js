'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');
const { normalizeCustomScanPaths } = require('../../customScanPaths');

const HEADER_CACHE_LIMIT = 4096;
const headerCache = new Map();

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value : '';
}

function isDirectory(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

// OmO uses JSONC. Keep strings intact while removing comments and trailing
// commas; never evaluate configuration as JavaScript. No runtime JSONC package
// is installed, and this reader only needs the task block.
function readTaskState(project) {
  for (const name of ['omo.jsonc', 'omo.json']) {
    try {
      const file = path.join(project, '.omo', name);
      if (fs.statSync(file).size > 256 * 1024) continue;
      const text = fs.readFileSync(file, 'utf8')
        .replace(/("(?:\\.|[^"\\])*")|\/\/[^\r\n]*|\/\*[\s\S]*?\*\//g, (match, string) => string || ' ')
        .replace(/("(?:\\.|[^"\\])*")|,\s*(?=[}\]])/g, (match, string) => string || '');
      const config = JSON.parse(text);
      if (!config || !Object.hasOwn(config, 'task')) return undefined;
      const dir = config.task?.state_dir;
      // A declared task block replaces the whole inherited block, even when
      // empty or relative. Match the pinned scanner's DefaultLayout case.
      return typeof dir === 'string' && path.isAbsolute(dir) ? dir : null;
    } catch (_) { /* An invalid JSONC file falls back to omo.json, like tokscale. */ }
  }
  return undefined;
}

function projectCwds(sessions, seenHeaders) {
  const projects = new Set();
  let entries;
  try { entries = fs.readdirSync(sessions, { withFileTypes: true }); } catch (_) { return projects; }
  for (const entry of entries) {
    const dir = path.join(sessions, entry.name);
    if (!entry.isDirectory() && !(entry.isSymbolicLink() && isDirectory(dir))) continue;
    let files;
    try { files = fs.readdirSync(dir, { withFileTypes: true }); } catch (_) { continue; }
    for (const file of files) {
      if (!file.name.endsWith('.jsonl') || (!file.isFile() && !file.isSymbolicLink())) continue;
      const filePath = path.join(dir, file.name);
      let fd;
      try {
        const stat = fs.statSync(filePath);
        if (!stat.isFile()) continue;
        seenHeaders.add(filePath);
        // File metadata catches in-place writes; identity also catches link
        // retargets and replaced files with an otherwise identical timestamp/size.
        const key = `${stat.mtimeMs}:${stat.size}:${stat.ctimeMs}:${stat.dev}:${stat.ino}`;
        const cached = headerCache.get(filePath);
        if (cached?.key === key) {
          if (cached.cwd) projects.add(cached.cwd);
          continue;
        }
        fd = fs.openSync(filePath, 'r');
        const bytes = Buffer.alloc(8192); // scanner's session-header limit
        const count = fs.readSync(fd, bytes, 0, bytes.length, 0);
        const end = bytes.indexOf(10, 0);
        const header = JSON.parse(bytes.subarray(0, end >= 0 && end < count ? end : count).toString('utf8'));
        const cwd = header?.type === 'session' && typeof header.cwd === 'string' && path.isAbsolute(header.cwd) ? header.cwd : null;
        headerCache.delete(filePath);
        // Keep admitted entries stable: sequential walks over an oversized tree
        // would otherwise evict each next hit and reread every header each time.
        if (headerCache.size < HEADER_CACHE_LIMIT) headerCache.set(filePath, { key, cwd });
        if (cwd) projects.add(cwd);
      } catch (_) {
        // Read/parse failures may recover without a metadata change. Retry them.
        headerCache.delete(filePath);
      }
      finally { if (fd !== undefined) fs.closeSync(fd); }
    }
  }
  return projects;
}

function senpiTopology(home, env, options) {
  const agentDir = nonBlank(env.SENPI_CODING_AGENT_DIR);
  const sessions = agentDir
    ? path.join(agentDir, 'sessions')
    : path.join(home, '.senpi', 'agent', 'sessions');
  const roots = [
    ['senpi-sessions', sessions],
    ['senpi-omo-sessions', path.join(home, '.omo', 'agent', 'sessions')]
  ];
  const extra = nonBlank(env.SENPI_CODING_AGENT_SESSION_DIR);
  const projects = new Set([home]);
  if (options.useEnvRoots !== false) {
    projects.add(options.cwdDir || process.cwd());
    const custom = normalizeCustomScanPaths(options.customScanPaths, options).senpi || [];
    const seenHeaders = new Set();
    for (const dir of new Set([sessions, roots[1][1], ...(extra ? [extra] : []), ...custom.flatMap(dir => [dir, path.join(dir, 'sessions')])])) {
      for (const project of projectCwds(dir, seenHeaders)) projects.add(project);
    }
    for (const file of headerCache.keys()) if (!seenHeaders.has(file)) headerCache.delete(file);
  }
  const userState = readTaskState(home);
  const taskDirs = new Set();
  const configFiles = [];
  for (const project of [...projects].sort()) {
    const state = readTaskState(project);
    const taskDir = state === undefined ? userState : state;
    taskDirs.add(path.join(taskDir || path.join(project, '.omo/senpi-task'), 'children'));
    configFiles.push(...['omo.jsonc', 'omo.json'].map(name => path.join(project, '.omo', name)));
  }
  // Stable ordering avoids rebuilding the host when directory enumeration order changes.
  roots.push(...[...taskDirs].sort().map(dir => ['senpi-task-children', dir]));
  if (extra) roots.push(['senpi-sessions', extra]);
  return { roots, configFiles };
}

function senpiSourceRoots(home, env = {}, options = {}) {
  return senpiTopology(home, env, options).roots;
}

function senpiWatchSources(options = {}) {
  const env = options.env || process.env;
  const home = tokscaleHomeDir({ ...options, env });
  const { roots, configFiles } = senpiTopology(home, env, options);
  const targets = [
    ...roots.map(([, dir]) => ({ path: dir, recursive: true })),
    ...configFiles.map(file => ({ path: file, recursive: false }))
  ];
  const dirs = new Set();
  for (const target of targets) {
    let dir = target.recursive ? target.path : path.dirname(target.path);
    while (!isDirectory(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir);
    if (process.platform === 'win32' && isDirectory(dir)) {
      // Existing junctions/8.3 spellings must resolve even when the leaf does
      // not exist yet, into the same path space as the native watch root.
      try { target.path = path.join(fs.realpathSync.native(dir), path.relative(dir, target.path)); } catch (_) {}
    }
    // An absent OmO installation must not create a watch over the whole home
    // or filesystem. Known projects may watch their exact .omo ancestor chain.
    if (isDirectory(dir) && path.resolve(dir) !== path.resolve(home) && path.dirname(dir) !== dir) dirs.add(dir);
  }
  return { roots, targets, dirs: [...dirs].sort() };
}

function resolveSenpiSessionsDirs({ homeDir = '', env = process.env, useEnvRoots = true } = {}) {
  const home = useEnvRoots === false ? homeDir : tokscaleHomeDir({ homeDir, env });
  return [...new Set(senpiSourceRoots(home, useEnvRoots === false ? {} : env, { useEnvRoots }).map(([, dir]) => dir))];
}

module.exports = { senpiSourceRoots, senpiWatchSources, resolveSenpiSessionsDirs };
