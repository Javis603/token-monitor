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
// start, because grok's own `info.cwd` is the authoritative project path and
// needs no URL decoding.
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
  const root = grokSessionsRoot(home, env, platform);
  const projectFor = typeof projectIdentity === 'function' ? projectIdentity : null;
  const readFileSync = deps.readFileSync || fs.readFileSync;

  for (const candidate of collectSummaryFiles(root)) {
    if (!wanted.has(candidate.sessionId) || result.has(candidate.sessionId)) continue;
    const summary = readSummary(candidate.summaryPath, readFileSync);
    if (!summary) continue;
    // The join is the directory name: tokscale reports the same bare uuid that
    // grok uses for the session directory and records as `info.id`. A summary
    // whose stated id disagrees with the directory it was found in is someone
    // else's record sitting in the wrong place, and its title, times and
    // project path must not be attached to this session.
    const claimed = typeof summary.info?.id === 'string' ? summary.info.id.trim() : '';
    if (claimed && claimed !== candidate.sessionId) continue;
    const meta = {};
    const startedAt = timestamp(summary.created_at, isoFromDate);
    if (startedAt) meta.startedAt = startedAt;
    const used = lastUsedAt(summary, isoFromDate);
    if (used) meta.lastUsedAt = used;
    const title = cleanTitle(summary.generated_title);
    if (title) meta.title = title;
    if (resolveProjects && projectFor) {
      const identity = projectFor(summary?.info?.cwd || '');
      if (identity?.projectId) meta.projectId = identity.projectId;
      if (identity?.projectLabel) meta.projectLabel = identity.projectLabel;
    }
    // A session with only a title is still worth recording: the applier writes
    // each field it is given, so dropping the row here would lose the name even
    // though the dock's row label prefers it over the bare uuid.
    if (Object.keys(meta).length) result.set(candidate.sessionId, meta);
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
