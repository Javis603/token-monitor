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
 * Path resolution mirrors `dshPaths.js` (`DSH_HOME` env override, falling
 * back to `~/.dsh`). That module is Node-builtin-free so it can vendor into
 * the Worker; this one is Electron/agent-only (session detail is never
 * served by the Worker), so it uses `node:path`/`node:os` directly. Once the
 * usage-tracking PR that introduces `dshPaths.js` lands, this resolver should
 * be replaced with an import of its `resolveDshSessionsDir`.
 */

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');

const DSH_HOME_DIR_NAME = '.dsh';
const DSH_SESSION_LOG_NAMES = new Set(['session.jsonl', 'session.jsonl.zstd']);
const DSH_SESSION_DIR_DEPTH = 2; // <root>/<project>/<session>/<artifact>
const ZSTD_MAGIC = 0xFD2FB528;

function resolveDshSessionsRoot(options = {}) {
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const dshHome = String(env.DSH_HOME || '').trim();
  const base = dshHome ? dshHome : path.join(homeDir, DSH_HOME_DIR_NAME);
  return path.join(base, 'sessions');
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

function decodeZstdBuffer(buffer) {
  if (!zstdAvailable()) {
    const error = new Error('this Node.js build does not support Zstandard decompression');
    error.code = 'zstd-unsupported';
    throw error;
  }
  let text = '';
  for (const frame of scanZstdFrames(buffer)) {
    text += zlib.zstdDecompressSync(buffer.subarray(frame.start, frame.end)).toString('utf8');
  }
  return text;
}

function decodeSessionText(filePath, buffer) {
  return filePath.endsWith('.jsonl.zstd') ? decodeZstdBuffer(buffer) : buffer.toString('utf8');
}

module.exports = {
  DSH_SESSION_DIR_DEPTH,
  DSH_SESSION_LOG_NAMES,
  decodeSessionText,
  dshSessionFiles,
  resolveDshSessionsRoot,
  scanZstdFrames,
  zstdAvailable
};
