'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tokscaleConfigDir } = require('./tokscaleConfig');

const CATALOG_FILES = ['pricing-litellm.json', 'pricing-openrouter.json', 'pricing-models-dev.json'];
const FRESH_MS = 60 * 60 * 1000;
// Catalogs are large (tens of MB together). The refresher only needs their
// timestamp, so remember the parsed value until the file identity on disk
// changes instead of re-reading and re-parsing every check.
const catalogFreshness = new Map();
// Every catalog writer emits `{"timestamp":…,"data":{…}}`, so the fields the
// freshness check needs are in the first few bytes. Reading a bounded prefix
// avoids turning a 9 MB catalog into a V8 object graph just to read one number.
const CATALOG_PREFIX_BYTES = 4096;
const CATALOG_TIMESTAMP_PREFIX = /^\s*\{\s*"timestamp"\s*:\s*(-?\d+(?:\.\d+)?)\s*,\s*"data"\s*:\s*\{/;

function catalogTimestampFromPrefix(file) {
  const prefix = Buffer.alloc(CATALOG_PREFIX_BYTES);
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const read = fs.readSync(fd, prefix, 0, prefix.length, 0);
    const match = CATALOG_TIMESTAMP_PREFIX.exec(prefix.toString('utf8', 0, read));
    if (!match) return null;
    const timestamp = Number(match[1]);
    return Number.isFinite(timestamp) ? timestamp : null;
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

function catalogPaths(options = {}) {
  return CATALOG_FILES.map(name => path.join(tokscaleConfigDir(options), 'cache', name));
}

// Disk catalogs are shared by main and the usage worker. Include replacement
// identity so a background refresh invalidates both price caches and anchors.
function catalogRevision(options = {}) {
  return catalogPaths(options).map(file => {
    try {
      const stat = fs.statSync(file);
      return [file, stat.size, stat.mtimeMs, stat.ctimeMs];
    } catch (_) { return [file, 'missing']; }
  });
}

function catalogsFresh(options, now) {
  return catalogPaths(options).every(file => {
    try {
      const stat = fs.statSync(file);
      const key = [stat.size, stat.mtimeMs, stat.ctimeMs].join(':');
      const cached = catalogFreshness.get(file);
      let timestamp;
      if (cached?.key === key) {
        timestamp = cached.timestamp;
      } else {
        timestamp = catalogTimestampFromPrefix(file);
        if (timestamp === null) {
          // An unexpected layout keeps the full parse as the correctness
          // fallback; it can still be cached by the same file identity.
          const value = JSON.parse(fs.readFileSync(file, 'utf8'));
          if (!value?.data || !Number.isFinite(value.timestamp)) {
            catalogFreshness.delete(file);
            return false;
          }
          timestamp = value.timestamp;
        }
        catalogFreshness.set(file, { key, timestamp });
      }
      return timestamp * 1000 <= now && now - timestamp * 1000 < FRESH_MS;
    } catch (_) {
      // A missing or unreadable file cannot stay cached: the next check must
      // see a replacement that appears between calls.
      catalogFreshness.delete(file);
      return false;
    }
  });
}

function createPricingCatalogRefresher(options, timers = {}) {
  const later = timers.setTimeout || setTimeout;
  const cancel = timers.clearTimeout || clearTimeout;
  const now = timers.now || Date.now;
  const random = timers.random || Math.random;
  let timer = null;
  let running = null;
  let stopped = false;
  let failures = 0;

  function arm(delay) {
    if (stopped) return;
    timer = later(run, delay);
    timer?.unref?.();
  }

  function run() {
    timer = null;
    if (stopped || running) return;
    if (catalogsFresh(options, now())) { arm(60_000); return; }
    const before = JSON.stringify(catalogRevision(options));
    running = Promise.resolve().then(options.refresh).then(() => {
      failures = 0;
    }).catch(error => {
      failures += 1;
      options.onError?.(error);
    }).then(async () => {
      // A partially successful refresh may replace one source even when the
      // command fails. Those prices must also invalidate the current snapshot.
      if (!stopped && before !== JSON.stringify(catalogRevision(options))) await options.onUpdate();
    }).catch(error => {
      options.onError?.(error);
    }).finally(() => {
      running = null;
      const retry = Math.min(30 * 60_000, 5 * 60_000 * 2 ** Math.min(failures - 1, 3));
      arm(failures ? retry * (1 + random() * 0.2) : 60_000);
    });
  }

  return {
    start() { if (!stopped && !running && timer === null) arm(0); },
    stop() { stopped = true; if (timer !== null) cancel(timer); timer = null; },
    whenIdle() { return running || Promise.resolve(); }
  };
}

module.exports = { catalogRevision, catalogsFresh, createPricingCatalogRefresher };
