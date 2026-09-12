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
 *   events. Legacy headers store the inherited count as `seedLength`; current
 *   headers store `isSeeded: true` and put the exact cut on the LAST
 *   `session/end-seed { inherited: true }` marker. Session Detail must exclude
 *   that prefix, or opening the child shows the parent's prompts and tokens a
 *   second time.
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

function lastStreamUsage(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const usage = stream[index]?.chunk?.usage;
    if (usage && typeof usage === 'object') return usage;
  }
  return null;
}

function parseDshDetailEvents(text) {
  const events = [];
  // dsh's own persistence layer can replay an already-flushed line back into
  // the file (crash/retry on the writer side); tokscale's dsh parser guards
  // against double-counting it with a dedup key of message identity + time +
  // routing + token signature. Summaries get their own namespace so an
  // otherwise-identical assistant call cannot suppress a real compaction
  // charge.
  const seenUsageKeys = new Set();
  const records = [];
  let header = null;
  let headerRecordIndex = -1;
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
      if (!header) {
        header = record;
        headerRecordIndex = records.length;
      }
    }
    records.push(record);
  }

  // v0 persisted the exact inherited-prefix length on the header. Current
  // generations keep only the lineage bit there and project the exact cut into
  // the log. A fork can inherit an ancestor's tagged marker, so only the LAST
  // tagged marker belongs to this session. Untagged end-seed markers are resume
  // lifecycle boundaries and must never hide history in an unseeded session.
  const hasLegacySeedLength = header?.seedLength !== undefined && header?.seedLength !== null;
  const headerSeedLength = Number(header?.seedLength);
  let inheritedCut = hasLegacySeedLength && Number.isFinite(headerSeedLength) ? headerSeedLength : null;
  const needsTaggedCut = inheritedCut === null && header?.isSeeded === true;
  if (needsTaggedCut) {
    for (const record of records) {
      if (record?.type !== 'session/end-seed' || record.data?.inherited !== true) continue;
      if (Number.isFinite(record.seq)) inheritedCut = record.seq;
    }
  }

  for (const [recordIndex, record] of records.entries()) {
    if (record?.type === 'session') continue;
    // tokscale's own loop never gates user/assistant processing on having
    // seen the header first (dsh.rs): every line is matched by its own
    // `type` independently, and seed_length simply stays its 0 default until
    // (if ever) a session record sets it. A torn or unreadable header must
    // not make an otherwise-parseable transcript report zero tokens — this
    // is what findDshSessionFile's directory-name fallback is for.
    //
    // A tagged marker at seq N occupies the boundary itself: inherited events
    // have seq < N, while child-owned events follow it. If a current seeded
    // header has no readable tagged marker, ownership cannot be recovered; the
    // safe result is no prompt/usage rather than charging the copied parent
    // prefix to the child. Legacy seq-less usage retains its prior behaviour.
    const recordSeq = Number.isFinite(record?.seq) ? record.seq : null;
    const inheritedCutApplies = headerRecordIndex >= 0 && recordIndex > headerRecordIndex;
    if (inheritedCutApplies && needsTaggedCut && inheritedCut === null) continue;
    if (inheritedCutApplies && inheritedCut !== null && recordSeq !== null && recordSeq < inheritedCut) continue;
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
      if (promptText) events.push({ kind: 'prompt', timestamp: new Date(time).toISOString(), text: promptText });
    } else if (record?.type === 'assistant/message'
      || record?.type === 'assistant/attempt'
      || record?.type === 'compaction/summary') {
      const isSummary = record.type === 'compaction/summary';
      const isAttempt = record.type === 'assistant/attempt';
      // Current DSH persists calls that never produced a surface message as
      // assistant/attempt and keeps their final usage inside the embedded
      // stream. A successful assistant/message normally promotes usage to the
      // top level; that value is authoritative when present, with the stream as
      // a fallback for partially-promoted/current records.
      const usage = !isAttempt && record.data?.usage
        ? record.data.usage
        : lastStreamUsage(record.data?.stream);
      if (!usage) continue;
      const tokens = usageTokens(usage);
      if (tokens.total === 0) continue;
      const source = record.data?.message?.source;
      const messageId = String(record.data?.message?.id || '').trim();
      const identity = messageId
        ? `msg:${messageId}`
        : (recordSeq !== null ? `seq:${recordSeq}` : `sid:${header?.id || ''}`);
      const dedupKey = [
        isSummary ? `summary:${identity}` : (isAttempt ? `attempt:${identity}` : identity),
        time, source?.provider || '', source?.model || '',
        tokens.input, tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning
      ].join(':');
      if (seenUsageKeys.has(dedupKey)) continue;
      seenUsageKeys.add(dedupKey);
      const tools = !isSummary && Array.isArray(record.data?.message?.content)
        ? record.data.message.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
        : [];
      events.push({
        kind: 'turn',
        type: isSummary ? 'compaction-summary' : (isAttempt ? 'assistant-attempt' : 'reply'),
        timestamp: new Date(time).toISOString(),
        tokens,
        tools
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
