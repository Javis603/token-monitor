'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clientHealthDetail,
  clientHealthNotes,
  clientHealthRows,
  clientPeriodUsage,
  exactDevice,
  friendlyPath,
  hasClientHealth
} = require('../../src/electron/renderer/clientHealthPresentation');

const entry = (overrides = {}) => ({
  source: { state: 'detected', detectedCount: 1, checkedCount: 1 },
  collection: { state: 'direct' },
  data: { liveTokens: 0 },
  overall: 'waiting',
  ...overrides
});

const health = (clients) => ({ version: 1, clients });

test('a client the device never reported gets no panel and no disclosure', () => {
  assert.equal(clientHealthDetail(health({ codex: entry() }), 'claude'), null);
  assert.equal(clientHealthDetail(null, 'codex'), null);
  assert.equal(hasClientHealth(health({ codex: entry() }), 'CODEX'), true);
  assert.equal(hasClientHealth(health({ codex: entry() }), 'claude'), false);
  assert.equal(hasClientHealth(undefined, 'codex'), false);
});

// Eighteen of twenty clients are `direct` on a normal machine — tokscale reads
// their files and there is no fetch step to report on. A "collection: direct"
// line on every one of them would be a column of noise.
test('the sync row appears only for the clients that have a sync step', () => {
  const keys = (e) => clientHealthRows(e).map((row) => row.key);
  assert.equal(keys(entry()).includes('settings.tools.health.sync'), false);
  assert.equal(keys(entry({ collection: { state: 'ok' } })).includes('settings.tools.health.sync'), true);
  assert.equal(keys(entry({ collection: { state: 'failed' } })).includes('settings.tools.health.sync'), true);
});

test('rows carry the values the renderer draws, not formatted text', () => {
  const rows = clientHealthRows(entry({
    source: { state: 'detected', detectedCount: 2, checkedCount: 3, checks: [{ id: 'antigravity-cli-data', exists: false }] },
    collection: { state: 'failed', lastAttemptAt: '2026-08-04T09:12:00.000Z', lastSuccessAt: '2026-08-04T08:40:00.000Z' },
    data: { liveTokens: 69_600_000, lastActivityDay: '2026-08-04' },
    overall: 'attention'
  }));
  const byKind = Object.fromEntries(rows.map((row) => [row.kind, row]));
  assert.deepEqual(Object.keys(byKind), ['sources', 'sync', 'day', 'tokens']);
  assert.equal(byKind.sources.detectedCount, 2);
  assert.equal(byKind.sources.checkedCount, 3);
  assert.deepEqual(byKind.sources.checks, [{ id: 'antigravity-cli-data', exists: false, paths: [] }]);
  assert.equal(byKind.sync.lastSuccessAt, '2026-08-04T08:40:00.000Z');
  assert.equal(byKind.day.day, '2026-08-04');
  assert.equal(byKind.tokens.tokens, 69_600_000);
});

// Physical roots explain one logical check; they never replace its canonical
// state or turn platform alternatives into extra checked dependencies.
test('local paths augment canonical checks without changing their counts', () => {
  const healthy = entry({
    source: { state: 'detected', detectedCount: 1, checkedCount: 1 },
    overall: 'healthy',
    data: { liveTokens: 42 }
  });
  const rows = clientHealthRows(healthy, {
    sources: [
      { id: 'zed-threads', dir: '/Users/x/.local/share/zed/threads', exists: false },
      { id: 'zed-threads', dir: '/Users/x/Library/Application Support/Zed/threads', exists: true }
    ]
  });
  const sources = rows.find((row) => row.kind === 'sources');
  assert.equal(sources.checks.length, 1);
  assert.equal(sources.checks[0].exists, true);
  assert.deepEqual(sources.checks[0].paths.map((path) => path.dir), [
    '/Users/x/.local/share/zed/threads',
    '/Users/x/Library/Application Support/Zed/threads'
  ]);
  assert.equal(sources.detectedCount, 1);
  assert.equal(sources.checkedCount, 1);
});

test('local paths never overwrite a canonical wire check', () => {
  const rows = clientHealthRows(entry({
    source: {
      state: 'detected',
      detectedCount: 0,
      checkedCount: 1,
      checks: [{ id: 'zed-threads', exists: false }]
    }
  }), {
    sources: [{ id: 'zed-threads', dir: '/Users/x/.local/share/zed/threads', exists: true }]
  });
  const check = rows.find((row) => row.kind === 'sources').checks[0];
  assert.equal(check.exists, false);
  assert.equal(Object.hasOwn(check, 'supplemental'), false);
});

// `wsl-home` is reached through wsl.exe and antigravity's source checks are not
// watch roots, so neither has a directory in the local probe. Dropping them would
// leave the ratio disagreeing with the chips under it.
test('checks the local probe cannot see survive the merge', () => {
  const rows = clientHealthRows(entry({
    source: { state: 'detected', detectedCount: 1, checkedCount: 2, checks: [{ id: 'wsl-home', exists: true }, { id: 'antigravity-cli-data', exists: false }] }
  }), { sources: [{ id: 'tokscale-antigravity-cache', dir: '/Users/x/.config/tokscale/antigravity-cache', exists: false }] });
  const sources = rows.find((row) => row.kind === 'sources');
  assert.deepEqual(sources.checks.map((check) => check.id), ['wsl-home', 'antigravity-cli-data', 'tokscale-antigravity-cache']);
  assert.equal(sources.detectedCount, 1);
  assert.equal(sources.checkedCount, 2);
});

// A ratio with no checks behind it asks a question it cannot answer: "2 of 3
// found" reads as a fault, and the missing one has no name. Checks only arrive
// for a client that is not healthy — the same client the ratio is worth showing
// for — so a healthy partial source drops the row instead of hanging it.
test('the source row appears only when it can explain itself', () => {
  const kinds = (e) => clientHealthRows(e).map((row) => row.kind);
  assert.equal(kinds(entry({ source: { state: 'detected', detectedCount: 2, checkedCount: 3 } })).includes('sources'), false);
  assert.equal(kinds(entry({ source: { state: 'detected', detectedCount: 1, checkedCount: 1 } })).includes('sources'), false);
  // Nothing found at all is the answer, so it shows with or without checks.
  assert.equal(kinds(entry({ source: { state: 'missing', detectedCount: 0, checkedCount: 2 } })).includes('sources'), true);
  assert.equal(kinds(entry({
    source: { state: 'detected', detectedCount: 1, checkedCount: 2, checks: [{ id: 'copilot-otel', exists: false }] }
  })).includes('sources'), true);
});

// This is the rule the real data forced: on this maintainer's machine thirteen
// of twenty tracked tools are simply not installed. Repeating "no source found"
// as a warning under each of them teaches the user to ignore the panel, which
// costs exactly the signal it exists to deliver.
test('an uninstalled tool states its absence once, in the headline', () => {
  const absent = entry({
    source: { state: 'missing', detectedCount: 0, checkedCount: 2 },
    diagnostics: [{ code: 'source-missing' }],
    overall: 'unavailable'
  });
  const detail = clientHealthDetail(health({ zed: absent }), 'zed');
  assert.equal(detail.overall, 'unavailable');
  assert.equal(detail.tone, 'muted');
  assert.deepEqual(detail.notes, [], 'the headline already said it');
  // The checked roots still show, because "I did install it" needs an answer.
  assert.equal(detail.rows[0].checkedCount, 2);
});

test('a failing sync stays loud even on a client with no usage yet', () => {
  const failing = entry({
    collection: { state: 'failed' },
    diagnostics: [{ code: 'sync-timeout' }, { code: 'no-usage-observed' }],
    overall: 'attention'
  });
  const detail = clientHealthDetail(health({ antigravity: failing }), 'antigravity');
  assert.equal(detail.tone, 'warn');
  assert.deepEqual(detail.notes, [
    { code: 'sync-timeout', tone: 'warn' },
    { code: 'no-usage-observed', tone: 'muted' }
  ]);
});

test('diagnostics select only the exact local device and its own usage', () => {
  const local = {
    deviceId: 'local',
    periods: {
      today: { clients: { codex: 3 }, clientCosts: { codex: 0.03 } },
      month: { clients: { codex: 7 }, clientCosts: {} },
      allTime: { clients: { codex: 11 }, clientCosts: {} }
    }
  };
  const remote = { deviceId: 'remote', periods: { today: { clients: { codex: 100 } } } };
  assert.equal(exactDevice({ devices: [remote] }, 'local'), null);
  assert.equal(exactDevice({ devices: [remote, local] }, 'local'), local);
  assert.deepEqual(clientPeriodUsage(local, 'codex'), {
    today: { tokens: 3, cost: 0.03 },
    month: { tokens: 7, cost: 0 },
    allTime: { tokens: 11, cost: 0 }
  });
});

test('friendlyPath abbreviates only the home itself or a real descendant', () => {
  assert.equal(friendlyPath('/Users/alice', '/Users/alice', 'darwin'), '~');
  assert.equal(friendlyPath('/Users/alice/.config/tool', '/Users/alice', 'darwin'), '~/.config/tool');
  assert.equal(friendlyPath('/Users/alice2/tool', '/Users/alice', 'darwin'), '/Users/alice2/tool');
  assert.equal(friendlyPath('C:\\Users\\Alice\\tool', 'c:\\users\\alice', 'win32'), '~\\tool');
  assert.equal(friendlyPath('/', '/', 'linux'), '~');
  assert.equal(friendlyPath('/tmp/tool', '/', 'linux'), '~/tmp/tool');
  assert.equal(friendlyPath('C:\\', 'c:\\', 'win32'), '~');
  assert.equal(friendlyPath('C:\\tool', 'c:\\', 'win32'), '~\\tool');
});

test('an unrecognised diagnostic code renders nothing rather than raw text', () => {
  const notes = clientHealthNotes(entry({ diagnostics: [{ code: 'invented-later' }, { code: 'sync-failed' }], collection: { state: 'failed' } }));
  assert.deepEqual(notes, [{ code: 'sync-failed', tone: 'warn' }]);
});

test('every overall state has a tone', () => {
  for (const overall of ['healthy', 'waiting', 'attention', 'unavailable', 'unknown']) {
    const detail = clientHealthDetail(health({ codex: entry({ overall }) }), 'codex');
    assert.ok(detail.tone, overall);
  }
});
