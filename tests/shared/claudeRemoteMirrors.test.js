'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { claudeRemoteMirrors } = require('../../src/shared/claudeRemoteMirrors');
const { collectUsageOnce, tokscaleCommand, localTodayKey, configFingerprint } = require('../../src/shared/collector');
const { captureSessionUsageArchive, applySessionUsageArchive } = require('../../src/shared/usage/sessionUsageArchive');

const id = '11111111-2222-4333-8444-555555555555';
const nativeBinary = process.env.TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI;

function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-remote-mirrors-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const projects = path.join(root, '.claude/projects');
  const mirror = path.join(projects, `ssh-${id}`);
  fs.mkdirSync(mirror, { recursive: true });
  fs.mkdirSync(path.join(projects, 'ssh-my-project'));
  return { root, projects, mirror, options: {
    homeDir: root, env: {}, mirrorStatePath: path.join(root, 'selection.json'), claudeRemoteMirrorsExcluded: true
  } };
}

test('explicit mirror selection is narrow, durable, reversible, and respects the configured Claude root', (t) => {
  const { root, projects, options } = fixture(t);
  assert.deepEqual(claudeRemoteMirrors({ ...options, claudeRemoteMirrorsExcluded: false }), { sessionKeys: [] });
  const selected = claudeRemoteMirrors(options);
  assert.deepEqual(selected, { root: projects, sessionKeys: [`claude:${id}`] });
  fs.rmSync(projects, { recursive: true });
  assert.deepEqual(claudeRemoteMirrors(options), selected, 'deleted mirrors remain excluded from retained source caches');
  assert.deepEqual(claudeRemoteMirrors({ ...options, env: { CLAUDE_CONFIG_DIR: path.join(root, 'other') } }).sessionKeys, []);
  assert.equal(tokscaleCommand().env.TOKSCALE_EXCLUDED_CLAUDE_DIRS, undefined);
});

test('mirror selection persists independently of disabled collector anchors', (t) => {
  const { mirror, options } = fixture(t);
  const selected = claudeRemoteMirrors({ ...options, anchorPersistenceEnabled: false });
  fs.rmSync(mirror, { recursive: true });
  assert.deepEqual(claudeRemoteMirrors({ ...options, anchorPersistenceEnabled: false }), selected);
});

test('remote ownership disables built-in WSL, protects session archive projection and refuses an unsupported binary', async (t) => {
  const { options } = fixture(t);
  const common = {
    ...options, platform: 'win32', clients: 'claude', deviceId: 'host', allTimeSince: '2020-01-01',
    projectsEnabled: false, historyEnabled: false,
    collectWslUsage: () => assert.fail('remote ownership must disable WSL scanning'),
    probeWslState: () => assert.fail('remote ownership must not probe WSL')
  };
  await assert.rejects(collectUsageOnce({ ...common, runTokscale: async () => ({ entries: [] }) }), /lacks Claude source exclusions/);
  let captured;
  let calls = 0;
  const scan = { ...common, runTokscale: async () => { calls += 1; return { claudeSourceExclusions: true, entries: [] }; },
    onAnchorComputed: value => { captured = value; } };
  const result = await collectUsageOnce(scan);
  const anchor = { dateKey: localTodayKey(), ...captured.windowsPeriods, excludedSessionKeys: captured.excludedSessionKeys };
  calls = 0;
  await collectUsageOnce({ ...scan, todayOnlyAnchor: anchor });
  assert.equal(calls, 1, 'unchanged exclusions keep the Today-only fast path');
  fs.mkdirSync(path.join(options.homeDir, '.claude/projects/ssh-aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'));
  calls = 0;
  await collectUsageOnce({ ...scan, todayOnlyAnchor: anchor });
  assert.equal(calls, 3, 'new exclusions rebuild old days instead of applying only a Today delta');
  assert.deepEqual(result.excludedSessionKeys, [`claude:${id}`]);
  assert.equal(result.wslStatus.state, 'disabled');
  const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
    [`claude:${id}`]: { client: 'claude', sessionId: id, totalTokens: 100 },
    'claude:local': { client: 'claude', sessionId: 'local', totalTokens: 20 }
  } } });
  const visible = applySessionUsageArchive(result, archive);
  assert.equal(visible.allTime.totalTokens, 20);
  assert.equal(visible.allTime.sessions[`claude:${id}`], undefined);
  assert.equal(applySessionUsageArchive({ ...result, excludedSessionKeys: [] }, archive).allTime.totalTokens, 120, 'disabling exclusion restores retained data');
});

test('actual CLI: native Windows + remote Agent totals remain exact with warm and deleted mirrors', {
  skip: !nativeBinary && 'set TOKEN_MONITOR_TOKSCALE_CLAUDE_WSL_CLI to the candidate binary'
}, async (t) => {
  const { root, mirror, projects, options } = fixture(t);
  const at = new Date().toISOString();
  const event = (session, key, tokens) => JSON.stringify({ type: 'assistant', sessionId: session, timestamp: at, requestId: `r_${key}`,
    message: { id: `m_${key}`, model: 'claude-sonnet-4-6', usage: { input_tokens: tokens, output_tokens: 0 } } }) + '\n';
  const mirrorFile = path.join(mirror, `${id}.jsonl`);
  fs.writeFileSync(mirrorFile, event(id, 'remote', 100));
  const local = path.join(projects, 'local');
  fs.mkdirSync(local);
  fs.writeFileSync(path.join(local, 'local.jsonl'), event('local', 'local', 20));
  fs.writeFileSync(path.join(projects, 'ssh-my-project', 'other.jsonl'), event('other', 'other', 40));
  const run = (input = {}, graph = false) => {
    const env = { ...tokscaleCommand(input).env, HOME: root, CLAUDE_CONFIG_DIR: path.join(root, '.claude'),
      TOKSCALE_CONFIG_DIR: path.join(root, 'config'), TOKSCALE_EXTRA_DIRS: '', TOKSCALE_PRICING_CACHE_ONLY: '1' };
    const args = graph ? ['graph', '--client', 'claude', '--no-spinner']
      : ['--json', '--client', 'claude', '--group-by', 'client,workspace,session,model', '--since', '2020-01-01', '--no-spinner'];
    return JSON.parse(execFileSync(nativeBinary, args, { env, encoding: 'utf8', timeout: 30000 }));
  };
  assert.equal(run().totalInput, 160, 'old Windows snapshot includes the remote mirror');
  fs.writeFileSync(mirrorFile, '{"type":"assistant","message":');
  assert.equal(run().totalInput, 160, 'compacted mirror history is retained before exclusion');
  // The root contract must cover mirrors created after App discovery too.
  const selected = claudeRemoteMirrors(options);
  const input = { claudeRemoteMirrorRoot: selected.root };
  assert.equal(run(input).totalInput + 100, 160, 'Windows 60 + Agent 100, not Windows 160 + Agent 100');
  assert.equal(run(input).claudeSourceExclusions, true);
  assert.equal(run(input, true).contributions.reduce((sum, day) => sum + day.totals.tokens, 0), 60);
  fs.rmSync(mirror, { recursive: true });
  assert.equal(run(input).totalInput, 60, 'a warm retained mirror cannot reappear');
  assert.equal(run().totalInput, 160, 'the selection does not erase cached history');
});

test('mirror source transport stays bounded with many sessions', (t) => {
  const { projects, options } = fixture(t);
  for (let index = 0; index < 400; index += 1) {
    fs.mkdirSync(path.join(projects, `ssh-${index.toString(16).padStart(8, '0')}-2222-4333-8444-555555555555`));
  }
  const selected = claudeRemoteMirrors(options);
  assert.ok(selected.sessionKeys.length === 401);
  const env = tokscaleCommand({ claudeRemoteMirrorRoot: selected.root }).env;
  assert.equal(env.TOKSCALE_CLAUDE_REMOTE_MIRROR_ROOT, projects);
  assert.equal(env.TOKSCALE_EXCLUDED_CLAUDE_DIRS, undefined);
  assert.equal(tokscaleCommand().env.TOKSCALE_CLAUDE_REMOTE_MIRROR_ROOT, undefined);
});

test('mirror archive exclusion includes linked child sessions and uppercase UUID directories', (t) => {
  const { projects, options } = fixture(t);
  const uuid = 'abcdefab-1234-5678-abcd-abcdefabcdef';
  fs.mkdirSync(path.join(projects, `SSH-${uuid.toUpperCase()}`));
  const selection = claudeRemoteMirrors(options);
  const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
    [`claude:${uuid}`]: { client: 'claude', sessionId: uuid, totalTokens: 100 },
    'claude:agent-child': { client: 'claude', sessionId: 'agent-child', parentSessionId: uuid, totalTokens: 30 },
    'claude:native': { client: 'claude', sessionId: 'native', totalTokens: 20 }
  } } });
  const visible = applySessionUsageArchive({ allTime: { sessions: {} }, excludedSessionKeys: selection.sessionKeys }, archive);
  assert.equal(visible.allTime.totalTokens, 20);
});

test('mirror policy anchors cannot be reused after the effective Claude root changes', () => {
  const fingerprint = root => configFingerprint('claude', '2020-01-01', true, '', '', null, '', {
    claudeRemoteMirrorsExcluded: true, env: { CLAUDE_CONFIG_DIR: root }
  }, '');
  assert.notEqual(fingerprint('/first'), fingerprint('/second'));
});

for (const content of ['{broken', '{"roots":null}', '{"roots":[]}', '{"roots":{"/old":[42]}}']) {
  test(`corrupt mirror state recovers collection without replaying unknown archive mirrors: ${content}`, async (t) => {
    const { options, mirror } = fixture(t);
    fs.rmSync(mirror, { recursive: true });
    fs.writeFileSync(options.mirrorStatePath, content);
    const progress = [];
    let captured;
    const events = [];
    const scan = { ...options, clients: 'claude', allTimeSince: '2020-01-01', projectsEnabled: false,
      historyEnabled: false, onProgress: value => progress.push(value), onAnchorComputed: value => { captured = value; },
      onDiagnosticEvent: value => events.push(value),
      runTokscale: async () => ({ claudeSourceExclusions: true, entries: [] }) };
    const result = await collectUsageOnce(scan);
    assert.equal(result.claudeMirrorArchiveRecovery, true);
    assert.equal(captured.claudeMirrorArchiveRecovery, true);
    const recoveredAnchor = { dateKey: localTodayKey(), ...captured.windowsPeriods,
      excludedSessionKeys: captured.excludedSessionKeys, claudeMirrorArchiveRecovery: true };
    const eventCount = events.length;
    await collectUsageOnce({ ...scan, todayOnlyAnchor: recoveredAnchor });
    assert.equal(events.length, eventCount, 'watch ticks do not flood recovery diagnostics');
    assert.ok(progress.every(value => value.claudeMirrorArchiveRecovery === true));
    assert.ok(events.some(event => event.code === 'storage-claude-mirror-state-recovered'));
    const files = fs.readdirSync(path.dirname(options.mirrorStatePath)).filter(name => name.includes('.corrupt'));
    assert.equal(files.length, 1);
    assert.equal(fs.readFileSync(path.join(path.dirname(options.mirrorStatePath), files[0]), 'utf8'), content);
    assert.equal((await collectUsageOnce(scan)).claudeMirrorArchiveRecovery, true, 'recovery guard survives the rebuilt file');
    const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
      [`claude:${id}`]: { client: 'claude', sessionId: id, totalTokens: 100 },
      'claude:child': { client: 'claude', sessionId: 'child', parentSessionId: id, totalTokens: 30 },
      'codex:native': { client: 'codex', sessionId: 'native', totalTokens: 20 }
    } } });
    assert.equal(applySessionUsageArchive(result, archive).allTime.totalTokens, 20);
    assert.equal(applySessionUsageArchive({ ...result, claudeMirrorArchiveRecovery: false }, archive).allTime.totalTokens, 150);
    const disabled = await collectUsageOnce({ ...scan, claudeRemoteMirrorsExcluded: false });
    assert.notEqual(disabled.claudeMirrorArchiveRecovery, true);
  });
}

test('mirror recovery is read-only during seed inspection and does not swallow filesystem errors', (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(options.mirrorStatePath, '{broken');
  assert.equal(claudeRemoteMirrors({ ...options, mirrorStatePersistenceEnabled: false }).recoveryRequired, true);
  assert.equal(fs.readFileSync(options.mirrorStatePath, 'utf8'), '{broken');
  assert.equal(fs.readdirSync(path.dirname(options.mirrorStatePath)).some(name => name.includes('.corrupt')), false);
  fs.unlinkSync(options.mirrorStatePath);
  fs.mkdirSync(options.mirrorStatePath);
  assert.throws(() => claudeRemoteMirrors(options), error => error.code === 'EISDIR');
});

test('recovery leaves live Claude usage and archive bytes intact and clears only with explicit repair', (t) => {
  const { options } = fixture(t);
  fs.writeFileSync(options.mirrorStatePath, '{broken');
  const selection = claudeRemoteMirrors(options);
  const archive = captureSessionUsageArchive(null, { allTime: { sessions: {
    'claude:local': { client: 'claude', sessionId: 'local', totalTokens: 100 },
    'claude:missing': { client: 'claude', sessionId: 'missing', totalTokens: 40 }
  } } });
  const before = JSON.stringify(archive);
  const visible = applySessionUsageArchive({ claudeMirrorArchiveRecovery: selection.recoveryRequired,
    allTime: { totalTokens: 20, sessions: { 'claude:local': { client: 'claude', sessionId: 'local', totalTokens: 20 } } }
  }, archive);
  assert.equal(visible.allTime.totalTokens, 20);
  assert.equal(JSON.stringify(archive), before);
  fs.writeFileSync(options.mirrorStatePath, JSON.stringify({ roots: {} }));
  assert.notEqual(claudeRemoteMirrors(options).recoveryRequired, true);
});

test('mirror recovery persists through collector restart and watch previews', { timeout: 10000 }, async (t) => {
  const { startCollector } = require('../../src/shared/collector');
  const { root, options } = fixture(t);
  const oldShared = process.env.TOKEN_MONITOR_SHARED_DIR;
  process.env.TOKEN_MONITOR_SHARED_DIR = root;
  let handle;
  t.after(async () => {
    await handle?.stop();
    if (oldShared === undefined) delete process.env.TOKEN_MONITOR_SHARED_DIR;
    else process.env.TOKEN_MONITOR_SHARED_DIR = oldShared;
  });
  fs.writeFileSync(options.mirrorStatePath, '{broken');
  const previews = [];
  const start = () => new Promise(resolve => {
    handle = startCollector({ ...options, clients: 'claude', allTimeSince: '2020-01-01',
      historyEnabled: false, projectsEnabled: false, watchEnabled: false, sessionActivityPolling: false,
      intervalMs: 3600000, runTokscale: async () => ({ claudeSourceExclusions: true, entries: [] }),
      onUpdate: resolve, onPreview: value => previews.push(value) });
  });
  assert.equal((await start()).claudeMirrorArchiveRecovery, true);
  await handle.whenIdle();
  await handle.stop();
  const saved = JSON.parse(fs.readFileSync(path.join(root, 'collector-anchor.json'), 'utf8'));
  assert.equal(saved.claudeMirrorArchiveRecovery, true);
  assert.equal((await start()).claudeMirrorArchiveRecovery, true);
  await handle.whenIdle();
  await handle.tick('watch', { todayOnly: true });
  await handle.whenIdle();
  assert.ok(previews.length > 0);
  assert.ok(previews.every(value => value.claudeMirrorArchiveRecovery === true));
  await handle.stop();
});
