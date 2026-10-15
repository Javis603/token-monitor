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

test('custom source identity survives the canonical source merge', () => {
  const source = clientHealthGroups(entry({
    source: { state: 'missing', detectedCount: 0, checkedCount: 1, checks: [{ id: 'custom-scan-path', exists: false }] }
  }), {
    sources: [{ id: 'custom-scan-path', dir: '/Volumes/archive/codex', exists: false, custom: true }]
  })[0];

  assert.deepEqual(source.checks[0].paths, [
    { dir: '/Volumes/archive/codex', exists: false, pending: false, custom: true }
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
    diagnostics: [{ code: 'sync-lock-present' }, { code: 'no-usage-observed' }, { code: 'invented' }],
    overall: 'attention'
  })), [
    { code: 'sync-lock-present', group: 'collection', tone: 'warn' },
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

const qoderSources = (projects, db = false) => ({
  state: projects || db ? 'detected' : 'missing',
  detectedCount: Number(projects) + Number(db),
  checkedCount: 2,
  checks: [
    { id: 'qodercn-db', exists: db },
    { id: 'qodercn-projects', exists: projects }
  ]
});
const qoderAvailabilityNote = { code: 'qodercn-token-availability', group: 'data', tone: 'neutral' };

test('Qoder CN transcripts explain unavailable first-party tokens instead of generic no usage', () => {
  const detail = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(true),
    diagnostics: [{ code: 'no-usage-observed' }]
  }) }), 'QODERCN', { usage: {
    today: { tokens: 0 }, month: { tokens: 0 }, allTime: { tokens: 0 }
  } });
  assert.deepEqual(detail.notes, [qoderAvailabilityNote]);
  assert.equal(detail.overall, 'waiting');
  assert.deepEqual(detail.groups[2].periods.map(({ tokens }) => tokens), [0, 0, 0]);
});

test('Qoder CN guidance also explains partial coverage without changing measured BYOK usage', () => {
  const detail = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(true, true),
    data: { liveTokens: 200, lastActivityDay: '2026-10-15' },
    overall: 'healthy'
  }) }), 'qodercn', { usage: {
    today: { tokens: 50, cost: 0.1 }, month: { tokens: 100, cost: 0.2 }, allTime: { tokens: 200, cost: 0.4 }
  } });
  assert.deepEqual(detail.notes, [qoderAvailabilityNote]);
  assert.equal(detail.overall, 'healthy');
  assert.equal(detail.groups[2].tokens, 200);
  assert.equal(detail.groups[2].lastActivityDay, '2026-10-15');
  assert.deepEqual(detail.groups[2].periods.map(({ tokens, cost }) => [tokens, cost]), [[50, 0.1], [100, 0.2], [200, 0.4]]);
});

test('Qoder CN legacy-only and missing sources retain their existing diagnostics', () => {
  const legacy = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(false, true), diagnostics: [{ code: 'no-usage-observed' }]
  }) }), 'qodercn');
  assert.deepEqual(legacy.notes, [{ code: 'no-usage-observed', group: 'data', tone: 'muted' }]);
  const missing = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(false), overall: 'unavailable', diagnostics: [{ code: 'source-missing' }]
  }) }), 'qodercn');
  assert.deepEqual(missing.notes, []);
});

test('Qoder CN guidance uses canonical checks before potentially stale local paths', () => {
  const detail = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(false, true)
  }) }), 'qodercn', { sources: [{ id: 'qodercn-projects', exists: true, dir: '/old/projects' }] });
  assert.deepEqual(detail.notes, []);
});

test('older Qoder CN health records can use the existing local source probe for guidance', () => {
  const detail = clientHealthDetail(health({ qodercn: entry() }), 'qodercn', {
    sources: [{ id: 'qodercn-projects', exists: true, dir: '/configured/projects' }]
  });
  assert.deepEqual(detail.notes, [qoderAvailabilityNote]);
});

test('Qoder CN guidance does not change other clients or hide collection failures', () => {
  const diagnostics = [{ code: 'sync-failed' }, { code: 'no-usage-observed' }];
  const detail = clientHealthDetail(health({ qodercn: entry({
    source: qoderSources(true), collection: { state: 'failed' }, overall: 'attention', diagnostics
  }) }), 'qodercn');
  assert.deepEqual(detail.notes, [{ code: 'sync-failed', group: 'collection', tone: 'warn' }, qoderAvailabilityNote]);
  const other = clientHealthDetail(health({ claude: entry({ diagnostics }) }), 'claude');
  assert.deepEqual(other.notes, [
    { code: 'sync-failed', group: 'collection', tone: 'warn' },
    { code: 'no-usage-observed', group: 'data', tone: 'muted' }
  ]);
});

test('Qoder CN token guidance is translated in every supported locale', () => {
  const { MESSAGES } = require('../../src/electron/renderer/i18n');
  for (const [locale, messages] of Object.entries(MESSAGES)) {
    const text = messages['settings.tools.health.code.qodercn-token-availability'];
    assert.ok(text, locale);
    assert.match(text, /BYOK/);
    assert.match(text, /Qoder/);
  }
});
