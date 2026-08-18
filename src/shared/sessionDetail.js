'use strict';

const fs = require('node:fs');
const { resolveSessionFile } = require('./sessionFiles');
const opencodeSession = require('./opencodeSession');
const { readReasonixSessionEvents } = require('./reasonixSessionDetail');

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
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
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
      if (label) events.push({ kind: 'prompt', timestamp: obj.timestamp || '', text: label });
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
  ex.turnCount = ex.turns.length;
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

function readSessionDetail({ client, sessionId, period = 'total', sessionCost = 0, home, deps = {} }) {
  if (client === 'opencode') return readOpenCodeSessionDetail({ sessionId, period, deps });
  if (client === 'reasonix') return readReasonixSessionDetail({ sessionId, period, home, deps });
  const filePath = resolveSessionFile(client, sessionId, home);
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
  parseCodexTranscript,
  makeTokens,
  groupEvents,
  filterExchangesByPeriod,
  distributeCost,
  readReasonixSessionDetail,
  readSessionDetail
};
