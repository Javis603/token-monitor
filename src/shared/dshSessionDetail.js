'use strict';

/**
 * Local, on-demand session detail for DeepSeek Harness (`dsh`) logs.
 *
 * The durable log is the source of truth; prompts and per-step usage are read
 * only when the user opens a session in the widget and are never uploaded.
 *
 * Two things a naive per-line parse gets wrong on real dsh transcripts:
 *
 * - `user/message` events are not all user-typed prompts. `data.source.kind`
 *   is `user` for what the person actually typed, but also `agent-instructions`
 *   (a full AGENTS.md dump), `plugin` (runtime-context snapshots) and
 *   `skill-catalog` (the available-skills list) for harness-injected context.
 *   Only `kind === 'user'` may become a prompt bubble.
 * - A forked session's log is seeded with a byte-for-byte copy of its parent's
 *   events up to `session.seedLength` (the `seq` of the `session/end-seed`
 *   marker). Tokscale's own aggregate leaves that seeded prefix on the parent
 *   and counts only the fork's own new events; Session Detail must match, or
 *   opening a forked session shows more tokens than tokscale's own count for
 *   it (measured up to +52.7% total across a small real sample dominated by
 *   one heavily-forked session).
 */

const fs = require('node:fs');
const { makeTokens, groupEvents, filterExchangesByPeriod, distributeCost } = require('./sessionDetail');
const { decodeSessionText, dshSessionFiles, readDshSessionHeader, resolveDshSessionsRoot } = require('./dshSessionFiles');

function numberValue(value) {
  const parsed = Number(value || 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function textFromContent(content) {
  const blocks = Array.isArray(content) ? content : [];
  return blocks
    .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
    .map((block) => block.text.trim())
    .filter(Boolean)
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
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

function parseDshDetailEvents(text) {
  const events = [];
  // dsh's own persistence layer can replay an already-flushed line back into
  // the file (crash/retry on the writer side); tokscale's dsh parser guards
  // against double-counting it with a dedup key of message identity + time +
  // routing + token signature, not `seq` (dsh.rs) — port the same key so a
  // replay isn't double counted here either. Scoped to assistant/message
  // like tokscale's own dedup: user/message never carries usage, so a
  // replayed prompt cannot skew the token total the way a replayed turn can.
  const seenAssistantKeys = new Set();
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
    // is what findDshSessionFile's directory-name fallback is for.
    //
    // A forked session's log is seeded with its parent's events verbatim.
    // Tokscale credits that shared prefix to the parent only, so Session
    // Detail must skip it too, or a fork's total exceeds its own card.
    // seedLength counts the inherited events (seq is 0-indexed), so the
    // event AT seq === seedLength is the fork's own first new event, not
    // part of the copied prefix — tokscale itself skips strictly `seq <
    // seed_length` (dsh.rs), and matching it here is a hard requirement,
    // not a rounding choice.
    if (seedLength !== null && numberValue(record?.seq) < seedLength) continue;
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
      const promptText = textFromContent(record.data?.content);
      if (promptText) events.push({ kind: 'prompt', timestamp: new Date(time).toISOString(), text: promptText });
    } else if (record?.type === 'assistant/message') {
      const usage = record.data?.usage;
      if (!usage) continue;
      const tokens = usageTokens(usage);
      if (tokens.total === 0) continue;
      const source = record.data?.message?.source;
      const messageId = String(record.data?.message?.id || '').trim();
      const identity = messageId || `sid:${header?.id || ''}`;
      const dedupKey = [
        identity, time, source?.provider || '', source?.model || '',
        tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning
      ].join(':');
      if (seenAssistantKeys.has(dedupKey)) continue;
      seenAssistantKeys.add(dedupKey);
      const tools = Array.isArray(record.data?.message?.content)
        ? record.data.message.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
        : [];
      events.push({ kind: 'turn', timestamp: new Date(time).toISOString(), tokens, tools });
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
