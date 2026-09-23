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

// The newest `token_count` sits behind one turn's worth of response items, so
// the first budget covers an ordinary turn and the second covers a turn with a
// large tool output. Beyond that the session simply has no context reading
// until its next turn lands — a bounded miss, not a full-file read on a
// transcript that can reach tens of megabytes.
const TAIL_READ_BUDGETS = [256 * 1024, 1024 * 1024];

// Keyed by file path and invalidated by size+mtime, so an unchanged transcript
// costs one stat. Module-level on purpose: it outlives a collection tick, the
// same way the shared timestamp cache does, because the pass that uses it is
// rebuilt on every tick.
const contextCache = new Map();

// Same lifetime rule as the context cache above, for the turn-boundary read.
const turnEndCache = new Map();

// The turn-boundary scan starts at the ordinary tail budget and doubles up to
// this cap. A boundary is normally within the first window (it is the last
// thing a turn writes), but a single Codex message can be several megabytes,
// so the window has to be able to grow past it. The cap keeps a transcript
// with no boundary at all (an old rollout predating the event) bounded rather
// than read in full.
const TURN_READ_START_BYTES = 256 * 1024;
const TURN_READ_MAX_BYTES = 8 * 1024 * 1024;

function readFileTail(filePath, size, bytes) {
  let fd;
  try {
    fd = fs.openSync(filePath, 'r');
    const length = Math.min(bytes, size);
    const buffer = Buffer.alloc(length);
    fs.readSync(fd, buffer, 0, length, Math.max(0, size - length));
    return buffer.toString('utf8');
  } catch (_) {
    return '';
  } finally {
    if (fd !== undefined) {
      try { fs.closeSync(fd); } catch (_) {}
    }
  }
}

function tokenCountInfo(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return null; }
  if (!obj || typeof obj !== 'object') return null;
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
  if (payload.type !== 'token_count') return null;
  // Codex emits `token_count` with a null `info` when it has nothing to report
  // (a resumed session before its first turn, for one). That is not an answer;
  // keep walking back for an event that carries usage.
  return payload.info && typeof payload.info === 'object' ? payload.info : null;
}

function contextFromInfo(info) {
  const usage = info.last_token_usage || info.lastTokenUsage;
  return normalizeSessionContext({
    contextTokens: usage && typeof usage === 'object'
      ? (usage.total_tokens ?? usage.totalTokens)
      : 0,
    contextWindow: info.model_context_window ?? info.modelContextWindow ?? info.context_window ?? info.contextWindow
  });
}

function contextFromTail(text) {
  const lines = text.split('\n');
  // The first line of a tail read is usually cut mid-record; walking backwards
  // reaches the newest complete event first and never depends on it.
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const info = tokenCountInfo(line);
    if (!info) continue;
    const context = contextFromInfo(info);
    if (context) return context;
  }
  return null;
}

/**
 * The context window occupancy of one Codex rollout transcript, or null when
 * the transcript has not reported one yet.
 */
function readCodexSessionContext(filePath, deps = {}) {
  const cache = deps.cache || contextCache;
  let stat;
  try { stat = fs.statSync(filePath); } catch (_) { return null; }
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.context;

  let context = null;
  for (const budget of TAIL_READ_BUDGETS) {
    context = contextFromTail(readFileTail(filePath, stat.size, budget));
    if (context || stat.size <= budget) break;
  }
  cache.set(filePath, { fingerprint, context });
  return context;
}

// Whether the last thing this transcript did was finish a turn. Codex writes
// `task_complete` when the agent stops generating, and `task_started` when it
// picks the next thing up, so the newest of the two answers the question. A
// transcript with neither has not had a turn finish yet (or predates the
// event), which reads as false and leaves the caller on its time window.
//
// A turn that was interrupted ends with `turn_aborted` instead: nothing is
// generating, so that counts as finished too.
function turnEndMarker(line) {
  let obj;
  try { obj = JSON.parse(line); } catch (_) { return ''; }
  if (!obj || typeof obj !== 'object') return '';
  const payload = obj.payload && typeof obj.payload === 'object' ? obj.payload : obj;
  if (payload.type === 'task_complete' || payload.type === 'turn_aborted') return 'end';
  if (payload.type === 'task_started') return 'start';
  return '';
}

function codexTurnEndedFromTail(text) {
  const lines = text.split('\n');
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index].trim();
    if (!line) continue;
    const marker = turnEndMarker(line);
    if (marker) return marker === 'end';
  }
  return false;
}

/**
 * True when the newest turn-boundary event in a Codex rollout is a completion.
 */
function readCodexTurnEnded(filePath, deps = {}) {
  const cache = deps.cache || turnEndCache;
  let stat;
  // No file means no evidence, which is not the same as `false` ("a turn is
  // under way"): only the latter may clear a `true` left by an earlier tick.
  try { stat = fs.statSync(filePath); } catch (_) { return undefined; }
  const fingerprint = `${stat.size}:${stat.mtimeMs}`;
  const cached = cache.get(filePath);
  if (cached?.fingerprint === fingerprint) return cached.turnEnded;
  // `undefined` until a boundary is actually found: a tail with no
  // task_complete/task_started/turn_aborted says nothing about the turn.
  let turnEnded;
  let budget = TURN_READ_START_BYTES;
  while (true) {
    const text = readFileTail(filePath, stat.size, budget);
    // A boundary found is an answer either way, and is the newest one because
    // the scan walks backwards from the end of this tail.
    if (codexHasTurnBoundary(text)) {
      turnEnded = codexTurnEndedFromTail(text);
      break;
    }
    // No boundary inside this window: widen. Codex can emit a single message
    // of several megabytes, so a fixed tail is not enough - one real session
    // put its last boundary behind two lines that together exceeded 1 MiB.
    if (stat.size <= budget || budget >= TURN_READ_MAX_BYTES) break;
    budget = Math.min(budget * 2, TURN_READ_MAX_BYTES);
  }
  cache.set(filePath, { fingerprint, turnEnded });
  return turnEnded;
}

function codexHasTurnBoundary(text) {
  return /"type":"(task_complete|task_started|turn_aborted)"/.test(text);
}

module.exports = {
  TAIL_READ_BUDGETS,
  readCodexSessionContext,
  readCodexTurnEnded
};
