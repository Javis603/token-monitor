'use strict';

const fs = require('node:fs');

// Read only recent transcripts, with a bounded tail and one stat on unchanged
// files. These are observations of cache activity, not server expiry receipts.
const READ_WINDOW_MS = 60 * 60 * 1000;
const TAIL_BYTES = 1024 * 1024;
// A display estimate for every Codex route, not a model or provider TTL claim.
const CODEX_ESTIMATE_TTL_SECONDS = 30 * 60;
const cache = new Map();

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function promptCacheFromTranscript(text, client) {
  let model = '';
  let observation = null;
  let previousUsage = '';
  let previousMessage = '';
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    const at = Date.parse(entry.timestamp || '');
    if (!Number.isFinite(at) || at <= 0) continue;
    if (client === 'claude') {
      if (entry.isSidechain === true) continue;
      if (entry.subtype === 'compact_boundary' || entry.isCompactSummary === true) {
        observation = null;
        previousMessage = '';
        continue;
      }
      if (entry.type !== 'assistant') continue;
      const message = entry.message;
      const usage = message?.usage;
      if (!usage || entry.isApiErrorMessage === true) continue;
      // One streamed response can be persisted several times. Its first usage
      // timestamp is the least optimistic available response-time anchor.
      if (message.id && message.id === previousMessage) continue;
      previousMessage = message.id || '';
      const iterations = Array.isArray(usage.iterations)
        ? usage.iterations.filter((item) => item?.type === 'message' || item?.type === 'fallback_message')
        : [];
      const measurement = iterations.length ? iterations[iterations.length - 1] : usage;
      const read = count(measurement.cache_read_input_tokens);
      const write = count(measurement.cache_creation_input_tokens);
      if (read === null || write === null || read + write === 0) {
        observation = null;
        continue;
      }
      const tiers = measurement.cache_creation;
      const short = count(tiers?.ephemeral_5m_input_tokens);
      const long = count(tiers?.ephemeral_1h_input_tokens);
      // A read alone does not state its tier. Do not carry an earlier tier
      // through a billing/configuration change that this record cannot prove.
      const ttlSeconds = short > 0 ? 300 : long > 0 ? 3600 : 0;
      observation = ttlSeconds ? { observedAt: new Date(at).toISOString(), ttlSeconds } : null;
    } else if (client === 'codex') {
      const payload = entry.payload;
      if (!payload || typeof payload !== 'object') continue;
      if (entry.type === 'turn_context') {
        if (model !== payload.model) observation = null;
        model = String(payload.model || '');
      }
      if (payload.type === 'context_compacted' || entry.type === 'compacted') {
        observation = null;
        previousUsage = '';
      }
      if (payload.type !== 'token_count' || !payload.info) continue;
      const info = payload.info;
      const usage = info.last_token_usage;
      if (!usage || typeof usage !== 'object') continue;
      // Quota-only token_count events repeat unchanged accounting; they are
      // not a new inference request and must not extend the estimate.
      const identity = JSON.stringify([info.total_token_usage, usage]);
      if (identity === previousUsage) continue;
      previousUsage = identity;
      const read = count(usage.cached_input_tokens);
      const write = count(usage.cache_write_input_tokens ?? 0);
      observation = read !== null && write !== null && read + write > 0
        ? { observedAt: new Date(at).toISOString(), ttlSeconds: CODEX_ESTIMATE_TTL_SECONDS } : null;
    }
  }
  return observation;
}

function readSessionPromptCache(filePath, client, now = Date.now()) {
  let fd;
  try {
    const stat = fs.statSync(filePath);
    if (stat.mtimeMs < now - READ_WINDOW_MS) return null;
    const fingerprint = `${client}:${stat.dev}:${stat.ino}:${stat.size}:${stat.mtimeMs}`;
    const cached = cache.get(filePath);
    if (cached?.fingerprint === fingerprint) return cached.value;
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(stat.size, TAIL_BYTES);
    const bytes = Buffer.alloc(length);
    fs.readSync(fd, bytes, 0, length, stat.size - length);
    const text = bytes.toString('utf8');
    const value = promptCacheFromTranscript(text, client);
    if (cache.size >= 512) cache.delete(cache.keys().next().value);
    cache.set(filePath, { fingerprint, value });
    return value;
  } catch (_) {
    return null;
  } finally {
    if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
  }
}

module.exports = { promptCacheFromTranscript, readSessionPromptCache };
