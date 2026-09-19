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
// in a sibling state.json, not in the wire stream tokscale parses. The session
// id is the directory name directly under a workspace dir. Enumerate the
// on-disk session dirs once instead of probing the workspace x requested-session
// Cartesian product on the Electron main thread.
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

// `toISOString` throws on an invalid date instead of returning one, and a finite
// number can still be out of range (`Number.MAX_VALUE` passes `Number.isFinite`).
// That throw would escape this reader and abort the whole metadata pass, since
// the resolver is called without containment, so every path validates first.
// The shared `isoFromDate` cannot be reused here: `src/shared/sessionMetadata.js`
// requires this module, so the import would be a cycle. A non-positive number
// counts as absent — the runtime's own `toEpochMs` returns 0 for a value it
// cannot use, and no session document carries a pre-1970 time.
function isoFromDate(date) {
  return Number.isNaN(date.getTime()) ? '' : date.toISOString();
}

function timestampValue(value) {
  if (typeof value === 'number' && Number.isFinite(value) && value > 0) {
    return isoFromDate(new Date(value));
  }
  if (typeof value !== 'string') return '';
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? '' : isoFromDate(new Date(parsed));
}

// The runtime sanitizes the titles it writes through the prompt path (secret
// redaction, whitespace collapse, 200-character cap), but its persistence layer
// accepts any string — `setTitle` stores the caller's value verbatim — so this
// reader owns the display cleaning: collapse the whitespace a hand-edited or
// future-client document may carry, and cap the length at the same 96 code
// points the claude and codex resolvers use, since a name is only ever read
// from the runtime's own summary or a user rename.
const TITLE_MAX_CODE_POINTS = 96;

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const collapsed = value.replace(/\s+/g, ' ').trim();
  const chars = Array.from(collapsed);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? collapsed
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

// The session document exists in two generations on disk. The legacy one (Kimi
// CLI 0.3x) holds a home-relative `workDir` and ISO-string timestamps; the
// current `version: 2` one — written by Kimi Code, the CLI and the desktop app
// alike — holds `cwd` and epoch-millisecond timestamps instead. The runtime
// itself migrates the legacy document on read (`cwd ?? workDir`,
// `toEpochMs(createdAt)`), so both spellings and both timestamp shapes have to
// be accepted here; `custom.*` is the older fallback from before either
// top-level field existed.
//
// `title` is only a session name once the runtime generated it or the user set
// it, so the kind decides — the rule claude applies to `custom-title` and
// `ai-title`, and dsh states outright for its own transcript events. Kimi stores
// `replaceable` there until then, and what lands in it is whatever the caller
// called a prompt: the CLI writes the first user message, while Kimi Work writes
// a transport envelope (`<meta awareness="low" ... /> hi`) for a conversation
// and the title-generator's own system prompt for the `ctitle-*` sessions it
// spawns. Taking the field regardless of kind would put those on session rows,
// so only `generated` (the runtime's `chat_title` summary) and `custom` (a user
// rename) are read, and the runtime never overwrites a custom title.
function readKimiStateMetadata(statePath) {
  let state;
  try { state = JSON.parse(fs.readFileSync(statePath, 'utf8')); } catch (_) { return {}; }
  if (!state || typeof state !== 'object') return {};
  const stringValue = (value) => typeof value === 'string' ? value.trim() : '';
  const projectPath = stringValue(state.cwd)
    || stringValue(state.workDir)
    || stringValue(state.custom?.cwd)
    || stringValue(state.custom?.workspacePath);
  const startedAt = timestampValue(state.createdAt);
  const lastUsedAt = timestampValue(state.updatedAt);
  // v2 carries `titleKind`; the legacy documents predate it and mark the same
  // distinction with `isCustomTitle`, which the runtime normalizes to `custom`
  // when it migrates them on read.
  const titleKind = stringValue(state.titleKind) || (state.isCustomTitle === true ? 'custom' : '');
  const title = titleKind === 'generated' || titleKind === 'custom' ? cleanTitle(state.title) : '';
  return {
    ...(projectPath ? { projectPath } : {}),
    ...(title ? { title } : {}),
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
      ...(raw.title ? { title: raw.title } : {}),
      ...(identity.projectId ? identity : {}),
      ...(raw.startedAt ? { startedAt: raw.startedAt } : {}),
      ...(raw.lastUsedAt ? { lastUsedAt: raw.lastUsedAt } : {})
    };
    // The title is deliberately outside the `resolveProjects` branch: it is a
    // session name, not project identity, so the Projects opt-out must not strip
    // it (issue #182 strips identity only). The gate therefore has to accept a
    // title-only answer, or a session whose state.json carries nothing else
    // would be dropped here.
    if (meta.title || meta.projectId || meta.startedAt || meta.lastUsedAt) result.set(sessionId, meta);
  }
  return result;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  kimiCodeSessionsHome,
  kimiWorkSessionsRoots,
  readKimiSessionStateFiles,
  readKimiStateMetadata,
  resolveSessionMetadata
};
