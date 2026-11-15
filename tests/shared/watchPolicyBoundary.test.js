'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

test('the watcher child imports the watch policy, not the collection graph', () => {
  const source = fs.readFileSync(path.join(__dirname, '../../src/shared/watcherWorker.js'), 'utf8');
  assert.match(source, /require\('\.\/watchPolicy'\)/);
  assert.doesNotMatch(source, /require\('\.\/collector'\)/);
});

test('loading the watch policy does not pull collector, usage, history or core session metadata', () => {
  require('../../src/shared/watchPolicy');
  const loaded = Object.keys(require.cache).filter((file) => (
    /src\/shared\/(collector|usage|history|sessionMetadata)\.js$/.test(file.replace(/\\/g, '/'))
  ));
  assert.deepEqual(loaded, [], 'watch policy must stay independent of the collection graph');
});
