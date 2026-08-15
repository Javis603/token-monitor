'use strict';

const { constants: fsConstants } = require('node:fs');
const fs = require('node:fs/promises');
const crypto = require('node:crypto');
const path = require('node:path');
const { MAC_WIDGET_ACTIVITY_DAYS } = require('../shared/macWidgetSnapshot');
const { isHistoryDocument } = require('./macWidgetHistory');

const MAC_WIDGET_HISTORY_CACHE_VERSION = 2;
const MAX_MAC_WIDGET_HISTORY_CACHE_BYTES = 256 * 1024;
const MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES = 8;
const MAC_WIDGET_HISTORY_CACHE_DESCRIPTION = 'macOS Widget history cache';
const CACHE_FILE_PATTERN = /^[a-f0-9]{64}\.json$/;

function safeLog(logger, message) {
  try { logger?.(message); } catch (_) {}
}

function maxCacheBytes(value) {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : MAX_MAC_WIDGET_HISTORY_CACHE_BYTES;
}

function maxCacheEntries(value) {
  return Number.isFinite(value)
    ? Math.max(1, Math.floor(value))
    : MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES;
}

function nonNegativeNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : 0;
}

function normalizedDay(value) {
  const day = String(value || '');
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return '';
  const timestamp = Date.parse(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(timestamp)) return '';
  return new Date(timestamp).toISOString().slice(0, 10) === day ? day : '';
}

function projectMacWidgetHistory(history) {
  const byDate = new Map();
  for (const entry of (Array.isArray(history?.daily) ? history.daily : [])) {
    const date = normalizedDay(entry?.date);
    if (!date) continue;
    byDate.set(date, {
      date,
      tokens: Math.round(nonNegativeNumber(entry?.tokens)),
      cost: nonNegativeNumber(entry?.cost)
    });
  }
  return {
    daily: Array.from(byDate.values())
      .sort((left, right) => left.date.localeCompare(right.date))
      .slice(-MAC_WIDGET_ACTIVITY_DAYS),
    monthly: [],
    summary: {}
  };
}

function macWidgetHistoryCacheFingerprint(sourceKey) {
  return crypto.createHash('sha256').update(String(sourceKey || '')).digest('hex');
}

function macWidgetHistoryCachePath(userDataPath, sourceKey) {
  const root = String(userDataPath || '').trim();
  if (!root) return null;
  return path.join(
    root,
    'mac-widget-history',
    `${macWidgetHistoryCacheFingerprint(sourceKey)}.json`
  );
}

function cacheDocument(sourceKey, history) {
  return {
    version: MAC_WIDGET_HISTORY_CACHE_VERSION,
    source: macWidgetHistoryCacheFingerprint(sourceKey),
    daily: projectMacWidgetHistory(history).daily
  };
}

function cacheHistory(document, sourceKey) {
  if (
    document?.version !== MAC_WIDGET_HISTORY_CACHE_VERSION
    || document.source !== macWidgetHistoryCacheFingerprint(sourceKey)
    || !Array.isArray(document.daily)
    || document.daily.length > MAC_WIDGET_ACTIVITY_DAYS
  ) return null;

  const seen = new Set();
  for (const day of document.daily) {
    if (
      normalizedDay(day?.date) !== day.date
      || !Number.isInteger(day.tokens)
      || day.tokens < 0
      || typeof day.cost !== 'number'
      || !Number.isFinite(day.cost)
      || day.cost < 0
      || seen.has(day.date)
    ) return null;
    seen.add(day.date);
  }
  return {
    daily: document.daily
      .map((day) => ({ date: day.date, tokens: day.tokens, cost: day.cost }))
      .sort((left, right) => left.date.localeCompare(right.date)),
    monthly: [],
    summary: {}
  };
}

async function readBoundedRegularFileNoFollow(filePath, options = {}) {
  const fsApi = options.fs || fs;
  const constants = options.constants || fsConstants;
  const description = options.description || 'File';
  const noFollow = constants.O_NOFOLLOW || 0;
  const limit = maxCacheBytes(options.maxBytes);
  const platform = options.platform || process.platform;
  let handle = null;
  let pathStat = null;
  try {
    if (!noFollow) {
      pathStat = await fsApi.lstat(filePath);
      if (!pathStat.isFile() || pathStat.isSymbolicLink()) {
        throw new Error(`${description} must be a regular file`);
      }
    }
    handle = await fsApi.open(filePath, constants.O_RDONLY | noFollow);
    const descriptorStat = await handle.stat();
    if (!descriptorStat.isFile()) throw new Error(`${description} must be a regular file`);
    if (descriptorStat.size > limit) throw new Error(`${description} exceeds ${limit} bytes`);
    if (pathStat && (pathStat.dev !== descriptorStat.dev || pathStat.ino !== descriptorStat.ino)) {
      throw new Error(`${description} changed while it was being opened`);
    }
    if (options.mode !== undefined && platform !== 'win32') {
      await handle.chmod(options.mode);
    }

    const expectedSize = descriptorStat.size;
    const buffer = Buffer.allocUnsafe(Math.min(limit + 1, expectedSize + 1));
    let offset = 0;
    while (offset < buffer.length) {
      const result = await handle.read(buffer, offset, buffer.length - offset, null);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    if (offset > limit) throw new Error(`${description} exceeds ${limit} bytes`);
    if (offset > expectedSize) throw new Error(`${description} changed while it was being read`);
    return buffer.subarray(0, offset).toString('utf8');
  } catch (error) {
    if (error?.code === 'ELOOP') {
      const symlinkError = new Error(`${description} must be a regular file`);
      symlinkError.cause = error;
      throw symlinkError;
    }
    throw error;
  } finally {
    try { await handle?.close(); } catch (_) {}
  }
}

async function writePrivateBufferAtomic(filePath, serialized, options = {}) {
  const fsApi = options.fs || fs;
  const constants = options.constants || fsConstants;
  const platform = options.platform || process.platform;
  const directory = path.dirname(filePath);
  const randomId = (options.randomUUID || crypto.randomUUID)();
  const temporary = `${filePath}.${process.pid}.${randomId}.tmp`;
  let handle = null;
  let directoryHandle = null;
  let renamed = false;
  await fsApi.mkdir(directory, { recursive: true, mode: 0o700 });
  if (platform !== 'win32') await fsApi.chmod(directory, 0o700);
  try {
    handle = await fsApi.open(temporary, 'wx', 0o600);
    await handle.writeFile(serialized);
    if (platform !== 'win32') await handle.chmod(0o600);
    await handle.sync();
    await handle.close();
    handle = null;
    await fsApi.rename(temporary, filePath);
    renamed = true;
    if (platform !== 'win32') {
      directoryHandle = await fsApi.open(directory, constants.O_RDONLY);
      await directoryHandle.sync();
      await directoryHandle.close();
      directoryHandle = null;
    }
  } catch (error) {
    if (renamed) error.atomicWriteCommitted = true;
    try { await handle?.close(); } catch (_) {}
    try { await directoryHandle?.close(); } catch (_) {}
    try { await fsApi.rm(temporary, { force: true }); } catch (_) {}
    throw error;
  }
}

async function pruneMacWidgetHistoryCaches(cachePath, options = {}) {
  const fsApi = options.fs || fs;
  const logger = options.logger;
  const directory = path.dirname(cachePath);
  try {
    const entries = await fsApi.readdir(directory, { withFileTypes: true });
    const candidates = [];
    for (const entry of entries) {
      if (!CACHE_FILE_PATTERN.test(entry.name)) continue;
      const filePath = path.join(directory, entry.name);
      try {
        const stat = await fsApi.lstat(filePath);
        if (!stat.isFile()) continue;
        candidates.push({ filePath, mtimeMs: stat.mtimeMs });
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    candidates.sort((left, right) => {
      if (left.filePath === cachePath) return -1;
      if (right.filePath === cachePath) return 1;
      return right.mtimeMs - left.mtimeMs || left.filePath.localeCompare(right.filePath);
    });
    for (const candidate of candidates.slice(maxCacheEntries(options.maxEntries))) {
      try {
        await fsApi.unlink(candidate.filePath);
      } catch (error) {
        if (error?.code !== 'ENOENT') {
          safeLog(logger, `[mac-widget] history cache cleanup failed: ${error?.message || error}`);
        }
      }
    }
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      safeLog(logger, `[mac-widget] history cache cleanup failed: ${error?.message || error}`);
    }
  }
}

async function readMacWidgetHistoryCache(cachePath, sourceKey, options = {}) {
  try {
    const raw = await readBoundedRegularFileNoFollow(cachePath, {
      ...options,
      description: MAC_WIDGET_HISTORY_CACHE_DESCRIPTION,
      mode: 0o600
    });
    return cacheHistory(JSON.parse(raw), sourceKey);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      safeLog(options.logger, `[mac-widget] history cache read failed: ${error?.message || error}`);
    }
    return null;
  }
}

async function writeMacWidgetHistoryCache(cachePath, sourceKey, history, options = {}) {
  if (!cachePath || !isHistoryDocument(history)) return;
  const document = cacheDocument(sourceKey, history);
  const stringify = options.stringify || JSON.stringify;
  const serialized = Buffer.from(`${stringify(document)}\n`, 'utf8');
  const limit = maxCacheBytes(options.maxBytes);
  if (serialized.byteLength > limit) {
    throw new Error(`${MAC_WIDGET_HISTORY_CACHE_DESCRIPTION} exceeds ${limit} bytes`);
  }
  await writePrivateBufferAtomic(cachePath, serialized, options);
  await pruneMacWidgetHistoryCaches(cachePath, options);
}

module.exports = {
  MAC_WIDGET_HISTORY_CACHE_VERSION,
  MAX_MAC_WIDGET_HISTORY_CACHE_BYTES,
  MAX_MAC_WIDGET_HISTORY_CACHE_ENTRIES,
  macWidgetHistoryCacheFingerprint,
  macWidgetHistoryCachePath,
  projectMacWidgetHistory,
  readMacWidgetHistoryCache,
  writeMacWidgetHistoryCache
};
