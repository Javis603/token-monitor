'use strict';

// Reasonix's native session transcript is a Node-only sidecar.  Keep this
// adapter separate from the aggregate stats scanner: Tokscale remains the
// aggregate authority, while this module only turns one native event log into
// the canonical prompt/turn events consumed by sessionDetail.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const { resolveReasonixHome } = require('./reasonixPaths');

const SESSION_PREFIX = 'reasonix:';
const META_SUFFIX = '.jsonl.meta';
const LEGACY_META_SUFFIX = '.meta.json';
const EVENTS_SUFFIX = '.events.jsonl';
const TRANSIENT_USER_BLOCK_TAGS = [
  'response-language',
  'reasoning-language',
  'memory-update',
  'background-jobs',
  'active-goal',
  'autoresearch-runtime',
  'hook-context',
  'capability-route',
  'interrupted-turn-recovery'
];
const SYNTHETIC_PROMPT_PREFIXES = [
  '<reasoning-language>',
  'Plan approved — plan mode is off',
  'Host final-answer readiness check failed',
  'You are already in the executor phase',
  'The previous assistant response was interrupted while a tool call',
  'The previous assistant response was interrupted during streaming',
  'The previous assistant response was interrupted before visible',
  'The previous assistant response finished without any visible answer',
  '<compaction-summary>',
  'Summary of the later conversation (compacted from here on):',
  'Summary of earlier conversation (compacted up to here):',
  'Continue pursuing the active goal',
  'The agent signaled goal completion and all tasks are marked done.'
];

function objectValue(value) {
  return value && typeof value === 'object' && !Array.isArray(value) ? value : null;
}

function textValue(value, maxLength = 4096) {
  if (typeof value !== 'string') return '';
  const text = value.trim();
  return text ? text.slice(0, maxLength) : '';
}

function finiteNumber(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value.replace(/[$,]/g, ''));
    if (Number.isFinite(parsed)) return parsed;
  }
  return 0;
}

function hasNumber(value) {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value.replace(/[$,]/g, '')));
}

function firstValue(sources, keys) {
  for (const source of sources || []) {
    const value = objectValue(source);
    if (!value) continue;
    for (const key of keys) {
      if (Object.prototype.hasOwnProperty.call(value, key)) return value[key];
    }
  }
  return undefined;
}

function firstNumber(sources, keys) {
  const value = firstValue(sources, keys);
  return hasNumber(value) ? Math.max(0, finiteNumber(value)) : 0;
}

function firstText(sources, keys, maxLength = 4096) {
  const value = firstValue(sources, keys);
  return textValue(value, maxLength);
}

function dateFromValue(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (typeof value === 'number' && Number.isFinite(value)) {
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text) return null;
  // provider.Message.CreatedAt is Unix milliseconds. Treat an all-numeric
  // string the same way for old JSON bridges, while keeping ISO strings intact.
  if (/^[+-]?\d+$/.test(text)) {
    const date = new Date(Number(text));
    if (!Number.isNaN(date.getTime())) return date;
  }
  const date = new Date(text);
  return Number.isNaN(date.getTime()) ? null : date;
}

function timestampValue(value, fallback = '') {
  const date = dateFromValue(value);
  return date ? date.toISOString() : fallback;
}

function uniqueTools(tools) {
  return [...new Set((tools || []).map((tool) => textValue(tool, 256)).filter(Boolean))];
}

function namespaceId(sessionId) {
  const value = textValue(sessionId, 512);
  if (!value.startsWith(SESSION_PREFIX)) return '';
  return value.slice(SESSION_PREFIX.length).trim();
}

function stableId(meta) {
  const root = objectValue(meta);
  if (!root) return '';
  const nested = [
    root.BranchMeta,
    root.branchMeta,
    root.branch_meta,
    root.branch
  ];
  return textValue(firstValue([root, ...nested], ['id', 'ID']), 512);
}

function timestampOf(record, payload, fallback = '') {
  const value = firstValue([record, payload], ['ts', 'timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt']);
  return timestampValue(value, fallback);
}

function eventPayload(record) {
  return objectValue(record?.payload) || objectValue(record?.data) || record;
}

function eventType(record, payload) {
  const direct = textValue(firstValue([record], ['event_type', 'eventType', 'kind', 'type'])).toLowerCase();
  if (direct && direct !== 'event') return direct;
  return textValue(firstValue([payload], ['event_type', 'eventType', 'kind', 'type'])).toLowerCase();
}

function eventTurn(record, payload) {
  const value = firstValue([record, payload], ['turn', 'turn_id', 'turnId']);
  return value === undefined || value === null ? '' : String(value);
}

function cleanPromptText(value) {
  let text = unwrapMemoryCompilerExecution(String(value || ''));
  // These blocks are prepended by Reasonix's controller, not typed by the
  // user. Keep the list deliberately narrow and anchored: a user discussing
  // an XML tag in ordinary prose must not lose the rest of their message.
  const transientTags = TRANSIENT_USER_BLOCK_TAGS.join('|');
  const leadingBlock = new RegExp(`^\\s*<(?:${transientTags})(?:\\s+[^>]*)?>[\\s\\S]*?<\\/(?:${transientTags})>\\s*`, 'i');
  for (let i = 0; i < 24; i += 1) {
    const next = text.replace(leadingBlock, '');
    if (next === text) break;
    text = next;
  }
  // Delivery mode and memory recall are suffix wrappers in the official
  // runtime. Only remove them at the end of the message.
  text = text.replace(/\s*<delivery-runtime>[\s\S]*?<\/delivery-runtime>\s*$/i, '');
  text = text.replace(/\s*<memory-recall>[\s\S]*?<\/memory-recall>\s*$/i, '');
  return text
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 20000);
}

function unwrapMemoryCompilerExecution(value) {
  let text = value;
  const block = /<memory-compiler-execution>\s*([\s\S]*?)\s*<\/memory-compiler-execution>/i;
  for (let depth = 0; depth < 24; depth += 1) {
    const match = block.exec(text);
    if (!match) break;
    let sourceEvent = '';
    try {
      const contract = JSON.parse(match[1]);
      sourceEvent = textValue(contract?.planner_ir?.source_event || contract?.source_event, 20000);
    } catch (_) {}
    text = `${text.slice(0, match.index)}${sourceEvent}${text.slice(match.index + match[0].length)}`;
  }
  const dangling = text.indexOf('<memory-compiler-execution>');
  if (dangling >= 0) text = text.slice(0, dangling);
  return text;
}

function isSyntheticPrompt(text) {
  const value = String(text || '').trim();
  return SYNTHETIC_PROMPT_PREFIXES.some((prefix) => value.startsWith(prefix));
}

function messageContentText(value) {
  if (typeof value === 'string') return cleanPromptText(value);
  if (Array.isArray(value)) {
    return cleanPromptText(value.map(messageContentText).filter(Boolean).join(' '));
  }
  const source = objectValue(value);
  if (!source) return '';
  const text = source.text ?? source.content ?? source.value;
  return typeof text === 'string' ? cleanPromptText(text) : '';
}

function messageText(message) {
  if (typeof message === 'string') return cleanPromptText(message);
  if (Array.isArray(message)) {
    return cleanPromptText(message.map((part) => messageText(part)).filter(Boolean).join(' '));
  }
  const value = objectValue(message) || {};
  // RawContent is the user-authored input. Content is provider-visible and
  // may contain controller-injected context, so it is only a fallback.
  for (const key of ['raw_content', 'rawContent', 'content', 'text']) {
    const text = messageContentText(value[key]);
    if (text) return text;
  }
  return '';
}

function toolName(value) {
  if (typeof value === 'string') return textValue(value, 256);
  const source = objectValue(value);
  if (!source) return '';
  const direct = firstText([source], ['name', 'tool_name', 'toolName', 'tool'], 256);
  if (direct) return direct;
  const nestedTool = objectValue(source.tool);
  const nestedName = firstText([nestedTool], ['name', 'tool_name', 'toolName'], 256);
  if (nestedName) return nestedName;
  const functionValue = objectValue(source.function);
  return firstText([functionValue], ['name'], 256);
}

function toolNames(value) {
  if (!Array.isArray(value)) return [];
  return uniqueTools(value.flatMap((item) => {
    const name = toolName(item);
    return name ? [name] : [];
  }));
}

function usageObject(record, payload) {
  return objectValue(firstValue([payload, record], ['usage', 'token_usage', 'tokenUsage'])) || null;
}

function reasonixTokens(record, payload) {
  const usage = usageObject(record, payload);
  const sources = [usage, payload, record];
  const prompt = firstNumber(sources, ['promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens']);
  const cacheRead = firstNumber(sources, [
    'cacheHitTokens', 'cache_hit_tokens', 'promptCacheHitTokens', 'prompt_cache_hit_tokens',
    'cacheReadTokens', 'cache_read_tokens', 'cachedInputTokens', 'cached_input_tokens'
  ]);
  const cacheMissValue = firstValue(sources, [
    'cacheMissTokens', 'cache_miss_tokens', 'promptCacheMissTokens', 'prompt_cache_miss_tokens',
    'cacheMiss', 'cache_miss'
  ]);
  const cacheMiss = hasNumber(cacheMissValue)
    ? Math.max(0, finiteNumber(cacheMissValue))
    : Math.max(0, prompt - cacheRead);
  const output = firstNumber(sources, ['completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens']);
  const cacheWrite = firstNumber(sources, [
    'cacheWriteTokens', 'cache_write_tokens', 'promptCacheWriteTokens', 'prompt_cache_write_tokens'
  ]);
  const reasoning = firstNumber(sources, [
    'reasoningTokens', 'reasoning_tokens', 'reasoningOutputTokens', 'reasoning_output_tokens'
  ]);

  // Reasonix reports reasoningTokens as a subset of completion.  Keep it in
  // the canonical informational field, but never add it to the closed total.
  return {
    input: cacheMiss,
    output,
    cacheRead,
    cacheWrite,
    reasoning,
    total: cacheMiss + output + cacheRead + cacheWrite
  };
}

function emptyTokens() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 0 };
}

function hasUsageData(record, payload) {
  const usage = usageObject(record, payload);
  if (!usage) return false;
  return [
    'promptTokens', 'prompt_tokens', 'inputTokens', 'input_tokens',
    'completionTokens', 'completion_tokens', 'outputTokens', 'output_tokens',
    'totalTokens', 'total_tokens', 'cacheHitTokens', 'cache_hit_tokens',
    'cacheReadTokens', 'cache_read_tokens', 'cacheWriteTokens', 'cache_write_tokens',
    'reasoningTokens', 'reasoning_tokens', 'reasoningOutputTokens', 'reasoning_output_tokens'
  ].some((key) => Object.prototype.hasOwnProperty.call(usage, key));
}

function messageTimestamp(message, fallback) {
  const value = firstValue([message], ['ts', 'timestamp', 'created_at', 'createdAt', 'updated_at', 'updatedAt']);
  return timestampValue(value, fallback);
}

function messageToolNames(message) {
  const source = objectValue(message) || {};
  return uniqueTools([
    ...toolNames(source.tool_calls),
    ...toolNames(source.toolCalls),
    ...toolNames(source.tools)
  ]);
}

function snapshotMessages(records) {
  let messages = [];
  let sawSnapshot = false;
  let appliedSnapshot = false;
  for (const { record, timestamp: recordTimestamp } of records) {
    const type = eventType(record, record);
    if (type !== 'replace' && type !== 'append') {
      // Once a native snapshot stream starts, an unknown record is damage, not
      // a reason to reinterpret the remainder as a different transcript format.
      if (sawSnapshot || Object.prototype.hasOwnProperty.call(record, 'schema_version')) break;
      continue;
    }
    sawSnapshot = true;
    const payload = eventPayload(record);
    const schemaVersion = firstValue([payload, record], ['schema_version', 'schemaVersion']);
    if (typeof schemaVersion !== 'number' || !Number.isInteger(schemaVersion) || schemaVersion !== 1) break;
    if (payload?.messages !== undefined && !Array.isArray(payload.messages)) break;
    const incoming = Array.isArray(payload?.messages) ? payload.messages : [];
    if (type === 'replace') {
      messages = incoming.map((message) => ({ message, fallback: '' }));
      appliedSnapshot = true;
      continue;
    }
    const index = firstValue([payload, record], ['message_index']);
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index !== messages.length) break;
    messages.push(...incoming.map((message) => ({ message, fallback: recordTimestamp || '' })));
    appliedSnapshot = true;
  }
  if (!sawSnapshot) return null;
  if (!appliedSnapshot) return [];

  const events = [];
  for (const { message, fallback } of messages) {
    const source = objectValue(message);
    if (!source) continue;
    const role = textValue(source.role || source.kind, 32).toLowerCase();
    const timestamp = messageTimestamp(source, fallback);
    if (role === 'user') {
      const text = messageText(source);
      if (text && source.internal !== true && source.synthetic !== true && !isSyntheticPrompt(text)) {
        events.push({ kind: 'prompt', timestamp, text });
      }
    } else if (role === 'assistant' || role === 'model') {
      if (source.local_only === true || source.localOnly === true) continue;
      events.push({
        kind: 'turn',
        timestamp,
        tokens: emptyTokens(),
        tokensAvailable: false,
        tools: messageToolNames(source)
      });
    }
  }
  return events;
}

function typedEvents(records) {
  const events = [];
  const toolsByTurn = new Map();
  const pendingTools = [];

  function addTools(turn, names) {
    const clean = uniqueTools(names);
    if (clean.length === 0) return;
    const key = turn || '__pending__';
    const current = toolsByTurn.get(key) || [];
    toolsByTurn.set(key, uniqueTools(current.concat(clean)));
    if (!turn) pendingTools.push(...clean);
  }

  for (const { record, timestamp: recordTimestamp } of records) {
    const payload = eventPayload(record);
    const type = eventType(record, payload);
    const timestamp = timestampOf(record, payload, recordTimestamp || '');
    const turn = eventTurn(record, payload);

    if (type === 'user.message' || type === 'user_message') {
      const rawText = firstValue([payload, record], ['raw_content', 'rawContent', 'content', 'text', 'message']);
      const text = cleanPromptText(typeof rawText === 'string' ? rawText : messageText(rawText));
      if (text && payload.internal !== true && payload.synthetic !== true && !isSyntheticPrompt(text)) {
        events.push({ kind: 'prompt', timestamp, text });
      }
      continue;
    }

    if (type.startsWith('tool.')) {
      addTools(turn, [toolName(payload), toolName(payload.toolCall), toolName(payload.tool_call)]);
      continue;
    }

    if (type === 'model.final' || type === 'model_final') {
      const finalTools = [
        ...toolNames(firstValue([payload, record], ['toolCalls', 'tool_calls', 'tools'])),
        ...((toolName(payload.toolCall) || toolName(payload.tool_call)) ? [toolName(payload.toolCall) || toolName(payload.tool_call)] : [])
      ];
      const turnTools = toolsByTurn.get(turn || '__pending__') || [];
      events.push({
        kind: 'turn',
        timestamp,
        tokens: reasonixTokens(record, payload),
        tokensAvailable: hasUsageData(record, payload),
        tools: uniqueTools(turnTools.concat(pendingTools, finalTools))
      });
      if (turn) toolsByTurn.delete(turn);
      toolsByTurn.delete('__pending__');
      pendingTools.length = 0;
    }
  }
  return events;
}

function parseReasonixEventLog(text) {
  const records = [];
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const record = JSON.parse(trimmed);
      if (!objectValue(record)) break;
      records.push({ record, timestamp: timestampOf(record, record, '') });
    } catch (_) {
      // Match Reasonix replay: a torn/corrupt line ends the trusted prefix.
      break;
    }
  }
  const snapshot = snapshotMessages(records);
  return snapshot || typedEvents(records);
}

function countReasonixProviderMessages(events) {
  // Token Monitor's native session `messageCount` is the provider-message
  // count, not BranchMeta's user-turn count: snapshot replay emits one turn
  // event per assistant/model Message and deliberately excludes user/tool
  // records.
  return (events || []).filter((event) => event && event.kind === 'turn').length;
}

function tokenDataAvailable(events) {
  const turns = (events || []).filter((event) => event && event.kind === 'turn');
  return turns.length > 0 && turns.every((event) => event.tokensAvailable !== false);
}

function readJson(fsApi, filePath) {
  try {
    const value = JSON.parse(fsApi.readFileSync(filePath, 'utf8'));
    return objectValue(value);
  } catch (_) {
    return null;
  }
}

function isFile(fsApi, filePath) {
  try { return fsApi.statSync(filePath).isFile(); } catch (_) { return false; }
}

function sessionDirectories(stateHome, fsApi, pathApi) {
  const directories = [];
  const legacy = pathApi.join(stateHome, 'sessions');
  if (isDirectory(fsApi, legacy)) directories.push(legacy);
  const projects = pathApi.join(stateHome, 'projects');
  if (!isDirectory(fsApi, projects)) return directories;
  let entries;
  try { entries = fsApi.readdirSync(projects, { withFileTypes: true }); } catch (_) { return directories; }
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    if (!entry.isDirectory()) continue;
    const routed = pathApi.join(projects, entry.name, 'sessions');
    if (isDirectory(fsApi, routed)) directories.push(routed);
  }
  return directories;
}

function isDirectory(fsApi, directory) {
  try { return fsApi.statSync(directory).isDirectory(); } catch (_) { return false; }
}

function metaCandidate(name) {
  if (name.endsWith(META_SUFFIX)) return { stem: name.slice(0, -META_SUFFIX.length), priority: 0 };
  if (name.endsWith(LEGACY_META_SUFFIX)) return { stem: name.slice(0, -LEGACY_META_SUFFIX.length), priority: 1 };
  return null;
}

function findSessionEventFile({ sessionId, home, options = {} } = {}) {
  const id = namespaceId(sessionId);
  if (!id) return '';
  const fsApi = options.fsModule || fs;
  const pathApi = options.pathModule || path;
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = home || options.homeDir || os.homedir();
  const cwdDir = options.cwdDir || process.cwd();
  const stateHome = resolveReasonixHome({ env, homeDir, platform, cwdDir });
  for (const directory of sessionDirectories(stateHome, fsApi, pathApi)) {
    let entries;
    try { entries = fsApi.readdirSync(directory, { withFileTypes: true }); } catch (_) { continue; }
    const candidates = entries
      .filter((entry) => entry.isFile())
      .map((entry) => {
        const parsed = metaCandidate(entry.name);
        return parsed ? { ...parsed, name: entry.name } : null;
      })
      .filter(Boolean)
      .sort((left, right) => left.name.localeCompare(right.name) || left.priority - right.priority);
    for (const candidate of candidates) {
      const metaPath = pathApi.join(directory, candidate.name);
      const meta = readJson(fsApi, metaPath);
      if (stableId(meta) !== id) continue;
      const eventsPath = pathApi.join(directory, `${candidate.stem}${EVENTS_SUFFIX}`);
      if (isFile(fsApi, eventsPath)) return eventsPath;
    }
  }
  return '';
}

function readReasonixSessionEvents({ sessionId, home, ...options } = {}) {
  const eventsPath = findSessionEventFile({ sessionId, home, options });
  if (!eventsPath) return { found: false, events: [] };
  try {
    const text = (options.fsModule || fs).readFileSync(eventsPath, 'utf8');
    const events = parseReasonixEventLog(text);
    return {
      found: true,
      events,
      messageCount: countReasonixProviderMessages(events),
      tokenDataAvailable: tokenDataAvailable(events)
    };
  } catch (_) {
    return { found: false, events: [] };
  }
}

module.exports = {
  findSessionEventFile,
  parseReasonixEventLog,
  readReasonixSessionEvents,
  reasonixTokens,
  stableId,
  countReasonixProviderMessages,
  tokenDataAvailable
};
