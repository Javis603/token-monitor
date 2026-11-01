'use strict';

// Which Claude sessions did Claude Desktop start?
//
// tokscale reports every Claude Code transcript under its `claude` client: the
// CLI's, the IDE extensions', and Claude Desktop's Code tab and Cowork, which
// run the same agent and write the same JSONL. Token Monitor splits Desktop's
// sessions onto a derived `claude-desktop` row so a user with several Claude
// channels (API keys, third-party gateways, the subscription) can read the
// subscription-billed Desktop share on its own. The model name cannot do that:
// every channel serves the same models.
//
// A session counts as Desktop when any local signal says so:
//   1. its transcript records `"entrypoint":"claude-desktop"` (Code tab) or
//      `"local-agent"` (Cowork) — the CLI writes `"cli"`, SDK hosts their own;
//   2. a Desktop `claude-code-sessions/**/local_*.json` record names it as its
//      `cliSessionId`;
//   3. its transcript lives under a Desktop userData root
//      (`local-agent-mode-sessions/**/.claude/projects/**/<id>.jsonl`).
// `claude-desktop-3p` and anything under a `Claude-3p` root is the
// third-party-inference build (Bedrock/Vertex/gateway). It is classified as
// 'desktop-3p' so callers can tell it apart; the collector leaves it under
// `claude` because it is not billed against the claude.ai subscription.
//
// Read-only and local: node:fs only, bounded reads and walks, no network, no
// credential files, no subprocess. The index caches directory listings and
// per-file answers across collector ticks; a transcript's entrypoint is written
// on its first turn and never changes, so positive answers are kept for good.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveClaudeConfigDir } = require('./paths');
const { claudeDesktopUserDataRoots, variantForDir } = require('./desktopPaths');

const DESKTOP = 'desktop';
const DESKTOP_3P = 'desktop-3p';
const HEAD_BYTES = 64 * 1024;
const METADATA_MAX_BYTES = 1024 * 1024;
const WALK_MAX_ENTRIES = 50000;
const WALK_MAX_DEPTH = 9;
const DEFAULT_TTL_MS = 60 * 1000;
const ENTRYPOINT_PATTERN = /"entrypoint"\s*:\s*"([^"\\]{1,64})"/;
const SESSION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function classifyEntrypoint(value) {
  const entrypoint = String(value || '').trim().toLowerCase();
  if (!entrypoint) return null;
  if (entrypoint === 'claude-desktop-3p' || entrypoint === 'local-agent-3p') return DESKTOP_3P;
  if (entrypoint === 'claude-desktop' || entrypoint === 'local-agent') return DESKTOP;
  return '';
}

function readHead(fsApi, file, bytes = HEAD_BYTES) {
  let fd = null;
  try {
    fd = fsApi.openSync(file, 'r');
    const buffer = Buffer.alloc(bytes);
    const read = fsApi.readSync(fd, buffer, 0, bytes, 0);
    return buffer.subarray(0, read).toString('utf8');
  } catch (_) {
    return null;
  } finally {
    if (fd !== null) { try { fsApi.closeSync(fd); } catch (_) {} }
  }
}

function entrypointFromHead(text) {
  if (!text) return null;
  const match = ENTRYPOINT_PATTERN.exec(text);
  return match ? match[1] : null;
}

function safeReaddir(fsApi, dir) {
  try { return fsApi.readdirSync(dir, { withFileTypes: true }); } catch (_) { return []; }
}

function safeStat(fsApi, file) {
  try { return fsApi.statSync(file); } catch (_) { return null; }
}

function sessionIdFromFile(name) {
  if (!name.endsWith('.jsonl')) return null;
  const id = name.slice(0, -'.jsonl'.length);
  return SESSION_ID_PATTERN.test(id) ? id : null;
}

// Bounded depth-first walk. `visit(entry, full, depth)` returns true to
// descend into a directory.
function boundedWalk(fsApi, root, visit, budget = { left: WALK_MAX_ENTRIES }) {
  const stack = [[root, 0]];
  while (stack.length > 0 && budget.left > 0) {
    const [dir, depth] = stack.pop();
    for (const entry of safeReaddir(fsApi, dir)) {
      if (--budget.left <= 0) break;
      const full = path.join(dir, entry.name);
      const descend = visit(entry, full, depth);
      if (descend && entry.isDirectory() && depth + 1 < WALK_MAX_DEPTH) stack.push([full, depth + 1]);
    }
  }
}

function strongerVariant(current, next) {
  if (!next) return current || null;
  if (!current) return next;
  // Two roots naming one session: the first-party answer wins, because the
  // official build is the one whose quota this row stands for.
  return current === DESKTOP || next === DESKTOP ? DESKTOP : DESKTOP_3P;
}

function cliSessionIdFromRecord(text) {
  if (!text) return null;
  let parsed = null;
  try { parsed = JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text); } catch (_) {}
  const value = parsed && typeof parsed === 'object'
    ? (parsed.cliSessionId ?? parsed.cli_session_id ?? parsed.claudeSessionId)
    : (/"cliSessionId"\s*:\s*"([^"\\]{1,128})"/.exec(text) || [])[1];
  const id = String(value || '').trim();
  return SESSION_ID_PATTERN.test(id) ? id : null;
}

// Desktop-side evidence: ids named by claude-code-sessions records and ids of
// transcripts stored inside a Desktop root. Rebuilt at most once per TTL.
function scanDesktopRoots(fsApi, roots) {
  const byId = new Map();
  const note = (id, variant) => { if (id) byId.set(id, strongerVariant(byId.get(id), variant)); };
  for (const root of roots) {
    const variant = root.variant === '3p' ? DESKTOP_3P : DESKTOP;
    const budget = { left: WALK_MAX_ENTRIES };
    boundedWalk(fsApi, path.join(root.dir, 'claude-code-sessions'), (entry, full) => {
      if (entry.isFile() && /^local_.*\.json$/i.test(entry.name)) {
        const stat = safeStat(fsApi, full);
        if (stat && stat.size <= METADATA_MAX_BYTES) note(cliSessionIdFromRecord(readHead(fsApi, full, stat.size || 1)), variant);
        return false;
      }
      return true;
    }, budget);
    boundedWalk(fsApi, path.join(root.dir, 'local-agent-mode-sessions'), (entry, full) => {
      if (entry.isFile()) {
        const id = sessionIdFromFile(entry.name);
        if (id && full.split(path.sep).includes('projects')) note(id, variant);
        return false;
      }
      return true;
    }, budget);
  }
  return byId;
}

function createClaudeDesktopSessionIndex(options = {}) {
  const fsApi = options.fs || fs;
  const ttlMs = Number.isFinite(options.ttlMs) ? options.ttlMs : DEFAULT_TTL_MS;
  const now = typeof options.now === 'function' ? options.now : Date.now;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const projectRoots = options.projectRoots
    || [path.join(resolveClaudeConfigDir({ env, homeDir }), 'projects')];
  const desktopRoots = () => (options.desktopRoots
    || claudeDesktopUserDataRoots({ env, homeDir, platform: options.platform, fs: fsApi }))
    .map((root) => (typeof root === 'string' ? { dir: root, variant: variantForDir(root) } : root));

  let desktopIds = new Map();
  let desktopScannedAt = -Infinity;
  let projectFiles = new Map();
  let projectsScannedAt = -Infinity;
  const slugCache = new Map();
  const fileAnswers = new Map();

  function refreshDesktop() {
    if (now() - desktopScannedAt < ttlMs) return;
    desktopScannedAt = now();
    desktopIds = scanDesktopRoots(fsApi, desktopRoots());
  }

  function refreshProjects() {
    if (now() - projectsScannedAt < ttlMs) return;
    projectsScannedAt = now();
    const next = new Map();
    for (const root of projectRoots) {
      for (const slug of safeReaddir(fsApi, root)) {
        if (!slug.isDirectory()) continue;
        const dir = path.join(root, slug.name);
        const stat = safeStat(fsApi, dir);
        const cached = slugCache.get(dir);
        let ids = cached?.ids;
        if (!cached || !stat || cached.mtimeMs !== stat.mtimeMs) {
          ids = [];
          for (const file of safeReaddir(fsApi, dir)) {
            const id = file.isFile() ? sessionIdFromFile(file.name) : null;
            if (id) ids.push(id);
          }
          slugCache.set(dir, { mtimeMs: stat?.mtimeMs, ids });
        }
        for (const id of ids) if (!next.has(id)) next.set(id, path.join(dir, `${id}.jsonl`));
      }
    }
    projectFiles = next;
  }

  function transcriptAnswer(sessionId) {
    const file = projectFiles.get(sessionId);
    if (!file) return null;
    const cached = fileAnswers.get(file);
    const stat = cached?.final ? null : safeStat(fsApi, file);
    if (cached && (cached.final || (stat && stat.size === cached.size))) return cached.answer;
    const entrypoint = entrypointFromHead(readHead(fsApi, file));
    const answer = entrypoint ? classifyEntrypoint(entrypoint) : null;
    // An entrypoint, or a head that is already full without one, will not
    // change; a short file without one may still be mid-first-write.
    const final = Boolean(entrypoint) || Boolean(stat && stat.size >= HEAD_BYTES);
    fileAnswers.set(file, { answer, size: stat?.size, final });
    return answer;
  }

  // 'desktop' | 'desktop-3p' | null
  function classify(sessionId) {
    const id = String(sessionId || '').trim();
    if (!SESSION_ID_PATTERN.test(id)) return null;
    refreshProjects();
    refreshDesktop();
    const fromTranscript = transcriptAnswer(id);
    if (fromTranscript) return fromTranscript;
    const fromDesktop = desktopIds.get(id) || null;
    // A transcript that names a non-Desktop entrypoint ('' above) is still
    // overridden by a Desktop record: Desktop resumes sessions the CLI began,
    // and a resumed session's later turns are billed through the Desktop login.
    return fromDesktop;
  }

  function invalidate() {
    desktopScannedAt = -Infinity;
    projectsScannedAt = -Infinity;
  }

  return { classify, invalidate };
}

// Moves tokscale `claude` rows of official Desktop sessions onto
// `claude-desktop`, in place, on both the usage rows (`entries`) and the
// per-session metadata rows (`sessions`) so later lookups keyed by
// `${client}:${sessionId}` still pair up. `keepClaude: false` drops the rows
// left on `claude` (the user tracks Desktop but not Claude Code); anything
// other than a bare `claude` row is untouched.
function splitClaudeDesktopRows(json, index, { keepClaude = true } = {}) {
  const result = { moved: 0, dropped: 0 };
  if (!json || typeof json !== 'object' || !index) return result;
  const answers = new Map();
  const isDesktop = (row) => {
    const id = String(row?.sessionId ?? row?.session_id ?? '').trim();
    if (!id) return false;
    if (!answers.has(id)) answers.set(id, index.classify(id) === DESKTOP);
    return answers.get(id);
  };
  for (const field of ['entries', 'sessions']) {
    if (!Array.isArray(json[field])) continue;
    const kept = [];
    for (const row of json[field]) {
      if (row && typeof row === 'object' && String(row.client || '').trim().toLowerCase() === 'claude') {
        if (isDesktop(row)) {
          row.client = 'claude-desktop';
          if (field === 'entries') result.moved += 1;
        } else if (!keepClaude) {
          if (field === 'entries') result.dropped += 1;
          continue;
        }
      }
      kept.push(row);
    }
    json[field] = kept;
  }
  return result;
}

module.exports = {
  DESKTOP,
  DESKTOP_3P,
  classifyEntrypoint,
  cliSessionIdFromRecord,
  createClaudeDesktopSessionIndex,
  entrypointFromHead,
  scanDesktopRoots,
  splitClaudeDesktopRows
};
