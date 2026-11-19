'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { parseCodebuddyTranscript, readSessionDetail } = require('../../src/shared/sessionDetail');
const { cases } = require('../fixtures/tencentBuddyUsage.json');
const { localMs } = require('../helpers/localTime');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { sumTokens, sumOutputTokens } = require('../../src/shared/history');

for (const client of ['codebuddy', 'workbuddy']) {
  for (const fixture of cases) {
    test(`${client} Detail matches pinned BuddyUsage: ${fixture.name}`, (t) => {
      const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-accounting-'));
      t.after(() => fs.rmSync(home, { recursive: true, force: true }));
      const dir = path.join(home, `.${client}`, 'projects', 'test');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, 'usage.jsonl'), JSON.stringify(fixture.entry));
      const detail = readSessionDetail({ client, sessionId: 'usage', home, env: {} });
      assert.equal(detail.found, true);
      assert.equal(detail.exchanges.length, 1);
      assert.deepEqual(detail.exchanges[0].tokens, fixture.tokens);
      assert.equal(detail.totals.totalTokens, fixture.tokens.total);
      // CLI rows have independent buckets and no explicit total. Both live
      // rows and history must close over the same total as Session Detail.
      const { total: _total, ...buckets } = fixture.tokens;
      const period = extractUsageFromTokscale([{ ...buckets, client, sessionId: 'usage', model: 'glm-5.2' }]);
      assert.equal(period.totalTokens, fixture.tokens.total);
      assert.equal(period.sessions[`${client}:usage`].totalTokens, fixture.tokens.total);
      assert.equal(period.clientOutputs[client], fixture.tokens.output + fixture.tokens.reasoning);
      assert.equal(sumTokens(buckets, client), fixture.tokens.total);
      assert.equal(sumOutputTokens(buckets, client), fixture.tokens.output + fixture.tokens.reasoning);
    });
  }

  test(`${client} filters by the usage-bearing record across day and month boundaries`, (t) => {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), 'buddy-period-'));
    t.after(() => fs.rmSync(home, { recursive: true, force: true }));
    const dir = path.join(home, `.${client}`, 'projects', 'test');
    fs.mkdirSync(dir, { recursive: true });
    const before = localMs(2026, 9, 30, 23, 59, 59);
    const after = localMs(2026, 10, 1, 0, 0, 1);
    const records = [
      { type: 'function_call', name: 'Read', timestamp: before, providerData: { messageId: 'response' } },
      { type: 'message', role: 'assistant', timestamp: after, providerData: { messageId: 'response', usage: { inputTokens: 7, outputTokens: 2 } } }
    ];
    fs.writeFileSync(path.join(dir, 'midnight.jsonl'), records.map(JSON.stringify).join('\n'));
    for (const period of ['today', 'month']) {
      const detail = readSessionDetail({ client, sessionId: 'midnight', home, env: {}, period, deps: { now: () => localMs(2026, 10, 1, 12) } });
      assert.equal(detail.totals.totalTokens, 9);
      assert.equal(detail.exchanges[0].turns[0].timestamp, new Date(after).toISOString());
      assert.deepEqual(detail.exchanges[0].tools, ['Read']);
    }
  });
}

test('BuddyUsage uses one usage object in pinned source order, including explicit zero fields', () => {
  const [turn] = parseCodebuddyTranscript(JSON.stringify({
    type: 'message', role: 'assistant',
    message: { usage: { input_tokens: 0, inputTokens: 100, output_tokens: 0, outputTokens: 100, cacheTokens: 5 } },
    providerData: { usage: { inputTokens: 200 }, rawUsage: { prompt_tokens: 300 } }
  }));
  assert.deepEqual(turn.tokens, { input: 0, output: 0, cacheRead: 5, cacheWrite: 0, reasoning: 0, total: 5 });
});

test('BuddyUsage mirrors camel-case aliases and keeps reasoning and cache writes additive', () => {
  const [turn] = parseCodebuddyTranscript(JSON.stringify({ type: 'function_call', providerData: { rawUsage: {
    cacheMissTokens: 7, outputTokens: 2, cacheReadInputTokens: 10, cacheCreationInputTokens: 4, completionThinkingTokens: 5
  } } }));
  assert.deepEqual(turn.tokens, { input: 7, output: 2, cacheRead: 10, cacheWrite: 4, reasoning: 5, total: 28 });
});

test('BuddyUsage does not count usage from unfinished records', () => {
  const [turn] = parseCodebuddyTranscript(JSON.stringify({ type: 'message', role: 'assistant', status: 'incomplete', providerData: {
    messageId: 'response', usage: { inputTokens: 100, outputTokens: 2 }
  } }));
  assert.equal(turn.tokensAvailable, false);
  assert.equal(turn.tokens.total, 0);
});

test('BuddyUsage keeps the largest repeated usage, choosing the latest record on a tie', () => {
  const record = (inputTokens, timestamp) => JSON.stringify({ type: 'function_call', timestamp, providerData: {
    messageId: 'response', usage: { inputTokens, outputTokens: 2 }
  } });
  const [turn] = parseCodebuddyTranscript([record(10, 1000), record(7, 2000), record(10, 3000)].join('\n'));
  assert.equal(turn.tokens.total, 12);
  assert.equal(turn.timestamp, new Date(3000).toISOString());
});

test('BuddyUsage applies first-positive cache aliases and first-present input/output/reasoning', () => {
  const [turn] = parseCodebuddyTranscript(JSON.stringify({ type: 'message', role: 'assistant', message: { usage: {
    input_tokens: 0, inputTokens: 100, output_tokens: 0, outputTokens: 100,
    cache_read_input_tokens: 0, cacheReadInputTokens: 7, cacheTokens: 9,
    cache_creation_input_tokens: 0, cachedWriteTokens: 4, prompt_cache_write_tokens: 6,
    completion_thinking_tokens: 0, completionThinkingTokens: 8
  } } }));
  assert.deepEqual(turn.tokens, { input: 0, output: 0, cacheRead: 7, cacheWrite: 4, reasoning: 0, total: 11 });
});

test('BuddyUsage does not fall through an empty selected usage object to rawUsage', () => {
  const [turn] = parseCodebuddyTranscript(JSON.stringify({ type: 'function_call', providerData: {
    messageId: 'response', usage: {}, rawUsage: { prompt_tokens: 100, completion_tokens: 10 }
  } }));
  assert.equal(turn.tokensAvailable, false);
  assert.equal(turn.tokens.total, 0);
});
