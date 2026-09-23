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

// The marker is what lets an operator remove the split client afterwards
// without it being re-added on every launch.
test('a recorded migration is not re-applied', () => {
  const { env } = tempSharedDir();
  seedAgentClients('claude,pi', { env });
  assert.equal(seedAgentClients('claude,pi', { env }), 'claude,pi');
});
