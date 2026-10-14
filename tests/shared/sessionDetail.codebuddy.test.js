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

// Both representations carry the pinned parser's direct token fields. The
// friendly usage object takes precedence over rawUsage when both are present.
function usageOf({ prompt, completion, hit = 0, thinking = 0 }) {
  return {
    rawUsage: {
      prompt_tokens: prompt,
      completion_tokens: completion,
      total_tokens: prompt + completion,
      prompt_cache_hit_tokens: hit,
      completion_thinking_tokens: thinking
    },
    usage: {
      inputTokens: prompt,
      outputTokens: completion,
      totalTokens: prompt + completion,
      cacheTokens: hit,
      reasoningTokens: thinking
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

test('subtracts proven inclusive cache input and adds Tencent Buddy reasoning', () => {
  // The reported total proves the input includes cache reads. Tokscale counts
  // Tencent Buddy reasoning separately from output.
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
    total: 31055
  });
});

test('does not infer cache or reasoning from fields the pinned parser ignores', () => {
  const viaDetails = JSON.stringify({
    type: 'function_call',
    providerData: {
      messageId: 'm1',
      rawUsage: {
        prompt_tokens: 100, completion_tokens: 50,
        prompt_tokens_details: { cached_tokens: 40 },
        completion_tokens_details: { reasoning_tokens: 30 }
      }
    }
  });
  const [turn] = parseCodebuddyTranscript(viaDetails);
  assert.deepEqual(turn.tokens, { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, reasoning: 0, total: 150 });
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

// tokscale reports every sub-agent transcript as its own codebuddy session,
// keyed on the top-level sessionId its records state — which appears nowhere
// in the file name, so the name-based lookup alone reads the session as
// missing. The `baggage` on those records carries the parent session id.
const withSessionId = (line, sessionId) => JSON.stringify({ ...JSON.parse(line), sessionId });

test('resolves a sub-agent transcript reported as its own session', () => {
  const home = tmpDir('codebuddy-subagent-detail-');
  const parentId = '01a13463-cb53-72a7-afee-0164d5bdde33';
  const subId = '01a13466-8201-7275-95ad-04d2f3520e7e';
  const dir = path.join(home, '.codebuddy', 'projects', 'd-some-project');
  fs.mkdirSync(path.join(dir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${parentId}.jsonl`), [
    user('run the market scan'),
    call('m1', 'Agent', usageOf({ prompt: 1000, completion: 100, hit: 400 }))
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, parentId, 'subagents', 'agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5.jsonl'), [
    withSessionId(user('collect competitor pricing'), subId),
    withSessionId(call('s1', 'WebSearch', usageOf({ prompt: 1000, completion: 100, hit: 400 })), subId),
    withSessionId(reply('s2', 'done', usageOf({ prompt: 2000, completion: 100 })), subId)
  ].join('\n') + '\n');

  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId: subId,
    period: 'total',
    sessionCost: 0.4,
    home
  });

  assert.equal(detail.found, true);
  assert.deepEqual(detail.exchanges.map((ex) => ex.promptPreview), ['collect competitor pricing']);
  assert.deepEqual(detail.exchanges[0].tools, ['WebSearch']);
  assert.equal(detail.totals.turnCount, 2);
  assert.equal(detail.totals.costUsd, 0.4);
  // 1000 prompt − 400 cached + 100 output + 400 cache read, then 2000 + 100.
  assert.equal(detail.exchanges[0].tokens.total, 3200);
});

test('resolves a parent session to its own transcript, not a sub-agent file', () => {
  const home = tmpDir('codebuddy-subagent-parent-');
  const parentId = '01a13463-cb53-72a7-afee-0164d5bdde33';
  const subId = '01a13466-8201-7275-95ad-04d2f3520e7e';
  const dir = path.join(home, '.codebuddy', 'projects', 'd-some-project');
  fs.mkdirSync(path.join(dir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, `${parentId}.jsonl`), [
    user('run the market scan'),
    call('m1', 'Agent', usageOf({ prompt: 1000, completion: 100, hit: 400 }))
  ].join('\n') + '\n');
  fs.writeFileSync(path.join(dir, parentId, 'subagents', 'agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5.jsonl'), [
    withSessionId(user('collect competitor pricing'), subId),
    withSessionId(call('s1', 'WebSearch', usageOf({ prompt: 1000, completion: 100, hit: 400 })), subId)
  ].join('\n') + '\n');

  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId: parentId,
    period: 'total',
    sessionCost: 0.4,
    home
  });

  assert.equal(detail.found, true);
  assert.deepEqual(detail.exchanges.map((ex) => ex.promptPreview), ['run the market scan']);
  // The sub-agent turns stay the scan's own session; the parent keeps only its
  // own turn, so the two do not double-count.
  assert.equal(detail.totals.turnCount, 1);
  assert.equal(detail.totals.totalTokens, 1100);
});

test('reports an unknown session id as missing even when sub-agents exist', () => {
  const home = tmpDir('codebuddy-subagent-missing-');
  const parentId = '01a13463-cb53-72a7-afee-0164d5bdde33';
  const dir = path.join(home, '.codebuddy', 'projects', 'd-some-project');
  fs.mkdirSync(path.join(dir, parentId, 'subagents'), { recursive: true });
  fs.writeFileSync(path.join(dir, parentId, 'subagents', 'agent-9077a5ed-6f2d-4464-8416-d182d9fd84d5.jsonl'),
    withSessionId(user('collect competitor pricing'), '01a13466-8201-7275-95ad-04d2f3520e7e'));

  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId: '01a0c29e-0000-0000-0000-000000000000',
    period: 'total',
    home
  });

  assert.equal(detail.found, false);
  assert.deepEqual(detail.exchanges, []);
});

test('reads a sub-agent that exists only in the injected filesystem and closes both handles', () => {
  const home = tmpDir('codebuddy-injected-detail-');
  const parentId = '01a13463-cb53-72a7-afee-0164d5bdde33';
  const subId = '01a13466-8201-7275-95ad-04d2f3520e7e';
  const root = path.join(home, '.codebuddy', 'projects');
  const project = path.join(root, 'project');
  const parent = path.join(project, parentId);
  const subagents = path.join(parent, 'subagents');
  const file = path.join(subagents, 'agent-a.jsonl');
  const content = Buffer.from([
    withSessionId(user('collect competitor pricing'), subId),
    withSessionId(call('s1', 'WebSearch', usageOf({ prompt: 1000, completion: 100, hit: 400 })), subId),
    withSessionId(reply('s2', 'done', usageOf({ prompt: 2000, completion: 100 })), subId)
  ].join('\n'));
  const entry = (name, directory) => ({ name, isDirectory: () => directory, isFile: () => !directory });
  const directories = new Map([
    [root, [entry('project', true)]],
    [project, [entry(parentId, true)]],
    [parent, [entry('subagents', true)]],
    [subagents, [entry('agent-a.jsonl', false)]]
  ]);
  const handles = new Map();
  const opened = [];
  const closed = [];
  const injectedFs = {
    readdirSync(dir) {
      assert.ok(directories.has(dir));
      return directories.get(dir);
    },
    openSync(filePath) {
      assert.equal(filePath, file);
      const fd = opened.length + 1;
      opened.push(fd);
      handles.set(fd, 0);
      return fd;
    },
    readSync(fd, buffer, offset, length, position) {
      assert.ok(handles.has(fd));
      const start = position === null ? handles.get(fd) : position;
      const count = content.copy(buffer, offset, start, start + length);
      if (position === null) handles.set(fd, start + count);
      return count;
    },
    closeSync(fd) {
      assert.ok(handles.delete(fd));
      closed.push(fd);
    }
  };

  assert.equal(fs.existsSync(file), false);
  const detail = readSessionDetail({ client: 'codebuddy', sessionId: subId, home, deps: { fs: injectedFs } });

  assert.equal(detail.found, true);
  assert.deepEqual(detail.exchanges.map(ex => ex.promptPreview), ['collect competitor pricing']);
  assert.deepEqual(detail.exchanges[0].tools, ['WebSearch']);
  assert.equal(detail.totals.turnCount, 2);
  assert.equal(detail.totals.totalTokens, 3200);
  assert.equal(opened.length, 2);
  assert.deepEqual(closed, opened);
  assert.equal(handles.size, 0);
});
