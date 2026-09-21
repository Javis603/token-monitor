'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const KIMI_WORK_RUNTIME_SUFFIX = path.join(
  'daimon',
  'runtime',
  'kimi-code',
  'home',
  'sessions'
);

const KIMI_WORK_SESSIONS_SUFFIX = path.join(
  'kimi-desktop',
  'daimon-share',
  KIMI_WORK_RUNTIME_SUFFIX
);

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function kimiWorkShareDirRoot(appData, options = {}) {
  const readFileSync = options.readFileSync || fs.readFileSync;
  let config;
  try {
    config = JSON.parse(readFileSync(path.join(appData, 'kimi-desktop', 'daimon-storage.json'), 'utf8'));
  } catch (_) {
    return null;
  }
  const shareDir = typeof config?.shareDir === 'string' ? config.shareDir : '';
  return shareDir.trim() ? path.join(shareDir, KIMI_WORK_RUNTIME_SUFFIX) : null;
}

function kimiWorkSessionsRoots(home = os.homedir(), platform = process.platform, env = process.env, options = {}) {
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', KIMI_WORK_SESSIONS_SUFFIX)];
  }
  if (platform === 'win32') {
    const homeAppData = path.join(home, 'AppData', 'Roaming');
    const roots = [path.join(homeAppData, KIMI_WORK_SESSIONS_SUFFIX)];
    if (options.useEnvRoots !== false) {
      // Tokscale uses `var_os("APPDATA").filter(|value| !value.is_empty())`:
      // missing/empty values add no env-derived root, while whitespace remains
      // a literal path. Keep health and watcher discovery semantically aligned.
      const appData = typeof env.APPDATA === 'string' && env.APPDATA.length > 0
        ? env.APPDATA
        : null;
      if (appData) {
        roots.push(kimiWorkShareDirRoot(appData, options) || path.join(appData, KIMI_WORK_SESSIONS_SUFFIX));
      }
    }
    return [...new Set(roots)];
  }
  return [];
}

function kimiCodeSessionsHome(home = os.homedir(), options = {}) {
  const env = options.env || process.env;
  const configured = options.useEnvRoots === false ? '' : env.KIMI_CODE_HOME;
  const kimiCodeHome = typeof configured === 'string' && configured.trim()
    ? configured
    : path.join(home, '.kimi-code');
  return path.join(kimiCodeHome, 'sessions');
}

// Kimi sessions (CLI `session_*`, Work `conv-*`/`ctitle-*`) put their workspace
// in a sibling state.json (`workDir` / `custom.workspacePath`), not in the wire
// stream tokscale parses. The session id is the directory name directly under a
// workspace dir. Enumerate the on-disk session dirs once instead of probing the
// workspace x requested-session Cartesian product on the Electron main thread.
function readKimiSessionStateFiles(roots, sessionIds) {
  const wanted = new Set(sessionIds);
  const found = new Map();
  for (const root of roots) {
    if (found.size >= wanted.size) break;
    let workspaceDirs;
    try { workspaceDirs = fs.readdirSync(root, { withFileTypes: true }); } catch (_) { continue; }
    for (const workspace of workspaceDirs) {
      if (!workspace.isDirectory()) continue;
      let sessionDirs;
      try { sessionDirs = fs.readdirSync(path.join(root, workspace.name), { withFileTypes: true }); } catch (_) { continue; }
      for (const session of sessionDirs) {
        const sessionId = session.name;
        if (!session.isDirectory() || !wanted.has(sessionId) || found.has(sessionId)) continue;
        const statePath = path.join(root, workspace.name, sessionId, 'state.json');
        if (fileExists(statePath)) found.set(sessionId, statePath);
      }
      if (found.size >= wanted.size) break;
    }
  }
  return found;
}

function readKimiStateMetadata(statePath) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return {}; }
  if (!state || typeof state !== 'object') return {};
  const stringValue = (value) => typeof value === 'string' ? value.trim() : '';
  const projectPath = stringValue(state.workDir) || stringValue(state.custom?.workspacePath);
  const startedAt = stringValue(state.createdAt);
  const lastUsedAt = stringValue(state.updatedAt);
  return {
    ...(projectPath ? { projectPath } : {}),
    ...(startedAt ? { startedAt } : {}),
    ...(lastUsedAt ? { lastUsedAt } : {})
  };
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, projectIdentity, resolveProjects } = context;
  const roots = [
    ...(deps.scopedHome ? [] : kimiWorkSessionsRoots(
      home,
      deps.platform || process.platform,
      deps.env || process.env,
      { readFileSync: deps.readFileSync }
    )),
    kimiCodeSessionsHome(home, { env: deps.env, useEnvRoots: !deps.scopedHome })
  ];
  const result = new Map();
  for (const [sessionId, statePath] of readKimiSessionStateFiles(roots, sessionIds)) {
    const raw = readKimiStateMetadata(statePath);
    const identity = resolveProjects ? projectIdentity(raw.projectPath) : {};
    const meta = {
      ...(identity.projectId ? identity : {}),
      ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
      ...(raw.lastUsedAt ? { lastUsedAt: raw.lastUsedAt } : {})
    };
    if (meta.projectId || meta.startedAt || meta.lastUsedAt) result.set(sessionId, meta);
  }
  return result;
}

module.exports = {
  kimiCodeSessionsHome,
  kimiWorkSessionsRoots,
  readKimiSessionStateFiles,
  readKimiStateMetadata,
  resolveSessionMetadata
};
