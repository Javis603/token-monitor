'use strict';
const semver = require('semver');
// Import, installed artifacts and runtime discovery share the same bounds.
const MAX_MANIFEST_BYTES = 256 * 1024;
function assertHostCompatibility(manifest) {
  const range = manifest.engines?.tokenMonitor;
  if (range !== undefined && (typeof range !== 'string' || !semver.validRange(range) || !semver.satisfies(require('../../../package.json').version, range))) {
    throw new Error('package requires an incompatible Token Monitor version');
  }
}
module.exports = { MAX_MANIFEST_BYTES, assertHostCompatibility };
