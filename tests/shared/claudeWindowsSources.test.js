'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { claudeDesktopMsixSourceRoots, clientSourceRoots } = require('../../src/shared/clientSources');

test('Windows Claude Desktop MSIX roots are discovered from LOCALAPPDATA', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-msix-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const local = path.join(home, 'relocated-local');
  const profile = path.join(local, 'Claude-Data', 'claude_pzs8sxrjxfjjc');
  const transcripts = path.join(profile, 'claude-code-sessions');
  const indexedDb = path.join(profile, 'IndexedDB');
  const leveldb = path.join(indexedDb, 'https_claude.ai_0.indexeddb.leveldb');
  const blob = path.join(indexedDb, 'https_claude.ai_0.indexeddb.blob');
  fs.mkdirSync(transcripts, { recursive: true });
  fs.mkdirSync(leveldb, { recursive: true });
  fs.mkdirSync(blob, { recursive: true });
  fs.mkdirSync(path.join(local, 'Claude-Data', 'other', 'claude-code-sessions'), { recursive: true });

  const roots = claudeDesktopMsixSourceRoots({ env: { LOCALAPPDATA: local }, platform: 'win32' });
  assert.deepEqual(roots, [
    ['claude-desktop-transcripts', transcripts, null, true],
    ['claude-desktop-cache', leveldb, null, true],
    ['claude-desktop-cache', blob, null, true]
  ]);
  const registered = clientSourceRoots('claude', { homeDir: home, env: { LocalAppData: local }, platform: 'win32' }).claude;
  assert.ok(registered.some(root => root.dir === transcripts));
  assert.ok(registered.some(root => root.dir === leveldb));
});

test('Claude MSIX discovery is disabled outside Windows and without an absolute LocalAppData', () => {
  assert.deepEqual(claudeDesktopMsixSourceRoots({ env: { LOCALAPPDATA: 'relative' }, platform: 'win32' }), []);
  assert.deepEqual(claudeDesktopMsixSourceRoots({ env: { LOCALAPPDATA: '/tmp/local' }, platform: 'linux' }), []);
});

test('Claude MSIX package discovers legacy and package-state storage roots', (t) => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-claude-msix-legacy-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const local = path.join(home, 'LocalAppData');

  // Older Anthropic package layout stores the profile below LocalCache.
  const legacyProfile = path.join(local, 'Packages', 'AnthropicPBC.Claude_8wekyb3d8bbwe', 'LocalCache', 'Roaming', 'Claude');
  const legacyTranscripts = path.join(legacyProfile, 'claude-code-sessions');
  const legacyLeveldb = path.join(legacyProfile, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');

  // Other MSIX builds place their app data directly in package state folders.
  const packageRoot = path.join(local, 'Packages', 'Claude_publisher');
  const localState = path.join(packageRoot, 'LocalState');
  const stateTranscripts = path.join(localState, 'claude-code-sessions');
  const stateLeveldb = path.join(localState, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
  const localCache = path.join(packageRoot, 'LocalCache');
  const cacheTranscripts = path.join(localCache, 'local-agent-mode-sessions');
  const roamingState = path.join(packageRoot, 'RoamingState');
  const roamingBlob = path.join(roamingState, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob');

  for (const dir of [
    legacyTranscripts, legacyLeveldb, stateTranscripts, stateLeveldb,
    cacheTranscripts, roamingBlob
  ]) fs.mkdirSync(dir, { recursive: true });

  const roots = claudeDesktopMsixSourceRoots({ env: { LOCALAPPDATA: local }, platform: 'win32' });
  for (const dir of [
    legacyTranscripts, legacyLeveldb, stateTranscripts, stateLeveldb,
    cacheTranscripts, roamingBlob
  ]) assert.ok(roots.some(([, root]) => root === dir), `missing discovered root: ${dir}`);

  const registered = clientSourceRoots('claude', {
    homeDir: home, env: { LOCALAPPDATA: local }, platform: 'win32'
  }).claude;
  for (const dir of [
    legacyTranscripts, legacyLeveldb, stateTranscripts, stateLeveldb,
    cacheTranscripts, roamingBlob
  ]) assert.ok(registered.some(root => root.dir === dir), `missing registered root: ${dir}`);
});
