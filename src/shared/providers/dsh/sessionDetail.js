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

const path = require('node:path');
const { readDshTranscriptRecords } = require('./transcriptReader');
const { makeTokens, groupEvents, filterExchangesByPeriod, distributeCost } = require('../../sessionDetail');
const { dshSessionFiles, resolveDshSessionsRoot } = require('./sessionFiles');

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

async function findDshSessionFile(sessionId, options = {}) {
  const root = options.sessionsRoot || resolveDshSessionsRoot(options);
  for (const filePath of dshSessionFiles(root)) {
    let id;
    try {
      for await (const record of readDshTranscriptRecords(filePath, { headerOnly: true })) {
        id = record?.type === 'session' && typeof record.id === 'string' ? record.id : null;
        break;
      }
    } catch (_) {}
    // Keep discovery's directory-name fallback for torn or unreadable headers.
    if ((id || path.basename(path.dirname(filePath))) === sessionId) return filePath;
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
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    try { records.push(JSON.parse(line)); } catch (_) {}
  }
  return parseDshDetailRecords(records);
}

function nativeStreamUsage(stream) {
  if (!Array.isArray(stream)) return null;
  for (let index = stream.length - 1; index >= 0; index -= 1) {
    const record = stream[index];
    if (record?.type === 'chunk' && record.chunk?.type === 'usage' && record.chunk.usage !== undefined) return record.chunk.usage;
  }
  return null;
}

const nonEmptyString = value => typeof value === 'string' ? value.trim() : '';
function nativeUsageIdentity(record, sessionId, time) {
  const data = record.data || {};
  if (record.type === 'assistant/attempt') {
    const id = nonEmptyString(data.attemptId !== undefined ? data.attemptId : data.retryId);
    if (id) return `attempt-id:${id}`;
    if (Number.isSafeInteger(record.seq)) return `attempt-session:${sessionId}:seq:${record.seq}`;
    if (Number.isSafeInteger(data.turn) && Number.isSafeInteger(data.step)) return `attempt-session:${sessionId}:turn:${data.turn}:step:${data.step}:${time}`;
    return `attempt-session:${sessionId}`;
  }
  const messageId = nonEmptyString(data.message?.id);
  if (messageId) return `msg:${messageId}`;
  const compactionId = record.type === 'compaction/summary' ? nonEmptyString(data.compactionId) : '';
  if (compactionId) return `cmp:${compactionId}`;
  return Number.isSafeInteger(record.seq) ? `seq:${record.seq}` : `sid:${sessionId}`;
}

function parseDshDetailRecords(inputRecords, { includeUsageSource = false, sessionId = 'unknown' } = {}) {
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
  for (const record of inputRecords) {
    if (record?.type === 'session' && !header) {
      header = record;
      headerRecordIndex = records.length;
    }
    records.push(record);
  }

  // v0 persisted the exact inherited-prefix length on the header. Current
  // generations keep only the lineage bit there and project the exact cut into
  // the log. A fork can inherit an ancestor's tagged marker, so only the LAST
  // tagged marker belongs to this session. Untagged end-seed markers are resume
  // lifecycle boundaries and must never hide history in an unseeded session.
  const hasLegacySeedLength = header?.seedLength !== undefined && header?.seedLength !== null;
  const headerSeedLength = includeUsageSource ? header?.seedLength : Number(header?.seedLength);
  let inheritedCut = hasLegacySeedLength && (includeUsageSource
    ? Number.isSafeInteger(headerSeedLength) && headerSeedLength > 0 : Number.isFinite(headerSeedLength)) ? headerSeedLength : null;
  const needsTaggedCut = (includeUsageSource ? !hasLegacySeedLength : inheritedCut === null) && header?.isSeeded === true;
  if (needsTaggedCut) {
    for (const record of records) {
      if (record?.type !== 'session/end-seed' || record.data?.inherited !== true) continue;
      if (includeUsageSource ? Number.isSafeInteger(record.seq) : Number.isFinite(record.seq)) inheritedCut = record.seq;
    }
  }

  let fallbackProvider;
  let fallbackModel;
  let nativeSessionId = sessionId;
  let lastSettlement;
  for (const [recordIndex, record] of records.entries()) {
    if (record?.type === 'session') {
      if (typeof record.id === 'string') nativeSessionId = record.id;
      continue;
    }
    if (includeUsageSource && record?.type === 'request/header') {
      const config = record.data?.header?.config;
      fallbackProvider = typeof config?.provider === 'string' ? config.provider : undefined;
      fallbackModel = nonEmptyString(config?.model);
      continue;
    }
    if (includeUsageSource && record?.type === 'llm/retry-started') {
      if (lastSettlement && record.data?.turn === lastSettlement.turn && record.data?.step === lastSettlement.step) lastSettlement = undefined;
      continue;
    }
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
    // Historical identity needs a complete fork boundary even when a torn
    // header appeared late; native detail totals retain their prior behaviour.
    if (needsTaggedCut && inheritedCut === null && (includeUsageSource || inheritedCutApplies)) continue;
    if (inheritedCutApplies && inheritedCut !== null && recordSeq !== null && recordSeq < inheritedCut) continue;
    // An event without a usable time cannot be placed in the exchange
    // timeline correctly — defaulting it to epoch 0 would either sort it out
    // of order or drop it from every non-"total" period filter silently.
    // tokscale applies the identical `timestamp <= 0` skip to assistant/message
    // (dsh.rs); applying it to user/message too is a Session Detail-specific
    // need tokscale itself doesn't have, since it never renders prompts.
    const time = includeUsageSource ? record?.time : numberValue(record?.time);
    if (time <= 0 || (includeUsageSource && !Number.isSafeInteger(time))) continue;
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
      const usage = includeUsageSource
        ? (isAttempt ? nativeStreamUsage(record.data?.stream)
          : (record.data?.usage !== undefined ? record.data.usage : (isSummary ? null : nativeStreamUsage(record.data?.stream))))
        : (!isAttempt && record.data?.usage ? record.data.usage : lastStreamUsage(record.data?.stream));
      if (!usage) continue;
      const nativeInt = key => Number.isSafeInteger(usage[key]) ? usage[key] : 0;
      const tokens = includeUsageSource ? makeTokens({
        input: nativeInt('inputTokens'), output: Math.max(0, nativeInt('outputTokens'), nativeInt('reasoningTokens')),
        cacheRead: nativeInt('cacheReadTokens'), cacheWrite: nativeInt('cacheWriteTokens'), reasoning: Math.max(0, nativeInt('reasoningTokens'))
      }) : usageTokens(usage);
      if (tokens.total === 0) continue;
      const source = record.data?.message?.source;
      const messageId = String(record.data?.message?.id || '').trim();
      const identity = includeUsageSource ? nativeUsageIdentity(record, nativeSessionId, time)
        : (messageId ? `msg:${messageId}` : (recordSeq !== null ? `seq:${recordSeq}` : `sid:${header?.id || ''}`));
      // Attribution follows the pinned native parser's route. Detail rendering
      // keeps its existing contract unless this evidence-only mode is requested.
      const provider = typeof source?.provider === 'string' ? source.provider : (fallbackProvider ?? 'unknown');
      const model = nonEmptyString(source?.replayState?.response?.responseModel)
        || nonEmptyString(source?.model) || fallbackModel || 'unknown';
      const dedupKey = [
        isSummary ? `summary:${identity}` : (isAttempt ? `attempt:${identity}` : identity),
        time, includeUsageSource ? provider : source?.provider || '', includeUsageSource ? model : source?.model || '',
        tokens.input, includeUsageSource ? tokens.output - tokens.reasoning : tokens.output, tokens.cacheRead, tokens.cacheWrite, tokens.reasoning
      ].join(':');
      if (seenUsageKeys.has(dedupKey)) continue;
      seenUsageKeys.add(dedupKey);
      const tools = !isSummary && Array.isArray(record.data?.message?.content)
        ? record.data.message.content.filter((block) => block && block.type === 'tool-call' && typeof block.name === 'string').map((block) => block.name)
        : [];
      const event = {
        kind: 'turn',
        type: isSummary ? 'compaction-summary' : (isAttempt ? 'assistant-attempt' : 'reply'),
        timestamp: new Date(time).toISOString(),
        tokens,
        tools,
        ...(includeUsageSource ? { usageSource: { provider, model,
          responseId: typeof source?.replayState?.response?.responseId === 'string' ? source.replayState.response.responseId : '' } } : {})
      };
      const turn = record.data?.turn, step = record.data?.step;
      if (includeUsageSource && !isSummary && Number.isSafeInteger(turn) && Number.isSafeInteger(step)) {
        if (lastSettlement?.turn === turn && lastSettlement.step === step) events[lastSettlement.index] = event;
        else {
          lastSettlement = { turn, step, index: events.length };
          events.push(event);
        }
      } else {
        events.push(event);
        if (includeUsageSource && !isSummary) lastSettlement = undefined;
      }
    }
  }
  return events;
}

function totalsOf(exchanges, sessionCost) {
  const totalTokens = exchanges.reduce((acc, ex) => acc + ex.tokens.total, 0);
  const turnCount = exchanges.reduce((acc, ex) => acc + ex.turnCount, 0);
  return { totalTokens, costUsd: numberValue(sessionCost), exchangeCount: exchanges.length, turnCount };
}

async function readDshSessionDetail({ sessionId, period = 'total', sessionCost = 0, home, env, platform, cwdDir, sessionsRoot, deps = {} }) {
  const options = {
    homeDir: home,
    env: env || deps.env || process.env,
    platform: platform || deps.platform || process.platform,
    cwdDir: cwdDir || deps.cwdDir || process.cwd(),
    ...(sessionsRoot ? { sessionsRoot } : {})
  };
  const findFile = deps.findDshSessionFile || findDshSessionFile;
  const filePath = await findFile(sessionId, options);
  if (!filePath) {
    return { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  let events;
  try {
    const records = [];
    for await (const record of readDshTranscriptRecords(filePath)) records.push(record);
    events = parseDshDetailRecords(records);
  } catch (error) {
    const missing = { found: false, client: 'dsh', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
    if (error.code === 'ENOENT') return missing;
    return { ...missing, error: error.code === 'SESSION_DETAIL_LINE_TOO_LARGE' ? 'line-too-large' : 'read-failed' };
  }
  const now = new Date((deps.now || Date.now)());
  const grouped = filterExchangesByPeriod(groupEvents(events), period, now);
  const distributed = distributeCost(grouped, sessionCost);
  return { found: true, client: 'dsh', sessionId, period, exchanges: distributed, totals: totalsOf(distributed, sessionCost) };
}

module.exports = {
  findDshSessionFile,
  parseDshDetailEvents,
  parseDshDetailRecords,
  readDshSessionDetail
};
