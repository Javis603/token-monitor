'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  initSqliteCache,
  readLatestSnapshot,
  writeSnapshot,
  upsertDailyObservations
} = require('../../src/shared/sqliteCache');

test('sqliteCache creates database and tables successfully', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-cache-test-'));
  const dbPath = path.join(tmpDir, 'test_token_monitor.db');

  const db = initSqliteCache({ dbPath });
  assert.ok(db, 'db instance should be created');
  assert.ok(fs.existsSync(dbPath), 'db file should exist');
  db.close();
});

test('sqliteCache writes and reads latest snapshot instantly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-cache-test-'));
  const dbPath = path.join(tmpDir, 'test_token_monitor.db');

  const sampleSnapshot = {
    deviceId: 'test-device-1',
    updatedAt: new Date().toISOString(),
    today: { totalTokens: 12345, costUsd: 1.23, clients: { claude: 10000, ccswitch: 2345 } },
    month: { totalTokens: 99999, costUsd: 9.99, clients: { claude: 80000, ccswitch: 19999 } },
    allTime: { totalTokens: 500000, costUsd: 50.0, clients: { claude: 400000, ccswitch: 100000 } }
  };

  const written = writeSnapshot('test-device-1', sampleSnapshot, { dbPath });
  assert.equal(written, true, 'writeSnapshot should return true');

  const read = readLatestSnapshot('test-device-1', { dbPath });
  assert.ok(read, 'snapshot should be retrieved');
  assert.equal(read.deviceId, 'test-device-1');
  assert.equal(read.today.totalTokens, 12345);
  assert.equal(read.today.clients.ccswitch, 2345);
});

test('sqliteCache upserts daily observations', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sqlite-cache-test-'));
  const dbPath = path.join(tmpDir, 'test_token_monitor.db');

  const result = upsertDailyObservations('2026-07-24', [
    { client: 'ccswitch', modelId: 'gpt-4o', tokens: 5000, cost: 0.05, messages: 10, reasoningTokens: 0 },
    { client: 'claude', modelId: 'claude-3-5-sonnet', tokens: 12000, cost: 0.12, messages: 5, reasoningTokens: 500 }
  ], { dbPath });

  assert.equal(result, true, 'upsertDailyObservations should return true');
});
