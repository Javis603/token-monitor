'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { parseCodebuddyTranscript, readSessionDetail } = require('../../src/shared/sessionDetail');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

function tmpDir(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

// The client writes the same numbers twice, under `usage` and `rawUsage`, and
// the cached part is reported differently by version — either as
// `prompt_cache_hit_tokens` or only inside the token-details arrays.
function usageOf({ prompt, completion, hit = 0, thinking = 0, hitViaDetails = false }) {
  const rawUsage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: prompt + completion,
    completion_tokens_details: { reasoning_tokens: thinking }
  };
  if (hitViaDetails) rawUsage.prompt_tokens_details = { cached_tokens: hit };
  else rawUsage.prompt_cache_hit_tokens = hit;
  return {
    rawUsage,
    usage: {
      requests: 1,
      inputTokens: prompt,
      outputTokens: completion,
      totalTokens: prompt + completion,
      inputTokensDetails: [{ cached_tokens: hit }],
      outputTokensDetails: [{ reasoning_tokens: thinking }]
    }
  };
}

const user = (text, providerData = {}) => JSON.stringify({
  type: 'message',
  role: 'user',
  timestamp: 1788851508705,
  content: [{ type: 'input_text', text }],
  providerData
});

const call = (messageId, name, usage) => JSON.stringify({
  type: 'function_call',
  timestamp: 1788851509000,
  name,
  providerData: { messageId, ...(usage || {}) }
});

const reply = (messageId, text, usage) => JSON.stringify({
  type: 'message',
  role: 'assistant',
  status: 'completed',
  timestamp: 1788851510000,
  content: [{ type: 'output_text', text }],
  providerData: { messageId, ...(usage || {}) }
});

test('emits one turn per response and keeps the response\u2019s tools', () => {
  // One model response is one messageId. When it calls a tool, the client
  // records the call (which carries the usage) and the text it sent alongside
  // it as a separate record under the same id — counting both would double the
  // reply and the tokens.
  const events = parseCodebuddyTranscript([
    user('fix the bug'),
    call('m1', 'Edit', usageOf({ prompt: 1000, completion: 100, hit: 400 })),
    reply('m1', 'looking at it'),
    reply('m2', 'done', usageOf({ prompt: 2000, completion: 50, hit: 100 }))
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.kind), ['prompt', 'turn', 'turn']);
  const [first, second] = events.slice(1);
  assert.deepEqual(first.tools, ['Edit']);
  assert.deepEqual(second.tools, []);
  // 1000 prompt − 400 cached = 600 input, plus 100 output and 400 cache read.
  assert.equal(first.tokens.total, 1100);
  assert.equal(first.tokensAvailable, true);

  // Timestamps are normalized to ISO: the shared grouping compares them as text
  // and every other transcript here stamps ISO strings.
  assert.equal(events[0].timestamp, new Date(1788851508705).toISOString());
  assert.equal(first.timestamp, new Date(1788851509000).toISOString());
});

test('subtracts cached input and keeps reasoning inside output', () => {
  // `prompt_tokens` counts cached input, so the cache is subtracted out —
  // otherwise the cache is counted twice, which is the bug the Codex parser
  // documents. `reasoning` is a subset of `output` and must not be added again.
  const events = parseCodebuddyTranscript([
    user('hi'),
    call('m1', 'Bash', usageOf({ prompt: 30530, completion: 371, hit: 1408, thinking: 154 }))
  ].join('\n'));

  const turn = events[1];
  assert.deepEqual(turn.tokens, {
    input: 29122,
    output: 371,
    cacheRead: 1408,
    cacheWrite: 0,
    reasoning: 154,
    total: 30901
  });
});

test('reads the cached count from whichever field the client filled', () => {
  // A newer build leaves `prompt_cache_hit_tokens` empty while filling the
  // token details. Reading only the first field reported a session as 9.1M
  // input / 0 cache where tokscale had 1.2M / 7.9M.
  const viaDetails = parseCodebuddyTranscript([
    user('hi'),
    call('m1', 'Read', usageOf({ prompt: 1000, completion: 10, hit: 700, hitViaDetails: true }))
  ].join('\n'));
  assert.equal(viaDetails[1].tokens.cacheRead, 700);
  assert.equal(viaDetails[1].tokens.input, 300);

  // ...and when only the mirror carries it.
  const onlyMirror = JSON.stringify({
    type: 'function_call',
    timestamp: 1788851509000,
    name: 'Read',
    providerData: {
      messageId: 'm2',
      rawUsage: { prompt_tokens: 1000, completion_tokens: 10 },
      usage: { inputTokens: 1000, outputTokens: 10, inputTokensDetails: [{ cached_tokens: 250 }] }
    }
  });
  const events = parseCodebuddyTranscript([user('hi'), onlyMirror].join('\n'));
  assert.equal(events[1].tokens.cacheRead, 250);
  assert.equal(events[1].tokens.input, 750);
});

test('reads reasoning from whichever field the client filled', () => {
  // `completion_thinking_tokens` is what the client usually writes, but a build
  // that leaves it empty fills `completion_tokens_details` instead — the same
  // instability the cached count has, and here the raw field is the only source
  // when the `usage` mirror is missing too.
  const viaDetails = JSON.stringify({
    type: 'function_call',
    timestamp: 1788851509000,
    name: 'Read',
    providerData: {
      messageId: 'm1',
      rawUsage: {
        prompt_tokens: 100,
        completion_tokens: 50,
        completion_tokens_details: { reasoning_tokens: 30 }
      }
    }
  });
  const fromDetails = parseCodebuddyTranscript([user('hi'), viaDetails].join('\n'));
  assert.equal(fromDetails[1].tokens.reasoning, 30);
  // ...and reasoning stays a subset of output rather than a fourth bucket.
  assert.equal(fromDetails[1].tokens.total, 150);

  const viaMirror = JSON.stringify({
    type: 'function_call',
    timestamp: 1788851509000,
    name: 'Read',
    providerData: {
      messageId: 'm2',
      rawUsage: { prompt_tokens: 10, completion_tokens: 5 },
      usage: { inputTokens: 10, outputTokens: 5, outputTokensDetails: [{ reasoning_tokens: 4 }] }
    }
  });
  const fromMirror = parseCodebuddyTranscript([user('hi'), viaMirror].join('\n'));
  assert.equal(fromMirror[1].tokens.reasoning, 4);
});

test('keeps a reply whose usage never arrived instead of dropping it', () => {
  // The reply is still a reply: the detail view shows it with its tools and
  // marks only its token numbers unavailable, which is what the shared
  // `tokensAvailable` contract is for.
  const events = parseCodebuddyTranscript([
    user('hi'),
    call('m1', 'Grep'),
    reply('m2', 'answered without usage')
  ].join('\n'));

  assert.deepEqual(events.map((event) => event.kind), ['prompt', 'turn', 'turn']);
  assert.deepEqual(events[1].tools, ['Grep']);
  assert.equal(events[1].tokensAvailable, false);
  assert.equal(events[2].tokensAvailable, false);
  assert.equal(events[2].tokens.total, 0);
});

test('skips harness user records and keeps their prompts intact', () => {
  const events = parseCodebuddyTranscript([
    user('<system-reminder data-role="tool-hint">x</system-reminder>'),
    user('echo', { skipRun: true }),
    user('<local-command-stdout></local-command-stdout>'),
    user('  spaced   out  '),
    call('m1', 'Read', usageOf({ prompt: 10, completion: 1 }))
  ].join('\n'));

  const prompts = events.filter((event) => event.kind === 'prompt');
  assert.equal(prompts.length, 1);
  assert.equal(prompts[0].text, 'spaced out');
});

test('resolves, parses and distributes cost for a codebuddy session', () => {
  const home = tmpDir('codebuddy-detail-');
  const sessionId = '01a07fd0-dc59-7af6-afa5-ef402c7a91ff';
  const dir = path.join(home, '.codebuddy', 'projects', 'd-some-project');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessionId}.jsonl`), [
    user('first ask'),
    call('m1', 'Read', usageOf({ prompt: 1000, completion: 100, hit: 400 })),
    user('second ask'),
    reply('m2', 'done', usageOf({ prompt: 2000, completion: 100 }))
  ].join('\n') + '\n');

  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId,
    period: 'total',
    sessionCost: 0.4,
    home
  });

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 2);
  assert.deepEqual(detail.exchanges.map((ex) => ex.promptPreview), ['first ask', 'second ask']);
  assert.deepEqual(detail.exchanges[0].tools, ['Read']);
  assert.equal(detail.totals.turnCount, 2);
  // Cost is apportioned by token share, exactly as for Claude and Codex.
  assert.equal(detail.totals.costUsd, 0.4);
  const grand = detail.exchanges.reduce((sum, ex) => sum + ex.tokens.total, 0);
  assert.equal(detail.exchanges[0].tokens.total, 1100);
  assert.equal(detail.exchanges[1].tokens.total, 2100);
  assert.ok(Math.abs(detail.exchanges[0].costEstimate - 0.4 * (1100 / grand)) < 1e-9);
});

test('reports a missing transcript instead of throwing', () => {
  const home = tmpDir('codebuddy-missing-');
  const detail = readSessionDetail({ client: 'codebuddy', sessionId: 'nope', home });
  assert.equal(detail.found, false);
  assert.deepEqual(detail.exchanges, []);
});
