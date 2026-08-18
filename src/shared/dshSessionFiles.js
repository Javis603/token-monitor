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
 * Path resolution delegates to `dshPaths.js` (`DSH_HOME` env override,
 * falling back to `~/.dsh`) — the module `src/shared/collector.js` already
 * uses to find DSH's source root for usage tracking. That module stays
 * Node-builtin-free so it can vendor into the Worker; this one is
 * Electron/agent-only (session detail is never served by the Worker), so it
 * fills in the `os.homedir()`/`process.env`/`process.platform` defaults
 * `dshPaths.js` leaves to its caller.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const { resolveDshSessionsDir } = require('./dshPaths');

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
const DSH_SESSION_DIR_DEPTH = 2; // <root>/<project>/<session>/<artifact>
const ZSTD_MAGIC = 0xFD2FB528;

function resolveDshSessionsRoot(options = {}) {
  const platform = options.platform || process.platform;
  // dshPaths.js's joiner only inserts a separator between the segments it
  // joins itself; it does not normalize separators already present in an
  // input like DSH_HOME (unlike the old path.join-based implementation this
  // replaced). Normalizing the result restores that — a DSH_HOME using the
  // "wrong" slash for the platform still resolves to a native-separator
  // path. Select path.win32/path.posix explicitly by the resolved `platform`
  // rather than using the ambient `path` module, so this stays a pure
  // function of its arguments (testable for either platform on any host),
  // matching how dshPaths.js itself treats `platform`.
  const pathImpl = platform === 'win32' ? path.win32 : path.posix;
  return pathImpl.normalize(resolveDshSessionsDir({
    env: options.env || process.env,
    homeDir: options.homeDir || os.homedir(),
    platform
  }));
}

function dshSessionFiles(root) {
  const files = [];
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
      } else if (entry.isFile() && DSH_SESSION_LOG_NAMES.has(entry.name)) {
        files.push(path.join(dir, entry.name));
      }
    }
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

function decodeZstdBuffer(buffer, frames) {
  if (!zstdAvailable()) {
    const error = new Error('this Node.js build does not support Zstandard decompression');
    error.code = 'zstd-unsupported';
    throw error;
  }
  let text = '';
  for (const frame of frames || scanZstdFrames(buffer)) {
    text += zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
  }
  return text;
}

function decodeSessionText(filePath, buffer) {
  return filePath.endsWith('.jsonl.zstd') ? decodeZstdBuffer(buffer) : buffer.toString('utf8');
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
  return decodeZstdBuffer(buffer, [frame]);
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
    if (header) index.set(header.id, { filePath, createdAt: header.createdAt });
  }
  return index;
}

module.exports = {
  DSH_SESSION_DIR_DEPTH,
  DSH_SESSION_LOG_NAMES,
  decodeFirstFrameText,
  decodeSessionText,
  dshSessionFiles,
  indexDshSessionHeaders,
  readDshSessionHeader,
  resolveDshSessionsRoot,
  scanZstdFrames,
  zstdAvailable
};
