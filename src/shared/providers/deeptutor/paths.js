'use strict';

const path = require('node:path');

// DeepTutor's default home is its launch directory. Never guess it from Token
// Monitor's cwd or scan projects/accounts. Both partitions use one exact ledger.
function deeptutorDatabasePath({ env = process.env, platform = process.platform } = {}) {
  const mod = platform === 'win32' ? path.win32 : path.posix;
  const absolute = value => mod.isAbsolute(value)
    && (platform !== 'win32' || mod.parse(value).root.length > 1);
  const explicit = String(env.TOKEN_MONITOR_DEEPTUTOR_DB_PATH || '').trim();
  if (explicit) return absolute(explicit) ? mod.normalize(explicit) : '';
  const home = String(env.DEEPTUTOR_HOME || '').trim();
  return home && absolute(home) ? mod.join(home, 'data', 'user', 'usage.sqlite3') : '';
}

const DEEPTUTOR_CLIENTS = Object.freeze(['deeptutor', 'deeptutor-estimated']);

function deeptutorSourceFingerprint(clientsCsv, options = {}) {
  const selected = String(clientsCsv || '').split(',');
  if (!DEEPTUTOR_CLIENTS.some(id => selected.includes(id))) return '';
  return deeptutorDatabasePath(options);
}

module.exports = { DEEPTUTOR_CLIENTS, deeptutorDatabasePath, deeptutorSourceFingerprint };
