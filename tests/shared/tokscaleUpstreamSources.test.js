'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { clientSourceRoots } = require('../../src/shared/clientSources');
const { clientsForWatchPath, watchAttributionRootsForClients, watchIgnoreMatcher, watchPathsForClients } = require('../../src/shared/collector');
const { MARKER_CLIENTS } = require('../../src/shared/clientSourceRegistration');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

installSourceEnvGuard(test);

test('Amp follows its config sync cache and independently retains legacy XDG threads', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-amp-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const config = path.join(home, 'custom-config');
  const data = path.join(home, 'custom-data');
  const cache = path.join(config, 'amp-cache', 'threads');
  const legacy = path.join(data, 'amp', 'threads');
  for (const dir of [cache, legacy]) fs.mkdirSync(dir, { recursive: true });
  const options = { homeDir: home, env: { TOKSCALE_CONFIG_DIR: config, XDG_DATA_HOME: data } };
  const roots = clientSourceRoots('amp', options).amp;
  assert.deepEqual(roots.map(({ dir }) => dir), [legacy, cache]);
  assert.ok(roots.every(({ sourcePath }) => sourcePath === undefined));
  assert.deepEqual(watchPathsForClients('amp', options), [legacy, cache]);
  const attribution = watchAttributionRootsForClients('amp', null, options);
  assert.deepEqual(clientsForWatchPath(path.join(cache, 'T-new.json'), attribution), ['amp']);
  assert.deepEqual(clientsForWatchPath(path.join(legacy, 'T-old.json'), attribution), ['amp']);
  assert.equal(MARKER_CLIENTS['.config/tokscale/amp-cache/threads'], 'amp');
});

test('Claude Desktop roots ignore app-data overrides and retain transcript and blob triggers', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-desktop-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const app = path.join(home, '.config', 'Claude');
  const transcripts = path.join(app, 'local-agent-mode-sessions');
  const project = path.join(transcripts, 'account', 'org', 'session', '.claude', 'projects', 'repo');
  const runtime = path.join(transcripts, 'account', 'org', 'session', '.claude', 'cache');
  const cache = path.join(app, 'IndexedDB', 'https_claude.ai_0.indexeddb.leveldb');
  const blobs = path.join(app, 'IndexedDB', 'https_claude.ai_0.indexeddb.blob');
  for (const dir of [project, runtime, cache, blobs]) fs.mkdirSync(dir, { recursive: true });
  const options = { homeDir: home, env: { APPDATA: '/unused-appdata', XDG_CONFIG_HOME: '/unused-config' } };
  const roots = clientSourceRoots('claude', options).claude;
  assert.ok(roots.some(({ dir, optional }) => dir === cache && optional));
  assert.ok(roots.some(({ dir, optional }) => dir === blobs && optional));
  assert.ok(roots.some(({ dir }) => dir === transcripts));
  const watched = watchPathsForClients('claude', options);
  for (const dir of [cache, blobs, transcripts]) assert.ok(watched.includes(dir));
  const ignored = watchIgnoreMatcher('claude', options);
  assert.equal(ignored(path.join(project, 'usage.jsonl')), false);
  assert.equal(ignored(runtime), true);
  assert.equal(ignored(path.join(cache, '000001.log')), false);
  assert.equal(ignored(path.join(blobs, '1', '01', '101')), false);
  const attribution = watchAttributionRootsForClients('claude', null, options);
  assert.deepEqual(clientsForWatchPath(path.join(cache, '000001.log'), attribution), ['claude']);
  assert.equal(MARKER_CLIENTS['.config/Claude/local-agent-mode-sessions'], 'claude');
  assert.equal(MARKER_CLIENTS['.config/Claude/IndexedDB/https_claude.ai_0.indexeddb.leveldb'], 'claude');
});

test('Hermes log-only settlements trigger refresh without watching runtime logs', (t) => {
  const home = fs.mkdtempSync(path.join(fs.realpathSync.native(os.tmpdir()), 'tm-hermes-log-roots-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  process.env.HERMES_HOME = home;
  const logs = path.join(home, 'logs');
  fs.mkdirSync(logs, { recursive: true });
  const options = { homeDir: home };
  const ignored = watchIgnoreMatcher('hermes', options);
  assert.equal(ignored(logs), false);
  for (const name of ['agent.log', 'agent.log.1', 'agent.log.2026-10-15']) {
    assert.equal(ignored(path.join(logs, name)), false);
  }
  assert.equal(ignored(path.join(logs, 'debug.log')), true);
  assert.equal(ignored(path.join(logs, 'agent.log.1', 'nested')), true);
  assert.equal(ignored(path.join(home, 'hermes-agent')), true);
  const attribution = watchAttributionRootsForClients('hermes', null, options);
  assert.deepEqual(clientsForWatchPath(path.join(logs, 'agent.log'), attribution), ['hermes']);
});
