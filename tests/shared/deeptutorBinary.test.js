'use strict';

// Opt-in, offline integration test against a locally built fork. Unlike the
// full release gate it never requests unrelated clients or account roots.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { DatabaseSync } = require('node:sqlite');
const {
  TOKEN_CONTRACT_CASES, runAgainstFixture, assertTokenContract
} = require('../../scripts/verify-vendored-tokscale');
const { extractUsageFromTokscale } = require('../../src/shared/usage');
const { writeDeepTutorLedger } = require('../fixtures/deeptutor');

const bin = process.env.TOKEN_MONITOR_TEST_TOKSCALE;
const binaryOptions = { skip: !bin };
const bothClients = 'deeptutor,deeptutor-estimated';

function fixture(t) {
  // Do not populate other clients: this test must never need real account data.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-deeptutor-fixture-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const dbPath = writeDeepTutorLedger(home);
  const read = (clients = bothClients) => runAgainstFixture(bin, home, 'client,session,model', clients);
  return { dbPath, read };
}

function hash(file) {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

test('built DeepTutor parser preserves precision and disjoint token buckets through the collector', binaryOptions, t => {
  const { dbPath, read } = fixture(t);
  const before = hash(dbPath);
  for (const contract of TOKEN_CONTRACT_CASES.filter(c => c.client.startsWith('deeptutor'))) {
    const first = read(contract.client);
    assertTokenContract(first, contract);
    assert.deepEqual(read(contract.client).entries, first.entries, 'unchanged ledger must not accumulate calls');
    assert.equal(first.entries[0].cost, 0, 'do not infer an API tariff for OAuth or estimates');
    assert.match(first.entries[0].provider, /^unpriced:/);
  }
  const combined = read();
  assert.equal(extractUsageFromTokscale(combined).totalTokens, 300);
  assert.equal(combined.entries.length, 2);
  assert.equal(hash(dbPath), before, 'the source database is read-only');
});

test('committed WAL changes move a call from estimated to reported without double counting', binaryOptions, t => {
  const { dbPath, read } = fixture(t);
  const writer = new DatabaseSync(dbPath);
  try {
    writer.exec('PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;');
    assert.equal(extractUsageFromTokscale(read()).totalTokens, 300);
    const { usage_json: json } = writer.prepare('SELECT usage_json FROM llm_calls WHERE call_id=?').get('fixture-true');
    const usage = JSON.parse(json);
    usage.estimated = false;
    writer.prepare('UPDATE llm_calls SET usage_json=? WHERE call_id=?').run(JSON.stringify(usage), 'fixture-true');
    const dbBefore = hash(dbPath);
    const walBefore = hash(`${dbPath}-wal`);
    const moved = read();
    const normalized = extractUsageFromTokscale(moved);
    assert.equal(normalized.totalTokens, 300);
    assert.equal(normalized.clients.deeptutor, 300);
    assert.equal(normalized.clients['deeptutor-estimated'] || 0, 0);
    assert.equal(moved.entries.length, 1);
    assert.equal(read('deeptutor-estimated').entries.length, 0);
    assert.deepEqual(read().entries, moved.entries);
    assert.equal(hash(dbPath), dbBefore);
    assert.equal(hash(`${dbPath}-wal`), walBefore, 'the parser must not checkpoint the source WAL');
  } finally { writer.close(); }
});

test('source failure retains the last complete result but a valid empty ledger clears it', binaryOptions, t => {
  const { dbPath, read } = fixture(t);
  const complete = read();
  const offline = `${dbPath}.offline`;
  fs.renameSync(dbPath, offline);
  assert.deepEqual(read().entries, complete.entries);
  fs.renameSync(offline, dbPath);
  const writer = new DatabaseSync(dbPath);
  try { writer.exec('DELETE FROM llm_calls;'); } finally { writer.close(); }
  assert.equal(extractUsageFromTokscale(read()).totalTokens, 0);
  assert.equal(read().entries.length, 0);
});

test('unknown precision is excluded rather than converted to reported usage', binaryOptions, t => {
  const { dbPath, read } = fixture(t);
  const writer = new DatabaseSync(dbPath);
  try {
    const { usage_json: json } = writer.prepare('SELECT usage_json FROM llm_calls LIMIT 1').get();
    const usage = JSON.parse(json);
    delete usage.estimated;
    writer.prepare('UPDATE llm_calls SET usage_json=?').run(JSON.stringify(usage));
  } finally { writer.close(); }
  assert.equal(read().entries.length, 0);
  assert.equal(extractUsageFromTokscale(read()).totalTokens, 0);
});
