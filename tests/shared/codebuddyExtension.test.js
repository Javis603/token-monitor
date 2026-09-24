'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const { applySessionMetadata, projectIdentity } = require('../../src/shared/sessionMetadata');
const {
  readCodebuddyExtensionSessionDetail,
  readSessionDetail
} = require('../../src/shared/sessionDetail');
const { findExtensionSession } = require('../../src/shared/providers/codebuddy/extension');

const tmpDirs = [];
test.after(() => {
  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
});

const TRACE = '60c91143d59742e3169c619c0ee7e13c';
const CONVERSATION = '0006a8e3aea0472283a80f0a93c850c4';
const WORKSPACE_FOLDER = 'D:\\work\\demo';

// The extension writes both the message payload and its metadata as JSON
// strings inside the message file, and keeps the prompt the user actually saw
// beside the context-wrapped payload in `extra.sourceContentBlocks`.
function messageFile(id, { role, traceId, prompt = '', contentText = '', createdAt = 1790211700000 }) {
  return JSON.stringify({
    id,
    role,
    createdAt,
    message: JSON.stringify({
      role,
      content: [{ type: 'text', text: `<user_info>\nWorkspace Folder: ${WORKSPACE_FOLDER}\n</user_info>\n\n${contentText}` }]
    }),
    extra: JSON.stringify({
      traceId,
      sourceContentBlocks: prompt ? [{ type: 'text', text: prompt }] : []
    })
  });
}

function conversationIndex(requests) {
  return JSON.stringify({
    messages: requests.flatMap((request) => request.messages.map((id) => ({
      id, type: 'text', role: id.endsWith('u') ? 'user' : 'assistant', isComplete: true
    }))),
    requests
  });
}

function workspaceIndex(conversations) {
  return JSON.stringify({ conversations, current: conversations[0]?.id });
}

// One Data root, one install, one editor, one workspace — the four id levels
// between the base and the history dir are not a contract, so the fixture
// spells out the observed shape.
function makeExtensionHome({ requests, name = '插件会话标题', state = 'complete' }) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'codebuddy-ext-'));
  tmpDirs.push(home);
  const history = path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'install-1', 'VSCode', 'editor-1', 'history', 'workspace-1');
  fs.mkdirSync(path.join(history, CONVERSATION, 'messages'), { recursive: true });
  fs.writeFileSync(path.join(history, 'index.json'), workspaceIndex([
    { id: CONVERSATION, type: 'craft', name, createdAt: '2026-09-23T02:30:58.517Z', lastMessageAt: '2026-09-24T01:02:03.506Z' }
  ]));
  fs.writeFileSync(path.join(history, CONVERSATION, 'index.json'), conversationIndex(requests.map((request) => ({
    ...request,
    state,
    messages: request.messages.map((message) => `${message}${message.endsWith('u') ? '' : ''}`)
  }))));
  for (const request of requests) {
    for (const [index, messageId] of request.messages.entries()) {
      const isUser = index === 0;
      fs.writeFileSync(
        path.join(history, CONVERSATION, 'messages', `${messageId}.json`),
        messageFile(messageId, {
          role: isUser ? 'user' : 'assistant',
          traceId: request.traceId,
          prompt: isUser ? '帮我看下这个 bug' : ''
        })
      );
    }
  }
  return home;
}

function usageOf({ input, output, cache = 0, write = 0 }) {
  return {
    inputTokens: input,
    outputTokens: output,
    totalTokens: input + output,
    cacheTokens: cache,
    cachedWriteTokens: write,
    cachedMissTokens: input - cache - write
  };
}

const options = (home) => ({ homeDir: home, env: { LOCALAPPDATA: home }, platform: 'win32' });

test('resolves the conversation title, the workspace and the turn boundary', () => {
  const home = makeExtensionHome({
    requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50, cache: 400 }) }],
    state: 'complete'
  });
  const found = findExtensionSession(TRACE, options(home));
  assert.equal(found.title, '插件会话标题');
  // The workspace folder rides the first user message's own envelope, which is
  // what joins these sessions to project grouping without a `cwd` anywhere.
  assert.equal(found.workspaceFolder, WORKSPACE_FOLDER);
  assert.equal(found.state, 'complete');

  // A request that has not completed is an open turn, and a conversation with
  // no requests answers nothing at all.
  const running = makeExtensionHome({
    requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50 }) }],
    state: 'running'
  });
  assert.equal(findExtensionSession(TRACE, options(running)).state, 'running');
  assert.equal(findExtensionSession('no-such-trace', options(home)), null);
});

test('decorates an extension session row through the shared metadata pass', () => {
  const home = makeExtensionHome({
    requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50, cache: 400 }) }]
  });
  const periods = {
    today: { sessions: { [`codebuddy:${TRACE}`]: { client: 'codebuddy', sessionId: TRACE } } },
    month: { sessions: {} },
    allTime: { sessions: {} }
  };
  applySessionMetadata(periods, home, {
    env: { LOCALAPPDATA: home },
    platform: 'win32',
    codebuddyExtensionDeps: {}
  });

  const session = periods.today.sessions[`codebuddy:${TRACE}`];
  assert.equal(session.title, '插件会话标题');
  assert.equal(session.turnEnded, true);
  const identity = projectIdentity(WORKSPACE_FOLDER);
  assert.equal(session.projectId, identity.projectId);
  assert.equal(session.projectLabel, identity.projectLabel);
});

test('parses a request into one exchange with the client\u2019s own token split', () => {
  // `cachedMissTokens` is the client's own uncached input; taking the gross
  // `inputTokens` instead would count the cached part twice, which is the same
  // convention the CLI transcript's `prompt_tokens` follows.
  const home = makeExtensionHome({
    requests: [{
      traceId: TRACE,
      messages: [`${TRACE}u`, `${TRACE}a`],
      startedAt: 1790211716645,
      usage: usageOf({ input: 232098, output: 3581, cache: 189056 })
    }]
  });
  const detail = readCodebuddyExtensionSessionDetail({
    sessionId: TRACE,
    period: 'total',
    sessionCost: 0.5,
    home,
    env: { LOCALAPPDATA: home },
    deps: { platform: 'win32' }
  });

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 1);
  const [exchange] = detail.exchanges;
  assert.equal(exchange.promptPreview, '帮我看下这个 bug');
  assert.equal(exchange.turnCount, 1);
  // 232098 input − 189056 cached = 43042 uncached input; the verified tokscale
  // numbers for this exact request are 43042 / 3581 / 189056.
  assert.deepEqual(
    [exchange.tokens.input, exchange.tokens.output, exchange.tokens.cacheRead],
    [43042, 3581, 189056]
  );
  assert.equal(detail.totals.costUsd, 0.5);
});

test('falls back to the extension store when no CLI transcript exists', () => {
  const home = makeExtensionHome({
    requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50 }) }]
  });
  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId: TRACE,
    period: 'total',
    home,
    env: { LOCALAPPDATA: home },
    deps: { platform: 'win32' }
  });
  assert.equal(detail.found, true);
  assert.equal(detail.exchanges.length, 1);
});

test('reports not found when neither store has the session', () => {
  const home = makeExtensionHome({ requests: [] });
  const detail = readSessionDetail({
    client: 'codebuddy',
    sessionId: 'missing-session',
    period: 'total',
    home,
    env: { LOCALAPPDATA: home },
    deps: { platform: 'win32' }
  });
  assert.equal(detail.found, false);
  assert.deepEqual(detail.exchanges, []);
});
