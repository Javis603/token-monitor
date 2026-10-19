'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { sessionActivityProvidersFor } = require('./sessionActivityRegistry');
const { discoverT3DbPaths } = require('./t3SessionMetadata');
const comparablePath = path.sep === '\\' ? (value) => value.toLowerCase() : (value) => value;

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
  const providers = sessionActivityProvidersFor(clients);
  const home = options.homeDir || os.homedir();
  const sources = [];
  for (const entry of providers) for (const source of entry.watchTargets({ ...options, homeDir: home })) {
    const target = path.resolve(source.target);
    const dir = existingParent(target, path.resolve(source.floor));
    if (dir && dir !== path.resolve(home)) sources.push({ ...source, dir, target, clients: [entry.id] });
  }
  const t3Clients = providers.filter((entry) => entry.t3Driver).map((entry) => entry.id);
  if (t3Clients.length) for (const file of discoverT3DbPaths(options)) {
    if (path.basename(file) !== 'statev2.sqlite') continue;
    const target = path.resolve(file);
    // Never watch the user's entire home when T3 is not installed.
    const parent = path.dirname(target);
    const dir = existingParent(parent, path.dirname(path.dirname(parent)));
    if (dir && dir !== path.resolve(home)) sources.push({ dir, target, kind: 'sqlite',
      runtimeFile: path.join(parent, 'server-runtime.json'), clients: t3Clients });
  }
  return sources;
}

function matches(source, file) {
  const target = comparablePath(source.target);
  // Keep just the ancestor chain so a missing sessions/userdata directory can
  // appear later. A registry's children are numeric PID files only.
  if (inside(file, target)) return true;
  if (source.kind === 'pid-registry') return path.dirname(file) === target && /^[1-9]\d*\.json$/.test(path.basename(file));
  return file === target || file === `${target}-wal`
    || (source.runtimeFile && file === comparablePath(source.runtimeFile));
}

function activityClientsForPath(filePath, sources) {
  const file = comparablePath(path.resolve(filePath || '.'));
  return [...new Set(sources.filter((source) => matches(source, file)).flatMap((source) => source.clients))];
}

function activityWatchIgnored(usageIgnored, usageDirs, sources) {
  if (!sources.length) return usageIgnored;
  // chokidar calls this for every path, often before and after stat. Compile the
  // small activity allowlist once instead of allocating path.relative strings
  // against every activity source for the whole historical transcript tree.
  const prefix = (root) => root.endsWith(path.sep) ? root : root + path.sep;
  const directory = (root) => {
    const dir = comparablePath(path.resolve(root));
    return { dir, prefix: prefix(dir) };
  };
  const usage = usageDirs.map(directory);
  const ancestors = new Set();
  const files = new Set();
  const registries = [];
  const roots = sources.map((source) => {
    const target = comparablePath(path.resolve(source.target));
    for (let dir = target; ; dir = path.dirname(dir)) {
      ancestors.add(dir);
      if (path.dirname(dir) === dir) break;
    }
    if (source.kind === 'pid-registry') registries.push(prefix(target));
    else {
      files.add(target);
      files.add(`${target}-wal`);
      if (source.runtimeFile) files.add(comparablePath(path.resolve(source.runtimeFile)));
    }
    return directory(source.dir);
  });
  return (filePath) => {
    const resolved = comparablePath(path.resolve(filePath));
    if (ancestors.has(resolved) || files.has(resolved)
      || registries.some((root) => resolved.startsWith(root) && /^[1-9]\d*\.json$/.test(resolved.slice(root.length)))) return false;
    if (roots.some((root) => resolved === root.dir || resolved.startsWith(root.prefix))
      && !usage.some((root) => resolved === root.dir || resolved.startsWith(root.prefix))) return true;
    return usageIgnored?.(filePath) || false;
  };
}

module.exports = { activityWatchSources, activityClientsForPath, activityWatchIgnored };
