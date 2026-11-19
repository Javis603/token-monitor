'use strict';

const fs = require('node:fs');
const path = require('node:path');

// Mirror the pinned scanner's Prime settings precedence, including null resets
// and the empty sessionDir spelling for the current working directory.
function primeAgentSessionRoots({ homeDir, env = process.env, cwd = process.cwd() }) {
  const expand = (value) => value === '~' ? homeDir : value.startsWith('~/') ? path.join(homeDir, value.slice(2)) : value;
  const withArtifacts = (sessions) => [sessions, path.join(path.dirname(sessions), 'session-artifacts')];
  const override = env.PRIME_AGENT_SESSION_DIR ?? env.PRIME_AGENT_CODING_AGENT_SESSION_DIR;
  if (override) return withArtifacts(expand(override));
  const agentDir = env.PRIME_AGENT_CODING_AGENT_DIR ? expand(env.PRIME_AGENT_CODING_AGENT_DIR) : path.join(homeDir, '.prime', 'agent');
  let sessionDir;
  for (const file of [path.join(agentDir, 'settings.json'), path.join(cwd, '.prime', 'agent', 'settings.json')]) {
    try {
      const settings = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (settings && (settings.sessionDir === null || typeof settings.sessionDir === 'string')) sessionDir = settings.sessionDir;
    } catch (_) { /* Missing or invalid settings do not override a valid value. */ }
  }
  if (sessionDir === '') return [cwd, path.join(cwd, 'session-artifacts')];
  if (typeof sessionDir === 'string') return withArtifacts(expand(sessionDir));
  return [path.join(agentDir, 'sessions'), path.join(agentDir, 'session-artifacts')];
}

module.exports = { primeAgentSessionRoots };
