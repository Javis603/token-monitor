'use strict';

const path = require('node:path');

// Match tokscale's fixed home-relative OMP root; environment profile overrides
// do not change the sessions directory it scans. The supplied home scopes WSL.
function resolveOmpAgentDir({ homeDir = '' } = {}) {
  return path.join(homeDir, '.omp', 'agent');
}

function resolveOmpSessionsDir(options = {}) {
  return path.join(resolveOmpAgentDir(options), 'sessions');
}

module.exports = { resolveOmpAgentDir, resolveOmpSessionsDir };
