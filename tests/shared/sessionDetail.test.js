'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { parseClaudeTranscript, parseCodexTranscript } = require('../../src/shared/sessionDetail');

test('parseClaudeTranscript yields prompts and turns with exact tokens + tools', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:00.000Z', message: { role: 'user', content: '重構 collector' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-30T06:00:05.000Z', message: { role: 'assistant', usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 }, content: [{ type: 'text', text: 'ok' }, { type: 'tool_use', name: 'Read' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:06.000Z', message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'x', content: '...' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-30T06:00:08.000Z', message: { role: 'assistant', usage: { input_tokens: 120, output_tokens: 80, cache_read_input_tokens: 210, cache_creation_input_tokens: 0 }, content: [{ type: 'tool_use', name: 'Bash' }] } }),
    '{bad json',
    JSON.stringify({ type: 'system', timestamp: '2026-05-30T06:00:09.000Z' })
  ].join('\n');

  const events = parseClaudeTranscript(lines);

  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'prompt');
  assert.equal(events[0].text, '重構 collector');
  assert.equal(events[1].kind, 'turn');
  assert.equal(events[1].tokens.total, 360);
  assert.equal(events[1].tokens.cacheRead, 200);
  assert.deepEqual(events[1].tools, ['Read']);
  assert.equal(events[2].tokens.total, 410);
  assert.deepEqual(events[2].tools, ['Bash']);
});

test('parseClaudeTranscript keeps [Image #N] markers, skips synthetic + source-ref duplicates', () => {
  const lines = [
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T05:59:59.000Z', message: { role: 'user', content: 'Base directory for this skill: /Users/x/skills/foo' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:00.000Z', message: { role: 'user', content: '<command-name>/model</command-name>' } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Image #5]看一下這個 bug' }, { type: 'image' }] } }),
    JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:02.000Z', message: { role: 'user', content: [{ type: 'text', text: '[Image: source: /Users/x/5.png]' }] } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-05-30T06:00:03.000Z', message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } })
  ].join('\n');
  const ev = parseClaudeTranscript(lines);
  const prompts = ev.filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '[Image #5]看一下這個 bug'); // marker kept; source-ref duplicate skipped
  assert.equal(ev.filter((e) => e.kind === 'turn').length, 1);
});

test('parseClaudeTranscript labels a text-free image message instead of dropping it', () => {
  const lines = JSON.stringify({ type: 'user', timestamp: '2026-05-30T06:00:00.000Z', message: { role: 'user', content: [{ type: 'image' }] } });
  const ev = parseClaudeTranscript(lines);
  assert.equal(ev.length, 1);
  assert.equal(ev[0].kind, 'prompt');
  assert.equal(ev[0].text, '[image]');
});

test('parseCodexTranscript extracts the real request from the IDE context preamble', () => {
  const raw = '# Context from my IDE setup:\n\n## Active file: package.json\n\n## My request for Codex:\n幫我修這個 bug';
  const lines = JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:00.000Z', payload: { type: 'user_message', message: raw } });
  const ev = parseCodexTranscript(lines);
  assert.equal(ev[0].kind, 'prompt');
  assert.equal(ev[0].text, '幫我修這個 bug');
});

test('parseCodexTranscript labels an image-only user_message instead of leaving it blank', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:00.000Z', payload: { type: 'user_message', message: '\n', images: ['data:image/png;base64,AAAA'] } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:05.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, output_tokens: 5 } } } })
  ].join('\n');
  const ev = parseCodexTranscript(lines);
  const prompts = ev.filter((e) => e.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, '[image]');
});

test('parseCodexTranscript marks a text+image user_message with an [image] prefix', () => {
  const lines = JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:00.000Z', payload: { type: 'user_message', message: 'image + test\n', images: ['data:image/png;base64,AAAA'] } });
  const ev = parseCodexTranscript(lines);
  assert.equal(ev[0].text, '[image] image + test');
});

test('parseCodexTranscript reads last_token_usage and attaches preceding tools', () => {
  // Codex follows OpenAI's convention: input_tokens INCLUDES cached_input_tokens and output_tokens
  // INCLUDES reasoning_output_tokens. The turn total must equal Codex's own total_tokens
  // (input_tokens + output_tokens) — not the sum of overlapping fields.
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:00.000Z', payload: { type: 'user_message', message: '修 bug' } }),
    JSON.stringify({ type: 'response_item', payload: { type: 'function_call', name: 'exec_command' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 5000, cached_input_tokens: 4000, output_tokens: 200, reasoning_output_tokens: 50, total_tokens: 5200 }, total_token_usage: { total_tokens: 999 } } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:05.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 6000, cached_input_tokens: 4500, output_tokens: 300, reasoning_output_tokens: 70, total_tokens: 6300 } } } })
  ].join('\n');

  const events = parseCodexTranscript(lines);

  assert.equal(events.length, 3);
  assert.equal(events[0].kind, 'prompt');
  assert.equal(events[0].text, '修 bug');
  assert.equal(events[1].kind, 'turn');
  assert.equal(events[1].tokens.total, 5200); // input_tokens + output_tokens, = total_tokens
  assert.equal(events[1].tokens.input, 1000); // input made disjoint from cache: 5000 - 4000
  assert.equal(events[1].tokens.cacheRead, 4000);
  assert.equal(events[1].tokens.output, 200); // output stays whole (includes reasoning)
  assert.equal(events[1].tokens.reasoning, 50); // informational subset of output, not added
  assert.deepEqual(events[1].tools, ['exec_command']);
  assert.equal(events[2].tokens.total, 6300);
  assert.deepEqual(events[2].tools, []);
});

test('parseCodexTranscript skips session-start/empty token_count ticks', () => {
  const lines = [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:00.000Z', payload: { type: 'user_message', message: 'go' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:01.000Z', payload: { type: 'token_count', info: { last_token_usage: null } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:02.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 0, cached_input_tokens: 0, output_tokens: 0, reasoning_output_tokens: 0, total_tokens: 0 } } } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-05-30T03:00:03.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 800, cached_input_tokens: 600, output_tokens: 20, reasoning_output_tokens: 0, total_tokens: 820 } } } })
  ].join('\n');
  const turns = parseCodexTranscript(lines).filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 1); // null tick + all-zero tick dropped, one real turn kept
  assert.equal(turns[0].tokens.total, 820);
});

test('parseClaudeTranscript counts one reply once across content-block splits and resume replay', () => {
  // One assistant API response is written as several content-block lines sharing message.id + usage;
  // on resume the whole transcript is re-appended verbatim (same line uuids). Both must collapse.
  const usage = { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200, cache_creation_input_tokens: 10 };
  const asst = (uuid, block) => JSON.stringify({ type: 'assistant', uuid, timestamp: '2026-05-31T20:53:00.000Z', message: { id: 'msg_AAA', usage, content: [block] } });
  const user = JSON.stringify({ type: 'user', uuid: 'u1', timestamp: '2026-05-31T20:52:00.000Z', message: { content: '今天几号' } });
  const reply = [
    asst('a1', { type: 'thinking', thinking: 'x' }),
    asst('a2', { type: 'text', text: '31' }),
    asst('a3', { type: 'tool_use', name: 'exec_command' })
  ];
  const transcript = [user, ...reply, /* resume replay → */ user, ...reply].join('\n');

  const events = parseClaudeTranscript(transcript);
  assert.equal(events.filter((e) => e.kind === 'prompt').length, 1); // replayed prompt deduped by uuid
  const turns = events.filter((e) => e.kind === 'turn');
  assert.equal(turns.length, 1); // 6 lines (split ×2 from replay) → one reply
  assert.equal(turns[0].tokens.total, 360); // 100 + 50 + 200 + 10
  assert.deepEqual(turns[0].tools, ['exec_command']); // tool_use merged from a later block
});

const {
  groupEvents,
  filterExchangesByPeriod,
  distributeCost,
  summarizeCacheContinuity,
  priceCacheContinuity
} = require('../../src/shared/sessionDetail');
const { localDate, localIso } = require('../helpers/localTime');

function turn(ts, total, tools = []) {
  return { kind: 'turn', timestamp: ts, tokens: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, reasoning: 0, total }, tools };
}

test('Codex cache continuity measures a switch drop, recovery, loss, and API equivalent', () => {
  const context = (timestamp, model, effort) => JSON.stringify({
    type: 'turn_context',
    timestamp,
    payload: { model, effort }
  });
  const usage = (timestamp, cachedInputTokens) => JSON.stringify({
    type: 'event_msg',
    timestamp,
    payload: {
      type: 'token_count',
      info: { last_token_usage: { input_tokens: 1_000_000, cached_input_tokens: cachedInputTokens, output_tokens: 1_000 } }
    }
  });
  const events = parseCodexTranscript([
    context(localIso(2026, 5, 29, 23, 59, 56), 'gpt-old', 'high'),
    usage(localIso(2026, 5, 29, 23, 59, 57), 900_000),
    usage(localIso(2026, 5, 29, 23, 59, 58), 900_000),
    usage(localIso(2026, 5, 29, 23, 59, 59), 900_000),
    context(localIso(2026, 5, 30, 0, 0, 0), 'gpt-new', 'high'),
    usage(localIso(2026, 5, 30, 0, 0, 1), 300_000),
    usage(localIso(2026, 5, 30, 0, 0, 2), 880_000)
  ].join('\n'));
  const turns = events.filter((event) => event.kind === 'turn');
  assert.deepEqual([turns[0].model, turns[0].effort, turns[3].model], ['gpt-old', 'high', 'gpt-new']);

  const summary = summarizeCacheContinuity(groupEvents(events), 'today', localDate(2026, 5, 30, 12));
  const priced = priceCacheContinuity(summary, {
    'gpt-new': { inputCostPerToken: 4e-6, cacheReadInputTokenCost: 0.4e-6 }
  });
  assert.equal(priced.switchCount, 1);
  assert.equal(priced.materialDropCount, 1);
  assert.equal(priced.lostTokens, 620_000);
  assert.equal(priced.latest.recovered, true);
  assert.equal(priced.latest.recoveryCalls, 2);
  assert.ok(Math.abs(priced.apiEquivalentUsd - 4.464) < 1e-9);
});

test('groupEvents groups turns under the preceding prompt', () => {
  const events = [
    { kind: 'prompt', timestamp: '2026-05-30T06:00:01.000Z', text: 'Q1' },
    turn('2026-05-30T06:00:02.000Z', 100, ['Read']),
    turn('2026-05-30T06:00:03.000Z', 50, ['Bash']),
    { kind: 'prompt', timestamp: '2026-05-30T06:00:04.000Z', text: 'Q2' },
    turn('2026-05-30T06:00:05.000Z', 20)
  ];
  const ex = groupEvents(events);
  assert.equal(ex.length, 2);
  assert.equal(ex[0].promptPreview, 'Q1');
  assert.equal(ex[0].turnCount, 2);
  assert.equal(ex[0].tokens.total, 150);
  assert.deepEqual(ex[0].tools, ['Read', 'Bash']);
  assert.equal(ex[1].promptPreview, 'Q2');
  assert.equal(ex[1].tokens.total, 20);
});

test('turns before any prompt go in a leading exchange', () => {
  const ex = groupEvents([turn('2026-05-30T06:00:00.000Z', 70)]);
  assert.equal(ex.length, 1);
  assert.equal(ex[0].promptPreview, '');
  assert.equal(ex[0].tokens.total, 70);
});

test('filterExchangesByPeriod keeps only in-period turns and drops empties', () => {
  // `today` is cut at local midnight, so the clock and both exchanges are stated
  // in local time. Written as `Z` instants the two exchanges share one local day
  // at some offsets, and then the filter has nothing to exclude.
  const now = localDate(2026, 5, 30, 12);
  const ex = groupEvents([
    { kind: 'prompt', timestamp: localIso(2026, 5, 29, 6), text: 'yesterday' },
    turn(localIso(2026, 5, 29, 6, 0, 1), 999),
    { kind: 'prompt', timestamp: localIso(2026, 5, 30, 6), text: 'today' },
    turn(localIso(2026, 5, 30, 6, 0, 1), 100)
  ]);
  const today = filterExchangesByPeriod(ex, 'today', now);
  assert.equal(today.length, 1);
  assert.equal(today[0].promptPreview, 'today');
  assert.equal(today[0].tokens.total, 100);

  const all = filterExchangesByPeriod(ex, 'total', now);
  assert.equal(all.length, 2);
});

test('distributeCost splits session cost by token share and reconciles', () => {
  const ex = groupEvents([
    { kind: 'prompt', timestamp: '2026-05-30T06:00:01.000Z', text: 'Q1' },
    turn('2026-05-30T06:00:02.000Z', 150),
    { kind: 'prompt', timestamp: '2026-05-30T06:00:03.000Z', text: 'Q2' },
    turn('2026-05-30T06:00:04.000Z', 20)
  ]);
  distributeCost(ex, 0.34);
  const sum = ex.reduce((acc, e) => acc + e.costEstimate, 0);
  assert.ok(Math.abs(sum - 0.34) < 1e-9);
  assert.ok(ex[0].costEstimate > ex[1].costEstimate);
  assert.ok(Math.abs(ex[0].turns[0].costEstimate - ex[0].costEstimate) < 1e-9);
});

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { readSessionDetail } = require('../../src/shared/sessionDetail');

function writeClaudeSession(home, sessionId, lines) {
  const dir = path.join(home, '.claude', 'projects', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), lines.join('\n'));
}

test('readSessionDetail resolves, parses, groups, and distributes cost', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detail-'));
  const id = 'sess-1';
  const ts = new Date().toISOString();
  writeClaudeSession(home, id, [
    JSON.stringify({ type: 'user', timestamp: ts, message: { role: 'user', content: 'hi' } }),
    JSON.stringify({ type: 'assistant', timestamp: ts, message: { role: 'assistant', usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } })
  ]);

  const detail = readSessionDetail({ client: 'claude', sessionId: id, period: 'total', sessionCost: 0.5, home });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.totals.totalTokens, 15);
  assert.ok(Math.abs(detail.totals.costUsd - 0.5) < 1e-9);
  assert.ok(Math.abs(detail.exchanges[0].costEstimate - 0.5) < 1e-9);
});

test('readSessionDetail resolves Claude transcripts from CLAUDE_CONFIG_DIR', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detail-config-'));
  const configDir = path.join(home, 'relocated-claude');
  const id = 'configured-detail';
  const dir = path.join(configDir, 'transcripts', '-proj');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${id}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: new Date().toISOString(), message: { role: 'user', content: 'configured' } }),
    JSON.stringify({ type: 'assistant', timestamp: new Date().toISOString(), message: { role: 'assistant', usage: { input_tokens: 3, output_tokens: 2 }, content: [] } })
  ].join('\n'));

  try {
    const detail = readSessionDetail({
      client: 'claude',
      sessionId: id,
      period: 'total',
      home,
      env: { CLAUDE_CONFIG_DIR: configDir }
    });
    assert.equal(detail.found, true);
    assert.equal(detail.totals.totalTokens, 5);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('readSessionDetail reports not found instead of throwing', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detail-'));
  const detail = readSessionDetail({ client: 'claude', sessionId: 'nope', period: 'total', sessionCost: 0, home });
  assert.equal(detail.found, false);
  assert.deepEqual(detail.exchanges, []);
});

test('readSessionDetail filters by the injected clock and passes the period cost through', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-detail-'));
  const id = 'injected-clock';
  // Freeze "now" at YESTERDAY noon (local time). One exchange sits on that injected
  // "today", the other on the wall clock's today. Which one survives the 'today'
  // filter therefore proves whether the injected clock (not new Date()) drove it.
  const now = new Date();
  const nowMs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 12, 0, 0).getTime();
  const injectedTodayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 1, 0, 0).toISOString();
  const wallTodayTs = new Date(now.getFullYear(), now.getMonth(), now.getDate(), 1, 0, 0).toISOString();
  writeClaudeSession(home, id, [
    JSON.stringify({ type: 'user', timestamp: injectedTodayTs, message: { role: 'user', content: 'injected today' } }),
    JSON.stringify({ type: 'assistant', timestamp: injectedTodayTs, message: { role: 'assistant', usage: { input_tokens: 80, output_tokens: 20, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } }),
    JSON.stringify({ type: 'user', timestamp: wallTodayTs, message: { role: 'user', content: 'wall today' } }),
    JSON.stringify({ type: 'assistant', timestamp: wallTodayTs, message: { role: 'assistant', usage: { input_tokens: 40, output_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }, content: [] } })
  ]);

  // The renderer reads sessionCost from the period-scoped row (tokscale applies the
  // date filter before grouping messages into sessions), so it must pass through
  // untouched — no rescaling in readSessionDetail.
  const todayDetail = readSessionDetail({ client: 'claude', sessionId: id, period: 'today', sessionCost: 0.75, home, deps: { now: () => nowMs } });
  assert.equal(todayDetail.exchanges.length, 1);
  assert.equal(todayDetail.totals.totalTokens, 100); // the injected-today exchange, not the wall-today one
  assert.ok(Math.abs(todayDetail.totals.costUsd - 0.75) < 1e-9);

  const totalDetail = readSessionDetail({ client: 'claude', sessionId: id, period: 'total', sessionCost: 1.5, home, deps: { now: () => nowMs } });
  assert.equal(totalDetail.totals.totalTokens, 150);
  assert.ok(Math.abs(totalDetail.totals.costUsd - 1.5) < 1e-9);
});
