// @ts-check
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { t3HomeDir } = require('../../t3/sessionMetadata');

const ANTIGRAVITY_ACP_SOURCE_ID = 't3-antigravity-acp';

/** @param {{ homeDir?: string, env?: NodeJS.ProcessEnv }} [options] */
function discoverAntigravityAcpPaths(options = {}) {
  const profilesDir = path.join(t3HomeDir(options), 'userdata', 'providers', 'antigravity');
  const paths = [];
  const seen = new Set();
  try {
    for (const profile of fs.readdirSync(profilesDir).sort()) {
      const dir = path.join(profilesDir, profile, 'antigravity-acp', 'conversations');
      // Tokscale's extra-dir argument uses unescaped comma-separated paths.
      if (dir.includes(',') || /[\r\n]/.test(dir)) continue;
      try {
        if (!fs.statSync(dir).isDirectory()) continue;
        const canonical = fs.realpathSync(dir);
        if (!seen.has(canonical)) paths.push(dir);
        seen.add(canonical);
      } catch (_) {
        // A profile can disappear or be inaccessible while T3 is running.
      }
    }
  } catch (_) {
    // T3 Code or its Antigravity provider may never have been used here.
  }
  return paths;
}

module.exports = { ANTIGRAVITY_ACP_SOURCE_ID, discoverAntigravityAcpPaths };
