'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { deriveClientHealth, clientWatchCandidates, clientSourceRoots, clientSourceChecks, watchPathsForClients, watchIgnoreMatcher, clientsForWatchPath, watchAttributionRootsForClients } = require('../../src/shared/collector');
const { createCursorUsageEventIndex } = require('../../src/shared/providers/cursor/usageEvents');

function fixture(t) {
  const homeDir = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tm-421-')));
  t.after(() => fs.rmSync(homeDir, { recursive: true, force: true }));
  return { homeDir, env: {}, cwdDir: homeDir };
}

test('Cursor source and event index follow the isolated config cache, not host history', t => {
  const options = fixture(t);
  const config = path.join(options.homeDir, 'isolated');
  options.env.TOKSCALE_CONFIG_DIR = config;
  options.env.XDG_CONFIG_HOME = path.join(options.homeDir, 'xdg');
  const cache = path.join(config, 'cursor-cache');
  fs.mkdirSync(cache, { recursive: true });
  fs.writeFileSync(path.join(cache, 'usage.json'), JSON.stringify({ usageEventsDisplay: [
    { timestamp: '1790000000000', conversationId: 'isolated', model: 'default', tokenUsage: { inputTokens: 100 } }
  ] }));
  assert.equal(clientSourceRoots('cursor', options).cursor[0].dir, cache);
  const index = createCursorUsageEventIndex(options)();
  assert.deepEqual(index.sessionsAt(1790000000000, 100), ['isolated']);
  options.env.TOKSCALE_CONFIG_DIR = '   ';
  assert.equal(clientSourceRoots('cursor', options).cursor[0].dir,
    path.join(options.homeDir, '.config/tokscale/cursor-cache'));
});

test('Copilot empty-window sessions are detected, watched and attributed without sibling caches', t => {
  const options = fixture(t);
  const dir = path.join(options.homeDir, '.config/Code/User/globalStorage/emptyWindowChatSessions');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'session.jsonl');
  fs.writeFileSync(file, '{}\n');
  assert.ok(clientSourceRoots('copilot', options).copilot.some(root => root.dir === dir));
  assert.ok(clientSourceChecks('copilot', options).copilot.some(root => root.exists));
  assert.ok(watchPathsForClients('copilot', options).includes(dir));
  const ignored = watchIgnoreMatcher('copilot', options);
  assert.equal(ignored(file), false);
  assert.equal(ignored(path.join(dir, 'unrelated-cache')), true);
  assert.deepEqual(clientsForWatchPath(file, watchAttributionRootsForClients('copilot', null, options)), ['copilot']);
});

test('Senpi watches new home-agent project children and memory transcripts with narrow discovery', t => {
  const options = fixture(t);
  const projects = path.join(options.homeDir, '.omo/agent/projects');
  const memory = path.join(options.homeDir, '.omo/memory');
  fs.mkdirSync(projects, { recursive: true });
  fs.mkdirSync(memory, { recursive: true });
  const future = path.join(projects, 'future-hash/senpi-task/children/task/sessions/child.jsonl');
  const memo = path.join(memory, 'agents/explorer/runtime/transcripts/run/transcript.jsonl');
  let ignored = watchIgnoreMatcher('senpi', options);
  assert.equal(ignored(future), false);
  assert.equal(ignored(path.join(projects, 'future-hash/unrelated-cache/data.jsonl')), true);
  assert.equal(ignored(memo), false);
  assert.ok(!watchPathsForClients('senpi', options).includes(options.homeDir));
  fs.mkdirSync(path.dirname(future), { recursive: true });
  fs.writeFileSync(future, '{}\n');
  const roots = watchAttributionRootsForClients('senpi', null, options);
  assert.deepEqual(clientsForWatchPath(future, roots), ['senpi']);
  assert.deepEqual(clientsForWatchPath(memo, roots), ['senpi']);
  ignored = watchIgnoreMatcher('senpi', options);
  assert.equal(ignored(path.join(projects, 'future-hash/unrelated-cache')), true);
});

test('Copilot native session-state events survive watch pruning and retain client attribution', t => {
  const options = fixture(t);
  const root = path.join(options.homeDir, '.copilot');
  fs.mkdirSync(root, { recursive: true });
  const ignored = watchIgnoreMatcher('copilot', options);
  const sources = watchAttributionRootsForClients('copilot', null, options);
  for (const relative of ['session-state', 'session-state/new-session', 'session-state/new-session/events.jsonl', 'session-state/legacy.jsonl']) {
    const file = path.join(root, relative);
    assert.equal(ignored(file), false, relative);
    assert.deepEqual(clientsForWatchPath(file, sources), ['copilot']);
  }
  for (const relative of ['session-state/new-session/checkpoints', 'session-state/new-session/plan.md', 'session-state/new-session/nested/events.jsonl']) {
    assert.equal(ignored(path.join(root, relative)), true, relative);
  }
});

test('Copilot native-only sources produce healthy and waiting health without duplicate watches', t => {
  const options = fixture(t);
  const root = path.join(options.homeDir, '.copilot');
  const native = path.join(root, 'session-state');
  let sourceChecks = clientSourceChecks('copilot', options);
  assert.equal(deriveClientHealth('copilot', { clients: {} }, { sourceChecks }).clients.copilot.overall, 'unavailable');
  fs.mkdirSync(path.join(native, 'new-session'), { recursive: true });
  fs.writeFileSync(path.join(native, 'new-session/events.jsonl'), '{}\n');
  sourceChecks = clientSourceChecks('copilot', options);
  assert.deepEqual(sourceChecks.copilot.filter(check => check.exists), [{ id: 'copilot-session-state', exists: true }]);
  for (const [tokens, expected] of [[0, 'waiting'], [100, 'healthy']]) {
    const health = deriveClientHealth('copilot', { clients: { copilot: tokens } }, { sourceChecks });
    assert.equal(health.clients.copilot.source.state, 'detected');
    assert.equal(health.clients.copilot.overall, expected);
    const mirrored = require('../../worker/src/shared/clientHealth').normalizeClientHealth(health).clients.copilot;
    assert.equal(mirrored.overall, expected);
    if (tokens === 0) assert.ok(mirrored.source.checks.some(check => check.id === 'copilot-session-state' && check.exists));
  }
  const watches = clientWatchCandidates('copilot', options).copilot;
  assert.ok(watches.includes(root));
  assert.ok(!watches.includes(native));
  assert.ok(!watches.includes(path.join(root, 'otel')));
  assert.equal(watchPathsForClients('copilot', options).filter(dir => dir === root).length, 1);
});
