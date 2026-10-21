'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function claudeProbeDir(deps = {}) {
  return deps.claudeProbeDir || path.join(os.tmpdir(), 'token-monitor-claude-probe');
}

function canonicalPath(dir) {
  try { return fs.realpathSync(dir); }
  catch (_) { return path.resolve(dir); } // The probe may not have run yet.
}

function isClaudeProbeCwd(cwd, probeDir = claudeProbeDir()) {
  if (typeof cwd !== 'string' || !cwd) return false;
  // macOS registry paths use /private/var while os.tmpdir() can use /var.
  return canonicalPath(cwd) === canonicalPath(probeDir);
}

module.exports = { claudeProbeDir, isClaudeProbeCwd };
