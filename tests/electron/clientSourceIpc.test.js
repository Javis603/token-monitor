'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { createClientSourceIpcHandlers } = require('../../src/electron/clientSourceIpc');

function createHandlers({ trackedClients = ['codex'], repairResult = { ok: true, code: 'repaired' } } = {}) {
  const calls = {
    sourceProbes: [],
    revealDirectories: [],
    revealLocks: [],
    rescans: [],
    repairs: []
  };
  const handlers = createClientSourceIpcHandlers({
    knownClients: ['codex', 'commandcode', 'antigravity'],
    trackedClients: () => trackedClients,
    visibleDiagnosticRoots: (client) => {
      calls.sourceProbes.push(client);
      return {
        [client]: [
          { id: `${client}-data`, dir: `/tmp/${client}`, exists: true },
          { id: 'custom-scan-path', dir: `/tmp/${client}-custom`, exists: false, custom: true }
        ]
      };
    },
    clientDiagnosticRoots: (client) => ({
      [client]: [{ id: `${client}-data`, dir: `/tmp/${client}`, exists: true }]
    }),
    openPath: async (dir) => {
      calls.revealDirectories.push(dir);
      return '';
    },
    revealClientSyncLock: (client) => {
      calls.revealLocks.push(client);
      return true;
    },
    canRunRescan: () => true,
    rescanClient: async (client) => {
      calls.rescans.push(client);
      return true;
    },
    repairClientSyncLock: async (client) => {
      calls.repairs.push(client);
      return repairResult;
    }
  });
  return { calls, handlers };
}

test('source inspection allows known untracked clients while rescan stays tracked-only', async () => {
  const { calls, handlers } = createHandlers();

  assert.deepEqual(handlers.clientSources('commandcode'), {
    sources: [
      { id: 'commandcode-data', dir: '/tmp/commandcode', exists: true },
      { id: 'custom-scan-path', dir: '/tmp/commandcode-custom', exists: false, custom: true }
    ],
    omittedCount: 0
  });
  assert.equal(await handlers.revealClientSource('commandcode'), true);
  assert.equal(handlers.revealClientSyncLock('commandcode'), false);
  assert.equal(await handlers.rescanClient('commandcode'), false);
  assert.deepEqual(await handlers.repairClientSyncLock('commandcode'), { ok: false, code: 'unavailable' });
  assert.deepEqual(calls.sourceProbes, ['commandcode']);
  assert.deepEqual(calls.revealDirectories, ['/tmp/commandcode']);
  assert.deepEqual(calls.rescans, []);
});

test('unknown clients are rejected by every client IPC handler', async () => {
  const { calls, handlers } = createHandlers();

  assert.equal(handlers.clientSources('unknown'), null);
  assert.equal(await handlers.revealClientSource('unknown'), false);
  assert.equal(handlers.revealClientSyncLock('unknown'), false);
  assert.equal(await handlers.rescanClient('unknown'), false);
  assert.deepEqual(await handlers.repairClientSyncLock('unknown'), { ok: false, code: 'unavailable' });
  assert.deepEqual(calls, {
    sourceProbes: [],
    revealDirectories: [],
    revealLocks: [],
    rescans: [],
    repairs: []
  });
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

test('source inspection keeps every custom source when the diagnostic cap is exceeded', () => {
  const builtIns = Array.from({ length: 32 }, (_, index) => ({
    id: `codex-data-${index}`,
    dir: `/tmp/codex-${index}`,
    exists: true
  }));
  const custom = Array.from({ length: 16 }, (_, index) => ({
    id: 'custom-scan-path',
    dir: `/tmp/custom-${index}`,
    exists: true,
    custom: true
  }));
  const handlers = createClientSourceIpcHandlers({
    knownClients: ['codex'],
    visibleDiagnosticRoots: () => ({ codex: [...builtIns, ...custom] })
  });

  const result = handlers.clientSources('codex');
  assert.equal(result.sources.length, 32);
  assert.equal(result.sources.filter((source) => source.custom === true).length, 16);
  assert.equal(result.omittedCount, 16);
});

test('Antigravity sync-lock repair is tracked-only and re-scans only after a safe repair', async () => {
  const untracked = createHandlers();
  assert.deepEqual(
    await untracked.handlers.repairClientSyncLock('antigravity'),
    { ok: false, code: 'unavailable' }
  );
  assert.deepEqual(untracked.calls.repairs, []);

  const active = createHandlers({
    trackedClients: ['antigravity'],
    repairResult: { ok: false, code: 'owner-active' }
  });
  assert.deepEqual(
    await active.handlers.repairClientSyncLock('antigravity'),
    { ok: false, code: 'owner-active' }
  );
  assert.deepEqual(active.calls.repairs, ['antigravity']);
  assert.deepEqual(active.calls.rescans, [], 'an active owner prevents the follow-up scan');

  const repaired = createHandlers({ trackedClients: ['antigravity'] });
  assert.deepEqual(
    await repaired.handlers.repairClientSyncLock('antigravity'),
    { ok: true, code: 'repaired' }
  );
  assert.deepEqual(repaired.calls.repairs, ['antigravity']);
  assert.deepEqual(repaired.calls.rescans, ['antigravity']);
});

test('only Antigravity can reveal the fixed sync-lock path', () => {
  const { calls, handlers } = createHandlers();

  assert.equal(handlers.revealClientSyncLock('codex'), false);
  assert.equal(handlers.revealClientSyncLock('antigravity'), true);
  assert.deepEqual(calls.revealLocks, ['antigravity']);
});

function createUntrackedHandlers({ tracked = ['codex'], present = ['kiro'], wsl = [], throws = false, wslThrows = false } = {}) {
  const probes = [];
  const wslProbes = [];
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
    },
    detectWslClients: async (remaining) => {
      wslProbes.push(remaining);
      if (wslThrows) throw new Error('wsl probe failed');
      return wsl;
    }
  });
  return { probes, wslProbes, handlers };
}

test('untracked clients with data are reported, tracked ones and empty ones are not', async () => {
  const { probes, handlers } = createUntrackedHandlers({
    tracked: ['codex'],
    present: ['kiro', 'workbuddy', 'codex']
  });

  assert.deepEqual(await handlers.untrackedClientsWithData(), ['kiro', 'workbuddy']);
  assert.deepEqual(probes, ['kiro,workbuddy,grok']);
});

test('untracked WSL-only clients are reported and tracked/unknown WSL entries are ignored', async () => {
  const { wslProbes, handlers } = createUntrackedHandlers({
    tracked: ['codex'],
    present: ['kiro'],
    wsl: ['codex', 'kiro', 'grok', 'unknown-tool']
  });

  assert.deepEqual(await handlers.untrackedClientsWithData(), ['kiro', 'grok']);
  assert.deepEqual(wslProbes, [['workbuddy', 'grok']]);
});

test('an untracked client whose only root is absent is not reported', async () => {
  const { handlers } = createUntrackedHandlers({ tracked: ['codex'], present: [] });

  assert.deepEqual(await handlers.untrackedClientsWithData(), []);
});

test('tracking every known client probes nothing', async () => {
  const { probes, wslProbes, handlers } = createUntrackedHandlers({
    tracked: ['codex', 'kiro', 'workbuddy', 'grok'],
    wsl: ['grok']
  });

  assert.deepEqual(await handlers.untrackedClientsWithData(), []);
  assert.deepEqual(probes, []);
  assert.deepEqual(wslProbes, []);
});

test('a failing probe reports nothing instead of throwing at the IPC boundary', async () => {
  const { handlers } = createUntrackedHandlers({ throws: true, wslThrows: true });

  assert.deepEqual(await handlers.untrackedClientsWithData(), []);
});

test('a failing WSL probe does not discard native root detections', async () => {
  const { handlers } = createUntrackedHandlers({ present: ['kiro'], wslThrows: true });

  assert.deepEqual(await handlers.untrackedClientsWithData(), ['kiro']);
});
