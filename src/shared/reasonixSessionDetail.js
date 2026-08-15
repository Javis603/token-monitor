'use strict';

// Reasonix's native session transcript is a Node-only sidecar.  Keep this
// adapter separate from the aggregate stats scanner: Tokscale remains the
// aggregate authority, while this module only turns one native event log into
// the canonical prompt/turn events consumed by sessionDetail.js.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { StringDecoder } = require('node:string_decoder');

const { readBoundedJson, REASONIX_META_MAX_BYTES } = require('./reasonixFileIo');
const { resolveReasonixHome } = require('./reasonixPaths');

const SESSION_PREFIX = 'reasonix:';
const META_SUFFIX = '.jsonl.meta';
const LEGACY_META_SUFFIX = '.meta.json';
const EVENTS_SUFFIX = '.events.jsonl';
const REASONIX_EVENT_REPLAY_LIMITS = Object.freeze({
  maxBytes: 128 << 20,
  maxRecords: 100_000,
  maxMessages: 100_000,
  maxCollectionItems: 100_000
});
const REASONIX_EVENT_REPLAY_PROBE_MAX_BYTES = 4 << 10;
const REASONIX_EVENT_READ_CHUNK_BYTES = 64 << 10;
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

function snapshotEvents(messages) {
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

function createTypedReplayState() {
  return {
    events: [],
    toolsByTurn: new Map(),
    pendingTools: []
  };
}

const LEGACY_TYPED_EVENT_TYPES = new Set([
  'model.final',
  'model_final',
  'model.turn.started',
  'user.message',
  'user_message'
]);

function isLegacyTypedEventType(type) {
  return LEGACY_TYPED_EVENT_TYPES.has(type) || type.startsWith('tool.');
}

function schemaVersionField(source) {
  if (objectValue(source)) {
    for (const key of ['schema_version', 'schemaVersion']) {
      if (Object.hasOwn(source, key)) return { present: true, value: source[key] };
    }
  }
  return { present: false, value: undefined };
}

function consumeTypedRecord(state, record, recordTimestamp) {
  const { events, toolsByTurn, pendingTools } = state;

  function addTools(turn, names) {
    const clean = uniqueTools(names);
    if (clean.length === 0) return;
    const key = turn || '__pending__';
    const current = toolsByTurn.get(key) || [];
    toolsByTurn.set(key, uniqueTools(current.concat(clean)));
    if (!turn) pendingTools.push(...clean);
  }

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
    return;
  }

  if (type.startsWith('tool.')) {
    addTools(turn, [toolName(payload), toolName(payload.toolCall), toolName(payload.tool_call)]);
    return;
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

function normalizeReplayLimits(overrides = {}) {
  const limits = { ...REASONIX_EVENT_REPLAY_LIMITS };
  for (const key of Object.keys(limits)) {
    const value = Number(overrides[key]);
    if (Number.isFinite(value) && value >= 0) limits[key] = Math.floor(value);
  }
  return limits;
}

class ReplayLimitExceeded extends Error {
  constructor(resource, value, limit) {
    super(`Reasonix event replay ${resource} limit exceeded`);
    this.name = 'ReplayLimitExceeded';
    this.resource = resource;
    this.value = value;
    this.limit = limit;
  }
}

function skipJsonWhitespace(text, state) {
  while (state.index < text.length && /\s/.test(text[state.index])) state.index += 1;
}

function parseJsonString(text, state, decode = false) {
  const start = state.index;
  if (text[state.index] !== '"') throw new SyntaxError('JSON string expected');
  state.index += 1;
  while (state.index < text.length) {
    const code = text.charCodeAt(state.index);
    const character = text[state.index];
    state.index += 1;
    if (character === '"') return decode ? JSON.parse(text.slice(start, state.index)) : '';
    if (character === '\\') {
      if (state.index >= text.length) throw new SyntaxError('JSON escape is truncated');
      const escape = text[state.index];
      state.index += 1;
      if (escape === 'u') {
        if (!/^[0-9a-fA-F]{4}$/.test(text.slice(state.index, state.index + 4))) {
          throw new SyntaxError('JSON unicode escape is invalid');
        }
        state.index += 4;
      } else if (!'"\\/bfnrt'.includes(escape)) {
        throw new SyntaxError('JSON escape is invalid');
      }
    } else if (code < 0x20) {
      throw new SyntaxError('JSON string contains a control character');
    }
  }
  throw new SyntaxError('JSON string is truncated');
}

function parseJsonNumber(text, state) {
  const start = state.index;
  if (text[state.index] === '-') state.index += 1;
  if (text[state.index] === '0') {
    state.index += 1;
  } else {
    if (!/[1-9]/.test(text[state.index] || '')) throw new SyntaxError('JSON number is invalid');
    while (/[0-9]/.test(text[state.index] || '')) state.index += 1;
  }
  if (text[state.index] === '.') {
    state.index += 1;
    if (!/[0-9]/.test(text[state.index] || '')) throw new SyntaxError('JSON number fraction is invalid');
    while (/[0-9]/.test(text[state.index] || '')) state.index += 1;
  }
  if (text[state.index] === 'e' || text[state.index] === 'E') {
    state.index += 1;
    if (text[state.index] === '+' || text[state.index] === '-') state.index += 1;
    if (!/[0-9]/.test(text[state.index] || '')) throw new SyntaxError('JSON number exponent is invalid');
    while (/[0-9]/.test(text[state.index] || '')) state.index += 1;
  }
  if (state.index === start) throw new SyntaxError('JSON number is empty');
}

function preflightJsonValue(text, limits) {
  const state = { index: 0, messageCount: 0, collectionItems: 0, type: '' };

  function parseValue({ insideMessage = false, messageArray = false, root = false } = {}) {
    skipJsonWhitespace(text, state);
    const character = text[state.index];
    if (character === '"') {
      parseJsonString(text, state);
      return;
    }
    if (character === '{') {
      state.index += 1;
      skipJsonWhitespace(text, state);
      if (text[state.index] === '}') {
        state.index += 1;
        return;
      }
      while (state.index < text.length) {
        skipJsonWhitespace(text, state);
        const keyStart = state.index + 1;
        parseJsonString(text, state);
        const key = text.slice(keyStart, state.index - 1);
        skipJsonWhitespace(text, state);
        if (text[state.index] !== ':') throw new SyntaxError('JSON object colon is missing');
        state.index += 1;
        const isRootEventType = root && ['event_type', 'eventType', 'kind', 'type'].includes(key);
        if (isRootEventType) {
          skipJsonWhitespace(text, state);
          if (text[state.index] === '"') {
            state.type = String(parseJsonString(text, state, true) || '').toLowerCase();
          } else {
            parseValue({ insideMessage });
          }
        } else {
          parseValue({ insideMessage, messageArray: key === 'messages' && !insideMessage });
        }
        skipJsonWhitespace(text, state);
        if (text[state.index] === '}') {
          state.index += 1;
          return;
        }
        if (text[state.index] !== ',') throw new SyntaxError('JSON object separator is missing');
        state.index += 1;
      }
      throw new SyntaxError('JSON object is truncated');
    }
    if (character === '[') {
      state.index += 1;
      skipJsonWhitespace(text, state);
      if (text[state.index] === ']') {
        state.index += 1;
        return;
      }
      while (state.index < text.length) {
        if (messageArray && !insideMessage) {
          state.messageCount += 1;
          if (state.messageCount > limits.maxMessages) {
            throw new ReplayLimitExceeded('messages', state.messageCount, limits.maxMessages);
          }
          parseValue({ insideMessage: true });
        } else {
          state.collectionItems += 1;
          if (state.collectionItems > limits.maxCollectionItems) {
            throw new ReplayLimitExceeded('message_collection_items', state.collectionItems, limits.maxCollectionItems);
          }
          parseValue({ insideMessage });
        }
        skipJsonWhitespace(text, state);
        if (text[state.index] === ']') {
          state.index += 1;
          return;
        }
        if (text[state.index] !== ',') throw new SyntaxError('JSON array separator is missing');
        state.index += 1;
      }
      throw new SyntaxError('JSON array is truncated');
    }
    if (text.startsWith('true', state.index)) {
      state.index += 4;
      return;
    }
    if (text.startsWith('false', state.index)) {
      state.index += 5;
      return;
    }
    if (text.startsWith('null', state.index)) {
      state.index += 4;
      return;
    }
    parseJsonNumber(text, state);
  }

  parseValue({ root: true });
  skipJsonWhitespace(text, state);
  if (state.index !== text.length) throw new SyntaxError('JSON has trailing data');
  return state;
}

function createReplayState() {
  return {
    sawData: false,
    records: 0,
    damaged: false,
    unsafe: false,
    format: '',
    snapshot: {
      saw: false,
      applied: false,
      stopped: false,
      messages: [],
      collectionItems: 0
    },
    typed: createTypedReplayState()
  };
}

function consumeReplayLine(state, line, limits) {
  const trimmed = line.trim();
  if (!trimmed || state.damaged || state.unsafe) return null;
  state.sawData = true;
  if (state.records >= limits.maxRecords) {
    return new ReplayLimitExceeded('event_records', state.records + 1, limits.maxRecords);
  }

  let preflight;
  try {
    preflight = preflightJsonValue(trimmed, limits);
  } catch (error) {
    if (error instanceof ReplayLimitExceeded) return error;
    state.damaged = true;
    return null;
  }

  // Match Reasonix's wire replay: include the already-applied snapshot in the
  // limit check before JSON.parse can materialize this append's messages.
  if (state.snapshot.saw && preflight.type === 'append') {
    const messageCount = state.snapshot.messages.length + preflight.messageCount;
    if (messageCount > limits.maxMessages) {
      return new ReplayLimitExceeded('messages', messageCount, limits.maxMessages);
    }
    const collectionItems = state.snapshot.collectionItems + preflight.collectionItems;
    if (collectionItems > limits.maxCollectionItems) {
      return new ReplayLimitExceeded('message_collection_items', collectionItems, limits.maxCollectionItems);
    }
  }

  let record;
  try {
    record = JSON.parse(trimmed);
  } catch (_) {
    state.damaged = true;
    return null;
  }
  if (!objectValue(record)) {
    state.damaged = true;
    return null;
  }
  state.records += 1;
  if (state.snapshot.stopped) return null;

  const payload = eventPayload(record);
  const type = eventType(record, payload);
  const rootType = eventType(record, record);
  const rootSchemaVersion = schemaVersionField(record);
  const nestedSchemaVersion = payload === record
    ? { present: false, value: undefined }
    : schemaVersionField(payload);
  const nativeType = rootType === 'replace' || rootType === 'append';
  const format = rootSchemaVersion.present || nativeType
    ? 'native'
    : !nestedSchemaVersion.present && isLegacyTypedEventType(type) ? 'legacy' : '';
  if (!format
    || (format === 'native'
      && (!nativeType || rootSchemaVersion.value !== 1 || !Number.isInteger(rootSchemaVersion.value)))
    || (state.format && state.format !== format)) {
    state.unsafe = true;
    state.snapshot.stopped = true;
    return null;
  }
  state.format = format;
  const recordTimestamp = timestampOf(record, format === 'native' ? record : payload, '');

  if (format === 'native') {
    const snapshot = state.snapshot;
    snapshot.saw = true;
    if (record.messages !== undefined && !Array.isArray(record.messages)) {
      state.damaged = true;
      snapshot.stopped = true;
      return null;
    }
    const incoming = Array.isArray(record.messages) ? record.messages : [];
    if (rootType === 'replace') {
      snapshot.messages = incoming.map((message) => ({ message, fallback: '' }));
      snapshot.collectionItems = preflight.collectionItems;
      snapshot.applied = true;
      return null;
    }
    const index = firstValue([record], ['message_index']);
    if (typeof index !== 'number' || !Number.isInteger(index) || index < 0 || index !== snapshot.messages.length) {
      state.damaged = true;
      snapshot.stopped = true;
      return null;
    }
    snapshot.messages.push(...incoming.map((message) => ({ message, fallback: recordTimestamp || '' })));
    snapshot.collectionItems += preflight.collectionItems;
    snapshot.applied = true;
    return null;
  }

  consumeTypedRecord(state.typed, record, recordTimestamp);
  return null;
}

function replayResult(state, failure = null) {
  const events = state.snapshot.saw
    ? state.snapshot.applied ? snapshotEvents(state.snapshot.messages) : []
    : state.typed.events;
  const damagedWithoutPrefix = state.damaged && state.records === 0;
  return {
    ok: !failure && !state.unsafe && !damagedWithoutPrefix,
    events,
    records: state.records,
    damaged: state.damaged,
    ...(failure ? {
      reason: 'limit',
      resource: failure.resource,
      value: failure.value,
      limit: failure.limit
    } : {})
  };
}

function replayText(text, limits) {
  const state = createReplayState();
  const source = String(text || '');
  let start = 0;
  for (let index = 0; index <= source.length; index += 1) {
    if (index !== source.length && source[index] !== '\n') continue;
    const failure = consumeReplayLine(state, source.slice(start, index), limits);
    if (failure || state.damaged || state.unsafe) return replayResult(state, failure);
    start = index + 1;
  }
  return replayResult(state);
}

function parseReasonixEventLog(text, options = {}) {
  const limits = normalizeReplayLimits(options.limits || options.replayLimits);
  if (Buffer.byteLength(String(text || ''), 'utf8') > limits.maxBytes) return [];
  return replayText(text, limits).events;
}

function readReasonixEventLog(filePath, options = {}) {
  const limits = normalizeReplayLimits(options.replayLimits || options.limits);
  const fsApi = options.fsModule || fs;
  let stat;
  try {
    stat = fsApi.statSync(filePath);
    if (!stat.isFile()) return { ok: false, events: [] };
    if (stat.size > limits.maxBytes) {
      return replayResult(createReplayState(), new ReplayLimitExceeded('encoded_bytes', stat.size, limits.maxBytes));
    }
  } catch (_) {
    return { ok: false, events: [] };
  }
  if (typeof fsApi.openSync !== 'function' || typeof fsApi.readSync !== 'function') {
    return { ok: false, events: [] };
  }

  const state = createReplayState();
  const decoder = new StringDecoder('utf8');
  const buffer = Buffer.allocUnsafe(REASONIX_EVENT_READ_CHUNK_BYTES);
  const pendingFragments = [];
  let encodedBytes = 0;
  let fileDescriptor;
  const consumeDecodedChunk = (decoded) => {
    let start = 0;
    let newline;
    while ((newline = decoded.indexOf('\n', start)) >= 0) {
      pendingFragments.push(decoded.slice(start, newline));
      const failure = consumeReplayLine(state, pendingFragments.join(''), limits);
      pendingFragments.length = 0;
      if (failure) return failure;
      if (state.damaged || state.unsafe) return null;
      start = newline + 1;
    }
    if (start < decoded.length) pendingFragments.push(decoded.slice(start));
    return null;
  };
  try {
    fileDescriptor = fsApi.openSync(filePath, 'r');
    while (!state.damaged && !state.unsafe) {
      const bytesRead = fsApi.readSync(fileDescriptor, buffer, 0, buffer.length, null);
      if (bytesRead === 0) break;
      encodedBytes += bytesRead;
      if (encodedBytes > limits.maxBytes) {
        return replayResult(state, new ReplayLimitExceeded('encoded_bytes', encodedBytes, limits.maxBytes));
      }
      const failure = consumeDecodedChunk(decoder.write(buffer.subarray(0, bytesRead)));
      if (failure) return replayResult(state, failure);
    }
    if (!state.damaged && !state.unsafe) {
      const chunkFailure = consumeDecodedChunk(decoder.end());
      if (chunkFailure) return replayResult(state, chunkFailure);
      const failure = consumeReplayLine(state, pendingFragments.join(''), limits);
      if (failure) return replayResult(state, failure);
    }
    return replayResult(state);
  } catch (_) {
    return { ok: false, events: [] };
  } finally {
    if (fileDescriptor !== undefined) {
      try { fsApi.closeSync(fileDescriptor); } catch (_) {}
    }
  }
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
      const meta = readBoundedJson(metaPath, REASONIX_META_MAX_BYTES, fsApi);
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
    const replay = readReasonixEventLog(eventsPath, {
      fsModule: options.fsModule,
      replayLimits: options.replayLimits
    });
    if (!replay.ok) return { found: false, events: [] };
    const events = replay.events;
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
  readReasonixEventLog,
  readReasonixSessionEvents,
  REASONIX_EVENT_REPLAY_LIMITS,
  REASONIX_EVENT_REPLAY_PROBE_MAX_BYTES,
  reasonixTokens,
  stableId,
  countReasonixProviderMessages,
  tokenDataAvailable
};
