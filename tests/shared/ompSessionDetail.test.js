'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { readSessionDetail } = require('../../src/shared/sessionDetail');

function tmpHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'tm-omp-home-'));
}

function cleanup(home) {
  fs.rmSync(home, { recursive: true, force: true });
}

function titleSlot() {
  return JSON.stringify({ type: 'title', v: 1, title: 'OMP detail test', pad: ' '.repeat(180) });
}

function sessionHeader(id, extra = {}) {
  return JSON.stringify({ type: 'session', version: 3, id, timestamp: '2026-10-01T00:00:00.000Z', cwd: '/project', ...extra });
}

function user(text) {
  return JSON.stringify({ type: 'message', id: 'u1', parentId: null, timestamp: '2026-10-01T00:00:01.000Z', message: { role: 'user', content: [{ type: 'text', text }] } });
}

function assistant(usage, content = []) {
  return JSON.stringify({ type: 'message', id: 'a1', parentId: 'u1', timestamp: '2026-10-01T00:00:02.000Z', message: { role: 'assistant', content, usage } });
}

function writeMainSession(home, sessionId, records) {
  const dir = path.join(home, '.omp', 'agent', 'sessions', '-project');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, `2026-10-01T00-00-00-000Z_${sessionId}.jsonl`);
  fs.writeFileSync(file, [titleSlot(), sessionHeader(sessionId), ...records].join('\n'));
  return file;
}

function writeSubagentSession(home, parentId, sessionId, taskName, records) {
  const dir = path.join(home, '.omp', 'agent', 'sessions', '-project', `2026-10-01T00-00-00-000Z_${parentId}`);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, taskName);
  fs.writeFileSync(file, [titleSlot(), sessionHeader(sessionId, { parentSession: parentId }), ...records].join('\n'));
  return file;
}

test('OMP main session detail reads prompts, tokens, tools and reported costs', () => {
  const home = tmpHome();
  try {
    const sessionId = 'omp-main';
    writeMainSession(home, sessionId, [
      user('first prompt'),
      assistant({ input: 10, output: 5, cacheRead: 3, cacheWrite: 2, reasoningTokens: 2, cost: { total: 0.003 } }, [{ type: 'toolCall', name: 'Read' }]),
      assistant({ input: 4, output: 7, cacheRead: 8, cacheWrite: 1, cost: { total: 0.004 } }, [{ type: 'toolCall', name: 'bash' }])
    ]);

    const detail = readSessionDetail({ client: 'omp', sessionId, sessionCost: 99, home });

    assert.equal(detail.found, true);
    assert.equal(detail.exchanges.length, 1);
    assert.equal(detail.exchanges[0].promptPreview, 'first prompt');
    assert.equal(detail.exchanges[0].turns.length, 2);
    assert.deepEqual(detail.exchanges[0].tools, ['Read', 'bash']);
    assert.equal(detail.exchanges[0].turns[0].tokens.reasoning, 2);
    assert.equal(detail.exchanges[0].turns[0].tokens.total, 20, 'reasoningTokens is informational, not added to total');
    assert.ok(Math.abs(detail.totals.costUsd - 0.007) < 1e-9);
    assert.equal(detail.totals.turnCount, 2);
  } finally { cleanup(home); }
});

test('OMP child sessions resolve by header id and keep usage separate from the parent', () => {
  const home = tmpHome();
  try {
    const parentId = 'omp-parent';
    const childId = 'omp-child';
    writeMainSession(home, parentId, [
      user('parent prompt'),
      assistant({ input: 9, output: 1, cost: { total: 0.25 } })
    ]);
    const childFile = writeSubagentSession(home, parentId, childId, 'explore.jsonl', [
      user('child prompt'),
      assistant({ input: 6, output: 3, cacheRead: 2, cacheWrite: 1, cost: { total: 0.125 } }, [{ type: 'toolCall', name: 'grep' }])
    ]);
    const brokenDir = path.dirname(childFile);
    fs.writeFileSync(path.join(brokenDir, 'broken.jsonl'), '{bad json\n');

    const child = readSessionDetail({ client: 'omp', sessionId: childId, home });
    const parent = readSessionDetail({ client: 'omp', sessionId: parentId, home });
    const unknown = readSessionDetail({ client: 'omp', sessionId: 'omp-unknown', home });

    assert.equal(child.found, true);
    assert.equal(child.exchanges.length, 1);
    assert.equal(child.exchanges[0].promptPreview, 'child prompt');
    assert.deepEqual(child.exchanges[0].tools, ['grep']);
    assert.equal(child.totals.totalTokens, 12);
    assert.equal(child.totals.costUsd, 0.125);
    assert.equal(parent.found, true);
    assert.equal(parent.totals.totalTokens, 10);
    assert.equal(parent.totals.costUsd, 0.25);
    assert.equal(unknown.found, false);
    assert.equal(Object.hasOwn(unknown, 'error'), false);
  } finally { cleanup(home); }
});

test('OMP fork details retain copied assistant history and zero-cost new replies', () => {
  const home = tmpHome();
  try {
    const sharedUsage = { input: 100, output: 20, cacheRead: 300, cost: { total: 0.42 } };
    const sharedReply = assistant(sharedUsage, [{ type: 'toolCall', name: 'read' }]);
    const copiedReply = JSON.parse(sharedReply);
    copiedReply.message.usage.cost.total = 0;
    writeMainSession(home, 'parent', [
      user('shared prompt'), sharedReply,
      user('parent work'), assistant({ input: 3, output: 2, cost: { total: 0 } })
    ]);
    writeSubagentSession(home, 'parent', 'child', 'Tan-test.jsonl', [
      user('shared prompt'), JSON.stringify(copiedReply),
      user('child work'), assistant({ input: 7, output: 3, cost: { total: 0 } })
    ]);
    for (const [sessionId, totalTokens] of [['parent', 425], ['child', 430]]) {
      const detail = readSessionDetail({ client: 'omp', sessionId, home });
      assert.equal(detail.found, true);
      assert.equal(detail.totals.totalTokens, totalTokens);
      assert.equal(detail.totals.turnCount, 2);
      assert.deepEqual(detail.exchanges.map(exchange => exchange.promptPreview), ['shared prompt', `${sessionId} work`]);
      assert.equal(detail.exchanges[0].turns[0].tokens.total, 420, 'copied tokens remain transcript context');
      assert.deepEqual(detail.exchanges[0].tools, ['read']);
      assert.equal(detail.exchanges[1].turns.length, 1, 'zero cost does not hide a new reply');
    }
  } finally { cleanup(home); }
});
