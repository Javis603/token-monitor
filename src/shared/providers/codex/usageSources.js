'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { findSessionFiles, isSafeSessionId } = require('../../sessionFiles');
const { normalizeModelNameForClient } = require('../../usage');
const { readMagpieUsageLedger } = require('../magpie/usageLedger');

const MAX_FILE_BYTES = 128 * 1024 * 1024;
const MAX_LINE_BYTES = 1024 * 1024;
const MAX_EVENTS = 50000;
const SUBSCRIPTION_PLANS = new Set(['plus', 'pro', 'team', 'business', 'enterprise', 'edu', 'go']);
const SYSTEM_PREFIXES = ['<environment_context>', '<system-reminder>', '<user_instructions>'];
const eventCache = new Map();
const clean = value => typeof value === 'string' ? value.trim() : '';
const exactId = value => typeof value === 'string' && value.length > 0 && value.length <= 512
  && value === value.trim() && !/[\x00-\x1f\x7f]/.test(value) ? value : '';
const platformName = value => /^[a-z0-9][a-z0-9._-]{0,63}$/.test(clean(value).toLowerCase()) ? clean(value).toLowerCase() : '';
const signature = stat => [stat.dev, stat.ino, stat.size, stat.mtimeMs, stat.ctimeMs].join(':');

function counts(value, complete = false) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const valid = n => Number.isSafeInteger(n) && n >= 0;
  if (!valid(value.input_tokens) || !valid(value.output_tokens)) return null;
  for (const key of ['cached_input_tokens', 'cache_read_input_tokens', 'reasoning_output_tokens', 'cache_write_input_tokens', 'total_tokens']) {
    if (Object.hasOwn(value, key) && !valid(value[key])) return null;
  }
  if (complete && (!Object.hasOwn(value, 'reasoning_output_tokens')
    || !Object.hasOwn(value, 'cached_input_tokens') && !Object.hasOwn(value, 'cache_read_input_tokens'))) return null;
  return [value.input_tokens, value.output_tokens, Math.max(value.cached_input_tokens || 0, value.cache_read_input_tokens || 0),
    value.reasoning_output_tokens || 0];
}
function same(a, b) { return a && b && a.every((value, index) => value === b[index]); }
function modelName(payload) {
  return clean(payload.model_info?.slug) || clean(payload.model) || clean(payload.model_name)
    || clean(payload.info?.model) || clean(payload.info?.model_name);
}
function accountingKey(last, total, turn) { return JSON.stringify([last, total, turn]); }
function scanWindow(flags = [], now = new Date()) {
  let start = 0;
  if (flags.includes('--today')) start = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  else if (flags.includes('--month')) start = new Date(now.getFullYear(), now.getMonth(), 1).getTime();
  else if (flags.includes('--since')) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(flags[flags.indexOf('--since') + 1] || '');
    if (match) start = new Date(+match[1], +match[2] - 1, +match[3]).getTime();
  }
  return { start, end: new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1).getTime() };
}

// This mirrors the pinned native token_count acceptance and timestamp rules for
// attribution only. Neither request records nor the gateway ledger add tokens
// or timing. Exact last + cumulative snapshots associate a response with its
// accepted token_count; a session id, model, creator or nearby time cannot.
async function readEvents(file, signal) {
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size > MAX_FILE_BYTES) return [];
  const cached = eventCache.get(file);
  if (cached?.signature === signature(stat)) return cached.events;
  const events = [], requests = new Map();
  let nativeId = '', provider = '', model = '', turn = '', announcedTurn = false;
  let previous = null, cursor = NaN, unsafe = false;
  const consume = line => {
    let record;
    try { record = JSON.parse(line); } catch (_) { return; }
    const payload = record?.payload;
    if (!payload || typeof payload !== 'object') return;
    const at = Date.parse(record.timestamp);
    if (record.type === 'session_meta') {
      nativeId = exactId(payload.id);
      provider = platformName(payload.model_provider);
      // Fork replay has global native dedup semantics. Leave these files to the
      // existing unknown bucket rather than attribute inherited parent usage.
      if (payload.forked_from_id || payload.source?.subagent) unsafe = true;
      return;
    }
    if (record.type === 'event_msg' && payload.type === 'task_started') {
      turn = exactId(payload.turn_id); announcedTurn = !!turn;
    }
    if (record.type === 'turn_context') {
      if (exactId(payload.turn_id)) turn = exactId(payload.turn_id);
      else if (!announcedTurn) turn = '';
      announcedTurn = false;
      model = modelName(payload); cursor = at;
      return;
    }
    if (record.type === 'event_msg' && payload.type === 'user_message') {
      if (typeof payload.message === 'string' && !SYSTEM_PREFIXES.some(prefix => payload.message.trimStart().startsWith(prefix))) cursor = at;
      return;
    }
    if (record.type === 'token_usage_record') {
      if (!nativeId || exactId(payload.thread_id) !== nativeId || !exactId(payload.response_id) || !exactId(payload.turn_id)) return;
      const last = counts(payload.usage, true), total = counts(payload.thread_token_usage, true);
      if (!last || !total) return;
      const key = accountingKey(last, total, exactId(payload.turn_id));
      const request = { responseId: payload.response_id, output: last[1] };
      if (requests.has(key) && JSON.stringify(requests.get(key)) !== JSON.stringify(request)) requests.set(key, null);
      else if (!requests.has(key)) requests.set(key, request);
      if (requests.size > MAX_EVENTS) unsafe = true;
      return;
    }
    if (record.type !== 'event_msg' || payload.type !== 'token_count' || !payload.info) return;
    model = modelName(payload) || model;
    const last = counts(payload.info.last_token_usage), total = counts(payload.info.total_token_usage);
    // Invalid accounting cannot be coerced to zero and made equal to another request.
    if (payload.info.last_token_usage != null && !last || payload.info.total_token_usage != null && !total) {
      unsafe = true; return;
    }
    let accepted = last, next = total;
    if (total && previous) {
      if (same(total, previous)) return;
      const regression = total.some((value, index) => value < previous[index]);
      if (last && regression) {
        const sum = value => value.reduce((result, n) => result + n, 0);
        const currentSum = sum(total), previousSum = sum(previous), lastSum = sum(last);
        if (previousSum > 0 && currentSum > 0 && lastSum > 0
          && (currentSum * 100 >= previousSum * 98 || currentSum + lastSum * 2 >= previousSum)) return;
      }
      if (!last) {
        if (regression) { previous = total; return; }
        accepted = total.map((value, index) => value - previous[index]);
      }
    } else if (!last) accepted = total;
    if (!total && last) next = previous ? previous.map((value, index) => value + last[index]) : null;
    if (!accepted || (!accepted[0] && !accepted[1])) return;
    previous = next;
    const startedAt = Number.isFinite(cursor) ? cursor : at;
    events.push({ at: startedAt, lastUsedAt: at, durationMs: Number.isFinite(cursor) && Number.isFinite(at) ? Math.max(0, at - cursor) : 0,
      input: accepted[0], cached: Math.min(accepted[0], accepted[2]), output: accepted[1], model, provider,
      plan: clean(payload.rate_limits?.plan_type).toLowerCase(),
      requestKey: turn && counts(payload.info.last_token_usage, true) && counts(payload.info.total_token_usage, true)
        ? accountingKey(last, total, turn) : '' });
    if (Number.isFinite(at) && (!Number.isFinite(cursor) || at > cursor)) cursor = at;
    announcedTurn = false;
    if (events.length > MAX_EVENTS) unsafe = true;
  };
  const stream = fs.createReadStream(file, { highWaterMark: 65536, end: Math.max(0, stat.size - 1) });
  let pending = Buffer.alloc(0), skipping = false;
  try {
    for await (const chunk of stream) {
      if (signal?.aborted) throw signal.reason || new Error('Aborted');
      let start = 0;
      for (let end = chunk.indexOf(10); end !== -1; end = chunk.indexOf(10, start)) {
        const part = chunk.subarray(start, end);
        if (!skipping && pending.length + part.length <= MAX_LINE_BYTES) consume(Buffer.concat([pending, part]).toString('utf8'));
        pending = Buffer.alloc(0); skipping = false; start = end + 1;
        if (unsafe) break;
      }
      if (unsafe) break;
      const tail = chunk.subarray(start);
      if (!skipping && pending.length + tail.length <= MAX_LINE_BYTES) pending = Buffer.concat([pending, tail]);
      else { pending = Buffer.alloc(0); skipping = true; }
    }
    if (!unsafe && !skipping && pending.length) consume(pending.toString('utf8'));
  } finally { stream.destroy(); }
  const result = unsafe ? [] : events.map(event => ({ ...event, request: requests.get(event.requestKey) || null }));
  if (signal?.aborted) throw signal.reason || new Error('Aborted');
  const after = fs.statSync(file);
  if (signature(after) !== signature(stat)) return [];
  if (eventCache.size >= 256) eventCache.delete(eventCache.keys().next().value);
  eventCache.set(file, { signature: signature(stat), events: result });
  return result;
}

function firstCount(row, keys) {
  for (const key of keys) if (Number.isFinite(Number(row?.[key])) && Number(row[key]) !== 0) return Math.max(0, Math.round(Number(row[key])));
  return 0;
}
function historicalSource(event, ledger) {
  const proof = event.request && ledger.get(event.request.responseId);
  if (proof && proof.input === event.input - event.cached && proof.output === event.output
    && event.request.output === event.output) return proof.source;
  return { platform: event.provider, accountId: '', accountLabel: '',
    accessType: event.provider === 'openai' && SUBSCRIPTION_PLANS.has(event.plan) ? 'subscription' : 'unknown' };
}

async function applyCodexUsageSources(json, options = {}) {
  const rows = (Array.isArray(json?.entries) ? json.entries : []).filter(row => clean(row?.client).toLowerCase() === 'codex');
  if (!rows.length) return;
  if (options.signal?.aborted) throw options.signal.reason || new Error('Aborted');
  const env = options.homeDir ? {} : options.env || process.env;
  const home = options.homeDir || os.homedir();
  const root = options.sessionsRoot || path.join(clean(env.CODEX_HOME) ? path.resolve(env.CODEX_HOME) : path.join(home, '.codex'), 'sessions');
  const ids = new Set(rows.map(row => clean(row.sessionId ?? row.session_id)).filter(isSafeSessionId));
  const files = new Map();
  for (const scanRoot of new Set([root, ...(options.customScanPaths?.codex || [])])) {
    for (const [id, file] of findSessionFiles(scanRoot, ids)) if (!files.has(id)) files.set(id, file);
  }
  const ledger = await readMagpieUsageLedger(options);
  const window = scanWindow(options.flags, options.now);
  const sessions = new Map();
  for (const row of rows) {
    if (options.signal?.aborted) throw options.signal.reason || new Error('Aborted');
    const id = clean(row.sessionId ?? row.session_id), file = files.get(id);
    if (!file) continue;
    let events = sessions.get(id);
    if (!events) {
      try { events = await readEvents(file, options.signal); } catch (error) { if (options.signal?.aborted) throw error; events = []; }
      sessions.set(id, events);
    }
    const model = normalizeModelNameForClient(row.model, 'codex');
    const selected = events.filter(event => event.at >= window.start && event.at < window.end
      && Number.isFinite(event.lastUsedAt) && normalizeModelNameForClient(event.model, 'codex') === model);
    const references = new Map(), sources = new Set();
    let output = 0, input = 0, duration = 0;
    for (const event of selected) {
      const usageSource = historicalSource(event, ledger), key = JSON.stringify(usageSource);
      sources.add(key); output += event.output; input += event.input; duration += event.durationMs;
      if (event.output <= 0) continue;
      const previous = references.get(key);
      references.set(key, { usageSource, outputTokens: (previous?.outputTokens || 0) + event.output,
        lastUsedAt: new Date(Math.max(event.lastUsedAt, Date.parse(previous?.lastUsedAt) || 0)).toISOString() });
    }
    const rowOutput = firstCount(row, ['output', 'outputTokens', 'output_tokens', 'completionTokens', 'completion_tokens', 'totalOutput'])
      + firstCount(row, ['reasoning', 'reasoningTokens', 'reasoning_tokens']);
    if (output <= 0 || output > rowOutput) continue;
    row.usageSourceReferences = [...references.values()];
    const rowInput = firstCount(row, ['input', 'inputTokens', 'input_tokens', 'promptTokens', 'prompt_tokens', 'totalInput'])
      + firstCount(row, ['cacheRead', 'cacheReadTokens', 'cache_read_tokens', 'cachedTokens', 'cached_tokens', 'cacheReadInputTokens', 'totalCacheRead']);
    const messageCount = firstCount(row, ['messageCount', 'message_count', 'messages', 'totalMessages', 'total_messages']);
    const rowDuration = firstCount(row.performance, ['totalDurationMs', 'total_duration_ms', 'timedDurationMs', 'timed_duration_ms']);
    // Assign the existing row duration only after every native contributing event
    // agrees on source and its output/input/count/duration closes over the row.
    // Mixed accounts keep references while native throughput stays unknown.
    if (sources.size === 1 && output === rowOutput && input === rowInput
      && (!messageCount || messageCount === selected.length) && (!rowDuration || rowDuration === duration)) {
      row.usageSource = references.values().next().value.usageSource;
    }
  }
}

module.exports = { applyCodexUsageSources };
