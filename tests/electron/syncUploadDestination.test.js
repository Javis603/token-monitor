'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { destinationIdentity } = require('../../src/electron/syncContentRuntime');

function harness() {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('async function postToHub(summary) {');
  const end = source.indexOf('\nlet syncContentRuntime = null;', start);
  assert.ok(start >= 0 && end > start);
  let context = { mode: 'client', url: 'https://first.example', secret: 'first', deviceId: 'one' };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  const posts = [];
  const sandbox = vm.createContext({
    settings: {}, console, AbortSignal, destinationIdentity,
    effectiveHubConfig: () => context, syncContentContext: () => context,
    getSyncContentRuntime: () => ({ prepareUpload: () => held }),
    postSyncPayload: async (_fetch, url, options) => {
      posts.push({ url, options });
      return { response: { ok: true, json: async () => ({ ok: true }) } };
    },
    fetch: async () => {}, saveSettings: () => {},
    HUB_RESPONSE_HEADER: 'x-token-monitor-response', HUB_RESPONSE_MINIMAL: 'minimal'
  });
  vm.runInContext(source.slice(start, end), sandbox);
  return {
    posts, context: () => context,
    setContext: next => { context = next; },
    release: (aborted = false) => release({ identity: destinationIdentity(context),
      syncSessionTitles: true, sessionTitleSyncGeneration: 1, signal: { aborted } }),
    post: () => sandbox.postToHub({ deviceId: 'one' })
  };
}

test('an upload waiting for consent cannot send to the previously captured destination', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.setContext({ ...fixture.context(), url: 'https://second.example', secret: 'second' });
  fixture.release();
  await assert.rejects(upload, /hub_changed/);
  assert.equal(fixture.posts.length, 0);
});

test('revocation while an upload waits stops serialization even at the same destination', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.release(true);
  await assert.rejects(upload, /hub_changed/);
  assert.equal(fixture.posts.length, 0);
});

test('a consented upload at the unchanged destination keeps the negotiated generation', async () => {
  const fixture = harness();
  const upload = fixture.post();
  fixture.release();
  await upload;
  assert.equal(fixture.posts[0].url, 'https://first.example/api/ingest');
  assert.equal(fixture.posts[0].options.sessionTitleSyncGeneration, 1);
});

test('the actual settings IPC handler rejects a destination change while publication waits', async () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf("  ipcMain.handle('settings:update', async (_event, patch) => {");
  const end = source.indexOf('  // The settings:update body', start);
  assert.ok(start >= 0 && end > start);
  let handler;
  let context = { mode: 'client', url: 'https://first.example', secret: 'one', deviceId: 'one' };
  let release;
  const held = new Promise(resolve => { release = resolve; });
  let applied = false;
  const sandbox = vm.createContext({ destinationIdentity, syncContentContext: () => context,
    ipcMain: { handle: (_channel, callback) => { handler = callback; } },
    getSyncContentRuntime: () => ({ publishPatch: () => held }),
    applySettingsPatch: () => { applied = true; }, latestUsageHost: null });
  vm.runInContext(source.slice(start, end), sandbox);
  const edit = handler(null, { customModelPricing: [] });
  context = { ...context, url: 'https://second.example' };
  release();
  await assert.rejects(edit, /hub_changed/);
  assert.equal(applied, false);
});

test('the main-process persistence adapter rolls back failed sync state writes', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = source.indexOf('function getSyncContentRuntime() {');
  const end = source.indexOf('\n// ---------------------------------------------------------------------------', start);
  assert.ok(start >= 0 && end > start);
  const original = { syncContentState: { enabled: { sessionTitles: false }, pendingTitleCleanup: ['old'] } };
  let dependencies;
  let failure = true;
  const sandbox = vm.createContext({
    settings: original, syncContentRuntime: null, applySyncSettingsPatch: null, mainWindow: null,
    syncContentContext: () => ({}), normalizeSharedSyncValue: value => value,
    ensureCredentialStore: () => {},
    createSyncContentCredentialQueue: () => ({ read: () => [], save: () => {}, remove: () => {} }),
    createSyncContentRuntime: value => { dependencies = value; return {}; },
    saveSettings: () => { if (failure) throw new Error('disk full'); }
  });
  vm.runInContext(source.slice(start, end), sandbox);
  sandbox.getSyncContentRuntime();
  const next = { enabled: { sessionTitles: false }, pendingTitleCleanup: [] };
  assert.throws(() => dependencies.saveState(next), /disk full/);
  assert.equal(sandbox.settings, original, 'failed completion must retain the retry row');
  failure = false;
  dependencies.saveState(next);
  assert.equal(sandbox.settings.syncContentState, next);
});
