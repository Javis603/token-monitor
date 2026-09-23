'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');

// Tokscale's Cursor JSON cache holds every usage event with its millisecond
// timestamp, its tokens and the conversation it belongs to, which is exactly
// what a legacy CSV row lacks. Tokscale reads `<home>/.config/tokscale/
// cursor-cache` regardless of TOKSCALE_CONFIG_DIR (see clientSourceRoots in
// collector.js), and moves a removed account's cache into its `archive/`.

function cursorCacheDir(options = {}) {
  return path.join(tokscaleHomeDir(options), '.config', 'tokscale', 'cursor-cache');
}

// tokscale `account_id_from_cursor_cache_path`, for the live cache files only.
function accountIdForCacheFile(fileName) {
  if (fileName === 'usage.json') return 'active';
  const stem = fileName.slice('usage.'.length, -'.json'.length).replace(/[^A-Za-z0-9._-]/g, '-');
  return stem || 'unknown';
}

function millisecondTimestamp(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? Math.trunc(value) : 0;
  const text = String(value ?? '').trim();
  if (/^-?\d+$/.test(text)) return Number(text);
  const parsed = Date.parse(text);
  return Number.isFinite(parsed) ? parsed : 0;
}

function tokenCount(value) {
  const number = Number(value);
  return Number.isFinite(number) ? Math.max(0, Math.trunc(number)) : 0;
}

// The session tokscale assigns an event: its conversation, or the per-account,
// per-UTC-day fallback when the event has none. An archived cache file no longer
// carries the account name tokscale derived that fallback from, so its
// conversation-less events are left out rather than guessed.
function sessionIdFor(event, accountId, time) {
  const conversationId = String(event?.conversationId ?? '').trim();
  if (conversationId) return conversationId;
  if (!accountId) return null;
  return `cursor-${accountId}-${new Date(time).toISOString().slice(0, 10)}`;
}

function cacheFiles(dir, fsImpl) {
  const files = [];
  const add = (folder, archived, pattern) => {
    let names;
    try {
      names = fsImpl.readdirSync(folder);
    } catch (_) {
      return;
    }
    for (const name of names) {
      if (!pattern.test(name)) continue;
      const filePath = path.join(folder, name);
      try {
        const stat = fsImpl.statSync(filePath);
        if (stat.isFile()) files.push({ filePath, name, archived, signature: `${filePath}:${stat.size}:${stat.mtimeMs}` });
      } catch (_) {}
    }
  };
  // Tokscale scans exactly these names in the live directory; archived copies
  // carry a label and a timestamp instead.
  add(dir, false, /^usage(?:\.[^/\\]+)?\.json$/);
  add(path.join(dir, 'archive'), true, /^usage.*\.json$/);
  return files.sort((left, right) => left.filePath.localeCompare(right.filePath));
}

// Returns `{ signature, sessionsAt(time, totalTokens) }`. The signature changes
// whenever a cache file is added, removed or rewritten, so a caller can skip a
// lookup that cannot answer differently from its last attempt.
function createCursorUsageEventIndex(options = {}) {
  const fsImpl = options.fs || fs;
  let cached = null;

  return function readCursorUsageEvents() {
    const files = cacheFiles(options.cacheDir || cursorCacheDir(options), fsImpl);
    const signature = files.map((file) => file.signature).join('\n');
    if (cached?.signature === signature) return cached;

    const byTime = new Map();
    for (const file of files) {
      let rows;
      try {
        rows = JSON.parse(fsImpl.readFileSync(file.filePath, 'utf8'))?.usageEventsDisplay;
      } catch (_) {
        continue;
      }
      if (!Array.isArray(rows)) continue;
      const accountId = file.archived ? null : accountIdForCacheFile(file.name);
      for (const event of rows) {
        const time = millisecondTimestamp(event?.timestamp);
        if (!time || !String(event?.model ?? '').trim()) continue;
        const sessionId = sessionIdFor(event, accountId, time);
        if (!sessionId) continue;
        const usage = event.tokenUsage || {};
        const totalTokens = tokenCount(usage.inputTokens) + tokenCount(usage.outputTokens)
          + tokenCount(usage.cacheReadTokens) + tokenCount(usage.cacheWriteTokens);
        if (!byTime.has(time)) byTime.set(time, []);
        byTime.get(time).push({ sessionId, totalTokens });
      }
    }

    cached = {
      signature,
      sessionsAt(time, totalTokens) {
        return [...new Set((byTime.get(time) || [])
          .filter((event) => event.totalTokens === totalTokens)
          .map((event) => event.sessionId))];
      }
    };
    return cached;
  };
}

module.exports = { createCursorUsageEventIndex, cursorCacheDir };
