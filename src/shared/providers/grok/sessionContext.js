// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { normalizeSessionContext } = require('../../sessionContext');

const UPDATES_TAIL_BUDGETS = [64 * 1024, 1024 * 1024];

/** @typedef {{ contextTokens: number, contextWindow: number }} SessionContext */

/** @type {Map<string, { stamp: string, contextTokens: number }>} */
const updatesContextCache = new Map();

/**
 * `updates.jsonl` grows to tens of megabytes; inspect only bounded trailing slices.
 *
 * @param {string} updatesPath
 * @param {Map<string, { stamp: string, contextTokens: number }>} [cache]
 * @returns {number}
 */
function readGrokUpdatesTokens(updatesPath, cache = updatesContextCache) {
  let stat;
  try {
    stat = fs.statSync(updatesPath);
  } catch (_) {
    return 0;
  }
  if (!stat.size) return 0;
  const stamp = `${stat.size}:${stat.mtimeMs}:${stat.ino ?? ''}`;
  const cached = cache.get(updatesPath);
  if (cached?.stamp === stamp) return cached.contextTokens;

  let fd;
  let tokens = 0;
  try {
    fd = fs.openSync(updatesPath, 'r');
    const fileSize = fs.fstatSync(fd).size;
    for (const budget of UPDATES_TAIL_BUDGETS) {
      const start = Math.max(0, fileSize - budget);
      const length = fileSize - start;
      const buffer = Buffer.allocUnsafe(length);
      let read = 0;
      while (read < length) {
        const chunk = fs.readSync(fd, buffer, read, length - read, start + read);
        if (chunk <= 0) break;
        read += chunk;
      }
      const text = buffer.subarray(0, read).toString('utf8');
      let cursor = text.length;
      while (cursor > 0) {
        const nl = text.lastIndexOf('\n', cursor - 1);
        const lineStart = nl === -1 ? 0 : nl + 1;
        if (start > 0 && lineStart === 0) break;
        const line = text.slice(lineStart, cursor).trim();
        cursor = nl;
        if (!line) continue;
        /** @type {any} */
        let parsed;
        try { parsed = JSON.parse(line); } catch (_) { continue; }
        const total = parsed?.params?._meta?.totalTokens;
        if (typeof total === 'number' && Number.isFinite(total) && total > 0) {
          tokens = Math.round(total);
          break;
        }
      }
      if (tokens > 0 || start === 0) break;
    }
    if (fileSize === stat.size) {
      if (cache.size >= 512 && !cache.has(updatesPath)) {
        const oldest = cache.keys().next().value;
        if (oldest !== undefined) cache.delete(oldest);
      }
      cache.set(updatesPath, { stamp, contextTokens: tokens });
    }
    return tokens;
  } catch (_) {
    return 0;
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

/**
 * @param {string} sessionDir
 * @param {unknown} contextWindowValue
 * @param {Record<string, any>} [deps]
 * @returns {SessionContext | null}
 */
function readGrokSessionContext(sessionDir, contextWindowValue, deps = {}) {
  const probe = normalizeSessionContext({ contextTokens: 1, contextWindow: contextWindowValue });
  if (!probe) return null;
  const contextTokens = readGrokUpdatesTokens(
    path.join(sessionDir, 'updates.jsonl'),
    deps.grokUpdatesCache
  );
  return normalizeSessionContext({
    contextTokens,
    contextWindow: probe.contextWindow
  });
}

module.exports = { readGrokSessionContext };
