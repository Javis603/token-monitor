'use strict';

// Claude Desktop row split: userData root discovery, session classification,
// collector split/watch/windowed handling, and archive folding when disabled.
// Every fixture is synthetic and lives in a temp directory; nothing here reads
// a real Claude directory or spawns tokscale.

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  claudeDesktopUserDataCandidates,
  claudeDesktopUserDataRoots,
  variantForDir
} = require('../../src/shared/providers/claude/desktopPaths');
const {
  classifyEntrypoint,
  cliSessionIdFromRecord,
  createClaudeDesktopSessionIndex,
  entrypointFromHead,
  splitClaudeDesktopRows
} = require('../../src/shared/providers/claude/desktopSessions');
const {
  applyClaudeDesktopSplit,
  collectUsageOnce,
  configFingerprint,
  expandDerivedTargets,
  localTodayKey,
  tokscaleClientFilter
} = require('../../src/shared/collector');
const { emptyPeriod, normalizeClientName } = require('../../src/shared/usage');
const {
  CLIENT_IDENTITY_GENERATION,
  CLIENT_IDENTITY_SPLITS,
  isPreSplitEntry,
  seedSplitClients,
  splitClientIdFor
} = require('../../src/shared/clientIdentitySplits');
const {
  applySessionDayArchive,
  applySessionUsageArchive
} = require('../../src/shared/usage/sessionUsageArchive');

const ACCOUNT = '99999999-8888-4777-8666-555555555555';
const ORG = '11111111-2222-4333-8444-555555555555';

function line(entrypoint, extra = {}) {
  return JSON.stringify({ type: 'user', sessionId: 'x', entrypoint, message: { role: 'user', content: 'hi' }, ...extra });
}

function fakeHome(t) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-desktop-sessions-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const projects = path.join(home, '.claude', 'projects', '-Users-u-proj');
  fs.mkdirSync(projects, { recursive: true });
  const write = (id, text) => fs.writeFileSync(path.join(projects, `${id}.jsonl`), text);
  write('cli-session', `${JSON.stringify({ type: 'summary', summary: 's' })}\n${line('cli')}\n`);
  write('code-tab-session', `${line('claude-desktop')}\n`);
  write('cowork-session', `${line('local-agent')}\n`);
  write('third-party-session', `${line('claude-desktop-3p')}\n`);
  write('resumed-session', `${line('cli')}\n`);
  write('no-entrypoint', `${JSON.stringify({ type: 'user' })}\n`);

  const desktop = path.join(home, '.config', 'Claude');
  const codeSessions = path.join(desktop, 'claude-code-sessions', ACCOUNT, ORG);
  fs.mkdirSync(codeSessions, { recursive: true });
  fs.writeFileSync(path.join(codeSessions, 'local_abc.json'), JSON.stringify({ sessionId: 'local_abc', cliSessionId: 'resumed-session' }));
  fs.writeFileSync(path.join(codeSessions, 'local_bad.json'), '{not json');
  const cowork = path.join(desktop, 'local-agent-mode-sessions', ACCOUNT, ORG, 'local_s1', '.claude', 'projects', '-sessions-x');
  fs.mkdirSync(cowork, { recursive: true });
  fs.writeFileSync(path.join(cowork, 'cowork-only.jsonl'), `${line('local-agent')}\n`);

  const thirdParty = path.join(home, '.config', 'Claude-3p', 'claude-code-sessions', ACCOUNT, ORG);
  fs.mkdirSync(thirdParty, { recursive: true });
  fs.writeFileSync(path.join(thirdParty, 'local_3p.json'), JSON.stringify({ cliSessionId: 'gateway-session' }));
  return home;
}

test('desktopPaths candidates cover macOS, Windows (APPDATA, MSIX, Claude-Data) and Linux, for 1p and 3p', () => {
  const mac = claudeDesktopUserDataCandidates({ platform: 'darwin', homeDir: '/Users/u', env: {} });
  assert.deepEqual(mac.map(({ dir, variant }) => [dir, variant]), [
    ['/Users/u/Library/Application Support/Claude', '1p'],
    ['/Users/u/Library/Application Support/Claude-3p', '3p']
  ]);

  const win = claudeDesktopUserDataCandidates({
    platform: 'win32',
    homeDir: 'C:\\Users\\u',
    env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
  }).map(({ dir }) => dir);
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\Claude'));
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Roaming\\Claude-3p'));
  assert.ok(win.some((dir) => /Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude$/.test(dir)), 'MSIX root');
  assert.ok(win.some((dir) => /Packages\\Claude_pzs8sxrjxfjjc\\LocalCache\\Roaming\\Claude-3p$/.test(dir)), 'MSIX 3p root');
  assert.ok(win.includes('C:\\Users\\u\\AppData\\Local\\Claude-Data'));

  const linux = claudeDesktopUserDataCandidates({ platform: 'linux', homeDir: '/home/u', env: { XDG_CONFIG_HOME: '/xdg' } });
  assert.deepEqual(linux.map(({ dir }) => dir), ['/xdg/Claude', '/xdg/Claude-3p']);

  const override = claudeDesktopUserDataCandidates({
    platform: 'linux', homeDir: '/home/u', env: { TOKEN_MONITOR_CLAUDE_DESKTOP_DIR: '/a:/b-3p' }
  });
  assert.deepEqual(override.slice(0, 2).map(({ dir, variant }) => [dir, variant]), [['/a', '1p'], ['/b-3p', '3p']]);
  assert.equal(variantForDir('/x/Claude-3p/'), '3p');
  assert.equal(variantForDir('/x/Claude'), '1p');
});

test('desktopPaths keeps Windows separators when a macOS or Linux layout is simulated under a Windows home', () => {
  const linux = claudeDesktopUserDataCandidates({ platform: 'linux', homeDir: 'C:\\Temp\\h', env: {} });
  assert.deepEqual(linux.map(({ dir }) => dir), ['C:\\Temp\\h\\.config\\Claude', 'C:\\Temp\\h\\.config\\Claude-3p']);
  const mac = claudeDesktopUserDataCandidates({ platform: 'darwin', homeDir: 'D:\\a\\home', env: {} });
  assert.equal(mac[0].dir, 'D:\\a\\home\\Library\\Application Support\\Claude');
  assert.equal(mac[1].variant, '3p');
});

test('claudeDesktopUserDataRoots returns only existing directories', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-desktop-paths-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  fs.mkdirSync(path.join(home, '.config', 'Claude'), { recursive: true });
  const roots = claudeDesktopUserDataRoots({ platform: 'linux', homeDir: home, env: {} });
  assert.deepEqual(roots.map(({ dir }) => dir), [path.join(home, '.config', 'Claude')]);
});

test('entrypoint values map to Desktop, Desktop third-party, or not Desktop', () => {
  assert.equal(classifyEntrypoint('claude-desktop'), 'desktop');
  assert.equal(classifyEntrypoint('local-agent'), 'desktop');
  assert.equal(classifyEntrypoint('claude-desktop-3p'), 'desktop-3p');
  assert.equal(classifyEntrypoint('cli'), '');
  assert.equal(classifyEntrypoint('sdk-ts'), '');
  assert.equal(classifyEntrypoint(''), null);
  assert.equal(entrypointFromHead('{"a":1,"entrypoint" : "claude-desktop"}'), 'claude-desktop');
  assert.equal(entrypointFromHead('{"a":1}'), null);
  assert.equal(cliSessionIdFromRecord('{"cliSessionId":"abc-1"}'), 'abc-1');
  assert.equal(cliSessionIdFromRecord('{"cliSessionId":"../etc"}'), null);
  assert.equal(cliSessionIdFromRecord('garbage "cliSessionId": "abc-2"'), 'abc-2');
});

test('the index classifies by transcript entrypoint, Desktop records and Desktop roots', (t) => {
  const home = fakeHome(t);
  const index = createClaudeDesktopSessionIndex({ homeDir: home, env: {}, platform: 'linux' });
  assert.equal(index.classify('code-tab-session'), 'desktop');
  assert.equal(index.classify('cowork-session'), 'desktop');
  assert.equal(index.classify('cowork-only'), 'desktop', 'transcript inside local-agent-mode-sessions');
  assert.equal(index.classify('resumed-session'), 'desktop', 'named by a claude-code-sessions record');
  assert.equal(index.classify('third-party-session'), 'desktop-3p');
  assert.equal(index.classify('gateway-session'), 'desktop-3p', 'record under the Claude-3p root');
  assert.equal(index.classify('cli-session'), null);
  assert.equal(index.classify('no-entrypoint'), null);
  assert.equal(index.classify('unknown'), null);
  assert.equal(index.classify('../escape'), null);
});

test('the index notices sessions created after its first listing once the TTL passes', (t) => {
  const home = fakeHome(t);
  let now = 0;
  const index = createClaudeDesktopSessionIndex({ homeDir: home, env: {}, platform: 'linux', ttlMs: 1000, now: () => now });
  assert.equal(index.classify('late-session'), null);
  const dir = path.join(home, '.claude', 'projects', '-Users-u-other');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'late-session.jsonl'), `${line('claude-desktop')}\n`);
  assert.equal(index.classify('late-session'), null, 'still cached');
  now = 2000;
  assert.equal(index.classify('late-session'), 'desktop');
});

test('a transcript whose first line is still being written is re-read later', (t) => {
  const home = fakeHome(t);
  const file = path.join(home, '.claude', 'projects', '-Users-u-proj', 'growing.jsonl');
  fs.writeFileSync(file, '{"type":"user","sess');
  const index = createClaudeDesktopSessionIndex({ homeDir: home, env: {}, platform: 'linux', ttlMs: 0 });
  assert.equal(index.classify('growing'), null);
  fs.writeFileSync(file, `${line('claude-desktop')}\n`);
  assert.equal(index.classify('growing'), 'desktop');
});

test('splitClaudeDesktopRows relabels official Desktop rows in entries and sessions only', () => {
  const index = { classify: (id) => ({ d1: 'desktop', p3: 'desktop-3p' })[id] || null };
  const json = {
    entries: [
      { client: 'claude', sessionId: 'd1', model: 'claude-opus', input: 10 },
      { client: 'claude', sessionId: 'c1', model: 'claude-opus', input: 20 },
      { client: 'claude', sessionId: 'p3', model: 'claude-opus', input: 30 },
      { client: 'codex', sessionId: 'd1', model: 'gpt', input: 40 },
      { client: 'claude', model: 'claude-opus', input: 50 }
    ],
    sessions: [{ client: 'claude', sessionId: 'd1', firstActiveMs: 1 }, { client: 'claude', sessionId: 'c1' }]
  };
  const result = splitClaudeDesktopRows(json, index);
  assert.deepEqual(result, { moved: 1, dropped: 0 });
  assert.deepEqual(json.entries.map(({ client, sessionId }) => `${client}:${sessionId}`), [
    'claude-desktop:d1', 'claude:c1', 'claude:p3', 'codex:d1', 'claude:undefined'
  ]);
  assert.deepEqual(json.sessions.map(({ client }) => client), ['claude-desktop', 'claude']);

  const desktopOnly = { entries: [{ client: 'claude', sessionId: 'd1' }, { client: 'claude', sessionId: 'c1' }] };
  assert.deepEqual(splitClaudeDesktopRows(desktopOnly, index, { keepClaude: false }), { moved: 1, dropped: 1 });
  assert.deepEqual(desktopOnly.entries.map(({ client }) => client), ['claude-desktop']);
});

test('the collector splits only when claude-desktop is part of the scan', () => {
  const index = { classify: (id) => (id === 'd1' ? 'desktop' : null) };
  const rows = () => ({ entries: [{ client: 'claude', sessionId: 'd1' }, { client: 'claude', sessionId: 'c1' }] });
  const untouched = rows();
  applyClaudeDesktopSplit(untouched, 'claude,codex', { claudeDesktopSessionIndex: index });
  assert.deepEqual(untouched.entries.map(({ client }) => client), ['claude', 'claude']);
  const both = rows();
  applyClaudeDesktopSplit(both, 'claude,claude-desktop', { claudeDesktopSessionIndex: index });
  assert.deepEqual(both.entries.map(({ client }) => client), ['claude-desktop', 'claude']);
  const desktopOnly = rows();
  applyClaudeDesktopSplit(desktopOnly, 'claude-desktop', { claudeDesktopSessionIndex: index });
  assert.deepEqual(desktopOnly.entries.map(({ client }) => client), ['claude-desktop']);
});

test('claude-desktop is a fixed point, scans as claude and pulls its parent into watch targets', () => {
  assert.equal(normalizeClientName('claude-desktop'), 'claude-desktop');
  assert.equal(normalizeClientName('Claude Desktop'), 'claude-desktop');
  assert.equal(normalizeClientName('claude-desktop-3p'), 'claude', 'third-party build stays under claude');
  assert.equal(tokscaleClientFilter('claude-desktop'), 'claude');
  assert.equal(tokscaleClientFilter('claude,claude-desktop'), 'claude');
  const tracked = new Set(['claude', 'claude-desktop', 'codex']);
  assert.deepEqual(expandDerivedTargets(['claude'], tracked), ['claude', 'claude-desktop']);
  assert.deepEqual(expandDerivedTargets(['claude-desktop'], tracked), ['claude-desktop', 'claude']);
  assert.deepEqual(expandDerivedTargets(['codex'], tracked), ['codex']);
  assert.deepEqual(expandDerivedTargets(['claude'], new Set(['claude'])), ['claude']);
});

const NOW = '2026-10-19T04:00:00.000Z';
function tokscaleRows() {
  return {
    entries: [
      { client: 'claude', sessionId: 'd1', model: 'claude-opus-4-8', input: 100, output: 0, cost: 0 },
      { client: 'claude', sessionId: 'c1', model: 'claude-opus-4-8', input: 7, output: 0, cost: 0 }
    ]
  };
}
const desktopIndex = { classify: (id) => (id === 'd1' ? 'desktop' : null) };
const baseOptions = {
  allTimeSince: '2025-01-01',
  now: NOW,
  commandTimeoutMs: 1000,
  deviceId: 'dev1',
  limitsEnabled: false,
  claudeDesktopSessionIndex: desktopIndex,
  collectWslUsage: async () => ({ bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] })
};

test('a full scan reports Desktop sessions under claude-desktop and the rest under claude', async () => {
  const scans = [];
  const summary = await collectUsageOnce({
    ...baseOptions,
    clients: 'claude,claude-desktop',
    runTokscale: async (input) => { scans.push(input.clients); return tokscaleRows(); }
  });
  assert.deepEqual(summary.today.clients, { 'claude-desktop': 100, claude: 7 });
  assert.equal(summary.allTime.clients['claude-desktop'], 100);
  assert.ok(scans.every((clients) => clients === 'claude,claude-desktop'));
});

test('a windowed full scan splits today, month, allTime and native-range days', async () => {
  const summary = await collectUsageOnce({
    ...baseOptions,
    clients: 'claude,claude-desktop',
    nativeRangesEnabled: true,
    runTokscaleWindows: async ({ windows }) => Object.fromEntries(windows.map(({ name }) => [name, tokscaleRows()]))
  });
  assert.deepEqual(summary.today.clients, { 'claude-desktop': 100, claude: 7 });
  assert.deepEqual(summary.month.clients, { 'claude-desktop': 100, claude: 7 });
  assert.deepEqual(summary.allTime.clients, { 'claude-desktop': 100, claude: 7 });
  assert.equal(summary.nativeRanges.yesterday.clients['claude-desktop'], 100);
  assert.equal(summary.nativeRanges.yesterday.clients.claude, 7);
});

test('tracking only claude-desktop leaves Claude Code usage out', async () => {
  const summary = await collectUsageOnce({
    ...baseOptions,
    clients: 'claude-desktop,codex',
    runTokscale: async () => tokscaleRows()
  });
  assert.deepEqual(summary.today.clients, { 'claude-desktop': 100 });
});

test('a watch tick on claude rescans both rows without a full fallback scan', async () => {
  let anchor = null;
  await collectUsageOnce({
    ...baseOptions,
    clients: 'claude,claude-desktop,codex',
    runTokscale: async () => tokscaleRows(),
    onAnchorComputed: (value) => { anchor = value; }
  });
  const scans = [];
  const summary = await collectUsageOnce({
    ...baseOptions,
    clients: 'claude,claude-desktop,codex',
    targetClients: 'claude',
    todayOnlyAnchor: { ...anchor.windowsPeriods, dateKey: localTodayKey(new Date(NOW)), todayPartitions: anchor.todayPartitions },
    runTokscale: async (input) => {
      scans.push(input.clients);
      return { entries: [{ client: 'claude', sessionId: 'c1', model: 'claude-opus-4-8', input: 9, output: 0, cost: 0 }] };
    }
  });
  assert.deepEqual(scans, ['claude,claude-desktop'], 'one targeted scan; a day without a new Desktop row is not a missing partition');
  assert.equal(summary.today.clients.claude, 9);
  assert.equal(summary.today.clients['claude-desktop'] || 0, 0);
});

test('the claude/claude-desktop identity split has its own generation', () => {
  const claudeSplit = CLIENT_IDENTITY_SPLITS.find(({ split }) => split === 'claude-desktop');
  const piSplit = CLIENT_IDENTITY_SPLITS.find(({ split }) => split === 'omp');
  assert.equal(claudeSplit.merged, 'claude');
  assert.equal(CLIENT_IDENTITY_GENERATION, claudeSplit.generation);
  assert.ok(claudeSplit.generation > piSplit.generation);
  const generationTwo = { clientIdentityGeneration: piSplit.generation };
  assert.equal(isPreSplitEntry(generationTwo, piSplit), false, 'written after the Pi split');
  assert.equal(isPreSplitEntry(generationTwo, claudeSplit), true, 'but before the Desktop split');
  assert.equal(isPreSplitEntry({ clientIdentityGeneration: CLIENT_IDENTITY_GENERATION }, claudeSplit), false);
  assert.equal(splitClientIdFor('claude'), 'claude-desktop');
  const seeded = seedSplitClients('claude,codex', { applied: ['omp'] });
  assert.equal(seeded.clients, 'claude,claude-desktop,codex');
  assert.deepEqual(seeded.seeded, ['claude-desktop']);
  assert.equal(seedSplitClients('claude,codex', { applied: ['omp', 'claude-desktop'] }).clients, 'claude,codex', 'seeded once');
});

test('disabling the Desktop split leaves tokscale rows under claude and changes the anchor fingerprint', () => {
  const index = { classify: (id) => (id === 'd1' ? 'desktop' : null) };
  const rows = () => ({ entries: [{ client: 'claude', sessionId: 'd1' }, { client: 'claude', sessionId: 'c1' }] });
  const both = rows();
  applyClaudeDesktopSplit(both, 'claude,claude-desktop', {
    claudeDesktopSessionIndex: index,
    claudeDesktopSplitEnabled: false
  });
  assert.deepEqual(both.entries.map(({ client }) => client), ['claude', 'claude']);
  const desktopOnly = rows();
  applyClaudeDesktopSplit(desktopOnly, 'claude-desktop', {
    claudeDesktopSessionIndex: index,
    claudeDesktopSplitEnabled: false
  });
  assert.deepEqual(desktopOnly.entries, [], 'desktop-only tracking with the split off keeps no Claude Code rows');

  const fpOn = configFingerprint('claude,claude-desktop', '2025-01-01', true, null, 'fixed', { claudeDesktopSplitEnabled: true });
  const fpOff = configFingerprint('claude,claude-desktop', '2025-01-01', true, null, 'fixed', { claudeDesktopSplitEnabled: false });
  assert.notEqual(fpOn, fpOff, 'toggling split invalidates persisted anchors');
});

test('seedSplitClients skips claude-desktop while the split is disabled', () => {
  const off = seedSplitClients('claude,codex', { applied: ['omp'], claudeDesktopSplitEnabled: false });
  assert.equal(off.clients, 'claude,codex');
  assert.deepEqual(off.seeded, []);
  assert.ok(!off.evaluated.includes('claude-desktop'));
  const on = seedSplitClients('claude,codex', { applied: ['omp'], claudeDesktopSplitEnabled: true });
  assert.equal(on.clients, 'claude,claude-desktop,codex');
  assert.deepEqual(on.seeded, ['claude-desktop']);
});

test('session archives fold archived claude-desktop rows onto claude when the split is disabled', () => {
  const now = new Date('2026-10-19T12:00:00.000Z');
  const day = localTodayKey(now);
  const yesterday = '2026-10-18';
  const archivedRow = {
    client: 'claude-desktop',
    sessionId: 'd1',
    model: 'claude-opus-4-8',
    totalTokens: 100,
    costUsd: 1,
    models: { 'claude-opus-4-8': 100 },
    modelCosts: { 'claude-opus-4-8': 1 }
  };
  const archive = {
    version: 1,
    sessions: {
      'claude-desktop:d1': {
        client: 'claude-desktop',
        sessionId: 'd1',
        capturedAt: now.toISOString(),
        day,
        month: day.slice(0, 7),
        periods: { today: archivedRow, month: archivedRow, allTime: archivedRow },
        days: { [yesterday]: { capturedAt: '2026-10-18T18:00:00.000Z', session: archivedRow } }
      }
    }
  };
  const emptySummary = {
    today: emptyPeriod(),
    month: emptyPeriod(),
    allTime: emptyPeriod(),
    nativeRanges: { yesterday: emptyPeriod() },
    nativeRangeWindows: { yesterday: { start: yesterday, end: yesterday } }
  };
  const foldedPeriods = applySessionUsageArchive(emptySummary, archive, { now, claudeDesktopSplitEnabled: false });
  assert.equal(foldedPeriods.today.clients.claude, 100);
  assert.equal(foldedPeriods.today.clients['claude-desktop'], undefined);
  assert.ok(foldedPeriods.today.sessions['claude:d1']);

  const foldedRanges = applySessionDayArchive(emptySummary, archive, {
    now,
    activeClients: 'claude',
    claudeDesktopSplitEnabled: false
  });
  assert.equal(foldedRanges.nativeRanges.yesterday.clients.claude, 100);
  assert.equal(foldedRanges.nativeRanges.yesterday.clients['claude-desktop'], undefined);
  assert.ok(foldedRanges.nativeRanges.yesterday.sessions['claude:d1']);
});
