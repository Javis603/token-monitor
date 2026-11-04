'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { clientSourceRoots, clientSourceChecks, watchPathsForClients, watchIgnoreMatcher, clientsForWatchPath, watchAttributionRootsForClients } = require('../../src/shared/collector');
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
