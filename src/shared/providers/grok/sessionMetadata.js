'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Grok keeps one directory per session under `~/.grok/sessions/<url-encoded
// cwd>/<session uuid>/`, and tokscale joins on that bare uuid: its entry
// `sessionId` is the same string as the directory name and `summary.json`'s
// `info.id`. Tokscale's `ModelUsageJson` carries no timestamp, title or project
// for any client, so this is where a grok session's identity comes from.
//
// `summary.json` is small (about 0.5–1.4 kB) and a full sweep of this machine's
// 101 sessions costs ~2.6 ms, so there is no cross-tick cache here: the
// registry rebuilds its own map every tick, and a stale title or timestamp
// would outlive the session that produced it.
//
// A scoped home is a WSL distro. Host GROK_HOME must never redirect this lookup
// away from that distro, matching tokscale's use_env_roots: false.
function grokSessionsRoot(home, env, platform) {
  const explicit = typeof env.GROK_HOME === 'string' ? env.GROK_HOME.trim() : '';
  if (explicit) return path.join(explicit, 'sessions');
  if (platform === 'darwin') return path.join(home, '.grok', 'sessions');
  return path.join(home, '.grok', 'sessions');
}

// Tokscale accepts a Grok home, its sessions directory, or a descendant as an
// extra scan root. Resolve each shape to the same sessions tree as the primary
// root, so a row counted from an alternate root can find its summary.
function sessionsRootFromScanPath(scanPath) {
  const resolved = path.resolve(scanPath);
  // The configured path's own sessions directory answers first: an alternate
  // home sitting below a directory that happens to be named sessions is still
  // a home, and the ancestor walk would hand back that unrelated directory.
  if (fs.existsSync(path.join(resolved, 'sessions'))) return path.join(resolved, 'sessions');
  let current = resolved;
  for (;;) {
    if (path.basename(current).toLowerCase() === 'sessions') return current;
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  return path.join(resolved, 'sessions');
}

// The same cap the other adapters apply to a derived session name. There is no
// shared cleaner: claude, codex and kimi each carry their own. grok's
// `generated_title` is the writer's own prompt text and runs to ~173 code
// points, so this one is load-bearing rather than decorative.
const TITLE_MAX_CODE_POINTS = 96;

function cleanTitle(value) {
  if (typeof value !== 'string') return '';
  const text = value.replace(/\s+/g, ' ').trim();
  if (!text) return '';
  const points = Array.from(text);
  return points.length > TITLE_MAX_CODE_POINTS
    ? `${points.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`
    : text;
}

// grok writes nanosecond ISO strings (`2026-08-19T07:53:22.948065400Z`). V8
// truncates rather than rejects them, but `applySessionMetadata` compares and
// stores this string as-is, so it is normalized here rather than passed through.
function timestamp(value, isoFromDate) {
  if (typeof value !== 'string' || !value.trim()) return '';
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) return '';
  return isoFromDate(new Date(parsed));
}

// `last_active_at` is when the session last talked to the model; `updated_at` is
// when the file itself was last written, which background work (recaps, title
// refreshes) moves forward on its own. Taking the later of the two would light
// a green running mark on a session abandoned a week ago — on this machine 13 of
// 101 files sit more than 10 minutes apart, the widest by 8 days — so each
// fallback is a lower bound rather than the furthest value available. A row with
// no usable last-used still gets the creation time: the dock drops any session
// whose timestamps do not parse, and an idle-but-real session is worth showing.
function lastUsedAt(summary, isoFromDate) {
  return timestamp(summary?.last_active_at, isoFromDate)
    || timestamp(summary?.updated_at, isoFromDate)
    || timestamp(summary?.created_at, isoFromDate);
}

function readSummary(filePath, readFileSync) {
  try {
    const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch (_) {
    return null;
  }
}

// One directory entry per workspace; the workspace name is only a place to
// start. The summary carries the project path and needs no URL decoding.
function collectSummaryFiles(root) {
  const files = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(root, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspacePath = path.join(root, workspace.name);
    let sessions;
    try {
      sessions = fs.readdirSync(workspacePath, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const session of sessions) {
      if (!session.isDirectory()) continue;
      files.push({
        sessionId: session.name,
        summaryPath: path.join(workspacePath, session.name, 'summary.json')
      });
    }
  }
  return files;
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps = {}, home, isoFromDate, resolveProjects, projectIdentity } = context;
  const wanted = sessionIds instanceof Set ? sessionIds : new Set(sessionIds || []);
  const result = new Map();
  if (!wanted.size || !home || typeof isoFromDate !== 'function') return result;

  const env = deps.scopedHome ? {} : (deps.env || process.env);
  const platform = deps.platform || process.platform;
  const roots = [grokSessionsRoot(home, env, platform)];
  if (!deps.scopedHome) {
    // The collector forwards these settings to Tokscale as GROK entries in
    // TOKSCALE_EXTRA_DIRS. Include inherited entries that Tokscale also reads.
    const configured = Array.isArray(deps.customScanPaths?.grok) ? deps.customScanPaths.grok : [];
    const inherited = String(env.TOKSCALE_EXTRA_DIRS || '').split(',').map((entry) => {
      const separator = entry.indexOf(':');
      return separator !== -1 && entry.slice(0, separator).trim() === 'grok'
        ? entry.slice(separator + 1).trim() : '';
    });
    for (const scanPath of [...configured, ...inherited]) {
      if (typeof scanPath === 'string' && scanPath.trim()) roots.push(sessionsRootFromScanPath(scanPath.trim()));
    }
  }
  const projectFor = typeof projectIdentity === 'function' ? projectIdentity : null;
  const readFileSync = deps.readFileSync || fs.readFileSync;
  const candidatesById = new Map();
  const visitedRoots = new Set();

  for (const root of roots) {
    let canonicalRoot = path.resolve(root);
    try { canonicalRoot = fs.realpathSync(root); } catch (_) { /* Scan the supplied path if canonicalization fails. */ }
    if (visitedRoots.has(canonicalRoot)) continue;
    visitedRoots.add(canonicalRoot);
    for (const candidate of collectSummaryFiles(canonicalRoot)) {
      if (!wanted.has(candidate.sessionId)) continue;
      // Match Grok's persisted-candidate rule: a directory without a regular
      // summary file does not make an otherwise valid session ambiguous.
      try {
        if (!fs.lstatSync(candidate.summaryPath).isFile()) continue;
      } catch (_) { continue; }
      const candidates = candidatesById.get(candidate.sessionId) || [];
      candidates.push(candidate);
      candidatesById.set(candidate.sessionId, candidates);
    }
  }
  for (const [sessionId, candidates] of candidatesById) {
    // An id in two cwd buckets is ambiguous. Choosing the first readdir entry
    // could attach another workspace's title, timestamps and project.
    if (candidates.length !== 1) continue;
    const summary = readSummary(candidates[0].summaryPath, readFileSync);
    if (!summary) continue;
    const claimed = typeof summary.info?.id === 'string' ? summary.info.id.trim() : '';
    if (claimed && claimed !== sessionId) continue;
    const meta = {};
    const startedAt = timestamp(summary.created_at, isoFromDate);
    if (startedAt) meta.startedAt = startedAt;
    const used = lastUsedAt(summary, isoFromDate);
    if (used) meta.lastUsedAt = used;
    const title = cleanTitle(summary.generated_title);
    if (title) meta.title = title;
    if (resolveProjects && projectFor) {
      const source = typeof summary.source_workspace_dir === 'string' ? summary.source_workspace_dir.trim() : '';
      const identity = projectFor(source || summary?.info?.cwd || '');
      if (identity?.projectId) meta.projectId = identity.projectId;
      if (identity?.projectLabel) meta.projectLabel = identity.projectLabel;
    }
    // A session with only a title is still worth recording: the applier writes
    // each field it is given, so dropping the row here would lose the name even
    // though the dock's row label prefers it over the bare uuid.
    if (Object.keys(meta).length) result.set(sessionId, meta);
  }
  return result;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  cleanTitle,
  grokSessionsRoot,
  resolveSessionMetadata,
  timestamp
};
