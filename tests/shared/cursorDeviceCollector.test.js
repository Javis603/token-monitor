'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const cursorAuth = require('../../src/shared/providers/cursor/auth');
const {
  clientSourceRoots,
  clientWatchCandidates,
  collectUsageOnce,
  configFingerprint,
  deriveClientHealth,
  watchPathsForClients
} = require('../../src/shared/collector');
const { emptyPeriod } = require('../../src/shared/usage');

function writeLog(logPath, records) {
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  fs.writeFileSync(logPath, `${records.map((row) => JSON.stringify(row)).join('\n')}\n`);
}

function stopLine(overrides = {}) {
  return {
    v: 1,
    event: 'stop',
    ts: '2026-09-15T12:00:00.000Z',
    model: 'cursor-grok-4.6-xhigh',
    input_tokens: 40,
    output_tokens: 2,
    cache_read_tokens: 0,
    cache_write_tokens: 0,
    conversation_id: 'conv-1',
    generation_id: 'gen-1',
    ...overrides
  };
}

test('device mode Cursor source root is the jsonl directory, not the tokscale cache', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-roots-'));
  const env = { TOKEN_MONITOR_SHARED_DIR: path.join(home, 'shared') };
  const account = clientSourceRoots('cursor', { homeDir: home, env });
  assert.equal(account.cursor[0].id, 'tokscale-cursor-cache');
  const device = clientSourceRoots('cursor', { homeDir: home, env, cursorUsageSource: 'device' });
  assert.equal(device.cursor[0].id, 'cursor-device-log');
  assert.equal(device.cursor[0].dir, path.join(home, 'shared', 'cursor-device'));
});

test('device mode watches the Cursor jsonl directory instead of skipping it as a sync cache', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-watch-'));
  const shared = path.join(home, 'shared');
  const env = { TOKEN_MONITOR_SHARED_DIR: shared };
  fs.mkdirSync(path.join(shared, 'cursor-device'), { recursive: true });
  const options = { homeDir: home, env, cursorUsageSource: 'device' };
  assert.deepEqual(clientWatchCandidates('cursor', options).cursor, [path.join(shared, 'cursor-device')]);
  assert.ok(watchPathsForClients('cursor', options).includes(path.join(shared, 'cursor-device')));
});

test('switching Cursor usage source changes the collector fingerprint', () => {
  const account = configFingerprint('cursor', '2024-01-01', true, '');
  const device = configFingerprint('cursor', '2024-01-01', true, '', 'device');
  assert.notEqual(account, device);
  assert.equal(configFingerprint('cursor', '2024-01-01', true, '', 'account'), account);
});

test('device mode collectUsageOnce reads the jsonl and skips tokscale cursor sync', async () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'cursor-device-collect-'));
  const shared = path.join(home, 'shared');
  const logPath = path.join(shared, 'cursor-device', 'usage.jsonl');
  writeLog(logPath, [stopLine()]);
  const originalSync = cursorAuth.runCursorSync;
  let syncCalls = 0;
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  const scanned = [];
  try {
    const summary = await collectUsageOnce({
      clients: 'cursor,claude',
      allTimeSince: '2026-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'dev1',
      homeDir: home,
      env: { TOKEN_MONITOR_SHARED_DIR: shared },
      cursorUsageSource: 'device',
      cursorDeviceLogPath: logPath,
      now: new Date('2026-09-15T13:00:00'),
      limitsEnabled: false,
      historyEnabled: false,
      lookupModelPricing: async () => null,
      runTokscale: async ({ clients }) => {
        scanned.push(clients);
        return { entries: [{ client: 'claude', sessionId: 's1', model: 'm', input: 7 }] };
      },
      collectWslUsage: async () => ({ bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] })
    });
    assert.equal(syncCalls, 0);
    assert.ok(scanned.length > 0);
    for (const filter of scanned) {
      assert.equal(filter.split(',').includes('cursor'), false, `cursor leaked into tokscale filter ${filter}`);
      assert.ok(filter.split(',').includes('claude'));
    }
    assert.equal(summary.today.clients.cursor, 42);
    assert.equal(summary.today.clients.claude, 7);
    assert.equal(summary.clientHealth.clients.cursor.collection.state, 'direct');
  } finally {
    cursorAuth.runCursorSync = originalSync;
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test('account mode still runs Cursor sync', async () => {
  const originalSync = cursorAuth.runCursorSync;
  let syncCalls = 0;
  cursorAuth.runCursorSync = async () => { syncCalls += 1; };
  try {
    await collectUsageOnce({
      clients: 'cursor',
      allTimeSince: '2026-01-01',
      commandTimeoutMs: 1000,
      deviceId: 'dev1',
      limitsEnabled: false,
      historyEnabled: false,
      forceSelfSync: ['cursor'],
      runTokscale: async () => ({ entries: [] }),
      collectWslUsage: async () => ({ bundle: { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() }, detected: [] })
    });
    assert.equal(syncCalls, 1);
  } finally {
    cursorAuth.runCursorSync = originalSync;
  }
});

test('device-mode Cursor health is a local adapter, not a self-sync lane', () => {
  const health = deriveClientHealth('cursor', { clients: { cursor: 10 } }, {
    cursorUsageSource: 'device',
    sourceChecks: { cursor: [{ id: 'cursor-device-log', exists: true }] }
  });
  assert.equal(health.clients.cursor.collection.state, 'direct');
});
