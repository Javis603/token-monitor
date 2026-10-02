'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { withoutSessionTitles, withoutSessionTitleStats } = require('../../src/shared/sessionTitlePrivacy');
const { applySessionMetadata, applyTokscaleSessionMetadata } = require('../../src/shared/sessionMetadata');
const { createUsageTransform } = require('../../src/shared/usage/usageTransform');
const { usageConfigFromSettings } = require('../../src/electron/runtimeConfig');
const claude = require('../../src/shared/providers/claude/sessionMetadata');
const codex = require('../../src/shared/providers/codex/sessionMetadata');
const cursor = require('../../src/shared/providers/cursor/sessionMetadata');
const { readDshSessionState } = require('../../src/shared/providers/dsh/sessionFiles');
const { droidSessionMetadataFromEntry } = require('../../src/shared/providers/droid/sessionMetadata');
const { collectUsageOnce } = require('../../src/shared/collector');
const { sessionRowsForPeriod } = require('../../src/electron/renderer/sessionRows');
const { assertSessionTitleContract } = require('../helpers/sessionTitleContract');

const AT = '2026-10-02T08:00:00.000Z';
function fixture(t, name, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-title-privacy-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const file = path.join(dir, name);
  fs.writeFileSync(file, content);
  return file;
}
function session() {
  return { client: 'codex', sessionId: 's', title: 'PRIVATE TITLE', preview: 'PRIVATE PREVIEW',
    totalTokens: 42, costUsd: 0.1, lastUsedAt: AT, models: { 'gpt-5': 42 },
    contextTokens: 20, contextWindow: 100, turnEnded: false, sessionKind: 'background-review' };
}

test('title privacy covers snapshots, native rows, devices and all-time pulls without mutating inputs', () => {
  const row = Object.freeze(session());
  const period = Object.freeze({ sessions: Object.freeze({ s: row }) });
  const stats = Object.freeze({ periods: { today: period, allTime: period },
    nativeSessions: { today: { s: { ...row, topicTitle: 'PRIVATE TOPIC', customTitle: 'PRIVATE CUSTOM' } } },
    devices: [{ today: period }] });
  const privateStats = withoutSessionTitleStats(stats);
  assert.doesNotMatch(JSON.stringify(privateStats), /PRIVATE/);
  assert.equal(stats.periods.today.sessions.s.title, 'PRIVATE TITLE');
  assert.equal(privateStats.periods.today.sessions.s.totalTokens, 42);
  assert.equal(privateStats.periods.today.sessions.s.contextTokens, 20);
  assert.equal(privateStats.periods.today.sessions.s.turnEnded, false);
  assert.equal(privateStats.periods.today.sessions.s.sessionKind, 'background-review');
  assert.strictEqual(withoutSessionTitleStats(privateStats), privateStats);
  assert.strictEqual(withoutSessionTitles(privateStats.periods.today.sessions), privateStats.periods.today.sessions);
});

test('missing metadata and stale resolver cache cannot restore a title while disabled', () => {
  const periods = { today: { sessions: { 'example:s': session() } } };
  const metadataCache = new Map([['example:s', { title: 'PRIVATE CACHE', lastUsedAt: AT }]]);
  applySessionMetadata(periods, '/missing', {
    resolveTitles: false, metadataCache, resolvedSessionKeys: new Set(['example:s']),
    sessionMetadataResolvers: new Map()
  });
  assert.equal(periods.today.sessions['example:s'].title, undefined);
  const empty = { today: { sessions: { 'example:s': session() } } };
  applySessionMetadata(empty, '/missing', { resolveTitles: false, sessionMetadataResolvers: new Map() });
  assert.equal(empty.today.sessions['example:s'].title, undefined);
});

test('Tokscale title aliases are removed even when the binary emits no metadata arrays', () => {
  const json = { entries: [{ client: 'codex', sessionId: 's', sessionTitle: 'PRIVATE', session_title: 'PRIVATE' }] };
  applyTokscaleSessionMetadata(json, { resolveTitles: false });
  assert.doesNotMatch(JSON.stringify(json), /PRIVATE/);
  const meta = { client: 'codex', sessionId: 's', firstActiveMs: Date.parse(AT), get title() { throw new Error('title accessed'); } };
  json.sessions = [meta];
  applyTokscaleSessionMetadata(json, { resolveTitles: false });
  assert.equal(json.entries[0].startedAt, AT);
});

test('Cursor private mode performs no sqlite discovery or title query', () => {
  const result = cursor.resolveSessionMetadata(new Set(['s']), {
    resolveTitles: false,
    deps: { get sqlite() { throw new Error('sqlite accessed'); } }
  });
  assert.equal(result.size, 0);
});

test('Codex private mode excludes title columns but preserves background review classification and skips T3', () => {
  const queries = [];
  class DatabaseSync {
    exec() {}
    close() {}
    prepare(sql) {
      queries.push(sql);
      if (sql.startsWith('PRAGMA')) return { all: () => ['id', 'name', 'title', 'thread_source', 'source'].map((name) => ({ name })) };
      return { all: () => [{ id: 's', thread_source: 'guardian_review' }, { id: 'ordinary', thread_source: 'user',
        get title() { throw new Error('title accessed'); } }] };
    }
  }
  const result = codex.readSessionMeta(['s', 'ordinary'], { sqlite: { DatabaseSync }, dbPaths: ['fake'], resolveTitles: false });
  assert.equal(result.get('s').sessionKind, 'background-review');
  assert.equal(result.has('ordinary'), false);
  assert.doesNotMatch(queries.find((sql) => sql.startsWith('SELECT')), /\btitle\b|\bname\b/);
  const resolved = codex.resolveSessionMetadata(new Set(['s']), {
    home: path.join(os.tmpdir(), 'missing-title-home'), metadata: new Map(), resolveTitles: false,
    deps: { readCodexMeta: () => result, readT3Meta() { throw new Error('T3 title read'); }, env: {} }
  });
  assert.equal(resolved.get('s').sessionKind, 'background-review');
});

test('Claude private scans retain context and turn state across off/on cache transitions', (t) => {
  const file = fixture(t, 'session.jsonl', [
    JSON.stringify({ type: 'custom-title', customTitle: 'PRIVATE TITLE' }),
    JSON.stringify({ type: 'assistant', message: { model: 'claude-opus-4-8', stop_reason: 'end_turn',
      usage: { input_tokens: 20, cache_read_input_tokens: 10, cache_creation_input_tokens: 0 } } })
  ].join('\n') + '\n');
  const cache = new Map();
  assertSessionTitleContract({
    read: (options) => ({
      title: claude.readSessionTitle(file, { cache, ...options }),
      ...claude.readSessionContext(file, { cache, ...options }),
      turnEnded: claude.readSessionTurnEnded(file, { cache, ...options })
    }),
    expectedTitle: 'PRIVATE TITLE',
    expectedMetadata: { contextTokens: 30, turnEnded: true },
    assertPrivateRead: () => assert.equal(cache.get(file).customTitle, '')
  });
});

test('DSH private scans preserve context and turn state across off/on transitions', (t) => {
  const content = [
    { type: 'session/title', data: { title: 'PRIVATE TITLE' } },
    { type: 'request/context', data: { contextWindow: 100 } },
    { type: 'response/chunk', data: { chunk: { type: 'usage', usage: { inputTokens: 30, outputTokens: 5 } } } },
    { type: 'turn/end' }
  ].map(JSON.stringify).join('\n') + '\n';
  const file = fixture(t, 'session.jsonl', content);
  let cached;
  assertSessionTitleContract({
    read: (options) => {
      cached = readDshSessionState(file, cached, options);
      return { title: cached.title, contextWindow: cached.contextWindow, turnEnded: cached.turnEnded };
    },
    expectedTitle: 'PRIVATE TITLE',
    expectedMetadata: { contextWindow: 100, turnEnded: true },
    assertPrivateRead: () => assert.equal(cached.resolveTitles, false)
  });
});

test('Droid private mode does not access the title but keeps timestamps and project identity', () => {
  let reads = 0;
  assertSessionTitleContract({
    read: (options) => {
      reads = 0;
      return droidSessionMetadataFromEntry({ createdTimeMs: Date.parse(AT), cwd: '/project',
        get title() {
          reads += 1;
          assert.notEqual(options.resolveTitles, false, 'disabled reader must not access title');
          return 'PRIVATE TITLE';
        } }, { ...options, resolveProjects: true, projectIdentity: () => ({ projectId: 'project' }) });
    },
    expectedTitle: 'PRIVATE TITLE',
    expectedMetadata: { startedAt: AT, projectId: 'project' },
    assertPrivateRead: () => assert.equal(reads, 0)
  });
});

test('usage transform strips titles before capture and after projecting retained archives', () => {
  const summary = { updatedAt: AT, today: { sessions: { 'codex:s': session() } } };
  const captured = [];
  const transform = createUsageTransform({
    getSettings: () => ({ sessionTitlesEnabled: false, projectsEnabled: false }),
    store: { capture(value) { captured.push(value); return { archive: { version: 1, sessions: {} } }; } }
  });
  const visible = transform.transform(summary);
  assert.doesNotMatch(JSON.stringify(captured), /PRIVATE/);
  assert.doesNotMatch(JSON.stringify(visible), /PRIVATE/);
  assert.equal(summary.today.sessions['codex:s'].title, 'PRIVATE TITLE');
  const projected = transform.project(summary, null, new Date(AT));
  assert.doesNotMatch(JSON.stringify(projected), /PRIVATE/);
});

test('collector private mode gates resolvers and removes raw scan titles in every period and preview', async () => {
  const previews = [];
  let calls = 0;
  const result = await collectUsageOnce({
    ...usageConfigFromSettings({ clients: 'codex', sessionTitlesEnabled: false, historyEnabled: false, wslScanEnabled: false }),
    now: new Date(AT), deviceId: 'test', homeDir: path.join(os.tmpdir(), 'missing-title-home'),
    runTokscale: async () => ({ entries: [{ client: 'codex', sessionId: 's', model: 'gpt-5', input: 40, output: 2, sessionTitle: 'PRIVATE SCAN' }] }),
    onProgress: (value) => previews.push(value),
    sessionMetadataDeps: { sessionMetadataResolvers: new Map([['codex', (_ids, context) => {
      calls += 1;
      assert.equal(context.resolveTitles, false);
      return new Map([['s', { title: 'PRIVATE RESOLVER', lastUsedAt: AT, contextTokens: 20, contextWindow: 100, turnEnded: true }]]);
    }]]) }
  });
  assert.ok(calls > 0);
  assert.doesNotMatch(JSON.stringify([result, previews]), /PRIVATE/);
  for (const name of ['today', 'month', 'allTime']) {
    assert.equal(result[name].sessions['codex:s'].totalTokens, 42);
    assert.equal(result[name].sessions['codex:s'].contextTokens, 20);
    assert.equal(result[name].sessions['codex:s'].turnEnded, true);
  }
  const rows = sessionRowsForPeriod(result.today, { clientLabels: { codex: 'Codex' }, now: new Date(AT) });
  assert.equal(rows.length, 1);
  assert.doesNotMatch(rows[0].name, /PRIVATE/);
});
