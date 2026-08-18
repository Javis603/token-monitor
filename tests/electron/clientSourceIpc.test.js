'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClientSourceIpcHandlers } = require('../../src/electron/clientSourceIpc');

function createHandlers({ trackedClients = ['codex'] } = {}) {
  const calls = {
    sourceProbes: [],
    revealDirectories: [],
    rescans: []
  };
  const handlers = createClientSourceIpcHandlers({
    knownClients: ['codex', 'commandcode'],
    trackedClients: () => trackedClients,
    visibleDiagnosticRoots: (client) => {
      calls.sourceProbes.push(client);
      return {
        [client]: [{ id: `${client}-data`, dir: `/tmp/${client}`, exists: true }]
      };
    },
    clientDiagnosticRoots: (client) => ({
      [client]: [{ id: `${client}-data`, dir: `/tmp/${client}`, exists: true }]
    }),
    openPath: async (dir) => {
      calls.revealDirectories.push(dir);
      return '';
    },
    canRunRescan: () => true,
    rescanClient: async (client) => {
      calls.rescans.push(client);
      return true;
    }
  });
  return { calls, handlers };
}

test('source inspection allows known untracked clients while rescan stays tracked-only', async () => {
  const { calls, handlers } = createHandlers();

  assert.deepEqual(handlers.clientSources('commandcode'), {
    sources: [{ id: 'commandcode-data', dir: '/tmp/commandcode', exists: true }],
    omittedCount: 0
  });
  assert.equal(await handlers.revealClientSource('commandcode'), true);
  assert.equal(await handlers.rescanClient('commandcode'), false);
  assert.deepEqual(calls.sourceProbes, ['commandcode']);
  assert.deepEqual(calls.revealDirectories, ['/tmp/commandcode']);
  assert.deepEqual(calls.rescans, []);
});

test('unknown clients are rejected by every client IPC handler', async () => {
  const { calls, handlers } = createHandlers();

  assert.equal(handlers.clientSources('unknown'), null);
  assert.equal(await handlers.revealClientSource('unknown'), false);
  assert.equal(await handlers.rescanClient('unknown'), false);
  assert.deepEqual(calls, { sourceProbes: [], revealDirectories: [], rescans: [] });
});

test('tracked clients retain source inspection and rescan behavior', async () => {
  const { calls, handlers } = createHandlers();

  assert.notEqual(handlers.clientSources('codex'), null);
  assert.equal(await handlers.revealClientSource('codex'), true);
  assert.equal(await handlers.rescanClient('codex'), true);
  assert.deepEqual(calls.sourceProbes, ['codex']);
  assert.deepEqual(calls.revealDirectories, ['/tmp/codex']);
  assert.deepEqual(calls.rescans, ['codex']);
});
