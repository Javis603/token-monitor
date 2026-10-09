'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { resolveClaudeConfigDir } = require('./providers/claude/paths');
const { discoverT3DbPaths } = require('./t3SessionMetadata');

function inside(root, file) {
  const relative = path.relative(root, file);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function existingParent(target, floor) {
  let dir = target;
  while (inside(floor, dir)) {
    try { if (fs.statSync(dir).isDirectory()) return dir; } catch (_) {}
    if (dir === floor) break;
    dir = path.dirname(dir);
  }
  return null;
}

function activityWatchSources(clients, options = {}) {
  if (options.scopedHome) return [];
  const enabled = new Set(clients);
  const home = options.homeDir || os.homedir();
  const sources = [];
  if (enabled.has('claude')) {
    const config = path.resolve(resolveClaudeConfigDir({ ...options, homeDir: home }));
    const target = path.join(config, 'sessions');
    const dir = existingParent(target, config);
    if (dir) sources.push({ dir, target, kind: 'claude', clients: ['claude'] });
  }
  const t3Clients = ['claude', 'codex'].filter((client) => enabled.has(client));
  if (t3Clients.length) for (const file of discoverT3DbPaths(options)) {
    if (path.basename(file) !== 'statev2.sqlite') continue;
    const target = path.resolve(file);
    // Never watch the user's entire home when T3 is not installed.
    const parent = path.dirname(target);
    const dir = existingParent(parent, path.dirname(path.dirname(parent)));
    if (dir && dir !== path.resolve(home)) sources.push({ dir, target, kind: 't3', clients: t3Clients });
  }
  return sources;
}

function matches(source, file) {
  const target = source.target;
  // Keep just the ancestor chain so a missing sessions/userdata directory can
  // appear later. A registry's children are numeric PID files only.
  if (inside(file, target)) return true;
  if (source.kind === 'claude') return path.dirname(file) === target && /^[1-9]\d*\.json$/.test(path.basename(file));
  return file === target || file === `${target}-wal`
    || file === path.join(path.dirname(target), 'server-runtime.json');
}

function activityClientsForPath(filePath, sources) {
  const file = path.resolve(filePath || '.');
  return [...new Set(sources.filter((source) => matches(source, file)).flatMap((source) => source.clients))];
}

function activityWatchIgnored(usageIgnored, usageDirs, sources) {
  if (!sources.length) return usageIgnored;
  // chokidar calls this for every path, often before and after stat. Compile the
  // small activity allowlist once instead of allocating path.relative strings
  // against every activity source for the whole historical transcript tree.
  const comparable = path.sep === '\\' ? (value) => value.toLowerCase() : (value) => value;
  const prefix = (root) => root.endsWith(path.sep) ? root : root + path.sep;
  const directory = (root) => {
    const dir = comparable(path.resolve(root));
    return { dir, prefix: prefix(dir) };
  };
  const usage = usageDirs.map(directory);
  const ancestors = new Set();
  const files = new Set();
  const registries = [];
  const roots = sources.map((source) => {
    const target = path.resolve(source.target);
    for (let dir = target; ; dir = path.dirname(dir)) {
      ancestors.add(comparable(dir));
      if (path.dirname(dir) === dir) break;
    }
    if (source.kind === 'claude') registries.push(prefix(target));
    else {
      files.add(target);
      files.add(`${target}-wal`);
      files.add(path.join(path.dirname(target), 'server-runtime.json'));
    }
    return directory(source.dir);
  });
  return (filePath) => {
    const file = path.resolve(filePath);
    const resolved = comparable(file);
    if (ancestors.has(resolved) || files.has(file)
      || registries.some((root) => file.startsWith(root) && /^[1-9]\d*\.json$/.test(file.slice(root.length)))) return false;
    if (roots.some((root) => resolved === root.dir || resolved.startsWith(root.prefix))
      && !usage.some((root) => resolved === root.dir || resolved.startsWith(root.prefix))) return true;
    return usageIgnored?.(filePath) || false;
  };
}

module.exports = { activityWatchSources, activityClientsForPath, activityWatchIgnored };
