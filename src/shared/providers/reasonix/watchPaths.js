'use strict';

// Path-only half of the Reasonix native-session helpers. The watcher child
// needs these predicates without pulling the session parser, the usage model or
// history into its process; sessions.js re-exports them for its own callers.

const os = require('node:os');
const path = require('node:path');
const { resolveReasonixHome } = require('./paths');

const META_SUFFIX = '.jsonl.meta';
const TELEMETRY_SUFFIX = '.jsonl.telemetry.json';
const EVENTS_SUFFIX = '.events.jsonl';

function uniquePaths(paths) {
  return [...new Set(paths.filter(Boolean).map((value) => String(value)))];
}

function pathOptions(options = {}) {
  const platform = options.platform || process.platform;
  const homeDir = options.homeDir || os.homedir();
  const env = options.env || process.env;
  return {
    env,
    homeDir,
    platform,
    cwdDir: options.cwdDir || process.cwd(),
    pathModule: options.pathModule || path,
    allTimeSince: options.allTimeSince
  };
}

// The official layout has two generations in the wild:
//   <state>/sessions                 legacy/global sessions
//   <state>/projects/<key>/sessions  routed project sessions
// Watch the legacy sessions directory and the projects directory. The scanner
// only descends into the official one-level project/session layout.
function reasonixNativeSessionWatchRoots(options = {}) {
  const pathApi = options.pathModule || path;
  const stateHome = resolveReasonixHome(pathOptions(options));
  return uniquePaths([
    pathApi.join(stateHome, 'sessions'),
    pathApi.join(stateHome, 'projects')
  ]);
}

function isReasonixNativeSessionSidecar(filePath) {
  const normalized = String(filePath || '').replace(/\\/g, '/');
  const name = normalized.slice(normalized.lastIndexOf('/') + 1);
  return name.endsWith(META_SUFFIX) || name.endsWith(TELEMETRY_SUFFIX) || name.endsWith(EVENTS_SUFFIX);
}

module.exports = {
  EVENTS_SUFFIX,
  META_SUFFIX,
  TELEMETRY_SUFFIX,
  isReasonixNativeSessionSidecar,
  pathOptions,
  reasonixNativeSessionWatchRoots,
  uniquePaths
};
