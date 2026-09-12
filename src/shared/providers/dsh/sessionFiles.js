'use strict';

/**
 * DeepSeek Harness (`dsh`) session-file discovery and transcript decoding.
 *
 * `dsh` persists one append-only JSONL transcript per session under
 * `<dsh-home>/sessions/<encoded-cwd>/<session-id>/session.jsonl(.zstd)`. The
 * default artifact is a concatenation of independently decodable Zstandard
 * frames — one per flush — so a live session scanned mid-write routinely ends
 * in a torn trailing frame; `scanZstdFrames` locates frame boundaries without
 * decompressing so a torn tail is skipped rather than throwing the whole
 * transcript away. Ported from dsh's own session-persistence-jsonl backend
 * (MIT).
 *
 * Path resolution delegates to `./paths.js` (`DSH_HOME` env override,
 * falling back to `~/.dsh`) — the module `src/shared/collector.js` already
 * uses to find DSH's source root for usage tracking. That module stays
 * Node-builtin-free so it can vendor into the Worker; this one is
 * Electron/agent-only (session detail is never served by the Worker), so it
 * fills in the `os.homedir()`/`process.env`/`process.platform` defaults
 * `./paths.js` leaves to its caller.
 */

const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { resolveDshSessionsDir } = require('./paths');

// The session header is a single small JSON record and always the first
// thing written, so a bounded head-read is enough to reach it even on a
// transcript that has grown large over a long-lived session — this is the
// difference between header lookup costing O(header size) and O(file size).
const HEADER_READ_BYTES = 64 * 1024;

function readFileHead(filePath, bytes = HEADER_READ_BYTES) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const size = fs.fstatSync(fd).size;
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, 0);
    return buffer;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

const DSH_SESSION_LOG_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd']);
// A transcript's file name is optional-versioned: the pair above is what DSH
// wrote up to v2, but a v3+ harness re-encodes the same session into a NEW file
// (`session.v3.jsonl.zstd`) instead of rotating the old one — which is why a
// fixed name list silently stopped finding live sessions (2026-09-10: a full
// day of deepseek-v4.1-flash usage missing from the widget before its tokscale
// vendor and Session Detail discovery were updated). Matching the version
// segment generically lets discovery select the canonical live artifact. The
// detail parser then reads recognized event shapes best-effort; accepting the
// filename is deliberately not a promise that every future event semantic is
// understood.
// Matches the harness's own `session.v<N>.<ext>` convention (observed: v3) rather
// than any `session.<something>` sibling, so an unrelated file dropped into a
// session directory cannot be mistaken for a transcript. A future rename that
// stops being numeric would have to widen this pattern.
const DSH_SESSION_LOG_PATTERN = /^session(?:\.v\d+)?\.jsonl(?:\.zstd)?$/;

function isDshSessionLogName(name) {
  const value = String(name || '');
  return DSH_SESSION_LOG_NAMES.has(value) || DSH_SESSION_LOG_PATTERN.test(value);
}

// Higher rank = preferred when one session directory holds several transcripts.
// A v3 upgrade leaves the pre-upgrade file in place next to the re-encoded one,
// so the versioned file is the live transcript and has to win the first match.
function dshSessionLogRank(name) {
  if (!isDshSessionLogName(name)) return -1;
  // dsh spells positive generations with the `v` prefix
  // (`session.v3.jsonl.zstd`); the number orders two transcripts of one
  // session using the same discovery contract as the pinned tokscale build.
  const versioned = /^session\.v(\d+)\.jsonl/.exec(String(name || ''));
  return versioned ? Number(versioned[1]) : 0;
}

function sortDshSessionLogNames(names) {
  return names.sort((a, b) => (dshSessionLogRank(b) - dshSessionLogRank(a)) || (a < b ? -1 : a > b ? 1 : 0));
}

function preferredDshSessionFileInDirectory(dir) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (_) {
    return null;
  }
  const names = entries
    .filter((entry) => entry.isFile() && isDshSessionLogName(entry.name))
    .map((entry) => entry.name);
  sortDshSessionLogNames(names);
  return names.length > 0 ? path.join(dir, names[0]) : null;
}
const DSH_SESSION_DIR_DEPTH = 2; // <root>/<project>/<session>/<artifact>
const ZSTD_MAGIC = 0xFD2FB528;
const DSH_SESSION_TITLE_READ_BYTES = 256 * 1024;
const DSH_SESSION_CONTINUITY_BYTES = 64 * 1024;

function resolveDshSessionsRoot(options = {}) {
  const platform = options.platform || process.platform;
  // The joiner in ./paths.js only inserts a separator between the segments it
  // joins itself; it does not normalize separators already present in an
  // input like DSH_HOME (unlike the old path.join-based implementation this
  // replaced). Normalizing the result restores that — a DSH_HOME using the
  // "wrong" slash for the platform still resolves to a native-separator
  // path. Select path.win32/path.posix explicitly by the resolved `platform`
  // rather than using the ambient `path` module, so this stays a pure
  // function of its arguments (testable for either platform on any host),
  // matching how ./paths.js itself treats `platform`.
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  return pathImpl.normalize(resolveDshSessionsDir({
    env: options.env || process.env,
    homeDir: options.homeDir || os.homedir(),
    platform
  }));
}

function dshSessionFiles(root) {
  // Collected per directory so a session holding several transcripts yields its
  // live one first: every caller that stops at the first match (session detail,
  // the header index) then reads the same file, while callers that aggregate
  // usage walk all of them and dedupe by event.
  const byDir = new Map();
  const stack = [{ dir: root, depth: 0 }];
  while (stack.length > 0) {
    const { dir, depth } = stack.pop();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (depth < DSH_SESSION_DIR_DEPTH) stack.push({ dir: path.join(dir, entry.name), depth: depth + 1 });
      } else if (entry.isFile() && isDshSessionLogName(entry.name)) {
        const names = byDir.get(dir);
        if (names) names.push(entry.name);
        else byDir.set(dir, [entry.name]);
      }
    }
  }
  const files = [];
  for (const [dir, names] of byDir) {
    sortDshSessionLogNames(names);
    for (const name of names) files.push(path.join(dir, name));
  }
  return files;
}

// Locate complete frames without decompressing them, so a torn trailing frame
// from a crash or a mid-write scan is skipped instead of aborting the parse.
function scanZstdFrames(buffer) {
  const frames = [];
  let offset = 0;
  while (offset < buffer.length) {
    const start = offset;
    if (buffer.length - offset < 4) return frames;
    if (buffer.readUInt32LE(offset) !== ZSTD_MAGIC) return frames;
    offset += 4;
    if (offset === buffer.length) return frames;
    const descriptor = buffer.readUInt8(offset);
    offset += 1;
    if ((descriptor & 0x18) !== 0) return frames; // reserved bits set — treat as torn/corrupt tail
    const contentSizeFlag = descriptor >>> 6;
    const singleSegment = (descriptor & 0x20) !== 0;
    const checksum = (descriptor & 0x04) !== 0;
    const dictionaryFlag = descriptor & 0x03;
    const dictionaryBytes = dictionaryFlag === 3 ? 4 : dictionaryFlag;
    const contentSizeBytes = contentSizeFlag === 0 ? (singleSegment ? 1 : 0) : 1 << contentSizeFlag;
    const remainingHeaderBytes = (singleSegment ? 0 : 1) + dictionaryBytes + contentSizeBytes;
    if (buffer.length - offset < remainingHeaderBytes) return frames;
    offset += remainingHeaderBytes;
    for (;;) {
      if (buffer.length - offset < 3) return frames;
      const blockHeader = buffer.readUIntLE(offset, 3);
      offset += 3;
      const lastBlock = (blockHeader & 1) !== 0;
      const blockType = (blockHeader >>> 1) & 0x03;
      const blockSize = blockHeader >>> 3;
      if (blockType === 0x03) return frames; // reserved block type — torn/corrupt tail
      const payloadBytes = blockType === 0x01 ? 1 : blockSize;
      if (buffer.length - offset < payloadBytes) return frames;
      offset += payloadBytes;
      if (lastBlock) break;
    }
    if (checksum) {
      if (buffer.length - offset < 4) return frames;
      offset += 4;
    }
    frames.push({ start, end: offset });
  }
  return frames;
}

function zstdAvailable() {
  return typeof zlib.zstdDecompressSync === 'function';
}

// Decodes complete frames in order and reports where it stopped, so the caller
// can tell "every frame decoded cleanly, end of file" from "decoding stopped
// at a corrupt frame". A frame whose framing is complete but whose content is
// corrupt (a checksum mismatch, say) cannot be decoded. Stopping there and
// keeping the valid prefix — instead of throwing the whole transcript away —
// matches tokscale's streaming decoder, which emits every record it
// successfully read before the error, and dsh's own reader. `stoppedOnError`
// also marks the recovery boundary for the caller: nothing after the first
// undecodable frame is trusted, so torn-tail recovery must not run past it.
// (The torn-tail recovery in decodeSessionText below handles the other
// failure mode — a frame that was cut off mid-write.)
function decodeZstdBuffer(buffer, frames) {
  if (!zstdAvailable()) {
    const error = new Error('this Node.js build does not support Zstandard decompression');
    error.code = 'zstd-unsupported';
    throw error;
  }
  let text = '';
  let decodedEnd = 0;
  for (const frame of frames || scanZstdFrames(buffer)) {
    let decoded;
    try {
      decoded = zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end));
    } catch (_) {
      return { text, decodedEnd, stoppedOnError: true };
    }
    text += decoded.toString('utf8');
    decodedEnd = frame.end;
  }
  return { text, decodedEnd, stoppedOnError: false };
}

function decodeZstdText(buffer) {
  const frames = scanZstdFrames(buffer);
  const decoded = decodeZstdBuffer(buffer, frames);
  // The first content-corrupt complete frame is the recovery boundary: nothing
  // after it is trusted, not even a torn tail whose complete records a partial
  // recovery could still read — tokscale's streaming decoder stops at the same
  // first decode error, so records past the corruption must not be resurrected
  // through tail recovery.
  if (decoded.stoppedOnError) return { text: decoded.text, consumed: decoded.decodedEnd };
  let text = decoded.text;
  // A live transcript is scanned mid-write routinely, so the trailing frame is
  // often torn. dsh's own reader (decompressZstdPrefix with ZSTD_e_flush) and
  // tokscale's streaming zstd decoder both keep the records a torn final frame
  // managed to write out completely, dropping only the fragment at the cut.
  // zlib's finishFlush reproduces that at block granularity: it emits every
  // fully-decoded block in the torn tail, and the per-line JSON parse
  // downstream skips the remainder. The header-only decodeFirstFrameText path
  // deliberately does not use this recovery and still returns '' for a torn
  // first frame.
  const tailStart = decoded.decodedEnd;
  if (tailStart < buffer.length) {
    const tail = buffer.subarray(tailStart);
    if (tail.length >= 4 && tail.readUInt32LE(0) === ZSTD_MAGIC) {
      try {
        text += zlib.zstdDecompressSync(tail, { finishFlush: zlib.constants.ZSTD_e_flush }).toString('utf8');
      } catch (_) {
        // The torn prefix could not be partially recovered; the complete frames
        // above are still valid, so keep them and drop only this tail.
      }
    }
  }
  return { text, consumed: decoded.decodedEnd };
}

function decodeSessionText(filePath, buffer) {
  if (!filePath.endsWith('.jsonl.zstd')) return buffer.toString('utf8');
  return decodeZstdText(buffer).text;
}

function persistedDshSessionTitle(value) {
  return typeof value === 'string' && value.length > 0 ? value : '';
}

function foldDshSessionTitle(text, initialTitle = '') {
  let title = persistedDshSessionTitle(initialTitle);
  for (const line of String(text || '').split(/\r?\n/)) {
    if (!line.trim()) continue;
    let event;
    try { event = JSON.parse(line); } catch (_) { continue; }
    if (event?.type !== 'session/title') continue;
    const nextTitle = persistedDshSessionTitle(event.data?.title);
    if (nextTitle) title = nextTitle;
  }
  return title;
}

function dshSessionFileIdentity(stat) {
  return `${String(stat.dev ?? '')}:${String(stat.ino ?? '')}`;
}

function hashDshSessionRange(hash, fd, start, length) {
  const buffer = Buffer.allocUnsafe(length);
  let offset = 0;
  while (offset < length) {
    const bytesRead = fs.readSync(fd, buffer, offset, length - offset, start + offset);
    if (bytesRead <= 0) throw new Error('DSH transcript changed during continuity read');
    offset += bytesRead;
  }
  hash.update(buffer);
}

function readDshSessionContinuity(fd, size) {
  const hash = crypto.createHash('sha256');
  const headLength = Math.min(size, DSH_SESSION_CONTINUITY_BYTES);
  hashDshSessionRange(hash, fd, 0, headLength);
  const tailStart = Math.max(headLength, size - DSH_SESSION_CONTINUITY_BYTES);
  hashDshSessionRange(hash, fd, tailStart, size - tailStart);
  return {
    size,
    hash: hash.digest('hex')
  };
}

function dshSessionContinuityMatches(fd, previous, previousSize) {
  const continuity = previous?.continuity;
  if (!continuity || continuity.size !== previousSize
    || typeof continuity.hash !== 'string') return false;
  return readDshSessionContinuity(fd, previousSize).hash === continuity.hash;
}

function decodeSessionAppend(filePath, buffer) {
  if (!filePath.endsWith('.jsonl.zstd')) {
    // Only advance over newline-complete JSONL records. A final partial record
    // is re-read after the next append instead of being cached as consumed.
    const lastNewline = buffer.lastIndexOf(0x0a);
    const consumed = lastNewline < 0 ? 0 : lastNewline + 1;
    return { text: buffer.subarray(0, consumed).toString('utf8'), consumed };
  }

  return decodeZstdText(buffer);
}

// DSH titles are durable `session/title` events and use latest-wins folding.
// Retain the last complete JSONL/zstd boundary and decode only new bytes when
// the previous file identity and bounded head/tail fingerprint still match. Any
// replacement or rewrite resets the fold, while a torn final record/frame
// remains eligible for retry.
function readDshSessionTitle(filePath, previous = {}) {
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return { title: '', offset: 0, size: 0, mtimeMs: 0 }; }
  const size = Number(stat.size) || 0;
  const mtimeMs = Number(stat.mtimeMs) || 0;
  const identity = dshSessionFileIdentity(stat);
  const previousSize = Number(previous.size) || 0;
  const previousMtimeMs = Number(previous.mtimeMs) || 0;
  if (size === previousSize && mtimeMs === previousMtimeMs
    && identity === previous.identity && previous.continuity) return previous;

  const previousOffset = Number(previous.offset);
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const appendOnly = size > previousSize && identity === previous.identity
      && Number.isSafeInteger(previousOffset) && previousOffset >= 0 && previousOffset <= previousSize
      && dshSessionContinuityMatches(fd, previous, previousSize);
    const start = appendOnly ? previousOffset : 0;
    let title = persistedDshSessionTitle(appendOnly ? previous.title : '');
    const isZstd = filePath.endsWith('.jsonl.zstd');
    let position = start;
    let consumed = 0;
    let pending = Buffer.alloc(0);
    let stoppedOnError = false;
    while (position < size && !stoppedOnError) {
      const length = Math.min(DSH_SESSION_TITLE_READ_BYTES, size - position);
      const chunk = Buffer.allocUnsafe(length);
      const bytesRead = fs.readSync(fd, chunk, 0, length, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const data = chunk.subarray(0, bytesRead);
      pending = pending.length > 0 ? Buffer.concat([pending, data]) : data;

      if (isZstd) {
        const decoded = decodeZstdBuffer(pending, scanZstdFrames(pending));
        title = foldDshSessionTitle(decoded.text, title);
        consumed += decoded.decodedEnd;
        pending = pending.subarray(decoded.decodedEnd);
        stoppedOnError = decoded.stoppedOnError;
      } else {
        const lastNewline = pending.lastIndexOf(0x0a);
        if (lastNewline >= 0) {
          const complete = lastNewline + 1;
          title = foldDshSessionTitle(pending.subarray(0, complete).toString('utf8'), title);
          consumed += complete;
          pending = pending.subarray(complete);
        }
      }
    }
    if (filePath.endsWith('.jsonl.zstd') && !stoppedOnError && pending.length > 0) {
      // A live final frame may be torn but still contain complete JSONL rows.
      // Fold those rows now, while retaining the frame boundary for replay.
      title = foldDshSessionTitle(decodeSessionAppend(filePath, pending).text, title);
    }
    return {
      title,
      offset: start + consumed,
      size,
      mtimeMs,
      identity,
      continuity: readDshSessionContinuity(fd, size)
    };
  } catch (_) {
    // Do not cache a failed read as though this file revision were observed;
    // preserving the older fingerprint makes the next tick retry it.
    return previous && typeof previous === 'object'
      ? previous
      : { title: '', offset: 0, size: 0, mtimeMs: 0 };
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

// DSH appends one zstd frame per flush, and the leading `session` header is
// always the first event written, so it lives entirely inside the first
// frame. Decoding just that frame — instead of every frame in the file —
// keeps session-id lookup cheap even once a transcript directory holds a
// long history of unrelated sessions.
function decodeFirstFrameText(filePath, buffer) {
  if (!filePath.endsWith('.jsonl.zstd')) return buffer.toString('utf8');
  const [frame] = scanZstdFrames(buffer);
  if (!frame) return '';
  return decodeZstdBuffer(buffer, [frame]).text;
}

function parseDshSessionHeader(text) {
  const firstLine = text.split(/\r?\n/).find((line) => line.trim());
  if (!firstLine) return null;
  const header = JSON.parse(firstLine.trim());
  return header?.type === 'session' && typeof header.id === 'string' ? header : null;
}

// DSH names the transcript directory after the session id; use it when the
// header itself can't be read, mirroring tokscale's own session_id_from_path
// fallback for a missing or unreadable leading `session` event (dsh.rs).
function sessionIdFromPath(filePath) {
  const dir = path.basename(path.dirname(filePath));
  return dir ? { type: 'session', id: dir } : null;
}

// The `session` header (id, createdAt, ...) is always the first record, and
// a bounded head-read (not the whole, possibly long-lived transcript) is
// enough to reach it in every real case observed (a header is a single small
// JSON record). If that bounded read doesn't yield a usable header — a torn
// first frame, or in principle one whose compressed size exceeds the bound —
// fall back to a full read before giving up, so a real session never goes
// undiscovered over a fixed byte budget; then fall back to the directory
// name so a header that's unreadable even on a full read still resolves to
// its id (with no createdAt — callers already tolerate that).
function readDshSessionHeader(filePath) {
  let header;
  try {
    header = parseDshSessionHeader(decodeFirstFrameText(filePath, readFileHead(filePath)));
  } catch (_) {
    header = null;
  }
  if (!header) {
    try {
      header = parseDshSessionHeader(decodeSessionText(filePath, fs.readFileSync(filePath)));
    } catch (_) {
      header = null;
    }
  }
  return header || sessionIdFromPath(filePath);
}

// Single pass over every session file under root, keyed by session id. Used
// whenever more than one session id needs resolving in the same tick: a
// find-by-id loop that scans the whole tree and reads a header per candidate
// for *each* wanted id degrades to O(ids x files), where this is O(files)
// regardless of how many ids are being looked up.
function indexDshSessionHeaders(options = {}) {
  const root = options.sessionsRoot || resolveDshSessionsRoot(options);
  const index = new Map();
  for (const filePath of dshSessionFiles(root)) {
    const header = readDshSessionHeader(filePath);
    // First wins: dshSessionFiles() lists a session's live transcript first, and a
    // v3 upgrade leaves an older re-encode of the same id right beside it.
    if (header && !index.has(header.id)) index.set(header.id, { filePath, createdAt: header.createdAt });
  }
  return index;
}

module.exports = {
  DSH_SESSION_DIR_DEPTH,
  DSH_SESSION_LOG_NAMES,
  DSH_SESSION_LOG_PATTERN,
  decodeFirstFrameText,
  decodeSessionText,
  dshSessionFiles,
  dshSessionLogRank,
  indexDshSessionHeaders,
  isDshSessionLogName,
  preferredDshSessionFileInDirectory,
  readDshSessionHeader,
  readDshSessionTitle,
  resolveDshSessionsRoot,
  scanZstdFrames,
  zstdAvailable
};
