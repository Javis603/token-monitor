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

function createUntrackedHandlers({ tracked = ['codex'], present = ['kiro'], throws = false } = {}) {
  const probes = [];
  const handlers = createClientSourceIpcHandlers({
    knownClients: ['codex', 'kiro', 'workbuddy', 'grok'],
    trackedClients: () => tracked,
    visibleDiagnosticRoots: (clientsCsv) => {
      probes.push(clientsCsv);
      if (throws) throw new Error('probe failed');
      return Object.fromEntries(String(clientsCsv).split(',').filter(Boolean).map((client) => [
        client,
        [{ id: `${client}-data`, dir: `/tmp/${client}`, exists: present.includes(client) }]
      ]));
    }
  });
  return { probes, handlers };
}

test('untracked clients with data are reported, tracked ones and empty ones are not', () => {
  const { probes, handlers } = createUntrackedHandlers({
    tracked: ['codex'],
    present: ['kiro', 'workbuddy', 'codex']
  });

  // codex has data but is already tracked, so it is not something to surface;
  // grok is untracked with nothing on disk.
  assert.deepEqual(handlers.untrackedClientsWithData(), ['kiro', 'workbuddy']);
  // One sweep for the whole untracked set, not one probe per client.
  assert.deepEqual(probes, ['kiro,workbuddy,grok']);
});

test('an untracked client whose only root is absent is not reported', () => {
  const { handlers } = createUntrackedHandlers({ tracked: ['codex'], present: [] });

  assert.deepEqual(handlers.untrackedClientsWithData(), []);
});

test('tracking every known client probes nothing', () => {
  const { probes, handlers } = createUntrackedHandlers({
    tracked: ['codex', 'kiro', 'workbuddy', 'grok']
  });

  assert.deepEqual(handlers.untrackedClientsWithData(), []);
  assert.deepEqual(probes, []);
});

test('a failing probe reports nothing instead of throwing at the IPC boundary', () => {
  const { handlers } = createUntrackedHandlers({ throws: true });

  assert.deepEqual(handlers.untrackedClientsWithData(), []);
});
