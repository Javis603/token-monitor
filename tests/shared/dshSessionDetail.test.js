'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readDshSessionDetail, parseDshDetailEvents } = require('../../src/shared/dshSessionDetail');

const BASE_TIME = Date.parse('2026-08-15T10:00:00Z');

function sessionHeader({ id, seedLength, parentSession } = {}) {
  return {
    type: 'session',
    version: 0,
    id,
    createdAt: BASE_TIME,
    cwd: '/work/project',
    delegationDepth: 0,
    agentPreset: 'standard',
    ...(seedLength !== undefined ? { seedLength } : {}),
    ...(parentSession ? { parentSession } : {})
  };
}

function userMessage({ seq, text, kind = 'user' }) {
  return {
    type: 'user/message',
    seq,
    time: BASE_TIME + seq * 1000,
    data: { content: [{ type: 'text', text }], source: { kind }, role: 'user' }
  };
}

function imageBlock(index = 0) {
  return { type: 'image', attachment: { attachmentId: `att_${index}`, mediaType: 'image/png', bytes: 10, width: 1, height: 1, name: `img${index}.png` } };
}

function userMessageWithBlocks({ seq, blocks, kind = 'user' }) {
  return {
    type: 'user/message',
    seq,
    time: BASE_TIME + seq * 1000,
    data: { content: blocks, source: { kind }, role: 'user' }
  };
}

function assistantMessage({ seq, usage, tools = [] }) {
  return {
    type: 'assistant/message',
    seq,
    time: BASE_TIME + seq * 1000,
    data: {
      turn: 1,
      step: 1,
      message: {
        role: 'assistant',
        content: [
          { type: 'text', text: 'reply' },
          ...tools.map((name, index) => ({ type: 'tool-call', id: `call_${index}`, name, arguments: '{}' }))
        ],
        source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4-flash' }
      },
      usage
    }
  };
}

function compactionSummary({ seq, usage }) {
  return {
    type: 'compaction/summary',
    seq,
    time: BASE_TIME + seq * 1000,
    data: {
      message: {
        source: { kind: 'model', provider: 'opencode-go', model: 'deepseek-v4-flash' }
      },
      usage
    }
  };
}

function writeFixture(root, sessionId, lines) {
  const dir = path.join(root, 'proj', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`);
  return dir;
}

test('readDshSessionDetail groups a real prompt with its reply and extracts tool calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-basic', [
    sessionHeader({ id: 'session-basic' }),
    userMessage({ seq: 1, text: 'Read package.json and run lint.' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 100, outputTokens: 20, cacheReadTokens: 50 }, tools: ['read', 'bash'] })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-basic', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.found, true);
  assert.equal(detail.client, 'dsh');
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'Read package.json and run lint.');
  assert.deepEqual(detail.exchanges[0].tools, ['read', 'bash']);
  assert.equal(detail.totals.totalTokens, 170);
});

// DSH carries a user-pasted image as a top-level `image` content block, not
// inline in the text. Without an image marker an image-only prompt produces no
// text, so its reply gets stranded as an empty exchange — mirror the
// Codex/Claude convention so the prompt survives.
test('readDshSessionDetail keeps an image-only prompt as [image]', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-image', [
    sessionHeader({ id: 'session-image' }),
    userMessageWithBlocks({ seq: 1, blocks: [imageBlock()] }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-image', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, '[image]');
  assert.equal(detail.totals.totalTokens, 15);
});

test('readDshSessionDetail prepends [image] to an image-plus-text prompt', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-image-text', [
    sessionHeader({ id: 'session-image-text' }),
    userMessageWithBlocks({ seq: 1, blocks: [imageBlock(), { type: 'text', text: 'describe this' }] }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-image-text', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges[0].promptPreview, '[image] describe this');
});

test('readDshSessionDetail counts multiple images as [N images]', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-images', [
    sessionHeader({ id: 'session-images' }),
    userMessageWithBlocks({ seq: 1, blocks: [imageBlock(0), imageBlock(1), imageBlock(2)] }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-images', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges[0].promptPreview, '[3 images]');
});

// DSH's outputTokens includes reasoning tokens as a subset. tokscale's dsh
// parser subtracts reasoning out of its internal `output` bucket, but its
// TokenBreakdown.total() adds `reasoning` straight back on top — the two
// cancel out, so tokscale's own reported total is input + RAW output + cache.
// makeTokens works the other way (output already reasoning-inclusive, total
// excludes reasoning), so passing outputTokens through unmodified is what
// actually matches tokscale, not subtracting it.
test('readDshSessionDetail counts reasoning tokens once, matching tokscale total()', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-reasoning', [
    sessionHeader({ id: 'session-reasoning' }),
    userMessage({ seq: 1, text: 'solve this' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 100, reasoningTokens: 60 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-reasoning', sessionsRoot: root, home: '/home/tester', env: {} });
  // tokscale: input(10) + output(100 - 60) + reasoning(60) = 110.
  assert.equal(detail.totals.totalTokens, 110);
});

test('readDshSessionDetail counts compaction summaries as real provider calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-summary', [
    sessionHeader({ id: 'session-summary' }),
    userMessage({ seq: 1, text: 'continue after compacting' }),
    compactionSummary({ seq: 2, usage: { inputTokens: 10, outputTokens: 20 } }),
    assistantMessage({ seq: 3, usage: { inputTokens: 30, outputTokens: 40 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-summary', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].turnCount, 1);
  assert.equal(detail.exchanges[0].turns.length, 2);
  assert.deepEqual(detail.exchanges[0].turns.map((turn) => turn.type), ['compaction-summary', 'reply']);
  assert.equal(detail.totals.totalTokens, 100);
  assert.equal(detail.totals.turnCount, 1);
});

test('readDshSessionDetail namespaces summaries away from matching assistant calls', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  const summary = compactionSummary({ seq: 2, usage: { inputTokens: 10, outputTokens: 20 } });
  const assistant = assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 20 } });
  writeFixture(root, 'session-summary-identity', [
    sessionHeader({ id: 'session-summary-identity' }),
    summary,
    summary,
    assistant
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-summary-identity', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges[0].turnCount, 1);
  assert.equal(detail.exchanges[0].turns.length, 2);
  assert.equal(detail.totals.totalTokens, 60);
});

test('readDshSessionDetail retains summary-only paid usage without claiming a reply', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-summary-only', [
    sessionHeader({ id: 'session-summary-only' }),
    compactionSummary({ seq: 1, usage: { inputTokens: 10, outputTokens: 20 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-summary-only', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].turnCount, 0);
  assert.equal(detail.exchanges[0].turns.length, 1);
  assert.equal(detail.totals.totalTokens, 30);
});

// #419 (the PR this module's discovery/decode primitives were extracted from)
// pushed a prompt bubble for every user/message with non-empty text, with no
// check on data.source.kind. Real dsh transcripts inject AGENTS.md, runtime
// context and the skill catalog as user/message records with non-`user`
// kinds — that regression must not resurface.
test('readDshSessionDetail ignores harness-injected non-user messages', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-synthetic', [
    sessionHeader({ id: 'session-synthetic' }),
    userMessage({ seq: 1, text: '# AGENTS.md\n...huge injected doc...', kind: 'agent-instructions' }),
    userMessage({ seq: 2, text: 'Available skills: ...', kind: 'skill-catalog' }),
    userMessage({ seq: 3, text: 'hi', kind: 'user' }),
    assistantMessage({ seq: 4, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-synthetic', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'hi');
});

// Tokscale's own dsh scanner credits a fork's seeded (copied) prefix to the
// parent session only. Session Detail must match, or opening a forked
// session shows more tokens than the session's own card/total.
test('readDshSessionDetail drops events strictly before seedLength on a forked session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-fork', [
    sessionHeader({ id: 'session-fork', parentSession: 'session-parent', seedLength: 4 }),
    userMessage({ seq: 1, text: 'inherited from parent' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 1000, outputTokens: 1000 } }),
    compactionSummary({ seq: 3, usage: { inputTokens: 1000, outputTokens: 1000 } }),
    { type: 'session/end-seed', seq: 4, time: BASE_TIME + 4000, data: {} },
    // tokscale's own dsh parser skips strictly `seq < seedLength` (dsh.rs),
    // so the event AT seq === seedLength is the fork's own first new event,
    // not part of the inherited prefix, and must be counted.
    userMessage({ seq: 4, text: 'the forks own new question' }),
    assistantMessage({ seq: 5, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-fork', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'the forks own new question');
  assert.equal(detail.totals.totalTokens, 15);
});

test('readDshSessionDetail keeps a usage row without seq even when a fork has seedLength', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  const turn = assistantMessage({ seq: 5, usage: { inputTokens: 10, outputTokens: 5 } });
  delete turn.seq;
  writeFixture(root, 'session-fork-no-seq', [
    sessionHeader({ id: 'session-fork-no-seq', parentSession: 'session-parent', seedLength: 4 }),
    turn
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-fork-no-seq', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.totals.totalTokens, 15);
});

test('readDshSessionDetail counts every event when the session was never forked', () => {
  const events = parseDshDetailEvents([
    sessionHeader({ id: 'session-plain' }),
    userMessage({ seq: 1, text: 'hi' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ].map((line) => JSON.stringify(line)).join('\n'));
  assert.equal(events.length, 2);
});

// tokscale's own loop never gates event processing on having seen the
// session header first — every line is matched by its own `type`
// independently (dsh.rs). A torn or corrupt header must not turn an
// otherwise-parseable transcript into a reported zero: findDshSessionFile
// falls back to the directory name to still locate the file, and
// parseDshDetailEvents must still count the real events it finds in it.
test('readDshSessionDetail still counts events when the header itself is unreadable', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  const dir = path.join(root, 'proj', 'session-no-header');
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    'this is not a session header at all',
    userMessage({ seq: 1, text: 'hi anyway' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ].map((line) => (typeof line === 'string' ? line : JSON.stringify(line)));
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);

  const detail = readDshSessionDetail({ sessionId: 'session-no-header', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.totals.totalTokens, 15);
});

test('readDshSessionDetail returns not-found for an unknown session id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-basic', [
    sessionHeader({ id: 'session-basic' }),
    userMessage({ seq: 1, text: 'hi' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);
  const detail = readDshSessionDetail({ sessionId: 'missing', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.found, false);
  assert.equal(detail.client, 'dsh');
});

test('readDshSessionDetail skips an assistant/message with no usable usage', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-zero', [
    sessionHeader({ id: 'session-zero' }),
    userMessage({ seq: 1, text: 'hi' }),
    { type: 'assistant/message', seq: 2, time: BASE_TIME + 2000, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] } } }
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-zero', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.totals.totalTokens, 0);
});

// tokscale requires a usable, positive `time` on assistant/message and drops
// the record otherwise (dsh.rs `skips_zero_usage_and_missing_timestamp`);
// without this, a timestamp-less record would default to epoch 0 here and
// either sort out of order or vanish from every non-"total" period filter.
test('readDshSessionDetail skips an assistant/message with a missing or non-positive time', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-no-time', [
    sessionHeader({ id: 'session-no-time' }),
    userMessage({ seq: 1, text: 'hi' }),
    { type: 'assistant/message', seq: 2, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 5 } } },
    { type: 'assistant/message', seq: 3, time: 0, data: { turn: 1, step: 1, message: { role: 'assistant', content: [] }, usage: { inputTokens: 10, outputTokens: 5 } } }
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-no-time', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.totals.totalTokens, 0);
});

// dsh's own persistence layer can replay an already-flushed line back into
// the file (crash/retry on the writer side); tokscale dedups identical
// replayed rows within a file (dsh.rs `dedups_identical_replayed_rows_within_a_file`)
// rather than counting each copy.
test('readDshSessionDetail dedups an identical replayed assistant/message', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  const turn = assistantMessage({ seq: 2, usage: { inputTokens: 10, outputTokens: 5 } });
  writeFixture(root, 'session-replay', [
    sessionHeader({ id: 'session-replay' }),
    userMessage({ seq: 1, text: 'hi' }),
    turn,
    turn // the exact same line, replayed
  ]);
  const detail = readDshSessionDetail({ sessionId: 'session-replay', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.totals.totalTokens, 15);
});
