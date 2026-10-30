'use strict';

const path = require('node:path');

// Match the bundled scanner's home-relative Pi root. Pi itself accepts
// PI_CODING_AGENT_DIR, but Tokscale does not, so applying it only to detail
// lookup would hide sessions that the scan still reports. The supplied home
// also scopes Windows lookups to the selected WSL distro.
function resolvePiAgentDir({ homeDir = '' } = {}) {
  return path.join(homeDir, '.pi', 'agent');
}

function resolvePiSessionsDir(options = {}) {
  return path.join(resolvePiAgentDir(options), 'sessions');
}

module.exports = { resolvePiAgentDir, resolvePiSessionsDir };
