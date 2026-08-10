'use strict';

const crypto = require('node:crypto');
const path = require('node:path');
const { coerceHistory } = require('../shared/history');
const {
  readRegularFileNoFollow,
  writePrivateJsonAtomic
} = require('../shared/credentialStore');
const { isHistoryDocument } = require('./macWidgetHistory');

const MAC_WIDGET_HISTORY_CACHE_VERSION = 1;
// History is bounded by day count but the lifetime monthly rollup is not. Keep
// the persisted fallback large enough for normal long-lived hubs while making
// a corrupt or hostile file unable to consume unbounded main-process memory.
const MAX_MAC_WIDGET_HISTORY_CACHE_BYTES = 4 * 1024 * 1024;
const MAC_WIDGET_HISTORY_CACHE_DESCRIPTION = 'macOS Widget history cache';

function maxCacheBytes(value) {
  return Number.isFinite(value)
    ? Math.max(0, Math.floor(value))
    : MAX_MAC_WIDGET_HISTORY_CACHE_BYTES;
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
    history: coerceHistory(history)
  };
}

function cacheDocumentBytes(document) {
  return Buffer.byteLength(`${JSON.stringify(document, null, 2)}\n`, 'utf8');
}

function readMacWidgetHistoryCache(cachePath, sourceKey, options = {}) {
  const readPrivateFile = options.readRegularFileNoFollow || readRegularFileNoFollow;
  try {
    const raw = readPrivateFile(cachePath, {
      ...(options.fs ? { fs: options.fs } : {}),
      description: MAC_WIDGET_HISTORY_CACHE_DESCRIPTION,
      encoding: 'utf8',
      mode: 0o600,
      maxBytes: maxCacheBytes(options.maxBytes)
    });
    const document = JSON.parse(raw);
    if (
      document?.version !== MAC_WIDGET_HISTORY_CACHE_VERSION
      || document.source !== macWidgetHistoryCacheFingerprint(sourceKey)
      || !isHistoryDocument(document.history)
    ) return null;
    return coerceHistory(document.history);
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      try { options.logger?.(`[mac-widget] history cache read failed: ${error?.message || error}`); } catch (_) {}
    }
    return null;
  }
}

function writeMacWidgetHistoryCache(cachePath, sourceKey, history, options = {}) {
  if (!cachePath || !isHistoryDocument(history)) return;
  const document = cacheDocument(sourceKey, history);
  const limit = maxCacheBytes(options.maxBytes);
  if (cacheDocumentBytes(document) > limit) {
    throw new Error(`${MAC_WIDGET_HISTORY_CACHE_DESCRIPTION} exceeds ${limit} bytes`);
  }
  const writePrivateFile = options.writePrivateJsonAtomic || writePrivateJsonAtomic;
  writePrivateFile(cachePath, document, options.fs ? { fs: options.fs } : {});
}

module.exports = {
  MAC_WIDGET_HISTORY_CACHE_VERSION,
  MAX_MAC_WIDGET_HISTORY_CACHE_BYTES,
  macWidgetHistoryCacheFingerprint,
  macWidgetHistoryCachePath,
  readMacWidgetHistoryCache,
  writeMacWidgetHistoryCache
};
