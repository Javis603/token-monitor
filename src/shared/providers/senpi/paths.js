'use strict';

const path = require('node:path');

function nonBlank(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : '';
}

// Tokscale's Senpi client always scans `~/.omo/agent/sessions` (omo-ai 5.1.0+)
// and `~/.omo/senpi-task`. `SENPI_CODING_AGENT_DIR` replaces the legacy
// `~/.senpi/agent` root; it does not move the OmO tree. `SENPI_CODING_AGENT_SESSION_DIR`
// is an extra sessions directory, not a replacement. There is no OmO-specific
// environment variable — a relocated OmO tree is `scanner.extraScanPaths.senpi`
// in tokscale settings, which arrives as a custom scan path rather than a root here.
function senpiSourceRoots(home, env = {}) {
  const agentDir = nonBlank(env.SENPI_CODING_AGENT_DIR);
  const sessions = agentDir
    ? path.join(agentDir, 'sessions')
    : path.join(home, '.senpi', 'agent', 'sessions');
  const roots = [
    ['senpi-sessions', sessions],
    ['senpi-omo-sessions', path.join(home, '.omo', 'agent', 'sessions')],
    ['senpi-task-children', path.join(home, '.omo', 'senpi-task')]
  ];
  const extra = nonBlank(env.SENPI_CODING_AGENT_SESSION_DIR);
  if (extra) roots.push(['senpi-sessions', extra]);
  return roots;
}

function resolveSenpiSessionsDirs({ homeDir = '', env = process.env, useEnvRoots = true } = {}) {
  const seen = new Set();
  const dirs = [];
  for (const [, dir] of senpiSourceRoots(homeDir, useEnvRoots === false ? {} : env)) {
    if (!dir || seen.has(dir)) continue;
    seen.add(dir);
    dirs.push(dir);
  }
  return dirs;
}

module.exports = { senpiSourceRoots, resolveSenpiSessionsDirs };
