'use strict';
const assert = require('node:assert/strict');
const test = require('node:test');
const { promptCacheFromTranscript } = require('../../src/shared/sessionPromptCache');
const { sessionPromptCacheForRow } = require('../../src/shared/sessionLive');
const { normalizePeriod } = require('../../src/shared/usage');
const at = '2026-09-30T09:00:00.000Z';
const later = '2026-09-30T09:10:00.000Z';
const jsonl = (rows) => rows.map(JSON.stringify).join('\n');
function claude(timestamp, id = 'msg', extra = {}) {
  return { timestamp, type: 'assistant', message: { id, usage: {
    cache_read_input_tokens: 1000, cache_creation_input_tokens: 20,
    cache_creation: { ephemeral_1h_input_tokens: 20, ephemeral_5m_input_tokens: 0 }
  } }, ...extra };
}
function codex(timestamp, extra = {}) {
  return { timestamp, type: 'event_msg', payload: { type: 'token_count', info: {
    total_token_usage: { input_tokens: 1000 },
    last_token_usage: { cached_input_tokens: 900, input_tokens: 1000 }
  }, ...extra } };
}
test('Claude duplicates and subagents do not extend the main cache estimate', () => {
  const result = promptCacheFromTranscript(jsonl([claude(at), claude(later), claude(later, 'sub', { isSidechain: true })]), 'claude');
  assert.deepEqual(result, { observedAt: at, ttlSeconds: 3600 });
});
test('Claude mixed tiers use the shorter lifetime; absent tier and compaction clear it', () => {
  const item = claude(at);
  item.message.usage.cache_creation.ephemeral_5m_input_tokens = 1;
  assert.equal(promptCacheFromTranscript(jsonl([item]), 'claude').ttlSeconds, 300);
  const unknown = claude(later, 'next');
  delete unknown.message.usage.cache_creation;
  assert.equal(promptCacheFromTranscript(jsonl([item, unknown]), 'claude'), null);
  assert.equal(promptCacheFromTranscript(jsonl([item, { timestamp: later, subtype: 'compact_boundary' }]), 'claude'), null);
});
test('Codex cache activity starts an estimate without requiring a model declaration', () => {
  assert.deepEqual(promptCacheFromTranscript(jsonl([codex(at), codex(later)]), 'codex'), { observedAt: at, ttlSeconds: 1800 });
  const cold = codex(later);
  cold.payload.info.last_token_usage.cached_input_tokens = 0;
  assert.equal(promptCacheFromTranscript(jsonl([codex(at), cold]), 'codex'), null);
});
test('Codex cache estimates do not depend on official, third-party or custom model names', () => {
  for (const model of ['gpt-6-sol', 'gpt-6.1-sol', 'gpt-5.4', 'deepseek-v4.1-flash', 'custom-gpt-6-sol', '']) {
    const context = { timestamp: at, type: 'turn_context', payload: { model } };
    assert.deepEqual(promptCacheFromTranscript(jsonl([context, codex(at)]), 'codex'), { observedAt: at, ttlSeconds: 1800 }, model);
  }
});
test('Codex clears a previous estimate on model changes or compaction and requires valid cache counts', () => {
  const context = { timestamp: at, type: 'turn_context', payload: { model: 'gpt-6-sol' } };
  const changed = { timestamp: later, type: 'turn_context', payload: { model: 'custom-model' } };
  assert.equal(promptCacheFromTranscript(jsonl([context, codex(at), changed]), 'codex'), null);
  const next = codex(later);
  next.payload.info.total_token_usage.input_tokens = 2000;
  assert.deepEqual(promptCacheFromTranscript(jsonl([context, codex(at), changed, next]), 'codex'), { observedAt: later, ttlSeconds: 1800 });
  assert.equal(promptCacheFromTranscript(jsonl([codex(at), { timestamp: later, type: 'event_msg', payload: { type: 'context_compacted' } }]), 'codex'), null);
  for (const invalid of [undefined, '900', -1, 0.5, null]) {
    const item = codex(later);
    item.payload.info.last_token_usage.cached_input_tokens = invalid;
    assert.equal(promptCacheFromTranscript(jsonl([codex(at), item]), 'codex'), null);
  }
});
test('cache display expires without a stats update and excludes archives and future clocks', () => {
  const session = { client: 'claude', promptCache: { observedAt: at, ttlSeconds: 3600 } };
  assert.equal(sessionPromptCacheForRow(session, Date.parse(at) + 29 * 60_000).minutes, 31);
  assert.equal(sessionPromptCacheForRow(session, Date.parse(at) + 3600_000), null);
  assert.equal(sessionPromptCacheForRow({ ...session, archived: true }, Date.parse(at)), null);
  assert.equal(sessionPromptCacheForRow(session, Date.parse(at) - 1), null);
});
test('normalization carries cache observations and rejects malformed lifetimes', () => {
  const periods = normalizePeriod({ sessions: {
    a: { client: 'claude', sessionId: 'a', totalTokens: 100, lastUsedAt: at, promptCache: { observedAt: at, ttlSeconds: 3600 } },
    b: { client: 'codex', sessionId: 'b', totalTokens: 100, lastUsedAt: at, promptCache: { observedAt: at, ttlSeconds: '1800' } }
  } });
  assert.deepEqual(periods.sessions['claude:a'].promptCache, { observedAt: at, ttlSeconds: 3600 });
  assert.equal(periods.sessions['codex:b'].promptCache, null);
});

test('newer cold observations clear a warm reading across period merges', () => {
  const { aggregateDevices } = require('../../src/shared/usage');
  const warm = { client: 'claude', sessionId: 'a', totalTokens: 100, lastUsedAt: at, promptCache: { observedAt: at, ttlSeconds: 3600 } };
  const cold = { ...warm, lastUsedAt: later, promptCache: null };
  const make = (id, session) => ({ deviceId: id, updatedAt: later, periods: { today: { sessions: { a: session } } } });
  for (const devices of [[make('one', warm), make('two', cold)], [make('two', cold), make('one', warm)]]) {
    const stats = aggregateDevices(devices);
    assert.equal(stats.periods.today.sessions['claude:a'].promptCache, null);
  }
});
test('cache clock wakes at the next minute and at expiry', () => {
  const { nextPromptCacheChangeAt } = require('../../src/shared/sessionLive');
  const session = { client: 'codex', promptCache: { observedAt: at, ttlSeconds: 1800 } };
  assert.equal(nextPromptCacheChangeAt([session], Date.parse(at) + 10_000), Date.parse(at) + 60_000);
  assert.equal(nextPromptCacheChangeAt([session], Date.parse(at) + 1799_000), Date.parse(at) + 1800_000);
});

test('turn completion keeps cache valid and an ended row still schedules its context-to-cache handoff', () => {
  const { nextSessionStatusChangeAt, sessionContextForRow } = require('../../src/shared/sessionLive');
  const context = { timestamp: at, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
  const completed = { timestamp: later, type: 'event_msg', payload: { type: 'task_complete' } };
  const promptCache = promptCacheFromTranscript(jsonl([context, codex(at), completed]), 'codex');
  assert.deepEqual(promptCache, { observedAt: at, ttlSeconds: 1800 });
  const session = { client: 'codex', lastUsedAt: at, turnEnded: true, contextTokens: 60, contextWindow: 100, promptCache };
  const boundary = Date.parse(at) + 600_001;
  assert.equal(sessionContextForRow(session, boundary - 1).percentUsed, 60);
  assert.equal(nextSessionStatusChangeAt([session], boundary - 1), boundary);
  assert.equal(sessionContextForRow(session, boundary), undefined);
  assert.equal(sessionPromptCacheForRow(session, boundary).minutes, 20);
  assert.equal(sessionPromptCacheForRow(session, Date.parse(at) + 1800_000), null);
});

test('Codex long-turn tail estimates cache activity even when the model declaration is outside it', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readSessionPromptCache } = require('../../src/shared/sessionPromptCache');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = { timestamp: at, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
  const padding = { timestamp: at, type: 'response_item', payload: { text: 'x'.repeat(1200_000) } };
  const cases = [
    { name: 'long', rows: [context, padding, codex(at)], expected: { observedAt: at, ttlSeconds: 1800 } },
    { name: 'switched', rows: [context, { ...context, payload: { model: 'custom-model' } }, padding, codex(at)], expected: { observedAt: at, ttlSeconds: 1800 } },
    { name: 'missing', rows: [padding, codex(at)], expected: { observedAt: at, ttlSeconds: 1800 } },
    { name: 'cold', rows: [context, padding, codex(at, { info: { last_token_usage: { cached_input_tokens: 0 } } })], expected: null }
  ];
  for (const item of cases) {
    const file = path.join(dir, `${item.name}.jsonl`);
    fs.writeFileSync(file, jsonl(item.rows));
    assert.deepEqual(readSessionPromptCache(file, 'codex', Date.parse(at)), item.expected, item.name);
  }
});
