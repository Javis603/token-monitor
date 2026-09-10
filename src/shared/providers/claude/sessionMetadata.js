'use strict';

const fs = require('node:fs');

const TITLE_MAX_CODE_POINTS = 96;
const TITLE_SCAN_BYTES = 256 * 1024;
const titleCache = new Map();

function cleanTitle(value) {
  const text = String(value || '').replace(/\s+/g, ' ').trim();
  const chars = Array.from(text);
  return chars.length <= TITLE_MAX_CODE_POINTS
    ? text
    : `${chars.slice(0, TITLE_MAX_CODE_POINTS - 1).join('')}…`;
}

function titleFromChunks(chunks) {
  let aiTitle = '';
  let customTitle = '';
  for (const chunk of chunks) {
    const lines = chunk.text.split(/\r?\n/);
    if (chunk.dropFirstPartial) lines.shift();
    if (chunk.dropLastPartial) lines.pop();
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const entry = JSON.parse(line);
        if (entry?.type === 'custom-title') {
          const candidate = cleanTitle(entry.customTitle);
          if (candidate) customTitle = candidate;
        } else if (entry?.type === 'ai-title') {
          const candidate = cleanTitle(entry.aiTitle);
          if (candidate) aiTitle = candidate;
        }
      } catch (_) { /* skip partial or unrelated lines */ }
    }
  }
  return customTitle || aiTitle;
}

function readSessionTitle(filePath, deps = {}) {
  const file = String(filePath || '');
  if (!file) return '';
  const cache = deps.cache || titleCache;
  const fsApi = deps.fs || fs;
  let fd;
  try {
    const stat = fsApi.statSync(file);
    const fingerprint = `${stat.size}:${stat.mtimeMs}`;
    const cached = cache.get(file);
    if (cached?.fingerprint === fingerprint) return cached.title;

    fd = fsApi.openSync(file, 'r');
    const chunks = [];
    if (stat.size <= TITLE_SCAN_BYTES * 2) {
      const buffer = Buffer.alloc(stat.size);
      fsApi.readSync(fd, buffer, 0, stat.size, 0);
      chunks.push({ text: buffer.toString('utf8'), dropFirstPartial: false, dropLastPartial: false });
    } else {
      const head = Buffer.alloc(TITLE_SCAN_BYTES);
      const tail = Buffer.alloc(TITLE_SCAN_BYTES);
      fsApi.readSync(fd, head, 0, TITLE_SCAN_BYTES, 0);
      fsApi.readSync(fd, tail, 0, TITLE_SCAN_BYTES, stat.size - TITLE_SCAN_BYTES);
      chunks.push({ text: head.toString('utf8'), dropFirstPartial: false, dropLastPartial: true });
      chunks.push({ text: tail.toString('utf8'), dropFirstPartial: true, dropLastPartial: false });
    }
    const title = titleFromChunks(chunks);
    cache.set(file, { fingerprint, title });
    return title;
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fsApi.closeSync(fd); } catch (_) {}
    }
  }
}

module.exports = {
  TITLE_MAX_CODE_POINTS,
  TITLE_SCAN_BYTES,
  cleanTitle,
  readSessionTitle
};
