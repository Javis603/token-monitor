'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '../..');
const mainSource = fs.readFileSync(path.join(root, 'src/electron/main.js'), 'utf8');
const agentSource = fs.readFileSync(path.join(root, 'src/agent/agent.js'), 'utf8');

test('official producers request the optional minimal ingest response', () => {
  assert.match(mainSource, /\[HUB_RESPONSE_HEADER\]: HUB_RESPONSE_MINIMAL/);
  assert.match(agentSource, /\[HUB_RESPONSE_HEADER\]: HUB_RESPONSE_MINIMAL/);
});

test('the desktop stream negotiates and receives full, freshness and delta events independently of REST', () => {
  assert.match(mainSource, /\[HUB_STREAM_HEADER\]: HUB_STREAM_VERSION/);
  assert.match(mainSource, /const streamSnapshot = createStatsStreamReceiver\(\);/);
  assert.match(mainSource, /\['snapshot', 'stats', 'freshness', 'delta'\]\.includes\(parsed\.event\)/);
  assert.match(mainSource, /streamSnapshot\.receive\(parsed\.event, parsed\.data\)/);
  assert.match(mainSource, /devices: refreshed\.devices\.map/);
});
