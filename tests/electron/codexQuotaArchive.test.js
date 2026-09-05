'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  createCodexQuotaArchiveStore,
  loadCodexQuotaArchiveFile,
  LOAD_CORRUPT,
  LOAD_MISSING,
  LOAD_OK,
  LOAD_UNREADABLE,
  LOAD_VERSION_UNSUPPORTED
} = require('../../src/electron/codexQuotaArchive');

const ACCOUNT_A = 'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';

function windowOf(kind, percent) {
  return {
    kind,
    limitId: 'codex',
    usedPercent: percent,
    resetsAt: '2026-09-08T00:00:00.000Z',
    windowMinutes: kind === 'session' ? 300 : 10080,
    additional: false
  };
}

function deviceAt({ at, sessionPercent, weeklyPercent, tokens }) {
  return {
    deviceId: 'local-device',
    updatedAt: at,
    allTime: {
      totalTokens: tokens,
      clients: { codex: tokens },
      models: { 'gpt-6-astra': tokens },
      clientModels: { codex: { 'gpt-6-astra': tokens } },
      capabilities: { tokenComponents: true }
    },
    limits: {
      updatedAt: at,
      providers: [{
        provider: 'codex',
        status: 'ok',
        accountKey: ACCOUNT_A,
        sourceDetail: 'rpc',
        sourceDeviceId: 'local-device',
        windows: [windowOf('session', sessionPercent), windowOf('weekly', weeklyPercent)]
      }]
    }
  };
}

function withTempDir(run) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codex-quota-archive-'));
  try {
    return run(path.join(dir, 'codex-quota-archive.json'));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

test('a missing archive seeds an empty one and is not locked', () => {
  withTempDir((filePath) => {
    const result = loadCodexQuotaArchiveFile(filePath);
    assert.equal(result.code, LOAD_MISSING);
    assert.equal(result.locked, false);
    assert.deepEqual(result.archive.observations, []);
    assert.deepEqual(result.archive.accountingSamples, []);
  });
});

test('a corrupt archive is locked and keeps its original bytes through captures', () => {
  withTempDir((filePath) => {
    const originalBytes = '{"version":1, "observations": [ BROKEN';
    fs.writeFileSync(filePath, originalBytes, 'utf8');
    const logs = [];
    const store = createCodexQuotaArchiveStore(filePath, { log: (message) => logs.push(message) });
    const loaded = store.load();
    assert.equal(store.isLocked(), true);
    assert.equal(store.lastLoadCode(), LOAD_CORRUPT);
    assert.deepEqual(loaded.observations, []);
    // Repeated captures must never rewrite the damaged file.
    store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    store.capture(deviceAt({ at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_000_000 }), '2026-09-05T07:05:00.000Z');
    assert.equal(fs.readFileSync(filePath, 'utf8'), originalBytes);
    // The lock reason is a stable code without paths or contents.
    assert.equal(logs.length, 1);
    assert.match(logs[0], /^\[codex-quota\] archive locked: archive-corrupt$/);
  });
});

test('an unreadable archive is locked without deleting or truncating it', () => {
  withTempDir((filePath) => {
    fs.writeFileSync(filePath, '{}', { mode: 0o444 });
    const failingRead = () => {
      const error = new Error('EACCES');
      error.code = 'EACCES';
      throw error;
    };
    const store = createCodexQuotaArchiveStore(filePath, { readFile: failingRead });
    store.load();
    assert.equal(store.isLocked(), true);
    assert.equal(store.lastLoadCode(), LOAD_UNREADABLE);
    store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    assert.equal(fs.readFileSync(filePath, 'utf8'), '{}');
  });
});

test('an empty or wrong-version archive file is locked, a valid one loads', () => {
  withTempDir((filePath) => {
    fs.writeFileSync(filePath, '   ', 'utf8');
    assert.equal(loadCodexQuotaArchiveFile(filePath).code, LOAD_CORRUPT);
    fs.writeFileSync(filePath, '{"version":99}', 'utf8');
    assert.equal(loadCodexQuotaArchiveFile(filePath).code, LOAD_VERSION_UNSUPPORTED);
    assert.equal(loadCodexQuotaArchiveFile(filePath).locked, true);
    fs.writeFileSync(filePath, JSON.stringify({ version: 1, observations: [], accountingSamples: [], scopes: {}, windowState: {}, lastProfileId: '' }), 'utf8');
    const ok = loadCodexQuotaArchiveFile(filePath);
    assert.equal(ok.code, LOAD_OK);
    assert.equal(ok.locked, false);
  });
});

test('a healthy store observes and persists, then stays stable across reloads', () => {
  withTempDir((filePath) => {
    const store = createCodexQuotaArchiveStore(filePath);
    const first = store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    assert.ok(first.accountingSamples.length > 0);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.version, 1);
    const second = createCodexQuotaArchiveStore(filePath);
    const reloaded = second.load();
    assert.equal(second.isLocked(), false);
    assert.equal(reloaded.accountingSamples.length, first.accountingSamples.length);
  });
});

test('a persist failure is reported as a stable code, never the path', () => {
  withTempDir((filePath) => {
    const logs = [];
    const store = createCodexQuotaArchiveStore(filePath, {
      writeFile: () => {
        throw new Error(`boom at ${filePath}`);
      },
      log: (message) => logs.push(message)
    });
    store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    assert.equal(logs.some((line) => line.includes('persist failed')), true);
    assert.equal(logs.some((line) => line.includes(filePath)), false);
  });
});

test('a JSON-valid but structurally broken current-version archive is locked as corrupt', () => {
  withTempDir((filePath) => {
    const brokenDocuments = [
      { version: 1, observations: 'bad', accountingSamples: [], scopes: {}, windowState: {} },
      { version: 1, observations: [], accountingSamples: { not: 'an array' }, scopes: {}, windowState: {} },
      { version: 1, observations: [], accountingSamples: [], scopes: [], windowState: {} },
      { version: 1, observations: [], accountingSamples: [], scopes: 'scalar', windowState: {} },
      { version: 1, observations: [], accountingSamples: [], scopes: {}, windowState: 42 },
      { version: 1, observations: [], accountingSamples: [], scopes: {}, windowState: {}, lastProfileId: 7 },
      { version: 1, observations: ['not an object'], accountingSamples: [], scopes: {}, windowState: {} },
      { version: 1, observations: [], accountingSamples: [null], scopes: {}, windowState: {} },
      { version: 1, observations: [], accountingSamples: [], scopes: { profile: 'scalar' }, windowState: {} },
      { version: 1, observations: [], accountingSamples: [], scopes: {}, windowState: { key: [1, 2] } }
    ];
    for (const document of brokenDocuments) {
      fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
      const result = loadCodexQuotaArchiveFile(filePath);
      assert.equal(result.code, LOAD_CORRUPT, JSON.stringify(document));
      assert.equal(result.locked, true);
      assert.deepEqual(result.archive.observations, []);
    }
  });
});

test('a structurally corrupt archive keeps its original bytes through repeated captures', () => {
  withTempDir((filePath) => {
    const original = JSON.stringify({
      version: 1,
      observations: 'bad',
      accountingSamples: [],
      scopes: {},
      windowState: {}
    });
    fs.writeFileSync(filePath, original, 'utf8');
    const logs = [];
    const store = createCodexQuotaArchiveStore(filePath, { log: (message) => logs.push(message) });
    store.load();
    assert.equal(store.isLocked(), true);
    assert.equal(store.lastLoadCode(), LOAD_CORRUPT);
    store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    store.capture(deviceAt({ at: '2026-09-05T07:05:00.000Z', sessionPercent: 20, weeklyPercent: 20, tokens: 2_000_000 }), '2026-09-05T07:05:00.000Z');
    assert.equal(fs.readFileSync(filePath, 'utf8'), original);
    assert.match(logs[0], /^\[codex-quota\] archive locked: archive-corrupt$/);
  });
});

test('dirty but well-shaped values still load, normalize and keep sampling', () => {
  withTempDir((filePath) => {
    const document = {
      version: 1,
      observations: [{ observedAt: 'not-a-date', provider: 'codex', profileId: 'sha256:deadbeef', kind: 'weekly', usedPercent: 500, extraField: 'ignored' }],
      accountingSamples: [],
      scopes: { 'sha256:deadbeef': { profileId: 'sha256:deadbeef', totalTokens: 'lots' } },
      windowState: { bad: { usedPercent: 999 } },
      lastProfileId: 'sha256:deadbeef',
      unknownFutureField: { note: 'tolerated' }
    };
    fs.writeFileSync(filePath, JSON.stringify(document), 'utf8');
    const result = loadCodexQuotaArchiveFile(filePath);
    assert.equal(result.code, LOAD_OK);
    assert.equal(result.locked, false);
    // Dirty inner values were compatibly cleaned, never locked.
    assert.deepEqual(result.archive.windowState, {});
    assert.equal(result.archive.observations.length, 1);
    assert.equal(result.archive.scopes['sha256:deadbeef'].totalTokens, 0);
    // A healthy capture still samples and persists atomically on top.
    const store = createCodexQuotaArchiveStore(filePath);
    const next = store.capture(deviceAt({ at: '2026-09-05T07:00:00.000Z', sessionPercent: 10, weeklyPercent: 10, tokens: 1_000_000 }), '2026-09-05T07:00:00.000Z');
    assert.ok(next.accountingSamples.length > 0);
    const persisted = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    assert.equal(persisted.version, 1);
    assert.ok(persisted.accountingSamples.length > 0);
  });
});
