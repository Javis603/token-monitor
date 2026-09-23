'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { seedAgentClients } = require('../../src/agent/seedClients');

function tempSharedDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-seed-'));
  return { dir, env: { TOKEN_MONITOR_SHARED_DIR: dir } };
}

function markerPath(dir) {
  return path.join(dir, 'seeded-client-splits.json');
}

test('a real launch seeds the split client once and records it', () => {
  const { dir, env } = tempSharedDir();
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi,omp');
  const marker = JSON.parse(fs.readFileSync(markerPath(dir), 'utf8'));
  assert.deepEqual(marker.applied, ['omp']);
  assert.equal(marker.sourceCsv, 'claude,pi');
  assert.equal(marker.clients, 'claude,pi,omp');
});

// A --dry-run preview must not consume the one-shot migration: recording it on
// a run that collected nothing would make the next real launch skip the seed
// and silently drop the split client's usage.
test('a dry run resolves the split client without recording the migration', () => {
  const { dir, env } = tempSharedDir();
  assert.equal(seedAgentClients('claude,pi', { persist: false, env }), 'claude,pi,omp');
  assert.equal(fs.existsSync(markerPath(dir)), false, 'dry run must not write the marker');

  // The next real launch still performs the migration.
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi,omp');
  assert.deepEqual(JSON.parse(fs.readFileSync(markerPath(dir), 'utf8')).applied, ['omp']);
});

// The env CSV is redeclared on every launch, so the seeded result is what must
// persist: a marker that only says the migration ran would read the unchanged
// pre-split CSV next launch and silently stop collecting Oh My Pi.
test('an unchanged CSV keeps the seeded client on every later launch', () => {
  const { env } = tempSharedDir();
  seedAgentClients('claude,pi', { env });
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi,omp');
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi,omp');
});

// Editing the CSV is a new declaration and is taken literally. That is also the
// operator's way to drop the split client: once the recorded source no longer
// matches, the new CSV is seeded on its own terms — and the recorded migration
// stops it being re-added.
test('an edited CSV is honored, including removing the split client', () => {
  const { env } = tempSharedDir();
  seedAgentClients('claude,pi', { env });
  assert.equal(seedAgentClients('claude,pi,omp', { env }), 'claude,pi,omp');
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi');
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi', 'the removal sticks');
});
