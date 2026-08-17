'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clientHealthCountsForTracked,
  clientHealthDetail,
  clientHealthGroups,
  clientHealthNotes,
  clientPeriodUsage,
  exactDevice,
  friendlyPath,
  hasClientHealth,
  clientHealthPlaceholderDetail
} = require('../../src/electron/renderer/clientHealthPresentation');

const entry = (overrides = {}) => ({
  source: { state: 'detected', detectedCount: 1, checkedCount: 1 },
  collection: { state: 'direct' },
  data: { liveTokens: 0 },
  overall: 'waiting',
  ...overrides
});
const health = (clients) => ({ version: 1, clients });

test('health summary partitions only the currently tracked clients', () => {
  const counts = clientHealthCountsForTracked(health({
    claude: entry({ overall: 'healthy' }),
    cursor: entry({ overall: 'waiting' }),
    codex: entry({ overall: 'attention' }),
    zed: entry({ overall: 'unavailable' }),
    extra: entry({ overall: 'attention' })
  }), ['CLAUDE', 'cursor', 'cursor', 'codex', 'zed']);
  assert.deepEqual(counts, { healthy: 1, review: 2, unavailable: 1 });
});

test('health summary falls back rather than hiding incomplete or unknown clients', () => {
  assert.equal(clientHealthCountsForTracked(null, ['claude']), null);
  assert.equal(clientHealthCountsForTracked(health({}), ['claude']), null);
  assert.equal(clientHealthCountsForTracked(health({ claude: entry({ overall: 'unknown' }) }), ['claude']), null);
  assert.equal(clientHealthCountsForTracked(health({ claude: entry({ overall: 'future-state' }) }), ['claude']), null);
  assert.deepEqual(clientHealthCountsForTracked(health({}), []), {
    healthy: 0, review: 0, unavailable: 0
  });
});

test('clientHealthDetail requires an actual health entry', () => {
  assert.equal(clientHealthDetail(health({ codex: entry() }), 'claude'), null);
  assert.equal(clientHealthDetail(null, 'codex'), null);
  assert.equal(hasClientHealth(health({ codex: entry() }), 'CODEX'), true);
  assert.equal(hasClientHealth(health({ codex: entry() }), 'claude'), false);
});

test('a client without health data can show on-demand source details', () => {
  const detail = clientHealthPlaceholderDetail({
    sources: [{ id: 'codebuddy-data', dir: '/Users/x/.codebuddy', exists: true }],
    usage: {
      today: { tokens: 0, cost: 0 },
      month: { tokens: 0, cost: 0 },
      allTime: { tokens: 0, cost: 0 }
    }
  });
  assert.equal(detail.tone, 'muted');
  assert.equal(detail.groups[0].state, 'detected');
  assert.deepEqual(detail.groups[0].checks, [{
    id: 'codebuddy-data',
    exists: true,
    paths: [{ dir: '/Users/x/.codebuddy', exists: true, pending: false }]
  }]);
  assert.equal(detail.groups[1].state, 'notTracked');
  assert.deepEqual(detail.groups[2].periods.map(({ period, tokens }) => ({ period, tokens })), [
    { period: 'today', tokens: 0 },
    { period: 'month', tokens: 0 },
    { period: 'allTime', tokens: 0 }
  ]);
  assert.equal(
    clientHealthPlaceholderDetail({ collectionState: 'waiting' }).groups[1].state,
    'waiting'
  );
});

test('detail always has source, collection, and data groups with raw values', () => {
  const groups = clientHealthGroups(entry({
    source: { state: 'detected', detectedCount: 2, checkedCount: 3, checks: [{ id: 'antigravity-cli-data', exists: false }] },
    collection: { state: 'failed', lastAttemptAt: '2026-08-04T09:12:00.000Z', lastSuccessAt: '2026-08-04T08:40:00.000Z' },
    data: { liveTokens: 69_600_000, lastActivityDay: '2026-08-04' },
    overall: 'attention'
  }));
  assert.deepEqual(groups.map((group) => group.id), ['source', 'collection', 'data']);
  assert.equal(groups[0].detectedCount, 2);
  assert.deepEqual(groups[0].checks, [{ id: 'antigravity-cli-data', exists: false, paths: [] }]);
  assert.equal(groups[1].state, 'failed');
  assert.equal(groups[1].lastSuccessAt, '2026-08-04T08:40:00.000Z');
  assert.equal(groups[2].tokens, 69_600_000);
  assert.equal(groups[2].lastActivityDay, '2026-08-04');
});

test('direct collection remains visible and usage replaces duplicate live tokens', () => {
  const groups = clientHealthGroups(entry({ data: { liveTokens: 42, lastActivityDay: '2026-08-04' } }), {
    usage: {
      today: { tokens: 3, cost: 0.03 },
      month: { tokens: 7, cost: 0 },
      allTime: { tokens: 11, cost: 0 }
    }
  });
  assert.equal(groups[1].state, 'direct');
  assert.deepEqual(groups[2].periods.map(({ period, tokens }) => ({ period, tokens })), [
    { period: 'today', tokens: 3 },
    { period: 'month', tokens: 7 },
    { period: 'allTime', tokens: 11 }
  ]);
});

test('local paths augment canonical checks without changing their truth', () => {
  const groups = clientHealthGroups(entry({
    source: { state: 'detected', detectedCount: 0, checkedCount: 1, checks: [{ id: 'zed-threads', exists: false }] }
  }), {
    sources: [
      { id: 'zed-threads', dir: '/Users/x/.local/share/zed/threads', exists: true },
      { id: 'zed-threads', dir: '/Users/x/Library/Application Support/Zed/threads', exists: false }
    ]
  });
  const source = groups[0];
  assert.equal(source.detectedCount, 0);
  assert.equal(source.checkedCount, 1);
  assert.equal(source.checks[0].exists, false);
  assert.equal(source.checks[0].paths.length, 2);
});

test('pending local paths stay neutral without changing canonical truth', () => {
  const source = clientHealthGroups(entry({
    source: { state: 'missing', detectedCount: 0, checkedCount: 1, checks: [{ id: 'codex-sessions', exists: false }] }
  }), {
    sources: [{ id: 'codex-sessions', dir: '/Users/x/.codex/sessions', exists: false, pending: true }]
  })[0];

  assert.equal(source.checks[0].exists, false);
  assert.deepEqual(source.checks[0].paths, [
    { dir: '/Users/x/.codex/sessions', exists: false, pending: true }
  ]);
});

test('pathless and probe-only checks survive the source merge', () => {
  const source = clientHealthGroups(entry({
    source: { state: 'detected', detectedCount: 1, checkedCount: 2, checks: [{ id: 'wsl-home', exists: true }] }
  }), {
    sources: [{ id: 'tokscale-antigravity-cache', dir: '/Users/x/cache', exists: false }]
  })[0];
  assert.deepEqual(source.checks.map((check) => check.id), ['wsl-home', 'tokscale-antigravity-cache']);
});

test('diagnostics are assigned to semantic groups and unavailable noise stays quiet', () => {
  assert.deepEqual(clientHealthNotes(entry({
    collection: { state: 'failed' },
    diagnostics: [{ code: 'sync-timeout' }, { code: 'no-usage-observed' }, { code: 'invented' }],
    overall: 'attention'
  })), [
    { code: 'sync-timeout', group: 'collection', tone: 'warn' },
    { code: 'no-usage-observed', group: 'data', tone: 'muted' }
  ]);
  assert.deepEqual(clientHealthNotes(entry({
    source: { state: 'missing', detectedCount: 0, checkedCount: 1 },
    diagnostics: [{ code: 'source-missing' }, { code: 'no-usage-observed' }],
    overall: 'unavailable'
  })), []);
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
    today: { tokens: 3, cost: 0.03 }, month: { tokens: 7, cost: 0 }, allTime: { tokens: 11, cost: 0 }
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

test('every overall state has a tone', () => {
  for (const overall of ['healthy', 'waiting', 'attention', 'unavailable', 'unknown']) {
    assert.ok(clientHealthDetail(health({ codex: entry({ overall }) }), 'codex').tone, overall);
  }
});
