'use strict';

const os = require('node:os');
const path = require('node:path');

function cursorDesktopStateCandidates({ home = os.homedir(), platform = process.platform, env = process.env } = {}) {
  if (platform === 'darwin') {
    return [path.join(home, 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
  }
  if (platform === 'win32') {
    const candidates = [];
    const appData = String(env?.APPDATA || '').trim();
    if (appData) candidates.push(path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    candidates.push(path.join(home, 'AppData', 'Roaming', 'Cursor', 'User', 'globalStorage', 'state.vscdb'));
    return [...new Set(candidates)];
  }
  return [path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
}

// Watch the parent, not just today's database inode: SQLite can replace the
// database or create its WAL after the watcher starts. The collector prunes this
// directory to state.vscdb and state.vscdb-wal; the read-created SHM is not input.
function cursorDesktopWatchRoots(options = {}) {
  return [...new Set(cursorDesktopStateCandidates({
    home: options.homeDir || os.homedir(),
    platform: options.platform || process.platform,
    env: options.env || process.env
  }).map((file) => path.dirname(file)))];
}

function isCursorDesktopStateWrite(filePath) {
  const name = path.basename(String(filePath || ''));
  return name === 'state.vscdb' || name === 'state.vscdb-wal';
}

module.exports = { cursorDesktopStateCandidates, cursorDesktopWatchRoots, isCursorDesktopStateWrite };
