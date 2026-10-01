'use strict';

// A product estimate for every Codex route, not a model or provider TTL claim.
const CODEX_ESTIMATE_TTL_SECONDS = 30 * 60;

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createPromptCacheState() {
  return { model: '', observation: undefined, previousUsage: '', previousMessage: '' };
}

// Fold an already decoded record; provider indexes own IO and retain this state.
function applyPromptCacheEntry(state, entry, client) {
  if (!entry || typeof entry !== 'object') return;
  const at = Date.parse(entry.timestamp || '');
  if (!Number.isFinite(at) || at <= 0) return;
  if (client === 'claude') {
    if (entry.isSidechain === true) return;
    if (entry.subtype === 'compact_boundary' || entry.isCompactSummary === true) {
      state.observation = null;
      state.previousMessage = '';
      return;
    }
    if (entry.type !== 'assistant') return;
    const message = entry.message;
    const usage = message?.usage;
    if (!usage || entry.isApiErrorMessage === true) return;
    // One streamed response can be persisted several times. Its first usage
    // timestamp is the least optimistic available response-time anchor.
    if (message.id && message.id === state.previousMessage) return;
    state.previousMessage = message.id || '';
    const iterations = Array.isArray(usage.iterations)
      ? usage.iterations.filter((item) => item?.type === 'message' || item?.type === 'fallback_message')
      : [];
    const measurement = iterations.length ? iterations[iterations.length - 1] : usage;
    const read = count(measurement.cache_read_input_tokens);
    const write = count(measurement.cache_creation_input_tokens);
    if (read === null || write === null || read + write === 0) {
      state.observation = null;
      return;
    }
    const tiers = measurement.cache_creation;
    const short = count(tiers?.ephemeral_5m_input_tokens);
    const long = count(tiers?.ephemeral_1h_input_tokens);
    // A read alone does not state its tier. Do not carry an earlier tier
    // through a billing/configuration change that this record cannot prove.
    const ttlSeconds = short > 0 ? 300 : long > 0 ? 3600 : 0;
    state.observation = ttlSeconds ? { observedAt: new Date(at).toISOString(), ttlSeconds } : null;
  } else if (client === 'codex') {
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') return;
    if (entry.type === 'turn_context') {
      if (state.model !== payload.model) state.observation = null;
      state.model = String(payload.model || '');
    }
    if (payload.type === 'context_compacted' || entry.type === 'compacted') {
      state.observation = null;
      state.previousUsage = '';
    }
    if (payload.type !== 'token_count' || !payload.info) return;
    const info = payload.info;
    const usage = info.last_token_usage;
    if (!usage || typeof usage !== 'object') return;
    // Quota-only token_count events repeat unchanged accounting; they are
    // not a new inference request and must not extend the estimate.
    const identity = JSON.stringify([info.total_token_usage, usage]);
    if (identity === state.previousUsage) return;
    state.previousUsage = identity;
    const read = count(usage.cached_input_tokens);
    const write = count(usage.cache_write_input_tokens ?? 0);
    state.observation = read !== null && write !== null && read + write > 0
      ? { observedAt: new Date(at).toISOString(), ttlSeconds: CODEX_ESTIMATE_TTL_SECONDS } : null;
  }
}

function promptCacheFromTranscript(text, client) {
  const state = createPromptCacheState();
  for (const line of text.split('\n')) {
    let entry;
    try { entry = JSON.parse(line); } catch (_) { continue; }
    applyPromptCacheEntry(state, entry, client);
  }
  return state.observation ?? null;
}

module.exports = { createPromptCacheState, applyPromptCacheEntry, promptCacheFromTranscript };
