'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const mainSource = fs.readFileSync(
  path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'),
  'utf8'
);

test('late Hub responses cannot replace the active mode cache', () => {
  assert.match(mainSource, /let hubModeGeneration = 0;/);
  assert.match(
    mainSource,
    /function hubModeRequestIsCurrent\(generation, expectedMode\)[\s\S]*return generation === hubModeGeneration && settings\?\.hubMode === expectedMode;/
  );
  assert.match(mainSource, /function startMode\(\) \{\s*hubModeGeneration \+= 1;/);

  const fetchStats = mainSource.match(/async function fetchStats\(options = \{\}\) \{([\s\S]*?)\n\}\n\nfunction managedPricingSidecarPath/);
  assert.ok(fetchStats, 'fetchStats exists');
  assert.match(fetchStats[1], /const requestGeneration = hubModeGeneration;/);
  assert.match(
    fetchStats[1],
    /const stats = await response\.json\(\);[\s\S]*if \(!hubModeRequestIsCurrent\(requestGeneration, 'client'\)\)/
  );
  assert.match(fetchStats[1], /composeLocalSyncStats\(stats, lastCollectedDevice\)/);

  const stream = mainSource.match(/async function startStatsStream\(options = \{\}\) \{([\s\S]*?)\n\}\n\nfunction/);
  assert.ok(stream, 'startStatsStream exists');
  assert.match(stream[1], /const generation = hubModeGeneration;/);
  assert.match(stream[1], /hubModeRequestIsCurrent\(generation, 'client'\)/);
  assert.match(
    stream[1],
    /const \{ value, done \} = await reader\.read\(\);\s*if \(!hubModeRequestIsCurrent\(generation, 'client'\)\) return;\s*if \(done\) break;/
  );
  assert.match(
    fetchStats[1],
    /if \(!hubModeRequestIsCurrent\(requestGeneration, 'client'\)\) \{[\s\S]*await modeQueue;[\s\S]*return fetchStats\(\{[\s\S]*force: false,[\s\S]*forceHistory: false,[\s\S]*forceSelfSync: false/
  );
});
