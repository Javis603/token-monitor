'use strict';

const fs = require('node:fs');
const path = require('node:path');

const FIRST_READ_BYTES = 64 * 1024;
const MAX_SCAN_LINES = 8;

function sessionHeaderMatches(filePath, sessionId, fsApi) {
  let fd;
  try {
    fd = fsApi.openSync(filePath, 'r');
    const buffer = Buffer.alloc(FIRST_READ_BYTES);
    const bytesRead = fsApi.readSync(fd, buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return false;
    const chunk = buffer.subarray(0, bytesRead);
    let start = 0;
    let lines = 0;
    while (start < chunk.length && lines < MAX_SCAN_LINES) {
      const newline = chunk.indexOf(0x0a, start);
      const end = newline === -1 ? chunk.length : newline;
      const raw = chunk.subarray(start, end);
      start = newline === -1 ? chunk.length : newline + 1;
      if (raw.length === 0) continue;
      lines += 1;
      let record;
      try { record = JSON.parse(raw.toString('utf8')); } catch (_) { return false; }
      if (record?.type === 'title') continue;
      if (record?.type === 'session') return String(record.id) === sessionId;
    }
  } catch (_) {
    return false;
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) {}
    }
  }
  return false;
}

function findOmpSubagentSessionFile(root, sessionId, options = {}) {
  const rootDir = String(root || '');
  if (!rootDir) return '';
  const fsApi = options.fs || fs;
  let found = '';

  function walk(dir, depth) {
    if (found) return;
    let entries;
    try { entries = fsApi.readdirSync(dir, { withFileTypes: true }); } catch (_) { return; }
    for (const entry of entries) {
      if (found) return;
      const filePath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(filePath, depth + 1);
      } else if (
        depth >= 2
        && entry.isFile()
        && entry.name.endsWith('.jsonl')
        && sessionHeaderMatches(filePath, sessionId, fsApi)
      ) {
        found = filePath;
        return;
      }
    }
  }

  walk(rootDir, 0);
  return found;
}

module.exports = { findOmpSubagentSessionFile };
