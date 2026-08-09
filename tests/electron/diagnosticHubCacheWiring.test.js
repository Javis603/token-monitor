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
    /function hubModeRequestIsCurrent\(generation, expectedMode, expectedIdentity = null\)[\s\S]*generation === hubModeGeneration[\s\S]*currentHubStatsIdentity\(expectedMode\) === expectedIdentity/
  );
  assert.match(mainSource, /function startMode\(\) \{\s*hubModeGeneration \+= 1;\s*advanceMacWidgetProducerAndSourceEpoch\(\);\s*clearLatestHubStatsCache\(\);/);
  assert.match(mainSource, /function setLatestHubStatsCache\(stats, source, generation, identity\)/);
  assert.match(
    mainSource,
    /function currentHubStatsCache\(\) \{[\s\S]*latestHubStatsSource !== expectedSource[\s\S]*latestHubStatsGeneration !== hubModeGeneration[\s\S]*latestHubStatsIdentity !== currentHubStatsIdentity\(hubMode\)/
  );
  assert.match(mainSource, /latestHubStats: currentHubStatsCache\(\)/);

  const fetchStats = mainSource.match(/async function fetchStats\(options = \{\}\) \{([\s\S]*?)\n\}\n\nfunction managedPricingSidecarPath/);
  assert.ok(fetchStats, 'fetchStats exists');
  assert.match(fetchStats[1], /const requestGeneration = hubModeGeneration;/);
  assert.match(
    fetchStats[1],
    /const stats = await response\.json\(\);[\s\S]*if \(!hubModeRequestIsCurrent\(requestGeneration, 'client', requestHubIdentity\)\)/
  );
  assert.match(fetchStats[1], /composeLocalSyncStats\(stats, lastCollectedDevice\)/);

  const stream = mainSource.match(/async function startStatsStream\(options = \{\}\) \{([\s\S]*?)\n\}\n\nfunction/);
  assert.ok(stream, 'startStatsStream exists');
  assert.match(stream[1], /const generation = hubModeGeneration;/);
  assert.match(stream[1], /hubModeRequestIsCurrent\(generation, 'client', cacheIdentity\)/);
  assert.match(
    stream[1],
    /const \{ value, done \} = await reader\.read\(\);\s*if \(!hubModeRequestIsCurrent\(generation, 'client', cacheIdentity\)\) return;\s*if \(done\) break;/
  );
  assert.match(
    fetchStats[1],
    /if \(!hubModeRequestIsCurrent\(requestGeneration, 'client', requestHubIdentity\)\) \{[\s\S]*await modeQueue;[\s\S]*return fetchStats\(\{[\s\S]*force: false,[\s\S]*forceHistory: false,[\s\S]*forceSelfSync: false/
  );
});
