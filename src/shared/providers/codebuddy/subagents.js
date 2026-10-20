'use strict';

const fs = require('node:fs');
const path = require('node:path');

// CodeBuddy keeps each sub-agent's conversation beside the session that spawned it:
//
//   <projectsRoot>/<mangled-cwd>/<parentSessionId>/subagents/agent-{agentId}.jsonl
//
// tokscale reports every one of those files as its own `codebuddy` session,
// keyed on the top-level `sessionId` its ordinary records carry — the
// sub-agent's own UUIDv7 session id, which appears nowhere in the file name.
// The name-based findSessionFiles therefore cannot resolve one, and Session
// Detail for a scan-reported sub-agent session reads as missing even though
// the transcript is on disk.
//
// Two fields look like the answer and are not:
//   - `_meta.baggage`'s `codebuddy.session_id` is the PARENT session id;
//     matching on it would resolve every sub-agent session to its parent file.
//   - a `session-meta` record's `sessionId` is the agent id
//     (`agent-{agentId}`), not a session id.
//
// Sub-agent usage is the scan's own per-session accounting; nothing here
// merges it into the parent, which would double-count against tokscale.
//
// This is an on-demand lookup for Session Detail only — never the per-tick
// collector path — so it reads at most the first records of each candidate and
// caches nothing: a handful of small files, milliseconds per open. The client
// nests sub-agents up to a fixed depth, so the walk is depth-agnostic rather
// than tied to the observed layout.

const FIRST_READ_BYTES = 256 * 1024;
const MAX_SCAN_LINES = 16;

// A single path segment only — separators would let the walk escape the root.
function isSingleSegmentId(sessionId) {
  const id = String(sessionId || '');
  return Boolean(id)
    && id !== '.'
    && id !== '..'
    && !id.includes('\0')
    && !/[\\/]/.test(id);
}

// The session id a record identifies, or '' when it identifies none. A
// `session-meta` record is skipped on purpose: its sessionId is the agent id.
function sessionIdOfRecord(raw) {
  let entry;
  try { entry = JSON.parse(raw.toString('utf8')); } catch (_) { return ''; }
  if (!entry || typeof entry !== 'object' || entry.type === 'session-meta') return '';
  const sessionId = entry.sessionId;
  return typeof sessionId === 'string' && sessionId ? sessionId : '';
}

// The first stated session id in a transcript, read from one bounded chunk.
// Empty lines and torn writes are skipped rather than treated as an answer:
// the writer may still be mid-record when the detail opens.
function sessionIdOfFile(filePath, fsApi) {
  let fd;
  try {
    fd = fsApi.openSync(filePath, 'r');
    const buffer = Buffer.alloc(FIRST_READ_BYTES);
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return '';
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    for (let line = 0; line < MAX_SCAN_LINES && start < chunk.length; line += 1) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const raw = chunk.subarray(start, end);
      start = newline === -1 ? chunk.length : newline + 1;
      if (raw.length === 0) continue;
      const sessionId = sessionIdOfRecord(raw);
      if (sessionId) return sessionId;
    }
    return '';
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) {}
    }
  }
}

// The sub-agent transcript reported under `sessionId`, or '' when the projects
// root holds none. Candidates are the `.jsonl` files under any `subagents`
// directory, plus any `agent-*.jsonl` elsewhere in the tree, so a layout the
// client has not been observed to emit still resolves; a file that states no
// session id simply never matches.
function findSubagentSessionFile(root, sessionId, options = {}) {
  if (!isSingleSegmentId(sessionId)) return '';
  const rootDir = String(root || '');
  if (!rootDir) return '';
  const fsApi = options.fs || fs;

  let found = '';
  function walk(dir, underSubagents) {
    if (found) return;
    let entries;
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found) return;
      const nextPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(nextPath, underSubagents || entry.name === 'subagents');
      } else if (
        entry.isFile()
        && entry.name.endsWith('.jsonl')
        && (underSubagents || /^agent-.+\.jsonl$/.test(entry.name))
        && sessionIdOfFile(nextPath, fsApi) === sessionId
      ) {
        found = nextPath;
        return;
      }
    }
  }

  walk(rootDir, false);
  return found;
}

module.exports = { findSubagentSessionFile };
