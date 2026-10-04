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
const { clearExtensionCaches, findExtensionSession } = require('../../src/shared/providers/codebuddy/extension');
const { codebuddyExtensionDataRoots } = require('../../src/shared/providers/codebuddy/paths');

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

function extensionWorkspace(home) {
  return path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data', 'install-1', 'VSCode', 'editor-1', 'history', 'workspace-1');
}

for (const platform of ['darwin', 'linux']) {
  test(`${platform} resolves metadata and Detail from a Windows-shaped extension home`, () => {
    const home = makeExtensionHome({
      requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50, cache: 400 }) }]
    });
    const env = platform === 'linux' ? { XDG_DATA_HOME: path.join(home, 'xdg-data') } : {};
    assert.deepEqual(codebuddyExtensionDataRoots({ homeDir: home, env, platform }), [
      path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data'),
      platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Data')
        : path.join(home, 'xdg-data', 'CodeBuddyExtension', 'Data')
    ]);
    const periods = { today: { sessions: { [`codebuddy:${TRACE}`]: { client: 'codebuddy', sessionId: TRACE } } } };
    applySessionMetadata(periods, home, { env, platform });
    const session = periods.today.sessions[`codebuddy:${TRACE}`];
    assert.equal(session.title, '插件会话标题');
    assert.equal(session.turnEnded, true);
    const detail = readSessionDetail({ client: 'codebuddy', sessionId: TRACE, home, env, deps: { platform } });
    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].promptPreview, '帮我看下这个 bug');
    assert.deepEqual(
      [detail.exchanges[0].tokens.input, detail.exchanges[0].tokens.output, detail.exchanges[0].tokens.cacheRead],
      [600, 50, 400]
    );
  });
}

test('deduplicates the native Windows extension root when it matches the home-relative root', () => {
  const home = path.join(os.tmpdir(), 'codebuddy-home');
  assert.deepEqual(codebuddyExtensionDataRoots({ homeDir: home, platform: 'win32', env: { LOCALAPPDATA: path.join(home, 'AppData', 'Local') } }), [
    path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Data')
  ]);
});

test('refreshes rewritten request usage and state without a conversation directory change', () => {
  const home = makeExtensionHome({
    requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], usage: usageOf({ input: 1000, output: 50 }) }],
    state: 'running'
  });
  const dir = path.join(extensionWorkspace(home), CONVERSATION);
  const before = fs.statSync(dir).mtimeMs;
  assert.equal(findExtensionSession(TRACE, options(home)).state, 'running');
  fs.writeFileSync(path.join(dir, 'index.json'), conversationIndex([{
    messages: [`${TRACE}u`, `${TRACE}a`], state: 'complete', usage: usageOf({ input: 1000, output: 500 })
  }]));
  assert.equal(fs.statSync(dir).mtimeMs, before);
  const updated = findExtensionSession(TRACE, options(home));
  assert.equal(updated.state, 'complete');
  assert.equal(updated.usage.outputTokens, 500);
});

test('refreshes a renamed conversation independently of its request cache', () => {
  const home = makeExtensionHome({ requests: [{ traceId: TRACE, messages: [`${TRACE}u`], usage: usageOf({ input: 1000, output: 50 }) }] });
  const workspace = extensionWorkspace(home);
  const before = fs.statSync(workspace).mtimeMs;
  assert.equal(findExtensionSession(TRACE, options(home)).title, '插件会话标题');
  fs.writeFileSync(path.join(workspace, 'index.json'), workspaceIndex([{ id: CONVERSATION, name: 'Renamed conversation' }]));
  assert.equal(fs.statSync(workspace).mtimeMs, before);
  assert.equal(findExtensionSession(TRACE, options(home)).title, 'Renamed conversation');
});

test('discovers a request message that arrives after its index', () => {
  const lateTrace = 'late-trace';
  const home = makeExtensionHome({ requests: [{ traceId: TRACE, messages: [`${TRACE}u`], usage: usageOf({ input: 1000, output: 50 }) }] });
  const dir = path.join(extensionWorkspace(home), CONVERSATION);
  fs.writeFileSync(path.join(dir, 'index.json'), conversationIndex([
    { messages: [`${TRACE}u`], state: 'complete' },
    { messages: ['late-user'], state: 'complete' }
  ]));
  assert.equal(findExtensionSession(lateTrace, options(home)), null);
  const before = fs.statSync(dir).mtimeMs;
  fs.writeFileSync(path.join(dir, 'messages', 'late-user.json'), messageFile('late-user', { role: 'user', traceId: lateTrace, prompt: 'Late prompt' }));
  assert.equal(fs.statSync(dir).mtimeMs, before);
  assert.equal(findExtensionSession(lateTrace, options(home)).entries[0].displayText, 'Late prompt');
});

test('refreshes an existing message rewritten without an index change', () => {
  const home = makeExtensionHome({ requests: [{ traceId: TRACE, messages: [`${TRACE}u`], usage: usageOf({ input: 1000, output: 50 }) }] });
  assert.equal(findExtensionSession(TRACE, options(home)).entries[0].displayText, '帮我看下这个 bug');
  const dir = path.join(extensionWorkspace(home), CONVERSATION);
  fs.writeFileSync(path.join(dir, 'messages', `${TRACE}u.json`), messageFile(`${TRACE}u`, { role: 'user', traceId: TRACE, prompt: 'Updated prompt after a partial write' }));
  assert.equal(findExtensionSession(TRACE, options(home)).entries[0].displayText, 'Updated prompt after a partial write');
});

test('collects extension metadata in one history traversal for all requested trace ids', () => {
  const home = makeExtensionHome({ requests: [] });
  const workspace = extensionWorkspace(home);
  const conversations = [];
  const sessions = {};
  for (let index = 0; index < 12; index += 1) {
    const id = `conversation-${index}`;
    const traceId = `trace-${index}`;
    const dir = path.join(workspace, id);
    fs.mkdirSync(path.join(dir, 'messages'), { recursive: true });
    fs.writeFileSync(path.join(dir, 'index.json'), conversationIndex([{ messages: ['user'], state: 'complete', usage: usageOf({ input: 100, output: 10 }) }]));
    fs.writeFileSync(path.join(dir, 'messages', 'user.json'), messageFile('user', { role: 'user', traceId, prompt: `Prompt ${index}` }));
    conversations.push({ id, name: `Title ${index}` });
    sessions[`codebuddy:${traceId}`] = { client: 'codebuddy', sessionId: traceId };
  }
  fs.writeFileSync(path.join(workspace, 'index.json'), workspaceIndex(conversations));
  clearExtensionCaches();
  let workspaceWalks = 0;
  let workspaceIndexReads = 0;
  const fsApi = {
    ...fs,
    readdirSync(dir, ...args) {
      if (dir === workspace) workspaceWalks += 1;
      return fs.readdirSync(dir, ...args);
    },
    readFileSync(file, ...args) {
      if (file === path.join(workspace, 'index.json')) workspaceIndexReads += 1;
      return fs.readFileSync(file, ...args);
    }
  };
  applySessionMetadata({ today: { sessions } }, home, { ...options(home), fs: fsApi });
  assert.equal(workspaceWalks, 1);
  assert.equal(workspaceIndexReads, 1);
  assert.deepEqual(Object.values(sessions).map((session) => session.title), conversations.map((conversation) => conversation.name));
});

test('uses message time for today and month details when request start time is missing or invalid', () => {
  const now = new Date(2026, 8, 24, 12).getTime();
  for (const startedAt of [undefined, 'invalid timestamp']) {
    const home = makeExtensionHome({ requests: [{ traceId: TRACE, messages: [`${TRACE}u`, `${TRACE}a`], startedAt, usage: usageOf({ input: 1000, output: 50 }) }] });
    const dir = path.join(extensionWorkspace(home), CONVERSATION, 'messages');
    fs.writeFileSync(path.join(dir, `${TRACE}u.json`), messageFile(`${TRACE}u`, { role: 'user', traceId: TRACE, prompt: 'Current prompt', createdAt: now - 1000 }));
    fs.writeFileSync(path.join(dir, `${TRACE}a.json`), messageFile(`${TRACE}a`, { role: 'assistant', traceId: TRACE, createdAt: now }));
    for (const period of ['today', 'month']) {
      const detail = readSessionDetail({ client: 'codebuddy', sessionId: TRACE, period, home, env: options(home).env, deps: { platform: 'win32', now: () => now } });
      assert.equal(detail.totals.totalTokens, 1050);
      assert.equal(detail.totals.turnCount, 1);
      assert.equal(detail.exchanges[0].turns[0].timestamp, new Date(now).toISOString());
    }
  }
});

test('keeps a valid request start time when later message timestamps cross midnight', () => {
  const now = new Date(2026, 8, 24, 0, 1).getTime();
  const startedAt = new Date(2026, 8, 23, 23, 59).getTime();
  const home = makeExtensionHome({ requests: [{ traceId: TRACE, messages: [`${TRACE}u`], startedAt, usage: usageOf({ input: 1000, output: 50 }) }] });
  const file = path.join(extensionWorkspace(home), CONVERSATION, 'messages', `${TRACE}u.json`);
  fs.writeFileSync(file, messageFile(`${TRACE}u`, { role: 'user', traceId: TRACE, prompt: 'Late reply', createdAt: now }));
  const args = { client: 'codebuddy', sessionId: TRACE, home, env: options(home).env, deps: { platform: 'win32', now: () => now } };
  assert.equal(readSessionDetail({ ...args, period: 'today' }).totals.turnCount, 0);
  assert.equal(readSessionDetail({ ...args, period: 'month' }).exchanges[0].turns[0].timestamp, new Date(startedAt).toISOString());
});

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
