'use strict';

const fs = require('node:fs');
const { resolveSessionFile } = require('./sessionFiles');
const {
  contentText,
  isUserPromptRecord,
  messageIdOf,
  usageTokens
} = require('./providers/codebuddy/transcript');
const codebuddyExtension = require('./providers/codebuddy/extension');
const opencodeSession = require('./providers/opencode/session');
const { readReasonixSessionEvents } = require('./providers/reasonix/sessionDetail');

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function makeTokens({ input = 0, output = 0, cacheRead = 0, cacheWrite = 0, reasoning = 0 }) {
  // `reasoning` is a subset of `output` (OpenAI/Codex report reasoning_output_tokens within
  // output_tokens), so it's informational only and must NOT be added to the total — that matches
  // how tokscale totals the session (input + output + cacheRead + cacheWrite). For Claude reasoning
  // is always 0, so this is a no-op there.
  const total = num(input) + num(output) + num(cacheRead) + num(cacheWrite);
  return { input: num(input), output: num(output), cacheRead: num(cacheRead), cacheWrite: num(cacheWrite), reasoning: num(reasoning), total };
}

function uniqueTools(tools) {
  return Array.from(new Set(tools.filter(Boolean)));
}

function cleanPromptText(text) {
  // Drop the verbose "[Image: source: /long/path.png]" reference that Claude Code emits as a
  // separate duplicate message, but KEEP the short "[Image #N]" markers the user actually sees —
  // they show that an image was attached and keep image-only prompts from vanishing.
  return String(text || '')
    .replace(/\[Image:[^\]]*\]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

// Slash-command blocks, interrupt notices, and other harness-injected user lines
// are not real prompts — skip them so their turns attach to the actual prompt.
function isSyntheticClaudePrompt(text) {
  const t = String(text || '').trim();
  if (!t) return false;
  if (/^\[Request interrupted/.test(t)) return true;
  if (/^Base directory for this skill:/.test(t)) return true; // superpowers skill injection
  return /^<\/?(command-name|command-message|command-args|local-command-stdout|local-command-caveat|bash-input|bash-stdout|bash-stderr|system-reminder)\b/.test(t);
}

function claudePromptText(content) {
  if (typeof content === 'string') {
    if (isSyntheticClaudePrompt(content)) return null;
    return cleanPromptText(content) || null; // empty / image-ref-only string → skip boundary
  }
  if (Array.isArray(content)) {
    if (content.some((part) => part && part.type === 'tool_result')) return null; // tool output, not a prompt
    const rawTexts = content.filter((part) => part && part.type === 'text').map((part) => String(part.text || ''));
    if (rawTexts.some(isSyntheticClaudePrompt)) return null;
    const joined = rawTexts.map(cleanPromptText).filter(Boolean).join(' ').replace(/\s+/g, ' ').trim();
    if (joined) return joined;
    // No text once the "[Image: source: …]" duplicate refs are gone:
    //   has an image part → genuine image-only prompt → keep a labelled row
    //   otherwise → text-only paste duplicate → skip so its turns fold into the real prompt
    return content.some((part) => part && part.type === 'image') ? '[image]' : null;
  }
  return null;
}

// Codex's IDE extension prepends an editor-context block; the real prompt follows
// the "## My request for Codex:" marker.
function codexPromptText(raw) {
  const text = String(raw || '');
  const marker = '## My request for Codex:';
  const idx = text.indexOf(marker);
  return cleanPromptText(idx >= 0 ? text.slice(idx + marker.length) : text);
}

function codexResponseItemPrompt(payload) {
  if (payload?.type !== 'message' || payload.role !== 'user') return null;
  const content = Array.isArray(payload.content) ? payload.content : [];
  const kinds = payload.internal_chat_message_metadata_passthrough?.content_item_kinds;
  const hasKinds = Array.isArray(kinds);
  const selected = content.filter((part, index) => !hasKinds || String(kinds[index] || '').startsWith('user.'));
  // Current Codex records injected instructions as role=user too, but gives each content item a
  // semantic kind. A message with metadata and no user.* items is context, not a prompt boundary.
  if (hasKinds && selected.length === 0) return null;
  const text = codexPromptText(selected
    .filter((part) => part?.type === 'input_text')
    .map((part) => part.text || '')
    .join('\n'));
  const imageCount = selected.filter((part) => part?.type === 'input_image').length;
  const imageMarker = imageCount > 1 ? `[${imageCount} images]` : (imageCount === 1 ? '[image]' : '');
  const audioCount = selected.filter((part) => part?.type === 'input_audio').length;
  const audioMarker = audioCount > 1 ? `[${audioCount} audio clips]` : (audioCount === 1 ? '[audio]' : '');
  return [imageMarker, audioMarker, text].filter(Boolean).join(' ') || null;
}

function parseClaudeTranscript(text) {
  const events = [];
  // Claude Code inflates a transcript two ways, both of which would otherwise multiply token counts:
  //   1. Resume replay — on resume it re-appends prior transcript entries verbatim, copying their
  //      line `uuid`. Skip any entry whose uuid we've already seen.
  //   2. Content-block split — one assistant API response is written as one line per content block
  //      (thinking, text, tool_use…), each repeating the SAME message.id and usage. Count that
  //      usage once and merge the tool names so a single reply is one turn, not N.
  const seenLineUuids = new Set();
  const turnByMessageId = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_) { continue; }
    if (obj.uuid) {
      if (seenLineUuids.has(obj.uuid)) continue;
      seenLineUuids.add(obj.uuid);
    }
    const message = obj.message || {};
    const timestamp = obj.timestamp || '';
    if (obj.type === 'assistant' && message.usage) {
      const u = message.usage;
      const tools = Array.isArray(message.content)
        ? message.content.filter((part) => part && part.type === 'tool_use').map((part) => part.name)
        : [];
      const id = message.id;
      if (id && turnByMessageId.has(id)) {
        const turn = turnByMessageId.get(id);
        turn.tools = uniqueTools(turn.tools.concat(tools)); // merge tool_use from a later block of the same reply
        continue;
      }
      const event = {
        kind: 'turn',
        timestamp,
        tokens: makeTokens({
          input: u.input_tokens,
          output: u.output_tokens, // Anthropic folds thinking into output_tokens; no separate reasoning field
          cacheRead: u.cache_read_input_tokens,
          cacheWrite: u.cache_creation_input_tokens,
          reasoning: 0
        }),
        tools: uniqueTools(tools)
      };
      if (id) turnByMessageId.set(id, event);
      events.push(event);
    } else if (obj.type === 'user') {
      const promptText = claudePromptText(message.content);
      if (promptText === null) continue; // tool_result or unsupported shape — not a boundary
      events.push({ kind: 'prompt', timestamp, text: promptText });
    }
  }
  return events;
}

function codexToolName(payload) {
  return payload.name || payload.tool_name || payload.tool || '';
}

function parseCodexTranscript(text) {
  const events = [];
  let pendingTools = [];
  let adjacentPrompt = null;
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    // Codex can persist the same prompt in either schema order. Snapshot and clear the candidate
    // for every physical JSONL record so only adjacent, equivalent prompt records are coalesced.
    const previousPrompt = adjacentPrompt;
    adjacentPrompt = null;
    let obj;
    try { obj = JSON.parse(trimmed); } catch (_) { continue; }
    const payload = obj.payload || {};
    if (obj.type === 'response_item' && (payload.type === 'function_call' || payload.type === 'custom_tool_call' || payload.type === 'tool_search_call')) {
      const name = codexToolName(payload);
      if (name) pendingTools.push(name);
    } else if (obj.type === 'event_msg' && payload.type === 'mcp_tool_call_end') {
      const name = codexToolName(payload);
      if (name) pendingTools.push(name);
    } else if (obj.type === 'event_msg' && payload.type === 'user_message') {
      const text = codexPromptText(payload.message || payload.text || '');
      const imageCount = (Array.isArray(payload.images) ? payload.images.length : 0)
        + (Array.isArray(payload.local_images) ? payload.local_images.length : 0);
      const marker = imageCount > 1 ? `[${imageCount} images]` : (imageCount === 1 ? '[image]' : '');
      const label = [marker, text].filter(Boolean).join(' '); // image-bearing prompts keep an [image] marker like Claude
      // empty + no image → degenerate user_message; skip so its turns fold into the real prompt
      if (label) {
        const prompt = { kind: 'prompt', timestamp: obj.timestamp || '', text: label };
        // Keep event_msg as the canonical renderer text when it follows its response_item twin.
        if (previousPrompt?.source === 'response_item'
          && previousPrompt.index === events.length - 1
          && previousPrompt.text === label) {
          events[previousPrompt.index] = prompt;
        } else {
          events.push(prompt);
        }
        adjacentPrompt = { source: 'event_msg', index: events.length - 1, text: label };
      }
    } else if (obj.type === 'response_item') {
      const label = codexResponseItemPrompt(payload);
      if (label) {
        // External-session imports persist event_msg first. Its response_item twin is model
        // history, not a second user-visible boundary, so retain the canonical event_msg.
        if (previousPrompt?.source !== 'event_msg'
          || previousPrompt.index !== events.length - 1
          || previousPrompt.text !== label) {
          events.push({ kind: 'prompt', timestamp: obj.timestamp || '', text: label });
        }
        adjacentPrompt = { source: 'response_item', index: events.length - 1, text: label };
      }
    } else if (obj.type === 'event_msg' && payload.type === 'token_count') {
      const u = payload.info && payload.info.last_token_usage;
      if (!u) continue; // session-start / idle tick with no turn usage — not a reply
      // Codex follows OpenAI's convention: input_tokens INCLUDES cached_input_tokens and
      // output_tokens INCLUDES reasoning_output_tokens. Make the input disjoint from cache (so
      // in + out + cacheRead == total_tokens) and keep reasoning as an informational subset of
      // output. Adding cache or reasoning on top would double-count (the original bug).
      const cacheRead = num(u.cached_input_tokens);
      const tokens = makeTokens({
        input: Math.max(0, num(u.input_tokens) - cacheRead),
        output: u.output_tokens,
        cacheRead,
        cacheWrite: 0,
        reasoning: u.reasoning_output_tokens
      });
      if (tokens.total === 0) { pendingTools = []; continue; } // empty bookkeeping tick — skip
      events.push({ kind: 'turn', timestamp: obj.timestamp || '', tokens, tools: uniqueTools(pendingTools) });
      pendingTools = [];
    }
  }
  return events;
}

// CodeBuddy timestamps are epoch milliseconds; every other transcript here
// stamps ISO strings, and the shared grouping compares timestamps as text, so
// they are normalized on the way in.
function codebuddyTimestamp(value) {
  const ms = Number(value);
  if (Number.isFinite(ms) && ms > 0) return new Date(ms).toISOString();
  return typeof value === 'string' ? value : '';
}

// CodeBuddy persists one model response per `providerData.messageId`, as either
// a `function_call` (the response asked for a tool) or an assistant message
// (it answered in text), and puts the response's token usage on whichever of
// the two records it wrote — overwhelmingly the call, so reading only assistant
// messages would find usage for a fifth of the turns. Emitting one turn per
// messageId also keeps the response count aligned with the message count
// tokscale reports for this client, and folding the same records reproduces the
// session's input, output and cache-read totals exactly.
function parseCodebuddyTranscript(text) {
  const events = [];
  // The turn object is pushed on first sight and filled in place: a response's
  // records are adjacent, and its usage may arrive on the call while its text
  // arrives on the message (or the other way round).
  const turns = new Map();
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let entry;
    try { entry = JSON.parse(trimmed); } catch (_) { continue; }

    if (isUserPromptRecord(entry)) {
      const prompt = contentText(entry.content).replace(/\s+/g, ' ').trim();
      events.push({ kind: 'prompt', timestamp: codebuddyTimestamp(entry.timestamp), text: prompt });
      continue;
    }
    const isResponse = entry.type === 'function_call'
      || (entry.type === 'message' && entry.role === 'assistant');
    if (!isResponse) continue;
    const messageId = messageIdOf(entry);
    if (!messageId) continue;

    let turn = turns.get(messageId);
    if (!turn) {
      turn = { kind: 'turn', timestamp: '', tokens: emptyTokens(), tokensAvailable: false, tools: [] };
      turns.set(messageId, turn);
      events.push(turn);
    }
    if (!turn.timestamp) turn.timestamp = codebuddyTimestamp(entry.timestamp);
    if (entry.type === 'function_call') {
      const name = entry.name || entry.tool_name;
      if (typeof name === 'string' && name) turn.tools.push(name);
    }
    // A response whose usage never arrived keeps `tokensAvailable: false`, which
    // the shared grouping and the detail view both understand: the reply is
    // still shown, with its tools, and only its token numbers are missing.
    if (!turn.tokensAvailable) {
      const tokens = usageTokens(entry);
      if (tokens) {
        turn.tokens = makeTokens(tokens);
        turn.tokensAvailable = true;
      }
    }
  }
  return events;
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function addTokens(target, src) {
  target.input += src.input; target.output += src.output;
  target.cacheRead += src.cacheRead; target.cacheWrite += src.cacheWrite;
  target.reasoning += src.reasoning; target.total += src.total;
  return target;
}

function newExchange(promptPreview, timestamp) {
  return {
    promptPreview,
    startedAt: timestamp || '',
    endedAt: timestamp || '',
    turnCount: 0,
    tools: [],
    tokens: emptyTokens(),
    tokensAvailable: true,
    costEstimate: 0,
    turns: []
  };
}

function finalizeExchange(ex) {
  // Paid non-reply usage such as a DSH compaction summary or failed/retried
  // assistant attempt stays in `turns` for period filtering, token totals and
  // cost allocation, but must not inflate the user-facing conversation count.
  ex.turnCount = ex.turns.filter((turn) => turn.type !== 'compaction-summary' && turn.type !== 'assistant-attempt').length;
  ex.tools = uniqueTools(ex.turns.flatMap((t) => t.tools));
  ex.tokensAvailable = ex.turns.every((turn) => turn.tokensAvailable !== false);
  return ex;
}

function groupEvents(events) {
  const exchanges = [];
  let current = null;
  for (const event of events) {
    if (event.kind === 'prompt') {
      if (current) finalizeExchange(current);
      current = newExchange(event.text || '', event.timestamp);
      exchanges.push(current);
    } else if (event.kind === 'turn') {
      if (!current) { current = newExchange('', event.timestamp); exchanges.push(current); }
      // event.cost is set for OpenCode (real per-message cost); claude/codex leave it undefined → 0.
      const turnEntry = {
        ...(event.type ? { type: event.type } : {}),
        timestamp: event.timestamp,
        tokens: event.tokens,
        tokensAvailable: event.tokensAvailable !== false,
        tools: event.tools,
        costEstimate: num(event.cost)
      };
      current.turns.push(turnEntry);
      addTokens(current.tokens, event.tokens);
      if (event.timestamp && (!current.startedAt || event.timestamp < current.startedAt)) current.startedAt = event.timestamp;
      if (event.timestamp && event.timestamp > current.endedAt) current.endedAt = event.timestamp;
    }
  }
  if (current) finalizeExchange(current);
  return exchanges;
}

function withinPeriod(timestamp, period, now) {
  if (period === 'total') return true;
  const date = new Date(timestamp || '');
  if (Number.isNaN(date.getTime())) return false;
  if (period === 'today') {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && date.getDate() === now.getDate();
  }
  if (period === 'month') {
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth();
  }
  return true;
}

function filterExchangesByPeriod(exchanges, period, now = new Date()) {
  const result = [];
  for (const ex of exchanges) {
    const turns = ex.turns.filter((t) => withinPeriod(t.timestamp, period, now));
    if (turns.length === 0) continue;
    const next = newExchange(ex.promptPreview, ex.startedAt);
    next.turns = turns;
    next.tokensAvailable = turns.every((turn) => turn.tokensAvailable !== false);
    for (const t of turns) addTokens(next.tokens, t.tokens);
    next.startedAt = turns.reduce((min, t) => (t.timestamp && (!min || t.timestamp < min) ? t.timestamp : min), '');
    next.endedAt = turns.reduce((max, t) => (t.timestamp > max ? t.timestamp : max), '');
    result.push(finalizeExchange(next));
  }
  return result;
}

function distributeCost(exchanges, sessionCost) {
  const cost = num(sessionCost);
  const grandTotal = exchanges.reduce((acc, ex) => acc + ex.tokens.total, 0);
  for (const ex of exchanges) {
    ex.costEstimate = grandTotal > 0 ? cost * (ex.tokens.total / grandTotal) : 0;
    for (const t of ex.turns) {
      t.costEstimate = grandTotal > 0 ? cost * (t.tokens.total / grandTotal) : 0;
    }
  }
  return exchanges;
}

function parseByClient(client, text) {
  if (client === 'claude') return parseClaudeTranscript(text);
  if (client === 'codebuddy') return parseCodebuddyTranscript(text);
  if (client === 'codex') return parseCodexTranscript(text);
  return [];
}

function totalsOf(exchanges, sessionCost) {
  const totalTokens = exchanges.reduce((acc, ex) => acc + ex.tokens.total, 0);
  const turnCount = exchanges.reduce((acc, ex) => acc + ex.turnCount, 0);
  return { totalTokens, costUsd: num(sessionCost), exchangeCount: exchanges.length, turnCount };
}

// OpenCode reports a real cost per assistant message, so exchanges use the true per-turn
// cost (summed) rather than the proportional split Claude/Codex need.
function sumRealCost(exchanges) {
  for (const ex of exchanges) {
    let cost = 0;
    for (const t of ex.turns) cost += num(t.costEstimate);
    ex.costEstimate = cost;
  }
  return exchanges;
}

function readOpenCodeSessionDetail({ sessionId, period = 'total', deps = {} }) {
  const { found, events, sessionCost } = opencodeSession.readSessionEvents(sessionId, deps);
  if (!found) return { found: false, client: 'opencode', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  const now = new Date((deps.now || Date.now)());
  const grouped = sumRealCost(filterExchangesByPeriod(groupEvents(events), period, now));
  const filteredCost = grouped.reduce((acc, ex) => acc + num(ex.costEstimate), 0);
  return { found: true, client: 'opencode', sessionId, period, exchanges: grouped, totals: totalsOf(grouped, filteredCost) };
}

function readReasonixSessionDetail({ sessionId, period = 'total', home, deps = {} }) {
  const result = readReasonixSessionEvents({
    sessionId,
    home,
    env: deps.env || process.env,
    platform: deps.platform || process.platform,
    cwdDir: deps.cwdDir || process.cwd(),
    fsModule: deps.fsModule,
    pathModule: deps.pathModule
  });
  if (!result.found) return { found: false, client: 'reasonix', sessionId, period, exchanges: [], totals: totalsOf([], 0) };

  const now = new Date(deps.now || Date.now());
  const grouped = filterExchangesByPeriod(groupEvents(result.events), period, now);
  // Reasonix's reported session cost belongs to the native-session sidecar.
  // It is intentionally not promoted to the generic Session Detail cost.
  const tokenDataAvailable = result.tokenDataAvailable === true;
  return {
    found: true,
    client: 'reasonix',
    sessionId,
    period,
    exchanges: grouped,
    totals: totalsOf(grouped, 0),
    tokensAvailable: tokenDataAvailable,
    tokenDataUnavailable: !tokenDataAvailable
  };
}

// CodeBuddy conversations from the VS Code extension live in the extension's
// own store, not in a transcript file, so the generic file path below answers
// nothing for them. One reported trace id is one request: its user messages
// are the exchange's prompts and the request's own usage is its single turn —
// the client counts the same way (one usage-bearing request, one message).
function readCodebuddyExtensionSessionDetail({ sessionId, period, sessionCost, home, env, deps = {} }) {
  const session = codebuddyExtension.findExtensionSession(sessionId, {
    homeDir: home,
    env,
    platform: deps.platform,
    fs: deps.fs,
    dataRoots: deps.codebuddyExtensionDataRoots
  });
  if (!session) {
    return { found: false, client: 'codebuddy', sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }

  const events = [];
  for (const entry of session.entries) {
    if (entry.role !== 'user') continue;
    // The client keeps the prompt the user actually saw beside the
    // context-wrapped payload; the fallback is that payload's own text.
    const prompt = cleanPromptText(entry.displayText || entry.text);
    if (!prompt) continue;
    events.push({ kind: 'prompt', timestamp: codebuddyTimestamp(entry.createdAt), text: prompt });
  }
  const usage = session.usage || {};
  const cacheRead = num(usage.cacheTokens);
  const cacheWrite = num(usage.cachedWriteTokens);
  // `cachedMissTokens` is what the client reports as uncached input, and it is
  // exactly `inputTokens` minus the cache fields; the subtraction is the
  // fallback for a record that states only the totals. Reading the gross
  // `inputTokens` as input would count the cached part twice — the same
  // convention the CLI transcript's `prompt_tokens` follows.
  const input = num(usage.cachedMissTokens) || Math.max(0, num(usage.inputTokens) - cacheRead - cacheWrite);
  events.push({
    kind: 'turn',
    timestamp: codebuddyTimestamp(session.startedAt),
    tokens: makeTokens({ input, output: num(usage.outputTokens), cacheRead, cacheWrite, reasoning: 0 }),
    tools: []
  });

  const now = new Date((deps.now || Date.now)());
  const grouped = filterExchangesByPeriod(groupEvents(events), period, now);
  distributeCost(grouped, sessionCost);
  return { found: true, client: 'codebuddy', sessionId, period, exchanges: grouped, totals: totalsOf(grouped, sessionCost) };
}

function readSessionDetail({ client, sessionId, period = 'total', sessionCost = 0, home, env, useEnvRoots, deps = {} }) {
  if (client === 'opencode') return readOpenCodeSessionDetail({ sessionId, period, deps });
  if (client === 'reasonix') return readReasonixSessionDetail({ sessionId, period, home, deps });
  const filePath = resolveSessionFile(client, sessionId, home, { env, useEnvRoots });
  if (!filePath && client === 'codebuddy') {
    return readCodebuddyExtensionSessionDetail({ sessionId, period, sessionCost, home, env, deps });
  }
  if (!filePath) return { found: false, client, sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  let text;
  try { text = fs.readFileSync(filePath, 'utf8'); } catch (_) {
    return { found: false, client, sessionId, period, exchanges: [], totals: totalsOf([], sessionCost) };
  }
  const events = parseByClient(client, text);
  const now = new Date((deps.now || Date.now)());
  const grouped = filterExchangesByPeriod(groupEvents(events), period, now);
  distributeCost(grouped, sessionCost);
  return { found: true, client, sessionId, period, exchanges: grouped, totals: totalsOf(grouped, sessionCost) };
}

module.exports = {
  parseClaudeTranscript,
  parseCodebuddyTranscript,
  parseCodexTranscript,
  makeTokens,
  readCodebuddyExtensionSessionDetail,
  groupEvents,
  filterExchangesByPeriod,
  distributeCost,
  readReasonixSessionDetail,
  readSessionDetail
};
