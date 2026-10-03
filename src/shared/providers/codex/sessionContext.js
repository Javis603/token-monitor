'use strict';

/**
 * Codex reports its own context window, so this reader never estimates one.
 *
 * Every turn appends a `token_count` event to the rollout transcript carrying
 * `info.model_context_window` (the window Codex is actually running with, which
 * is a per-session fact — `config.toml` can raise it, so a model-name table
 * would be wrong for exactly the sessions users care about) and
 * `info.last_token_usage` (the most recent request's usage, i.e. what the
 * window currently holds). `total_token_usage` beside it is the session's
 * cumulative spend and is deliberately not used here: it exceeds the window on
 * any long session.
 *
 * Codex's own TUI subtracts a fixed baseline allowance from both sides before
 * turning this into a percentage, so its "% left" reads a little lower than
 * the raw ratio here. We report what the transcript states and let the UI
 * derive the ratio, rather than reproducing an undocumented constant that
 * would silently rot.
 */

const fs = require('node:fs');
const { normalizeSessionContext } = require('../../sessionContext');
const { createPromptCacheState, applyPromptCacheEntry } = require('../../sessionPromptCache');

const TAIL_READ_BUDGETS = [256 * 1024, 1024 * 1024];
const TURN_READ_MAX_BYTES = 8 * 1024 * 1024;
const MAX_METADATA_LINE_BYTES = 64 * 1024;
const stateCache = new Map();

function contextFromInfo(info) {
  const usage = info.last_token_usage || info.lastTokenUsage;
  return normalizeSessionContext({
    contextTokens: usage && typeof usage === 'object'
      ? (usage.total_tokens ?? usage.totalTokens) : 0,
    contextWindow: info.model_context_window ?? info.modelContextWindow ?? info.context_window ?? info.contextWindow
  });
}

function applyLine(state, line, position, contextStart, cacheStart) {
  // Metadata records are small; never decode arbitrarily large tool output.
  if (!line.length || line.length > MAX_METADATA_LINE_BYTES) return;
  let entry;
  try { entry = JSON.parse(line.toString('utf8')); } catch (_) { return; }
  if (!entry || typeof entry !== 'object') return;
  const payload = entry.payload && typeof entry.payload === 'object' ? entry.payload : entry;
  if (payload.type === 'token_count' && payload.info && position >= contextStart) {
    const context = contextFromInfo(payload.info);
    if (context) state.context = context;
  }
  if (payload.type === 'task_complete' || payload.type === 'turn_aborted') state.turnEnded = true;
  else if (payload.type === 'task_started') state.turnEnded = false;
  if (position >= cacheStart) applyPromptCacheEntry(state.promptCacheState, entry, 'codex');
}

function consumeBytes(state, chunk, start, contextStart, cacheStart) {
  const prefix = state.trailing;
  const bytes = prefix.length ? Buffer.concat([prefix, chunk]) : chunk;
  const base = start - prefix.length;
  let lineStart = 0;
  for (let index = 0; index < bytes.length; index += 1) {
    if (bytes[index] !== 0x0a) continue;
    if (!state.droppingLine) applyLine(state, bytes.subarray(lineStart, index), base + lineStart, contextStart, cacheStart);
    state.droppingLine = false;
    lineStart = index + 1;
  }
  const remainder = bytes.subarray(lineStart);
  if (state.droppingLine || remainder.length > MAX_METADATA_LINE_BYTES) {
    state.trailing = Buffer.alloc(0);
    state.droppingLine = true;
  } else state.trailing = Buffer.from(remainder);
}

// Context, boundary and cache share one decoded index. Append-only updates read
// only new bytes and carry accounting identity across scans; a duplicate cannot
// restart the cache clock after its original record leaves the initial tail.
function readCodexSessionState(filePath, deps = {}) {
  const cache = deps.cache || stateCache;
  const fsApi = deps.fs || fs;
  let fd;
  try {
    const stat = fsApi.statSync(filePath);
    const identity = `${stat.dev}:${stat.ino}`;
    const cached = cache.get(filePath);
    if (cached?.identity === identity && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached;
    const appendOnly = cached?.identity === identity && stat.size > cached.size;
    const state = appendOnly ? { ...cached, promptCacheState: { ...cached.promptCacheState } }
      : { context: null, turnEnded: undefined, promptCacheState: createPromptCacheState(), trailing: Buffer.alloc(0), droppingLine: false };
    fd = fsApi.openSync(filePath, 'r');
    let start;
    const chunks = [];
    if (appendOnly) {
      start = cached.size;
    } else {
      // Widen only for an absent turn boundary. Each earlier segment is read
      // once; occupancy and cache still use the newest 1 MiB only.
      start = stat.size;
      let boundaryFound = false;
      while (start > 0 && stat.size - start < TURN_READ_MAX_BYTES) {
        const length = Math.min(chunks.length ? TAIL_READ_BUDGETS[0] : TAIL_READ_BUDGETS[1], start);
        start -= length;
        const bytes = Buffer.alloc(length);
        const read = fsApi.readSync(fd, bytes, 0, length, start);
        if (read !== length) throw new Error('Incomplete transcript read');
        chunks.unshift(bytes);
        const boundaryText = Buffer.concat([bytes, chunks[1]?.subarray(0, 128) || Buffer.alloc(0)]).toString('utf8');
        boundaryFound = /"type"\s*:\s*"(?:task_complete|task_started|turn_aborted)"/.test(boundaryText) || boundaryFound;
        if (stat.size - start >= TAIL_READ_BUDGETS[1] && boundaryFound) break;
      }
      state.droppingLine = start > 0;
    }
    const contextStart = appendOnly ? 0 : Math.max(0, stat.size - TAIL_READ_BUDGETS[1]);
    const cacheStart = contextStart;
    let position = start;
    if (appendOnly) {
      while (position < stat.size) {
        const length = Math.min(TAIL_READ_BUDGETS[0], stat.size - position);
        const bytes = Buffer.alloc(length);
        const read = fsApi.readSync(fd, bytes, 0, length, position);
        if (read !== length) throw new Error('Incomplete transcript read');
        consumeBytes(state, bytes, position, contextStart, cacheStart);
        position += length;
      }
    } else {
      for (const bytes of chunks) {
        consumeBytes(state, bytes, position, contextStart, cacheStart);
        position += bytes.length;
      }
    }
    // A complete final record without a newline is valid. Keep its bytes so
    // a later append can finish a partial record; accounting dedup is stateful.
    if (!state.droppingLine) applyLine(state, state.trailing, stat.size - state.trailing.length, contextStart, cacheStart);
    Object.assign(state, { identity, size: stat.size, mtimeMs: stat.mtimeMs });
    if (cache.size >= 512 && !cache.has(filePath)) cache.delete(cache.keys().next().value);
    cache.set(filePath, state);
    return state;
  } catch (_) {
    return {};
  } finally {
    if (fd !== undefined) { try { fsApi.closeSync(fd); } catch (_) {} }
  }
}

function readCodexSessionContext(filePath, deps = {}) {
  return readCodexSessionState(filePath, deps).context || null;
}

function readCodexTurnEnded(filePath, deps = {}) {
  return readCodexSessionState(filePath, deps).turnEnded;
}

module.exports = { TAIL_READ_BUDGETS, readCodexSessionState, readCodexSessionContext, readCodexTurnEnded };
