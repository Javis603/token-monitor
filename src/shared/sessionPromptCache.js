'use strict';

function count(value) {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function createPromptCacheState() {
  return { observation: undefined, previousMessage: '' };
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
    // Usage reports cache reuse, not a server-side expiration time. Clear the
    // former fixed estimate instead of manufacturing a deadline for any route.
    state.observation = null;
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
