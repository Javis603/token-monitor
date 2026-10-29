;
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { codebuddyProjectsRoot } = require('./paths');

// CodeBuddy records no generation timing: every record states when it was
// written, and the record that carries a response's usage states its token
// counts, but nothing links the two. Tokscale therefore reports a zero
// performance block for every codebuddy row, and the live-rate footer — which
// divides output by the duration of the entries that produced it — has nothing
// to divide for a device whose usage is CodeBuddy-only.
//
// The gap between two records is the only duration the format offers: the
// response that reports usage was written after the prompt or tool result that
// fed it and before the next record landed. That is the same shape the Claude
// reader works from. `turn-metrics.durationMs` is deliberately not used: it
// spans the whole turn, tool execution and idle waits included, and divides to
// a rate an order of magnitude below what the model actually produced.
//
// Records written inside a response (reasoning blocks) must not reset the
// anchor, or every response would measure from its own last thought; a window
// with no usage-bearing record inside it is dropped so idle gaps between
// prompts never enter the denominator.
const MAX_GENERATION_WINDOW_MS = 15 * 60 * 1000;
const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
const SKIPPED_RECORD_TYPES = new Set(['reasoning', 'summary', 'ai-title', 'file-history-snapshot', 'session-meta']);

// Transcripts are append-only, so a file only has to be re-read after its size
// or mtime changes: the supplement runs on every collector tick, and re-parsing
// the tree each time would cost more than the tokscale pass it follows.
const transcriptCache = new Map();

function localDayStart(now) {
  const date = new Date(now == null ? Date.now() : now);
  if (Number.isNaN(date.getTime())) return 0;
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime();
}

function transcriptPaths(projectsRoot) {
  const files = [];
  let workspaces;
  try {
    workspaces = fs.readdirSync(projectsRoot, { withFileTypes: true });
  } catch (_) {
    return files;
  }
  for (const workspace of workspaces) {
    if (!workspace.isDirectory()) continue;
    const workspaceDir = path.join(projectsRoot, workspace.name);
    let entries;
    try {
      entries = fs.readdirSync(workspaceDir, { withFileTypes: true });
    } catch (_) {
      continue;
    }
    for (const entry of entries) {
      if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path.join(workspaceDir, entry.name));
      if (!entry.isDirectory()) continue;
      // <session>/subagents/agent-*.jsonl — the scan reports those as their own
      // sessions, so their timing belongs to the same day the parent's does.
      const subagents = path.join(workspaceDir, entry.name, 'subagents');
      let agents;
      try {
        agents = fs.readdirSync(subagents, { withFileTypes: true });
      } catch (_) {
        continue;
      }
      for (const agent of agents) {
        if (agent.isFile() && agent.name.endsWith('.jsonl')) files.push(path.join(subagents, agent.name));
      }
    }
  }
  return files;
}

function dayTotals(filePath, dayStartMs) {
  let stat;
  try {
    stat = fs.statSync(filePath);
  } catch (_) {
    return null;
  }
  if (!stat.isFile() || stat.size > MAX_TRANSCRIPT_BYTES) return null;
  // A transcript last written before today cannot hold a window that ends
  // today, and most of a long-lived tree is exactly that.
  if (stat.mtimeMs < dayStartMs) return null;
  const stamp = String(stat.mtimeMs) + ':' + String(stat.size);
  const cached = transcriptCache.get(filePath);
  if (cached && cached.stamp === stamp && cached.dayStartMs === dayStartMs) return cached.totals;

  let text;
  try {
    text = fs.readFileSync(filePath, 'utf8');
  } catch (_) {
    return null;
  }
  const totals = { timedDurationMs: 0, timedOutputTokens: 0, timedTokens: 0 };
  let windowStart = 0;
  for (const line of text.split('\n')) {
    if (!line.includes('"timestamp"')) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch (_) {
      continue;
    }
    const at = Number(record.timestamp) || 0;
    if (!at) continue;
    if (SKIPPED_RECORD_TYPES.has(record.type)) continue;
    // A turn boundary closes a window even though it reports no usage of its
    // own: the next response must not be measured from before it.
    if (record.type === 'turn-metrics') {
      windowStart = at;
      continue;
    }
    const usage = record.providerData && record.providerData.rawUsage;
    const output = usage ? Number(usage.completion_tokens) || 0 : 0;
    if (output > 0 && at >= dayStartMs && windowStart > 0 && at > windowStart
      && at - windowStart <= MAX_GENERATION_WINDOW_MS) {
      totals.timedDurationMs += at - windowStart;
      totals.timedOutputTokens += output;
      totals.timedTokens += Number(usage.total_tokens) || output;
    }
    windowStart = at;
  }
  transcriptCache.set(filePath, { stamp, dayStartMs, totals });
  return totals;
}

// The day's CodeBuddy generation, in the counter shape the periods carry, so a
// caller can fold it into the period it belongs to. Null when no record carried
// a usable window, which leaves the period — and the footer — without a rate
// rather than with a fabricated one.
function codebuddyTurnThroughput(options = {}) {
  const dayStartMs = localDayStart(options.now);
  if (!dayStartMs) return null;
  const projectsRoot = codebuddyProjectsRoot({ homeDir: options.homeDir });
  if (!projectsRoot) return null;
  const files = transcriptPaths(projectsRoot);
  const present = new Set(files);
  for (const cachedPath of transcriptCache.keys()) {
    if (!present.has(cachedPath)) transcriptCache.delete(cachedPath);
  }
  const totals = { timedDurationMs: 0, timedOutputTokens: 0, timedTokens: 0 };
  for (const filePath of files) {
    const part = dayTotals(filePath, dayStartMs);
    if (!part) continue;
    totals.timedDurationMs += part.timedDurationMs;
    totals.timedOutputTokens += part.timedOutputTokens;
    totals.timedTokens += part.timedTokens;
  }
  if (!(totals.timedDurationMs > 0) || !(totals.timedOutputTokens > 0)) return null;
  return totals;
}

module.exports = { codebuddyTurnThroughput, localDayStart };
