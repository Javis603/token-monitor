'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const script = path.join(root, 'scripts/benchmark-hub-bandwidth.js');
const source = fs.readFileSync(script, 'utf8');

test('hub bandwidth benchmark stringifies each SSE frame once and compares runtimes', () => {
  assert.match(source, /function sse\(event, data\) \{[\s\S]*?JSON\.stringify\(data\)/);
  assert.match(source, /assert\.deepEqual\(workerRecord, nodeRecord, 'Node and Worker normalized records drifted'\)/);
  assert.match(source, /'Node and Worker aggregate stats drifted'/);
  assert.match(source, /burst10LegacyPerClient: burstEvents\.reduce/);
  assert.match(source, /burst10NewPerClient: bytes\(burstEvents\.at\(-1\)\)/);
  assert.match(source, /unchangedNewTwoClients: bytes\(freshness\) \* 2/);
  assert.match(source, /meaningfulNewTwoClients: bytes\(fullEvent\) \* 2/);
});

test('hub bandwidth benchmark stays deterministic across Node and Worker', () => {
  const result = spawnSync(process.execPath, [script], { encoding: 'utf8', cwd: root });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  assert.match(result.stdout, /1800 session rows/);
  assert.match(result.stdout, /Node Hub/);
  assert.match(result.stdout, /Cloudflare Worker/);
  assert.match(result.stdout, /99\.98%/);
  assert.match(result.stdout, /90\.00%/);
});
