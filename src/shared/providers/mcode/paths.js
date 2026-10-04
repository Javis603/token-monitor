'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

// MiniMax Code (CLI and desktop app) writes every Session through its shared
// local runtime to `<data-dir>/v2/sessions/<yyyy>/<mm>/<dd>/<dir>/`. Token
// Monitor's tokscale fork reads that history as a supplement to upstream's
// `mcode` client (crates/tokscale-core/src/token_monitor/mcode.rs), and this
// mirrors the data directories it reads: a non-empty MINIMAX_DATA_DIR, else
// MAVIS_DATA_DIR, is the only one, as it is for MiniMax Code itself; otherwise
// `.minimax`, the earlier `.mavis`, and each `-<profile>` variant of either.
const MCODE_SOURCE_CHECK_ID = 'mcode-sessions';
const ENV_OVERRIDES = ['MINIMAX_DATA_DIR', 'MAVIS_DATA_DIR'];
const DATA_DIR_BASENAMES = ['.minimax', '.mavis'];

function isMcodeProfileDir(name) {
  return DATA_DIR_BASENAMES.some((base) => name.startsWith(`${base}-`) && name.length > base.length + 1);
}

function mcodeDataDirs({ env = process.env, homeDir = os.homedir() } = {}) {
  for (const name of ENV_OVERRIDES) {
    const value = typeof env[name] === 'string' ? env[name].trim() : '';
    if (value) return [value];
  }
  // A profile is matched by name, links included, as the fork does; a name that
  // is not a data directory simply has no sessions to watch.
  let profiles;
  try {
    profiles = fs.readdirSync(homeDir, { withFileTypes: true })
      .filter((entry) => (entry.isDirectory() || entry.isSymbolicLink()) && isMcodeProfileDir(entry.name))
      .map((entry) => entry.name)
      .sort();
  } catch (_) {
    profiles = [];
  }
  // `.mavis` is often a link to `.minimax`; keep the first spelling of a store.
  const seen = new Set();
  return [...DATA_DIR_BASENAMES, ...profiles]
    .map((name) => path.join(homeDir, name))
    .filter((dir) => {
      let key = dir;
      try { key = fs.realpathSync.native(dir); } catch (_) {}
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
}

function mcodeSessionDirs(options = {}) {
  return mcodeDataDirs(options).map((dir) => path.join(dir, 'v2', 'sessions'));
}

module.exports = {
  MCODE_SOURCE_CHECK_ID,
  isMcodeProfileDir,
  mcodeDataDirs,
  mcodeSessionDirs
};
