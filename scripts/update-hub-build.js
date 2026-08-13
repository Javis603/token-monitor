#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const {
  REGISTRY_PATH,
  currentHubSourceBuildIds,
  readRegistry,
  updatedRegistry
} = require('./hub-build-manifest');

const previous = readRegistry();
const next = updatedRegistry(previous, currentHubSourceBuildIds());

if (JSON.stringify(previous) === JSON.stringify(next)) {
  console.log('Hub build registry is already current.');
  process.exit(0);
}

fs.writeFileSync(REGISTRY_PATH, `${JSON.stringify(next, null, 2)}\n`);
console.log('Updated Hub build registry. Run npm run sync:worker to copy it into worker/.');
