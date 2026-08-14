'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { readDshSessionDetail } = require('../../src/shared/dshSessionDetail');

function writeFixture(root, sessionId = 'session-detail') {
  const time = Date.parse('2026-08-15T10:00:00Z');
  const dir = path.join(root, 'proj', sessionId);
  fs.mkdirSync(dir, { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session', version: 0, id: sessionId, createdAt: time, cwd: '/work/project', delegationDepth: 0 }),
    JSON.stringify({ type: 'user/message', seq: 0, time, data: { content: [{ type: 'text', text: 'Explain event sourcing.' }] } }),
    JSON.stringify({
      type: 'assistant/message',
      seq: 1,
      time: time + 1000,
      data: {
        turn: 1,
        step: 1,
        content: [{ type: 'text', text: 'Event sourcing stores state as an append-only log.' }],
        provenance: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
        usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 20, reasoningTokens: 2 }
      }
    })
  ];
  fs.writeFileSync(path.join(dir, 'session.jsonl'), `${lines.join('\n')}\n`);
}

test('readDshSessionDetail finds a session and groups prompt/turn events', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root);
  const detail = readDshSessionDetail({
    sessionId: 'session-detail',
    sessionsRoot: root,
    homeDir: '/home/tester',
    env: {},
    platform: process.platform,
    cwdDir: root
  });
  assert.equal(detail.found, true);
  assert.equal(detail.client, 'dsh');
  assert.equal(detail.totals.totalTokens, 35);
  assert.equal(detail.exchanges.length, 1);
  assert.equal(detail.exchanges[0].promptPreview, 'Explain event sourcing.');
  assert.equal(detail.exchanges[0].turns.length, 1);
  assert.equal(detail.exchanges[0].tokens.cacheRead, 20);
});

test('readDshSessionDetail returns not-found for an unknown session id', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-detail-'));
  writeFixture(root);
  const detail = readDshSessionDetail({
    sessionId: 'missing',
    sessionsRoot: root,
    homeDir: '/home/tester',
    env: {},
    platform: process.platform,
    cwdDir: root
  });
  assert.equal(detail.found, false);
  assert.equal(detail.client, 'dsh');
});
