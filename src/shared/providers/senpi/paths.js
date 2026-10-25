'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { tokscaleHomeDir } = require('../../tokscaleConfig');
const { normalizeCustomScanPaths } = require('../../customScanPaths');

const HEADER_CACHE_LIMIT = 4096;
const CUSTOM_DISCOVERY_ENTRY_LIMIT = 20000;
const CUSTOM_DISCOVERY_DEPTH_LIMIT = 32;
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

function* directoryEntries(dir) {
  let handle;
  try {
    handle = fs.opendirSync(dir);
    let entry;
    while ((entry = handle.readSync())) yield entry;
  } catch (_) { /* Missing or unreadable sources are retried on the next discovery. */ }
  finally { if (handle) handle.closeSync(); }
}

function projectCwds(sessions, seenHeaders, budget = null) {
  const projects = new Set();
  const visited = new Set();
  function walk(dir, depth) {
    if (budget && budget.remaining <= 0) return;
    let real;
    try { real = fs.realpathSync.native(dir); } catch (_) { return; }
    if (visited.has(real)) return;
    visited.add(real);
    for (const file of directoryEntries(dir)) {
      if (budget && budget.remaining-- <= 0) break;
      const filePath = path.join(dir, file.name);
      if (file.isDirectory() || (file.isSymbolicLink() && isDirectory(filePath))) {
        if (depth < (budget ? CUSTOM_DISCOVERY_DEPTH_LIMIT : 1)) walk(filePath, depth + 1);
        continue;
      }
      if (!budget && depth === 0) continue;
      if (!file.name.endsWith('.jsonl') || (!file.isFile() && !file.isSymbolicLink())) continue;
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
  walk(sessions, 0);
  return projects;
}

function centralProjectKey(project) {
  let canonical = path.resolve(project);
  try { canonical = fs.realpathSync.native(canonical); } catch (_) {}
  const name = path.basename(canonical).replace(/[^\p{L}\p{N}._-]/gu, '_') || 'root';
  return `${name}-${createHash('sha256').update(canonical).digest('hex').slice(0, 12)}`;
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
  const omoAgent = nonBlank(env.OMO_CODING_AGENT_DIR) || agentDir || nonBlank(env.PI_CODING_AGENT_DIR);
  const agents = new Set([path.join(home, '.omo', 'agent'), ...(omoAgent ? [path.resolve(omoAgent)] : [])]);
  const omoSessions = omoAgent && path.join(path.resolve(omoAgent), 'sessions');
  if (omoSessions && !roots.some(([, dir]) => dir === omoSessions)) roots.push(['senpi-omo-sessions', omoSessions]);
  const projects = new Set([home]);
  const custom = options.useEnvRoots === false ? [] : normalizeCustomScanPaths(options.customScanPaths, options).senpi || [];
  if (options.useEnvRoots !== false) {
    projects.add(options.cwdDir || process.cwd());
    const seenHeaders = new Set();
    for (const dir of new Set([...roots.map(([, dir]) => dir), ...(extra ? [extra] : [])])) {
      for (const project of projectCwds(dir, seenHeaders)) projects.add(project);
    }
    const budget = { remaining: CUSTOM_DISCOVERY_ENTRY_LIMIT };
    for (const dir of custom) {
      for (const project of projectCwds(dir, seenHeaders, budget)) projects.add(project);
      if (path.basename(dir) === 'sessions') agents.add(path.dirname(dir));
      else if (isDirectory(path.join(dir, 'sessions')) || isDirectory(path.join(dir, 'projects'))) agents.add(dir);
    }
    for (const file of headerCache.keys()) if (!seenHeaders.has(file)) headerCache.delete(file);
  }
  const userState = readTaskState(home);
  const taskDirs = new Set();
  const configFiles = [];
  for (const agent of agents) {
    const central = path.join(agent, 'projects');
    for (const entry of directoryEntries(central)) {
      if (entry.isDirectory() || (entry.isSymbolicLink() && isDirectory(path.join(central, entry.name)))) {
        taskDirs.add(path.join(central, entry.name, 'senpi-task', 'children'));
      }
    }
  }
  for (const project of [...projects].sort()) {
    const state = readTaskState(project);
    const taskDir = state === undefined ? userState : state;
    taskDirs.add(path.join(taskDir || path.join(project, '.omo/senpi-task'), 'children'));
    for (const agent of agents) taskDirs.add(path.join(agent, 'projects', centralProjectKey(project), 'senpi-task', 'children'));
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

function senpiExtraScanDirs(options = {}) {
  const env = options.env || process.env;
  const home = tokscaleHomeDir({ ...options, env });
  // The pinned binary's TOKSCALE_EXTRA_DIRS lane does not discover OmO children.
  // Supply the same narrow roots used by watching; let tokscale own parsing,
  // pricing and physical-file deduplication. Match the custom-path transport's
  // delimiter restriction without imposing its user-selection count limit.
  return [...new Set(senpiSourceRoots(home, env, options).map(([, dir]) => dir))]
    .filter(dir => isDirectory(dir) && !/[,\0\r\n]/.test(dir));
}

function resolveSenpiSessionsDirs({ homeDir = '', env = process.env, useEnvRoots = true, customScanPaths } = {}) {
  const home = useEnvRoots === false ? homeDir : tokscaleHomeDir({ homeDir, env });
  const options = { useEnvRoots, customScanPaths: useEnvRoots === false ? {} : customScanPaths };
  return [...new Set([
    ...senpiSourceRoots(home, useEnvRoots === false ? {} : env, options).map(([, dir]) => dir),
    ...(normalizeCustomScanPaths(options.customScanPaths).senpi || [])
  ])];
}

module.exports = { senpiSourceRoots, senpiWatchSources, senpiExtraScanDirs, resolveSenpiSessionsDirs };
