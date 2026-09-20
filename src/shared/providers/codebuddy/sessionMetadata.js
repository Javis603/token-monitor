'use strict';

const fs = require('node:fs');
const { findSessionFiles } = require('../../sessionFiles');
const { codebuddyProjectsRoot } = require('./paths');
const { assistantStatus, cleanTitle, isUserPromptRecord } = require('./transcript');

// One bounded pass over a transcript answers both things the scan cannot:
// the title (an `ai-title` record the client writes when it names a session)
// and the turn boundary (the `status` on each assistant response). They ride
// together because they must — a second pass would re-read every transcript per
// tick for a field that sits in the same file, which is the same reason
// providers/claude/sessionMetadata.js reads its two fields out of one scan.
//
// The cache intentionally outlives one collection tick: a tick asks about every
// session the scan reported, and an idle transcript must not be re-read for
// each one. Size+mtime (plus the file identity, so a replaced file with equal
// size and timestamp is not mistaken for the old one) is the whole invalidation
// policy — a transcript that changed is re-read in full rather than resumed
// from its last offset. That costs one full read per *changed* file per tick,
// which is the session being written right now, while the scan-all cost the
// cache exists to avoid stays a stat per session.
const metadataCache = new Map();
const READ_CHUNK_BYTES = 256 * 1024;
const MAX_LINE_BYTES = 64 * 1024;

function emptyState() {
  return { title: '', status: '', userSinceStop: false, trailing: Buffer.alloc(0), droppingLongLine: false };
}

function applyLine(state, line) {
  if (line.length === 0) return;
  let entry;
  try {
    entry = JSON.parse(line.toString('utf8'));
  } catch (_) {
    return; // a torn trailing write, or a record this reader has no use for
  }
  if (entry?.type === 'ai-title') {
    // The client rewrites the title as the session evolves, so the newest
    // non-empty one wins. A record that cleans down to nothing is not an
    // answer and must not erase the title already read.
    const title = cleanTitle(entry.aiTitle);
    if (title) state.title = title;
    return;
  }
  const status = assistantStatus(entry);
  if (status) {
    state.status = status;
    // The response answered, so any prompt the user sent before it belongs to
    // the turn this record closes.
    state.userSinceStop = false;
    return;
  }
  if (isUserPromptRecord(entry)) {
    // A prompt accepted after the last response means that response no longer
    // describes the current turn: without this the finished status would latch
    // and a session that had just been prompted would keep reading as finished
    // until the model answered again.
    state.userSinceStop = true;
  }
}

function consumeBytes(state, chunk) {
  const bytes = state.trailing.length > 0
    ? Buffer.concat([state.trailing, chunk])
    : chunk;
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (!state.droppingLongLine) {
      let lineEnd = index;
      if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
      const line = bytes.subarray(lineStart, lineEnd);
      // The bound is applied per record rather than per read chunk, so a record
      // is dropped on its own length and never on where a chunk happened to end.
      // Records over it are dropped, not retained: a transcript holds arbitrary
      // sizes — tool output is what every oversized record is, and one
      // `function_call_result` on a real machine was 2 MB — while the reading
      // that can be lost is a turn boundary, never a title (an `ai-title` record
      // is a few hundred bytes). Measured over 53248 records, 313 exceeded this
      // bound and only 3 of those were `message` records. Dropping leaves the
      // previous reading in place, where a client that states nothing at all
      // falls back to the recency window.
      if (line.length <= MAX_LINE_BYTES) applyLine(state, line);
    }
    state.droppingLongLine = false;
    lineStart = index + 1;
  }

  const remainder = bytes.subarray(lineStart);
  if (remainder.length > MAX_LINE_BYTES) {
    // A record still being written is already over the bound, so it is dropped
    // now and its remaining bytes are discarded until its newline arrives.
    state.droppingLongLine = true;
    state.trailing = Buffer.alloc(0);
  } else {
    state.trailing = Buffer.from(remainder);
  }
}

function scanRange(fd, size, state, fsApi) {
  let position = 0;
  let remaining = size;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(READ_CHUNK_BYTES, remaining));
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead <= 0) break;
    consumeBytes(state, buffer.subarray(0, bytesRead));
    position += bytesRead;
    remaining -= bytesRead;
  }
  // A complete final record is valid even when the writer has not emitted its
  // newline yet.
  if (!state.droppingLongLine && state.trailing.length > 0) applyLine(state, state.trailing);
}

// `true` is a finished turn, `false` one that is open, and `undefined` a
// transcript that states no boundary at all. The three are forwarded as they
// are: only the last may leave an earlier reading in place.
function turnEndedOf(state) {
  if (!state.status) return undefined;
  if (state.userSinceStop) return false;
  return state.status === 'completed';
}

function readSessionMetadata(filePath, deps = {}) {
  const file = String(filePath || '');
  if (!file) return { title: '', turnEnded: undefined };
  const cache = deps.cache || metadataCache;
  const fsApi = deps.fs || fs;
  const cached = cache.get(file);
  let fd;
  try {
    const stat = fsApi.statSync(file);
    const identity = `${String(stat.dev ?? '')}:${String(stat.ino ?? '')}`;
    if (
      cached
      && cached.identity === identity
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs
    ) {
      return { title: cached.title, turnEnded: cached.turnEnded };
    }
    const state = emptyState();
    fd = fsApi.openSync(file, 'r');
    scanRange(fd, stat.size, state, fsApi);
    const metadata = { title: state.title, turnEnded: turnEndedOf(state) };
    cache.set(file, { ...metadata, identity, size: stat.size, mtimeMs: stat.mtimeMs });
    return metadata;
  } catch (_) {
    return { title: cached?.title || '', turnEnded: cached?.turnEnded };
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) {}
    }
  }
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, metadata } = context;
  const result = new Map();
  const files = findSessionFiles(codebuddyProjectsRoot({ homeDir: home }), sessionIds);
  for (const [sessionId, filePath] of files) {
    const local = readSessionMetadata(filePath, deps.codebuddyMetadataDeps);
    // Timestamps and project attribution come from the shared helper, which
    // reads `cwd` out of the same transcript the scan already reported a
    // project for — so only the two fields the scan cannot answer are added
    // here.
    const meta = context.fileSessionMetadata(
      sessionId,
      filePath,
      metadata.get(`codebuddy:${sessionId}`)
    );
    result.set(sessionId, {
      ...meta,
      ...(local.title ? { title: local.title } : {}),
      ...(local.turnEnded === undefined ? {} : { turnEnded: local.turnEnded })
    });
  }
  return result;
}

module.exports = { readSessionMetadata, resolveSessionMetadata };
