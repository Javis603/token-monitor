'use strict';

/**
 * Local, on-demand session detail for DeepSeek Harness (`dsh`) logs.
 *
 * The durable log is the source of truth; prompts and per-step usage are read
 * only when the user opens a session in the widget and are never uploaded.
 *
 * Record-level parsing (which lines count, fork seeding, replayed-line dedupe)
 * lives in one place — dshTranscriptRecords below — so parseDshDetailEvents is a
 * thin projection over it rather than a second reading of the same format.
 */

const fs = require('node:fs');
const { makeTokens, groupEvents, filterExchangesByPeriod, distributeCost } = require('../../sessionDetail');
const { decodeSessionText, dshSessionFiles, readDshSessionHeader, resolveDshSessionsRoot } = require('./sessionFiles');

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function promptFromContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  const text = blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  // DSH carries a user-pasted image as a top-level `image` content block (not
  // inline in the text), so a text-only scan would drop an image-only prompt
  // entirely and leave its reply stranded as an empty exchange. Mirror the
  // Codex/Claude detail convention: [image] for one, [N images] for several,
  // prepended to whatever was typed.
  const imageCount = blocks.filter((block) => block && block.type === 'image').length;
  const marker = imageCount === 1 ? '[image]' : imageCount > 1 ? `[${imageCount} images]` : '';
  if (!marker) return text;
  return text ? `${marker} ${text}` : marker;
}

function findDshSessionFile(sessionId, options = {}) {
  const root = options.sessionsRoot || resolveDshSessionsRoot(options);
  for (const filePath of dshSessionFiles(root)) {
    const header = readDshSessionHeader(filePath);
    if (header?.id === sessionId) return filePath;
  }
  return null;
}

function usageTokens(usage) {
  // DSH's `outputTokens` includes reasoning tokens as a subset. tokscale's
  // dsh parser does subtract reasoning out of its internal `output` bucket
  // (`output.saturating_sub(reasoning)` in dsh.rs) — but TokenBreakdown.total()
  // then adds `reasoning` straight back on top of every bucket (lib.rs), so
  // the subtraction and the re-add cancel out: tokscale's own reported total
  // for a message is input + RAW inclusive output + cache, identical to never
  // subtracting at all. makeTokens works the other way — output is expected
  // reasoning-inclusive and its total deliberately excludes reasoning from the
  // sum (see its own comment) — so passing outputTokens straight through,
  // unmodified, is what actually matches tokscale's total. An earlier version
  // of this function subtracted reasoning here, which under-counted every
  // reasoning-heavy session's total by exactly its reasoning token count.
  return makeTokens({
    input: numberValue(usage?.inputTokens),
    output: numberValue(usage?.outputTokens),
    cacheRead: numberValue(usage?.cacheReadTokens),
    cacheWrite: numberValue(usage?.cacheWriteTokens),
    reasoning: numberValue(usage?.reasoningTokens)
  });
}

// One pass over a transcript's records, returning the parsed `session` header
// plus normalized entries — either a prompt (`kind: 'prompt'`) or one billable
// model call (`kind: 'usage'`). parseDshDetailEvents below is a projection over
// this, so the rules that decide which records count are stated once.
//
// Everything in here exists because tokscale's dsh.rs does it too, and a second
// implementation that got it slightly wrong would disagree with the totals the
// dashboard already reports for the same session:
//
// - `user/message` events are not all user-typed prompts. `data.source.kind`
//   is `user` for what the person actually typed, but also `agent-instructions`
//   (a full AGENTS.md dump), `plugin` (runtime-context snapshots) and
//   `skill-catalog` (the available-skills list) for harness-injected context.
//   Only `kind === 'user'` may become a prompt bubble.
// - A forked session's log is seeded with a byte-for-byte copy of its parent's
//   events up to `session.seedLength` (the `seq` of the `session/end-seed`
//   marker). Tokscale's own aggregate leaves that seeded prefix on the parent
//   and counts only the fork's own new events; Session Detail must match, or
//   opening a forked session shows more tokens than tokscale's own count for
//   it (measured up to +52.7% total across a small real sample dominated by
//   one heavily-forked session).
// - dsh's persistence layer can replay an already-flushed line back into the
//   file (crash/retry on the writer side); tokscale's dsh parser guards against
//   double-counting it with a dedup key of message identity + time + routing +
//   token signature. Summaries get their own namespace so an otherwise-identical
//   assistant call cannot suppress a real compaction charge.
function dshTranscriptRecords(text, options = {}) {
  const records = [];
  const seenUsageKeys = new Set();
  // dsh names the transcript directory after the session id, mirroring
  // tokscale's session_id_from_path fallback, so a torn or unreadable leading
  // `session` event still resolves to the id its own directory names.
  const fallbackSessionId = String(options.sessionId || '').trim();
  let header = null;
  let seedLength = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let record;
    try {
      record = JSON.parse(trimmed);
    } catch (_) {
      continue;
    }
    if (record?.type === 'session') {
      header = record;
      seedLength = Number.isFinite(Number(record.seedLength)) ? Number(record.seedLength) : null;
      continue;
    }
    // tokscale's own loop never gates user/assistant processing on having
    // seen the header first (dsh.rs): every line is matched by its own
    // `type` independently, and seed_length simply stays its 0 default until
    // (if ever) a session record sets it. A torn or unreadable header must
    // not make an otherwise-parseable transcript report zero tokens — this
    // is what the directory-name fallback is for.
    //
    // A forked session's log is seeded with its parent's events verbatim.
    // Tokscale credits that shared prefix to the parent only, so Session
    // Detail must skip it too, or a fork's total exceeds its own card.
    // seedLength counts the inherited events (seq is 0-indexed), so the
    // event AT seq === seedLength is the fork's own first new event, not
    // part of the copied prefix — tokscale itself skips strictly `seq <
    // seed_length` (dsh.rs), and matching it here is a hard requirement,
    // not a rounding choice.
    const recordSeq = Number.isFinite(record?.seq) ? record.seq : null;
    if (seedLength !== null && recordSeq !== null && recordSeq < seedLength) continue;
    // An event without a usable time cannot be placed in the exchange
    // timeline correctly — defaulting it to epoch 0 would either sort it out
    // of order or drop it from every non-"total" period filter silently.
    // tokscale applies the identical `timestamp <= 0` skip to assistant/message
    // (dsh.rs); applying it to user/message too is a Session Detail-specific
    // need tokscale itself doesn't have, since it never renders prompts.
    const time = numberValue(record?.time);
    if (time <= 0) continue;
    if (record?.type === 'user/message') {
      if (record.data?.source?.kind !== 'user') continue;
      const promptText = promptFromContent(record.data?.content);
      if (promptText) records.push({ kind: 'prompt', timeMs: time, text: promptText });
    } else if (record?.type === 'assistant/message' || record?.type === 'compaction/summary') {
      const isSummary = record.type === 'compaction/summary';
      const usage = record.data?.usage;
      if (!usage) continue;
      const tokens = usageTokens(usage);
      if (tokens.total === 0) continue;
      const source = record.data?.message?.source;
      const messageId = String(record.data?.message?.id || '').trim();
      const identity = messageId
        ? `msg:${messageId}`
        : (recordSeq !== null ? `seq:${recordSeq}` : `sid:${header?.id || fallbackSessionId}`);
      const dedupKey = [
        isSummary ? `summary:${identity}` : identity,
        time, source?.provider || '', source?.model || '',
        tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning
      ].join(':');
      if (seenUsageKeys.has(dedupKey)) continue;
      seenUsageKeys.add(dedupKey);
      const tools = !isSummary && Array.isArray(record.data?.message?.content)
        ? record.data.message.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
        : [];
      records.push({
        kind: 'usage',
        timeMs: time,
        isSummary,
        model: String(source?.model || '').trim(),
        provider: String(source?.provider || '').trim(),
        messageId,
        seq: recordSeq,
        tools,
        tokens
      });
    }
  }
  return {
    header,
    sessionId: String(header?.id || fallbackSessionId || '').trim(),
    records
  };
}

// Session Detail's view of the same parse: prompt bubbles and per-turn token
// totals. `parseDshDetailEvents` keeps that name and shape because the widget's
// session-detail tests and renderer consume it directly.
function parseDshDetailEvents(text) {
  const events = [];
  for (const record of dshTranscriptRecords(text).records) {
    if (record.kind === 'prompt') {
      events.push({ kind: 'prompt', timestamp: new Date(record.timeMs).toISOString(), text: record.text });
    } else {
      events.push({
        kind: 'turn',
        type: record.isSummary ? 'compaction-summary' : 'reply',
        timestamp: new Date(record.timeMs).toISOString(),
        tokens: record.tokens,
        tools: record.tools
      });
    }
  }
  return events;
}

function totalsOf(exchanges, sessionCost) {
  const totalTokens = exchanges.reduce((acc, ex) => acc + ex.tokens.total, 0);
  const turnCount = exchanges.reduce((acc, ex) => acc + ex.turnCount, 0);
  return { totalTokens, costUsd: numberValue(sessionCost), exchangeCount: exchanges.length, turnCount };
}

function readDshSessionDetail({ sessionId, period = 'total', sessionCost = 0, home, env, platform, cwdDir, sessionsRoot, deps = {} }) {
  const options = {
    homeDir: home,
    env: env || deps.env || process.env,
    platform: platform || deps.platform || process.platform,
    cwdDir: cwdDir || deps.cwdDir || process.cwd(),
    ...(sessionsRoot ? { sessionsRoot } : {})
  };
  const findFile = deps.findDshSessionFile || findDshSessionFile;
  const filePath = findFile(sessionId, options);
  if (!filePath) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  let events;
  try {
    const buffer = fs.readFileSync(filePath);
    const text = decodeSessionText(filePath, buffer);
    events = parseDshDetailEvents(text);
  } catch (_) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  const now = new Date((deps.now || Date.now)());
  const grouped = filterExchangesByPeriod(groupEvents(events), period, now);
  const distributed = distributeCost(grouped, sessionCost);
  return { found: true, client: 'dsh', sessionId, period, exchanges: distributed, totals: totalsOf(distributed, sessionCost) };
}

module.exports = {
  findDshSessionFile,
  parseDshDetailEvents,
  readDshSessionDetail
};
