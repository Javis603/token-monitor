'use strict';

const fs = require('node:fs');
const { claudeSessionRoots } = require('./paths');
const { findSessionFiles } = require('../../sessionFiles');

const TITLE_MAX_CODE_POINTS = 96;
const TITLE_READ_CHUNK_BYTES = 256 * 1024;
const MAX_METADATA_LINE_BYTES = 64 * 1024;
// The turn boundary needs two fields, and on a real transcript they sit at
// opposite ends of a record: whether a `user` record is a genuine prompt is
// decided by the head (its content blocks), while `stop_reason` trails the
// assistant text. Oversized records are read from those two bounded fragments
// instead of being parsed whole — a pasted screenshot makes a real user record
// of 1.9 MB, and the title scanner deliberately drops anything past
// `MAX_METADATA_LINE_BYTES`, which used to drop the boundary riding the same pass.
const LONG_LINE_HEAD_BYTES = 64 * 1024;
const LONG_LINE_TAIL_BYTES = 8 * 1024;
const titleCache = new Map();

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? text
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

// Whether a `user` record is something the user actually asked, as opposed to
// the plumbing that shares the same type. Almost every user record is a
// tool_result being handed back to the model (14070 of 16393 on one real
// machine), and the client also writes meta and compaction bookkeeping there.
// Only a real prompt starts a new turn, so only it may retire the previous
// completion — treating a tool_result as one would mark every working session
// as finished, which is the same mistake `tool_use` guards against.
function isUserPrompt(entry) {
  if (entry?.isMeta === true || entry?.isCompactSummary === true) return false;
  const content = entry?.message?.content;
  if (typeof content === 'string') return content.trim().length > 0;
  if (!Array.isArray(content)) return false;
  let asked = false;
  for (const block of content) {
    const type = block?.type;
    if (type === 'tool_result') return false;
    if (type === 'text' || type === 'image') asked = true;
  }
  return asked;
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
      // The assistant answered, so any prompt the user sent before it belongs to
      // the turn this record closes.
      state.userSinceStop = false;
    } else if (isUserPrompt(entry)) {
      // A prompt accepted after the last completion means that completion no
      // longer describes the current turn: the old `end_turn` would otherwise
      // latch, and the session would read as finished while the new turn is
      // still being generated. The next assistant record restores the reading.
      state.userSinceStop = true;
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
      // The bytes between the last cut and this newline belong to the record
      // that is ending, so they are folded into the tail before it is read.
      // Without this the scan saw only the stale tail, and a record closes
      // with the field that matters: a 300 KiB assistant record puts its
      // `stop_reason` in the next read chunk, so the previous reading
      // survived and the row kept a turn state the transcript had replaced.
      keepLongLineTail(state, bytes.subarray(lineStart, index));
      applyLongLineFragments(state);
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
    // Keep the tail as the record continues, so its last bytes are available
    // when the newline finally arrives.
    keepLongLineTail(state, remainder);
  } else if (remainder.length > MAX_METADATA_LINE_BYTES) {
    // Transcript messages can be arbitrarily large, and the title records this
    // scanner was built for are tiny. Bound retained memory by holding only a
    // head and a tail of the oversized record instead of the whole thing, and
    // resume at the next newline.
    state.longLineHead = Buffer.from(remainder.subarray(0, LONG_LINE_HEAD_BYTES));
    state.longLineTail = Buffer.from(remainder.subarray(-LONG_LINE_TAIL_BYTES));
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
  if (state.droppingLongLine) {
    // EOF is not necessarily the end of the record: a transcript being written
    // right now stops mid-record, and the next tick reads only the bytes that
    // were appended. The boundary is evaluated for whatever the fragments show
    // so far, but they are kept and the record stays open, because the suffix
    // that arrives later carries no head and could never be identified as an
    // assistant record again. Consuming them here lost the stop_reason for
    // good, and the previous turn's reading survived.
    const head = state.longLineHead;
    const tail = state.longLineTail;
    applyLongLineFragments(state);
    state.longLineHead = head || Buffer.alloc(0);
    state.longLineTail = tail || Buffer.alloc(0);
  } else if (state.trailing.length > 0) {
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
    userSinceStop: false,
    trailing: Buffer.alloc(0),
    droppingLongLine: false,
    longLineHead: Buffer.alloc(0),
    longLineTail: Buffer.alloc(0)
  };
}

// Accumulate the tail of an oversized record: the last bytes written are the
// ones the next newline will close, so only the newest window is worth keeping.
function keepLongLineTail(state, remainder) {
  if (!remainder.length) return;
  const previous = state.longLineTail || Buffer.alloc(0);
  const combined = previous.length > 0 ? Buffer.concat([previous, remainder]) : remainder;
  state.longLineTail = combined.length > LONG_LINE_TAIL_BYTES
    ? Buffer.from(combined.subarray(combined.length - LONG_LINE_TAIL_BYTES))
    : Buffer.from(combined);
}

// The boundary inside a record too large to parse. The fragments are partial
// JSON by construction, so the two fields are matched on the raw text: a user
// record is a real prompt when its content opens with text or an image rather
// than a tool_result, and an assistant record reports the stop_reason it ends
// with. Anything else leaves the state untouched, exactly as a full parse of an
// unrelated record would.
function applyLongLineFragments(state) {
  const head = (state.longLineHead || Buffer.alloc(0)).toString('utf8');
  const tail = (state.longLineTail || Buffer.alloc(0)).toString('utf8');
  state.longLineHead = Buffer.alloc(0);
  state.longLineTail = Buffer.alloc(0);
  if (/"type"\s*:\s*"assistant"/.test(head)) {
    // stop_reason is the last occurrence, and it trails the assistant text.
    const matches = [...tail.matchAll(/"stop_reason"\s*:\s*"([^"]*)"/g)];
    const reason = matches.length ? matches[matches.length - 1][1] : '';
    // A record still being written has no reason yet, and that absence is not
    // the same as a finished turn: clearing the flag here would retire the
    // prompt that started this record and let the previous completion show
    // through again while the model is mid-answer. Only a stated reason is a
    // reading.
    if (!reason) return;
    state.stopReason = reason;
    state.userSinceStop = false;
    return;
  }
  if (!/"type"\s*:\s*"user"/.test(head)) return;
  if (/"isMeta"\s*:\s*true/.test(head) || /"isCompactSummary"\s*:\s*true/.test(head)) return;
  // This has to agree with what isUserPrompt() accepts, or the same record is a
  // prompt when it fits in one line and not one when it does not. That function
  // takes a plain string content as a real prompt, so this path does too; the
  // array form is still decided by its leading block, where a tool_result hands
  // work back to the model and is not a prompt while text or an image is.
  const contentAt = head.indexOf('"content"');
  if (contentAt < 0) return;
  const after = head.slice(contentAt);
  // A string value is either blank (which the full parser also rejects) or a
  // prompt. The capture stops at the first quote, so a value still being
  // written is matched on the bytes that have arrived.
  const asString = /^"content"\s*:\s*"([^"]*)/.exec(after);
  if (asString) {
    if (asString[1].trim().length > 0) state.userSinceStop = true;
    return;
  }
  if (/"type"\s*:\s*"tool_result"/.test(after.slice(0, 400))) return;
  if (/"type"\s*:\s*"(text|image)"/.test(after.slice(0, 400))) state.userSinceStop = true;
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
        userSinceStop: cached.userSinceStop === true,
        trailing: Buffer.isBuffer(cached.trailing) ? Buffer.from(cached.trailing) : Buffer.alloc(0),
        droppingLongLine: cached.droppingLongLine === true,
        // Carried across the append resume: a scan that stopped mid-record has
        // to finish reading that record's boundary from the fragments it kept.
        longLineHead: Buffer.isBuffer(cached.longLineHead) ? Buffer.from(cached.longLineHead) : Buffer.alloc(0),
        longLineTail: Buffer.isBuffer(cached.longLineTail) ? Buffer.from(cached.longLineTail) : Buffer.alloc(0)
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
  if (!file) return undefined;
  const cache = deps.cache || titleCache;
  // Reading the title first populates or refreshes the shared index; an
  // unchanged file short-circuits both through the same size+mtime check.
  readSessionTitle(file, deps);
  const cached = cache.get(file);
  // No index means nothing was read from this transcript, so there is no
  // evidence either way and the caller must stay on its time window.
  if (!cached) return undefined;
  const stopReason = String(cached?.stopReason || '');
  // A completion is only the current turn while nothing newer has been asked of
  // the session. `tool_use` never counts: the client paused to run tools.
  if (stopReason === '') return undefined;
  return stopReason !== 'tool_use' && cached?.userSinceStop !== true;
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
    //
    // Emitted in all three states, not just the truthy one. A transcript that
    // shows a new prompt has `false`, which is evidence of an active turn and
    // has to reach the merge to clear a `true` from an earlier tick; omitting it
    // left the stale completion in place and the row read Finished while the
    // model was generating. `undefined` is reserved for "no evidence".
    const turnEnded = readSessionTurnEnded(filePath, deps.claudeMetadataDeps);
    result.set(sessionId, {
      ...meta,
      ...(title ? { title } : {}),
      ...(turnEnded === undefined ? {} : { turnEnded })
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
