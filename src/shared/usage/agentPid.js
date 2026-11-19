'use strict';

const fs = require('node:fs');

// Whether a headless agent other than this process is running. The PID file is
// the agent's claim; a stale file (process gone) or one naming this process does
// not count. Kept out of config.js, which is part of the Hub build.
function externalAgentActive(pidPath) {
  try {
    const pid = parseInt(fs.readFileSync(pidPath, 'utf8').trim(), 10);
    if (!pid || pid === process.pid) return false;
    process.kill(pid, 0);
    return true;
  } catch (_) { return false; }
}

module.exports = {
  externalAgentActive
};
