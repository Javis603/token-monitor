'use strict';

const fs = require('node:fs');
const { isCompressedCodexTranscript, readCompressedCodexTranscript } = require('./transcript');
const MAX_HEADER_BYTES = 8 * 1024 * 1024;

// Like the rollout timestamp cache, retain only per-path fingerprints and IDs.
// A small LRU would churn on every serial all-time scan of a large history.
const identityCache = new Map();
function nativeIdForFile(file) {
  let fd;
  try {
    const stat = fs.lstatSync(file);
    if (!stat.isFile()) return '';
    const fingerprint = `${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}`;
    const cached = identityCache.get(file);
    if (cached?.fingerprint === fingerprint) return cached.id;
    if (isCompressedCodexTranscript(file)) {
      const bytes = readCompressedCodexTranscript(file);
      const newline = bytes.indexOf(10);
      const end = newline < 0 ? bytes.length : newline;
      const first = end <= MAX_HEADER_BYTES ? JSON.parse(bytes.subarray(0, end).toString('utf8')) : null;
      const id = first?.type === 'session_meta' && typeof first.payload?.id === 'string' ? first.payload.id : '';
      identityCache.set(file, { fingerprint, id });
      return id;
    }
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    // Instructions/tool definitions can make session_meta larger than a chunk.
    // Read only that complete first line, with a hard bound and no retained text.
    const chunks = [];
    let position = 0;
    let complete = false;
    while (position < MAX_HEADER_BYTES) {
      const buffer = Buffer.alloc(Math.min(64 * 1024, MAX_HEADER_BYTES - position));
      const bytes = fs.readSync(fd, buffer, 0, buffer.length, position);
      if (!bytes) { complete = true; break; }
      const newline = buffer.subarray(0, bytes).indexOf(10);
      chunks.push(buffer.subarray(0, newline >= 0 ? newline : bytes));
      position += bytes;
      if (newline >= 0 || position >= stat.size) { complete = true; break; }
    }
    const first = complete ? JSON.parse((chunks.length === 1 ? chunks[0] : Buffer.concat(chunks)).toString('utf8')) : null;
    const id = first?.type === 'session_meta' && typeof first.payload?.id === 'string' ? first.payload.id : '';
    identityCache.set(file, { fingerprint, id });
    return id;
  } catch (_) { return ''; }
  finally { if (fd !== undefined) fs.closeSync(fd); }
}

module.exports = { nativeIdForFile };
