'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { summaryForUpload } = require('../fixtures/syncUpload');

test('live upload benchmark includes a device first observed after the initial snapshot', t => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-upload-benchmark-'));
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const fixture = path.join(directory, 'snapshots.json');
  const device = (deviceId, tick) => ({ ...summaryForUpload({ days: 2, tick }), deviceId, receivedAt: `receipt-${tick}` });
  fs.writeFileSync(fixture, JSON.stringify({ snapshots: [
    { devices: [device('first', 0)] },
    { devices: [device('first', 1), device('late', 1)] },
    { devices: [device('first', 2), device('late', 2)] }
  ] }));
  const output = execFileSync(process.execPath, [path.resolve(__dirname, '../../scripts/benchmark-upload-delta.js'), fixture], { encoding: 'utf8', timeout: 15000 });
  const { results } = JSON.parse(output);
  assert.deepEqual(results.map(row => [row.deviceId, row.snapshots, row.identicalFinalState]), [['first', 3, true], ['late', 2, true]]);
});
