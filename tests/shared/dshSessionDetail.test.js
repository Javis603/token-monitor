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
test('readDshSessionDetail drops events at or before seedLength on a forked session', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root, 'session-fork', [
    sessionHeader({ id: 'session-fork', parentSession: 'session-parent', seedLength: 4 }),
    userMessage({ seq: 1, text: 'inherited from parent' }),
    assistantMessage({ seq: 2, usage: { inputTokens: 1000, outputTokens: 1000 } }),
    { type: 'session/end-seed', seq: 4, time: BASE_TIME + 4000, data: {} },
    userMessage({ seq: 5, text: 'the forks own new question' }),
    assistantMessage({ seq: 6, usage: { inputTokens: 10, outputTokens: 5 } })
  ]);

  const detail = readDshSessionDetail({ sessionId: 'session-fork', sessionsRoot: root, home: '/home/tester', env: {} });
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'the forks own new question');
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
