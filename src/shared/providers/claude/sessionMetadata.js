'use strict';

const fs = require('node:fs');
const { claudeSessionRoots } = require('./paths');
const { findSessionFiles } = require('../../sessionFiles');

const TITLE_MAX_CODE_POINTS = 96;
const TITLE_READ_CHUNK_BYTES = 256 * 1024;
const MAX_METADATA_LINE_BYTES = 64 * 1024;
const titleCache = new Map();

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? text
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

function applyMetadataLine(state, line) {
  if (!line.length) return;
  try {
    const entry = JSON.parse(line.toString('utf8'));
    if (entry?.type === 'custom-title') {
      const candidate = cleanTitle(entry.customTitle);
      if (candidate) state.customTitle = candidate;
    } else if (entry?.type === 'ai-title') {
      const candidate = cleanTitle(entry.aiTitle);
      if (candidate) state.aiTitle = candidate;
    } else if (entry?.type === 'assistant') {
      // Claude stamps every assistant record with why it stopped. `tool_use`
      // means it paused to run tools and is still mid-turn; anything else
      // (`end_turn`, `stop_sequence`, `max_tokens`) means nothing further is
      // being generated. Titles and this boundary ride one pass, so the turn
      // state costs no extra read.
      const stopReason = entry.message?.stop_reason;
      if (typeof stopReason === 'string' && stopReason) state.stopReason = stopReason;
    }
  } catch (_) { /* skip partial or unrelated lines */ }
}

function consumeMetadataBytes(state, chunk) {
  const bytes = state.trailing.length > 0
    ? Buffer.concat([state.trailing, chunk])
    : chunk;
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (state.droppingLongLine) {
      state.droppingLongLine = false;
    } else {
      let lineEnd = index;
      if (lineEnd > lineStart && bytes[lineEnd - 1] === 0x0d) lineEnd -= 1;
      applyMetadataLine(state, bytes.subarray(lineStart, lineEnd));
    }
    lineStart = index + 1;
  }

  const remainder = bytes.subarray(lineStart);
  if (state.droppingLongLine) {
    state.trailing = Buffer.alloc(0);
  } else if (remainder.length > MAX_METADATA_LINE_BYTES) {
    // Transcript messages can be arbitrarily large. Title records are tiny, so
    // bound retained partial-line memory and resume after the next newline.
    state.trailing = Buffer.alloc(0);
    state.droppingLongLine = true;
  } else {
    state.trailing = Buffer.from(remainder);
  }
}

function scanRange(fd, start, length, state, fsApi) {
  let position = start;
  let remaining = length;
  while (remaining > 0) {
    const buffer = Buffer.alloc(Math.min(TITLE_READ_CHUNK_BYTES, remaining));
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, position);
    if (bytesRead <= 0) break;
    consumeMetadataBytes(state, buffer.subarray(0, bytesRead));
    position += bytesRead;
    remaining -= bytesRead;
  }
  // A complete final JSONL record is valid even when the writer omitted its
  // newline. Keep the bytes as trailing state too, so a partial concurrent
  // write can still be completed on the next append-only scan.
  if (!state.droppingLongLine && state.trailing.length > 0) {
    applyMetadataLine(state, state.trailing);
  }
}

function statIdentity(stat) {
  return `${String(stat.dev ?? '')}:${String(stat.ino ?? '')}`;
}

function emptyIndex() {
  return {
    customTitle: '',
    aiTitle: '',
    stopReason: '',
    trailing: Buffer.alloc(0),
    droppingLongLine: false
  };
}

function readSessionTitle(filePath, deps = {}) {
  const file = String(filePath || '');
  if (!file) return '';
  const cache = deps.cache || titleCache;
  const fsApi = deps.fs || fs;
  const cached = cache.get(file);
  let fd;
  try {
    const stat = fsApi.statSync(file);
    const identity = statIdentity(stat);
    if (
      cached
      && cached.identity === identity
      && cached.size === stat.size
      && cached.mtimeMs === stat.mtimeMs
    ) return cached.title;

    const appendOnly = cached
      && cached.identity === identity
      && Number.isFinite(cached.size)
      && stat.size > cached.size;
    const index = appendOnly
      ? {
        customTitle: cached.customTitle || '',
        aiTitle: cached.aiTitle || '',
        stopReason: cached.stopReason || '',
        trailing: Buffer.isBuffer(cached.trailing) ? Buffer.from(cached.trailing) : Buffer.alloc(0),
        droppingLongLine: cached.droppingLongLine === true
      }
      : emptyIndex();
    const start = appendOnly ? cached.size : 0;

    fd = fsApi.openSync(file, 'r');
    scanRange(fd, start, stat.size - start, index, fsApi);
    const title = index.customTitle || index.aiTitle;
    cache.set(file, {
      ...index,
      identity,
      size: stat.size,
      mtimeMs: stat.mtimeMs,
      title
    });
    return title;
  } catch (_) {
    return cached?.title || '';
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * The session's own account of whether a turn is still in progress. Claude
 * writes `stop_reason` on every assistant record, so the newest one is the
 * answer: `tool_use` means it is mid-turn running tools, anything else means
 * nothing further is being generated. Shares the title scan and its cache, so
 * asking for both costs one pass over the file.
 */
function readSessionTurnEnded(filePath, deps = {}) {
  const file = String(filePath || '');
  if (!file) return false;
  const cache = deps.cache || titleCache;
  // Reading the title first populates or refreshes the shared index; an
  // unchanged file short-circuits both through the same size+mtime check.
  readSessionTitle(file, deps);
  const cached = cache.get(file);
  const stopReason = String(cached?.stopReason || '');
  return stopReason !== '' && stopReason !== 'tool_use';
}

function resolveSessionMetadata(sessionIds, context) {
  const { deps, home, metadata } = context;
  const result = new Map();
  const roots = claudeSessionRoots({
    homeDir: home,
    env: deps.env,
    useEnvRoots: !deps.scopedHome
  });
  const applyFile = (sessionId, filePath) => {
    const meta = context.fileSessionMetadata(
      sessionId,
      filePath,
      metadata.get(`claude:${sessionId}`)
    );
    const title = readSessionTitle(filePath, deps.claudeMetadataDeps);
    // The turn boundary rides the same scan and its cache, so asking for it
    // costs no second pass. Reported for every session rather than only a recent
    // one: it is what stops a session reading as running, and gating it on the
    // time window would keep a finished session green for that whole window.
    const turnEnded = readSessionTurnEnded(filePath, deps.claudeMetadataDeps);
    result.set(sessionId, {
      ...meta,
      ...(title ? { title } : {}),
      ...(turnEnded ? { turnEnded: true } : {})
    });
  };
  const projectFiles = findSessionFiles(roots.projects, sessionIds);
  for (const [sessionId, filePath] of projectFiles) applyFile(sessionId, filePath);
  const missingIds = new Set([...sessionIds].filter((sessionId) => !projectFiles.has(sessionId)));
  const transcriptFiles = findSessionFiles(roots.transcripts, missingIds);
  for (const [sessionId, filePath] of transcriptFiles) applyFile(sessionId, filePath);
  return result;
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  TITLE_READ_CHUNK_BYTES,
  cleanTitle,
  readSessionTitle,
  readSessionTurnEnded,
  resolveSessionMetadata
};
