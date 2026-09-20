'use strict';

const path = require('node:path');

// CodeBuddy Code keeps one transcript per session under a directory named after
// the working directory it ran in, the same storage shape Claude Code uses:
//
//   <configDir>/projects/<mangled-cwd>/<session-id>.jsonl
//
// `CODEBUDDY_CONFIG_DIR` is deliberately not consulted, even though the CLI
// itself resolves its config directory from it. The pinned tokscale declares no
// override for this client — its table spells the root as a bare
// `.codebuddy/projects`, where Claude and Codex carry `CLAUDE_CONFIG_DIR` and
// `CODEX_HOME` — so honoring one here would only let the local readers answer
// for sessions the scan never reported, leaving the same session with usage
// from one root and a title or a transcript from another. Mirror the scan.
function codebuddyProjectsRoot(options = {}) {
  return path.join(String(options.homeDir ?? ''), '.codebuddy', 'projects');
}

module.exports = { codebuddyProjectsRoot };
