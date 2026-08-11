'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  readSessionDetailForPlatform,
  resolveSessionDetailForPlatform,
  runSessionDetailWorker
} = require('../../src/shared/sessionDetailResolver');
const { readSessionDetail: readNativeDetail } = require('../../src/shared/sessionDetail');

function missing(args) {
  return { found: false, client: args.client, sessionId: args.sessionId, exchanges: [] };
}

test('reads a Claude transcript from a discovered WSL home', (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'wsl-session';
  const transcriptDir = path.join(wslHome, '.claude', 'projects', '-workspace');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from WSL' } }),
    JSON.stringify({
      type: 'assistant',
      timestamp: '2026-07-31T00:00:01.000Z',
      message: {
        usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 2, cache_creation_input_tokens: 1 },
        content: []
      }
    })
  ].join('\n'));

  const detail = resolveSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total', sessionCost: 0.25 },
    {
      platform: 'win32',
      homedir: () => nativeHome,
      wslUsageHomes: () => [wslHome]
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from WSL');
  assert.equal(detail.totals.totalTokens, 18);
  assert.equal(detail.totals.costUsd, 0.25);
});

test('reads a Claude transcript from the alternate root in a discovered WSL home', (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'alternate-wsl-session';
  const transcriptDir = path.join(wslHome, '.claude', 'transcripts');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'user', timestamp: '2026-07-31T00:00:00.000Z', message: { content: 'from alternate root' } }),
    JSON.stringify({ type: 'assistant', timestamp: '2026-07-31T00:00:01.000Z', message: { usage: { input_tokens: 4, output_tokens: 2 }, content: [] } })
  ].join('\n'));

  const detail = resolveSessionDetailForPlatform(
    { client: 'claude', sessionId, period: 'total' },
    { platform: 'win32', homedir: () => nativeHome, wslUsageHomes: () => [wslHome] }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from alternate root');
  assert.equal(detail.totals.totalTokens, 6);
});

test('reads a Codex transcript from its dated path in a discovered WSL home', (t) => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-detail-'));
  const wslHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-wsl-detail-'));
  t.after(() => fs.rmSync(nativeHome, { recursive: true, force: true }));
  t.after(() => fs.rmSync(wslHome, { recursive: true, force: true }));
  const sessionId = 'rollout-2026-07-31T12-34-56-real-codex';
  const transcriptDir = path.join(wslHome, '.codex', 'sessions', '2026', '07', '31');
  fs.mkdirSync(transcriptDir, { recursive: true });
  fs.writeFileSync(path.join(transcriptDir, `${sessionId}.jsonl`), [
    JSON.stringify({ type: 'event_msg', timestamp: '2026-07-31T00:00:00.000Z', payload: { type: 'user_message', message: 'from Codex WSL' } }),
    JSON.stringify({ type: 'event_msg', timestamp: '2026-07-31T00:00:01.000Z', payload: { type: 'token_count', info: { last_token_usage: { input_tokens: 10, cached_input_tokens: 3, output_tokens: 5, reasoning_output_tokens: 2, total_tokens: 15 } } } })
  ].join('\n'));

  const detail = resolveSessionDetailForPlatform(
    { client: 'codex', sessionId, period: 'total', sessionCost: 0.1 },
    { platform: 'win32', homedir: () => nativeHome, wslUsageHomes: () => [wslHome] }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.exchanges[0].promptPreview, 'from Codex WSL');
  assert.equal(detail.totals.totalTokens, 15);
  assert.equal(detail.totals.costUsd, 0.1);
});

test('returns a native Claude detail without enumerating WSL homes', () => {
  let enumerated = false;
  const detail = resolveSessionDetailForPlatform(
    { client: 'claude', sessionId: 'native' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: (args) => ({ ...missing(args), found: true, home: args.home }),
      wslUsageHomes: () => { enumerated = true; return []; }
    }
  );

  assert.equal(detail.found, true);
  assert.equal(detail.home, 'C:\\Users\\me');
  assert.equal(enumerated, false);
});

test('resolves a Reasonix native detail through the same platform resolver', () => {
  const nativeHome = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-native-reasonix-detail-'));
  const stateHome = path.join(nativeHome, 'state');
  const sessions = path.join(stateHome, 'projects', 'opaque', 'sessions');
  fs.mkdirSync(sessions, { recursive: true });
  fs.writeFileSync(path.join(sessions, 'branch.jsonl.meta'), JSON.stringify({ id: 'resolver-id' }));
  fs.writeFileSync(path.join(sessions, 'branch.events.jsonl'), [
    JSON.stringify({ type: 'user.message', ts: '2026-08-08T00:00:00.000Z', text: 'resolver prompt' }),
    JSON.stringify({ type: 'model.final', ts: '2026-08-08T00:00:01.000Z', usage: { prompt_tokens: 3, completion_tokens: 2 } })
  ].join('\n'));
  try {
    const detail = resolveSessionDetailForPlatform(
      { client: 'reasonix', sessionId: 'reasonix:resolver-id', period: 'total' },
      {
        platform: process.platform,
        homedir: () => nativeHome,
        readSessionDetail: (args) => readNativeDetail({
          ...args,
          deps: { platform: process.platform, env: { REASONIX_STATE_HOME: stateHome } }
        })
      }
    );
    assert.equal(detail.found, true);
    assert.equal(detail.exchanges[0].promptPreview, 'resolver prompt');
    assert.equal(detail.totals.totalTokens, 5);
  } finally {
    fs.rmSync(nativeHome, { recursive: true, force: true });
  }
});

for (const client of ['claude', 'codex']) {
  test(`falls back to running WSL homes for ${client} JSONL details on Windows`, () => {
    const homes = [];
    const detail = resolveSessionDetailForPlatform(
      { client, sessionId: 'wsl-session' },
      {
        platform: 'win32',
        homedir: () => 'C:\\Users\\me',
        readSessionDetail: (args) => {
          homes.push(args.home);
          return args.home.endsWith('\\ubuntu') ? { ...missing(args), found: true, home: args.home } : missing(args);
        },
        wslUsageHomes: () => ['\\\\wsl$\\Ubuntu\\home\\first', '\\\\wsl$\\Ubuntu\\home\\ubuntu']
      }
    );

    assert.equal(detail.found, true);
    assert.equal(detail.home, '\\\\wsl$\\Ubuntu\\home\\ubuntu');
    assert.deepEqual(homes, [
      'C:\\Users\\me',
      '\\\\wsl$\\Ubuntu\\home\\first',
      '\\\\wsl$\\Ubuntu\\home\\ubuntu'
    ]);
  });
}

test('does not inspect WSL homes for non-Windows or SQLite-backed clients', () => {
  for (const [platform, client] of [['linux', 'claude'], ['win32', 'opencode']]) {
    let enumerated = false;
    const detail = resolveSessionDetailForPlatform(
      { client, sessionId: 'missing' },
      {
        platform,
        homedir: () => '/native',
        readSessionDetail: missing,
        wslUsageHomes: () => { enumerated = true; return ['should-not-run']; }
      }
    );

    assert.equal(detail.found, false);
    assert.equal(enumerated, false);
  }
});

test('returns the native not-found result when WSL discovery fails', () => {
  const nativeDetail = { found: false, client: 'claude', sessionId: 'missing', exchanges: [], marker: 'native' };
  const detail = resolveSessionDetailForPlatform(
    { client: 'claude', sessionId: 'missing' },
    {
      platform: 'win32',
      homedir: () => 'C:\\Users\\me',
      readSessionDetail: () => nativeDetail,
      wslUsageHomes: () => { throw new Error('WSL unavailable'); }
    }
  );

  assert.equal(detail, nativeDetail);
});

test('runs session detail lookup in a worker thread', async () => {
  const detail = await runSessionDetailWorker(
    { expected: 'worker-result' },
    { workerPath: path.join(__dirname, '..', 'fixtures', 'sessionDetailThreadWorker.js') }
  );

  assert.equal(detail.expected, 'worker-result');
  assert.ok(detail.threadId > 0);
});

test('the production worker entry returns session detail', async () => {
  const detail = await readSessionDetailForPlatform({ client: 'hermes', sessionId: 'missing', period: 'total' });

  assert.deepEqual(detail, {
    found: false,
    client: 'hermes',
    sessionId: 'missing',
    period: 'total',
    exchanges: [],
    totals: { totalTokens: 0, costUsd: 0, exchangeCount: 0, turnCount: 0 }
  });
});

test('terminates and rejects a session detail worker that exceeds its deadline', async () => {
  let onTimeout;
  let timeoutDelay;
  let terminated = false;
  class HangingWorker {
    once() { return this; }
    terminate() {
      terminated = true;
      return Promise.resolve(0);
    }
  }

  const result = runSessionDetailWorker(
    { client: 'claude', sessionId: 'blocked-wsl' },
    {
      Worker: HangingWorker,
      timeoutMs: 25,
      setTimeout: (callback, delay) => { onTimeout = callback; timeoutDelay = delay; return 1; },
      clearTimeout: () => {}
    }
  );

  assert.equal(timeoutDelay, 25);
  onTimeout();
  await assert.rejects(result, /Session detail worker timed out after 25ms/);
  assert.equal(terminated, true);
});

test('the public session detail resolver uses the worker boundary', async () => {
  let workerArgs;
  class FakeWorker {
    constructor(_workerPath, options) {
      workerArgs = options.workerData;
      this.listeners = new Map();
      queueMicrotask(() => this.listeners.get('message')?.({ ok: true, detail: { found: false } }));
    }

    once(event, listener) {
      this.listeners.set(event, listener);
      return this;
    }
  }

  const args = { client: 'claude', sessionId: 'missing' };
  const result = readSessionDetailForPlatform(args, { Worker: FakeWorker });
  assert.ok(result instanceof Promise);
  assert.deepEqual(await result, { found: false });
  assert.equal(workerArgs, args);
});
