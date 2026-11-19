'use strict';

const path = require('node:path');

function nonBlank(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

// Claude Code resolves both projects and transcript sessions from
// CLAUDE_CONFIG_DIR, falling back to ~/.claude. `useEnvRoots: false` is used
// for an explicit secondary home such as a WSL distro, where the scoped home
// must win over the host process environment.
function resolveClaudeConfigDir({ env, homeDir = '', useEnvRoots = true } = {}) {
  const configured = useEnvRoots ? nonBlank((env || process.env).CLAUDE_CONFIG_DIR) : '';
  return configured || path.join(homeDir, '.claude');
}

function claudeSessionRoots(options = {}) {
  const configDir = resolveClaudeConfigDir(options);
  return {
    projects: path.join(configDir, 'projects'),
    transcripts: path.join(configDir, 'transcripts')
  };
}

module.exports = { claudeSessionRoots, resolveClaudeConfigDir };
