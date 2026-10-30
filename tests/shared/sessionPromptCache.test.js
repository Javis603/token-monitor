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
test('Codex cache usage never creates an expiry estimate for any model or route', () => {
  for (const model of ['gpt-6-sol', 'gpt-5.4', 'custom-model', '']) {
    const context = { timestamp: at, type: 'turn_context', payload: { model } };
    assert.equal(promptCacheFromTranscript(jsonl([context, codex(at), codex(later)]), 'codex'), null, model);
  }
});
test('legacy Codex estimates neither display nor schedule countdown updates', () => {
  const { nextPromptCacheChangeAt } = require('../../src/shared/sessionLive');
  const session = { client: 'codex', promptCache: { observedAt: at, ttlSeconds: 1800 } };
  for (const elapsed of [0, 600_001, 1800_000]) {
    assert.equal(sessionPromptCacheForRow(session, Date.parse(at) + elapsed), null);
    assert.equal(nextPromptCacheChangeAt([session], Date.parse(at) + elapsed), 0);
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
    const stats = aggregateDevices(devices, 10 * 60_000, Date.parse(later));
    assert.equal(stats.periods.today.sessions['claude:a'].promptCache, null);
  }
});
test('cache clock wakes at the next minute and at expiry', () => {
  const { nextPromptCacheChangeAt } = require('../../src/shared/sessionLive');
  const session = { client: 'claude', promptCache: { observedAt: at, ttlSeconds: 300 } };
  assert.equal(nextPromptCacheChangeAt([session], Date.parse(at) + 10_000), Date.parse(at) + 60_000);
  assert.equal(nextPromptCacheChangeAt([session], Date.parse(at) + 299_000), Date.parse(at) + 300_000);
});

test('Codex turn completion retains recent context without a cache handoff', () => {
  const { nextSessionStatusChangeAt, sessionContextForRow } = require('../../src/shared/sessionLive');
  const context = { timestamp: at, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
  const completed = { timestamp: later, type: 'event_msg', payload: { type: 'task_complete' } };
  const promptCache = promptCacheFromTranscript(jsonl([context, codex(at), completed]), 'codex');
  assert.equal(promptCache, null);
  const session = { client: 'codex', lastUsedAt: at, turnEnded: true, contextTokens: 60, contextWindow: 100, promptCache };
  const boundary = Date.parse(at) + 600_001;
  assert.equal(sessionContextForRow(session, boundary - 1).percentUsed, 60);
  assert.equal(nextSessionStatusChangeAt([session], boundary - 1), boundary);
  assert.equal(sessionContextForRow(session, boundary), undefined);
  assert.equal(sessionPromptCacheForRow(session, boundary), null);
  assert.equal(sessionPromptCacheForRow(session, Date.parse(at) + 1800_000), null);
});

test('Codex long-turn tails do not produce cache expiry estimates', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'prompt-cache-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const context = { timestamp: at, type: 'turn_context', payload: { model: 'gpt-6.1-sol' } };
  const padding = { timestamp: at, type: 'response_item', payload: { text: 'x'.repeat(1200_000) } };
  const cases = [
    { name: 'long', rows: [context, padding, codex(at)] },
    { name: 'switched', rows: [context, { ...context, payload: { model: 'custom-model' } }, padding, codex(at)] },
    { name: 'missing', rows: [padding, codex(at)] },
    { name: 'cold', rows: [context, padding, codex(at, { info: { last_token_usage: { cached_input_tokens: 0 } } })] }
  ];
  for (const item of cases) {
    const file = path.join(dir, `${item.name}.jsonl`);
    fs.writeFileSync(file, jsonl(item.rows));
    assert.equal(Object.hasOwn(readCodexSessionState(file), 'promptCacheState'), false, item.name);
  }
});

test('Codex shares one read for context and turn without generating cache deadlines', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readCodexSessionState, readCodexSessionContext, readCodexTurnEnded } = require('../../src/shared/providers/codex/sessionContext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-shared-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const usage = codex(at);
  usage.payload.info.last_token_usage.total_tokens = 123_000;
  usage.payload.info.model_context_window = 200_000;
  fs.writeFileSync(file, `${jsonl([usage, { timestamp: at, type: 'event_msg', payload: { type: 'task_complete' } }])}\n`);
  let bytesRead = 0;
  let reads = 0;
  const deps = { cache: new Map(), fs: { ...fs, readSync(...args) {
    reads += 1;
    const result = fs.readSync(...args);
    bytesRead += result;
    return result;
  } } };
  const first = readCodexSessionState(file, deps);
  assert.equal(Object.hasOwn(first, 'promptCacheState'), false);
  assert.equal(bytesRead, fs.statSync(file).size);
  assert.equal(reads, 1);
  assert.deepEqual(readCodexSessionContext(file, deps), { contextTokens: 123_000, contextWindow: 200_000 });
  assert.equal(readCodexTurnEnded(file, deps), true);
  assert.equal(reads, 1, 'context and boundary reuse the decoded session state');

  const padding = `${JSON.stringify({ type: 'response_item', payload: { text: 'x'.repeat(1200_000) } })}\n`;
  fs.appendFileSync(file, padding);
  readCodexSessionState(file, deps);
  assert.equal(bytesRead, fs.statSync(file).size, 'append reads only new bytes');
  const duplicate = { ...usage, timestamp: later };
  fs.appendFileSync(file, `${JSON.stringify(duplicate)}\n`);
  assert.equal(Object.hasOwn(readCodexSessionState(file, deps), 'promptCacheState'), false);
  assert.equal(bytesRead, fs.statSync(file).size);
  const next = structuredClone(duplicate);
  next.payload.info.total_token_usage.input_tokens += 100;
  fs.appendFileSync(file, `${JSON.stringify(next)}\n`);
  assert.equal(Object.hasOwn(readCodexSessionState(file, deps), 'promptCacheState'), false);

  fs.writeFileSync(file, `${JSON.stringify(duplicate)}\n`);
  assert.equal(Object.hasOwn(readCodexSessionState(file, deps), 'promptCacheState'), false);
  const compact = { timestamp: later, type: 'event_msg', payload: { type: 'context_compacted' } };
  fs.appendFileSync(file, `${JSON.stringify(compact)}\n`);
  assert.equal(Object.hasOwn(readCodexSessionState(file, deps), 'promptCacheState'), false);
});

test('Claude cache reuses the title/context scan, including oversized records and append deduplication', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readSessionTitle, readSessionContext, readSessionTurnEnded, readSessionPromptCache } = require('../../src/shared/providers/claude/sessionMetadata');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'claude-shared-read-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const item = claude(at);
  item.message = { id: 'msg', role: 'assistant', content: [{ type: 'text', text: 'x'.repeat(1200_000) }], model: 'claude-sonnet-5-5', stop_reason: 'end_turn', usage: { input_tokens: 10, ...item.message.usage } };
  fs.writeFileSync(file, `${jsonl([{ type: 'custom-title', customTitle: 'Shared scan' }, item])}\n`);
  let bytesRead = 0;
  const deps = { cache: new Map(), fs: { ...fs, readSync(...args) {
    const result = fs.readSync(...args);
    bytesRead += result;
    return result;
  } } };
  assert.equal(readSessionTitle(file, deps), 'Shared scan');
  const initialBytes = bytesRead;
  assert.deepEqual(readSessionPromptCache(file, deps), { observedAt: at, ttlSeconds: 3600 });
  assert.deepEqual(readSessionContext(file, deps), { contextTokens: 1030, contextWindow: 1_000_000 });
  assert.equal(readSessionTurnEnded(file, deps), true);
  assert.equal(bytesRead, initialBytes, 'cache/context/boundary perform no extra read');
  fs.appendFileSync(file, `${JSON.stringify({ ...item, timestamp: later })}\n`);
  assert.deepEqual(readSessionPromptCache(file, deps), { observedAt: at, ttlSeconds: 3600 });
  assert.equal(bytesRead, fs.statSync(file).size, 'only appended bytes are read');
  fs.appendFileSync(file, `${JSON.stringify({ timestamp: later, subtype: 'compact_boundary' })}\n`);
  assert.equal(readSessionPromptCache(file, deps), null);
});

test('Codex shared index completes partial records and resets state on file replacement', (t) => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { readCodexSessionState } = require('../../src/shared/providers/codex/sessionContext');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-partial-index-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, 'session.jsonl');
  const deps = { cache: new Map() };
  const initial = codex(at);
  initial.payload.info.model_context_window = 200000;
  initial.payload.info.last_token_usage.total_tokens = 1000;
  fs.writeFileSync(file, `${JSON.stringify(initial)}\n`);
  assert.equal(readCodexSessionState(file, deps).context.contextTokens, 1000);
  const next = structuredClone(initial);
  next.timestamp = later;
  next.payload.info.last_token_usage.total_tokens = 1100;
  next.payload.info.total_token_usage.input_tokens += 10;
  const line = JSON.stringify(next);
  const cut = line.indexOf('last_token_usage');
  fs.appendFileSync(file, line.slice(0, cut));
  assert.equal(readCodexSessionState(file, deps).context.contextTokens, 1000);
  fs.appendFileSync(file, line.slice(cut));
  assert.equal(readCodexSessionState(file, deps).context.contextTokens, 1100);
  fs.appendFileSync(file, '\n');
  assert.equal(readCodexSessionState(file, deps).context.contextTokens, 1100);

  const replacement = path.join(dir, 'replacement.jsonl');
  fs.writeFileSync(replacement, `${JSON.stringify(initial)}\n`);
  fs.renameSync(replacement, file);
  assert.equal(readCodexSessionState(file, deps).context.contextTokens, 1000, 'a new inode does not inherit context state');
});

test('Codex metadata clears legacy estimates even outside the transcript-read window', t => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');
  const { applySessionMetadata } = require('../../src/shared/sessionMetadata');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-cache-clear-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const id = 'rollout-2026-09-30T09-00-00-aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa';
  const dir = path.join(home, '.codex', 'sessions', '2026', '09', '30');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, id + '.jsonl'), jsonl([codex(at)]));
  for (const elapsed of [0, 3600_000]) {
    const periods = { today: { sessions: { ['codex:' + id]: {
      client: 'codex', sessionId: id, totalTokens: 1000, lastUsedAt: at,
      cacheReadTokens: 900, promptCache: { observedAt: at, ttlSeconds: 1800 }
    } } } };
    applySessionMetadata(periods, home, { now: Date.parse(at) + elapsed, env: {}, resolveProjects: false,
      readCodexMeta: () => new Map(), readT3Meta: () => new Map() });
    const session = periods.today.sessions['codex:' + id];
    assert.equal(session.promptCache, null);
    assert.equal(session.cacheReadTokens, 900, 'clearing a display estimate does not change accounting');
  }
});
