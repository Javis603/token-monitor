'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { antigravityCliDataDir, clientSourceRoots } = require('./clientSources');
const { antigravityDataPresent, antigravityDataRoots } = require('./providers/antigravity/selfSync');

function dirExists(dir) {
  try { return fs.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function fileExists(file) {
  try { return fs.statSync(file).isFile(); } catch (_) { return false; }
}

function hasCopilotChatSessions(workspaceRoot) {
  try {
    return fs.readdirSync(workspaceRoot, { withFileTypes: true })
      .some((entry) => entry.isDirectory() && dirExists(path.join(workspaceRoot, entry.name, 'chatSessions')));
  } catch (_) {
    return false;
  }
}

// Which roots actually exist is probed here; the collector derives its legacy
// presence dot and health record from the same collapsed checks.
function sourceRootExists(root) {
  if (root.sourcePath) return fileExists(root.sourcePath);
  return root.id === 'vscode-workspace-storage'
    ? hasCopilotChatSessions(root.dir)
    : dirExists(root.dir);
}

// Diagnostics print `dir` beside `exists`. For an exact-file source this must
// be the file we probed, not its watch parent; sourcePath also tells the reveal
// handler to show a file rather than open a directory.
function evaluatedClientSourceRoots(clientsCsv, options = {}) {
  return Object.fromEntries(Object.entries(clientSourceRoots(clientsCsv, options)).map(([client, roots]) => [
    client,
    roots.map((root) => ({
      id: root.id,
      dir: root.sourcePath || root.dir,
      ...(root.sourcePath ? { sourcePath: root.sourcePath } : {}),
      ...(root.optional ? { optional: true } : {}),
      ...(root.custom ? { custom: true } : {}),
      exists: sourceRootExists(root)
    }))
  ]));
}

function clientSourceChecks(clientsCsv, options = {}) {
  const checks = {};
  const push = (client, id, exists) => {
    const list = checks[client] || (checks[client] = []);
    const found = list.find((entry) => entry.id === id);
    if (found) found.exists = found.exists || exists;
    else list.push({ id, exists });
  };
  for (const [client, roots] of Object.entries(evaluatedClientSourceRoots(clientsCsv, options))) {
    checks[client] = checks[client] || [];
    for (const { id, exists } of roots) push(client, id, exists);
  }
  // Antigravity's cache is written by our sync, while its IDE and CLI roots are
  // real sources. Keep separate checks so an IDE-only or CLI-only install with
  // no counted usage reads `waiting`, not `missing`.
  // A WSL-only install likewise has a source without any host path.
  if (Object.prototype.hasOwnProperty.call(checks, 'antigravity')) {
    push('antigravity', 'antigravity-ide-source', antigravityDataPresent(os.homedir()));
    push('antigravity', 'antigravity-cli-data', dirExists(antigravityCliDataDir()));
  }
  for (const client of options.wslDetected || []) {
    if (Object.prototype.hasOwnProperty.call(checks, client)) push(client, 'wsl-home', true);
  }
  return checks;
}

// Decide visibility where `exists` is still the answer to a real stat(). The
// renderer temporarily marks cached sources pending during a re-probe, so
// filtering there would blink an existing optional root out of the panel.
// The unfiltered diagnostics remain available for the reveal handler; hiding
// a missing optional root here does not remove it from the health checks.
function visibleDiagnosticRoots(clientsCsv, options = {}) {
  return Object.fromEntries(Object.entries(clientDiagnosticRoots(clientsCsv, options)).map(([client, roots]) => [
    client,
    roots.filter((root) => !(root.optional === true && root.exists !== true))
  ]));
}

function clientDiagnosticRoots(clientsCsv, options = {}) {
  const byClient = evaluatedClientSourceRoots(clientsCsv, options);
  if (byClient.antigravity) {
    byClient.antigravity.unshift(
      ...antigravityDataRoots().map((dir) => ({ id: 'antigravity-ide-source', dir, exists: dirExists(dir) })),
      { id: 'antigravity-cli-data', dir: antigravityCliDataDir(), exists: dirExists(antigravityCliDataDir()) }
    );
  }
  return byClient;
}

module.exports = { clientDiagnosticRoots, clientSourceChecks, dirExists, visibleDiagnosticRoots };
