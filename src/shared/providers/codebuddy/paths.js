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

// The VS Code extension keeps its conversations outside the CLI tree, in the
// shared CodeBuddyExtension data dir, one tree per install and per editor:
//
//   <base>/Data/<install-id>/VSCode/<uuid>/history/<workspace>/<conversation>/
//
// The same bases as the collector's extension watch roots apply, with `Data`
// where those use `Logs` — tokscale attributes these conversations' usage to
// the `codebuddy` client too, so a relocated base would split a session's
// usage from its title and transcript the same way an env-var root would.
function codebuddyExtensionDataRoots(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = String(options.homeDir ?? '');
  const bases = [];
  if (platform === 'darwin') {
    bases.push(path.join(homeDir, 'Library', 'Application Support', 'CodeBuddyExtension'));
  } else if (platform === 'linux') {
    const xdgDataHome = nonBlank(env.XDG_DATA_HOME) || path.join(homeDir, '.local', 'share');
    bases.push(path.join(xdgDataHome, 'CodeBuddyExtension'));
  } else {
    const localAppData = nonBlank(env.LOCALAPPDATA) || path.join(homeDir, 'AppData', 'Local');
    bases.push(path.join(localAppData, 'CodeBuddyExtension'));
    bases.push(path.join(homeDir, 'AppData', 'Local', 'CodeBuddyExtension'));
  }
  return [...new Set(bases.map((base) => path.join(base, 'Data')))].filter(nonBlank);
}

function nonBlank(value) {
  return String(value ?? '').trim();
}

module.exports = { codebuddyExtensionDataRoots, codebuddyProjectsRoot };
