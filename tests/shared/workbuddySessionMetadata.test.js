'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const { resolveSessionFile } = require('../../src/shared/sessionFiles');
const { readSessionDetail } = require('../../src/shared/sessionDetail');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const SESSION = '104ae982fbaa4e6383d9e0843b145ced';

function transcript() {
  return [
    JSON.stringify({
      type: 'custom-title',
      customTitle: '手改的标题',
      timestamp: 1776418026391,
      sessionId: SESSION
    }),
    JSON.stringify({
      type: 'ai-title',
      aiTitle: '生成的标题',
      timestamp: 1776418025188,
      sessionId: SESSION
    }),
    JSON.stringify({
      type: 'message',
      role: 'user',
      timestamp: 1776418025188,
      sessionId: SESSION,
      cwd: 'D:\\work\\demo',
      content: [{ type: 'input_text', text: '你好' }]
    }),
    JSON.stringify({
      id: 'call-1',
      type: 'function_call',
      name: 'Read',
      status: 'completed',
      timestamp: 1776418030000,
      sessionId: SESSION,
      providerData: {
        messageId: 'm1',
        model: 'glm-5.3-flash',
        rawUsage: {
          prompt_tokens: 1000,
          completion_tokens: 50,
          prompt_cache_hit_tokens: 400,
          completion_thinking_tokens: 10
        }
      }
    }),
    JSON.stringify({
      type: 'message',
      role: 'assistant',
      status: 'completed',
      timestamp: 1776418031000,
      sessionId: SESSION,
      providerData: { messageId: 'm1' },
      content: [{ type: 'output_text', text: '好的' }]
    })
  ].join('\n') + '\n';
}

function makeHome(rootName) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-'));
  tmpDirs.push(home);
  const dir = path.join(home, rootName, 'projects', 'c-Users-me-WorkBuddy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${SESSION}.jsonl`), transcript());
  return home;
}

test('resolves a workbuddy session from either home', () => {
  const legacy = makeHome('.workbuddy');
  try {
    assert.equal(resolveSessionFile('workbuddy', SESSION, legacy), path.join(
      legacy, '.workbuddy', 'projects', 'c-Users-me-WorkBuddy', `${SESSION}.jsonl`
    ));
  } finally { fs.rmSync(legacy, { recursive: true, force: true }); }

  const moved = makeHome('.workbuddy-ai');
  try {
    // 5.5 moved the home; tokscale scans both, so both stay resolvable.
    assert.equal(resolveSessionFile('workbuddy', SESSION, moved), path.join(
      moved, '.workbuddy-ai', 'projects', 'c-Users-me-WorkBuddy', `${SESSION}.jsonl`
    ));
  } finally { fs.rmSync(moved, { recursive: true, force: true }); }
});

test('the user\u2019s custom title outranks the generated one', () => {
  const home = makeHome('.workbuddy');
  const periods = {
    today: { sessions: { [`workbuddy:${SESSION}`]: { client: 'workbuddy', sessionId: SESSION } } },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  applySessionMetadata(periods, home, {});
  const session = periods.today.sessions[`workbuddy:${SESSION}`];
  assert.equal(session.title, '手改的标题');
  assert.equal(session.turnEnded, true);
  const identity = projectIdentity('D:\\work\\demo');
  assert.equal(session.projectId, identity.projectId);
  assert.equal(session.projectLabel, identity.projectLabel);
});

test('parses a workbuddy transcript into the shared detail shape', () => {
  const home = makeHome('.workbuddy');
  const detail = readSessionDetail({
    client: 'workbuddy',
    sessionId: SESSION,
    period: 'total',
    sessionCost: 0.2,
    home
  });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 1);
  const [exchange] = detail.exchanges;
  assert.equal(exchange.promptPreview, '你好');
  assert.deepEqual(exchange.tools, ['Read']);
  assert.deepEqual(
    [exchange.tokens.input, exchange.tokens.output, exchange.tokens.cacheRead],
    [600, 50, 400]
  );
});

test('reads an older transcript that groups neither id nor cache fields', () => {
  // Older builds wrote a bare snake-case `usage` with no
  // `providerData.messageId` at all: each usage-bearing record is its own
  // response, and the calls before it — which nothing ties to a response —
  // ride the next turn's tools. Verified against tokscale: a real transcript
  // in this shape folds to the scan's exact input, output and message count.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'workbuddy-old-'));
  tmpDirs.push(home);
  const dir = path.join(home, '.workbuddy', 'projects', 'c-Users-me-WorkBuddy');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'old1.jsonl'), [
    JSON.stringify({
      type: 'message', role: 'user', timestamp: 1776418025188, sessionId: 'old1',
      content: [{ type: 'input_text', text: '第一条' }]
    }),
    JSON.stringify({
      id: 'c1', type: 'function_call', name: 'Read', timestamp: 1776418030000,
      sessionId: 'old1', providerData: {}
    }),
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: 1776418031000, sessionId: 'old1',
      providerData: { model: 'auto', usage: { input_tokens: 29254, output_tokens: 116, total_tokens: 29370 } },
      content: [{ type: 'output_text', text: '答' }]
    }),
    JSON.stringify({
      type: 'message', role: 'user', timestamp: 1776418040000, sessionId: 'old1',
      content: [{ type: 'input_text', text: '第二条' }]
    }),
    JSON.stringify({
      type: 'message', role: 'assistant', timestamp: 1776418041000, sessionId: 'old1',
      providerData: { model: 'auto', usage: { input_tokens: 48294, output_tokens: 274, total_tokens: 48568 } },
      content: [{ type: 'output_text', text: '答2' }]
    })
  ].join('\n') + '\n');

  const detail = readSessionDetail({ client: 'workbuddy', sessionId: 'old1', period: 'total', home });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 2);
  assert.deepEqual(detail.exchanges.map((ex) => ex.promptPreview), ['第一条', '第二条']);
  const [first, second] = detail.exchanges;
  assert.deepEqual([first.tools, second.tools], [['Read'], []]);
  assert.deepEqual(
    [first.tokens.input, first.tokens.output],
    [29254, 116]
  );
  assert.deepEqual([second.tokens.input, second.tokens.output], [48294, 274]);
  assert.equal(detail.totals.turnCount, 2);
});
