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
    return candidates;
  }
  return [path.join(home, '.config', 'Cursor', 'User', 'globalStorage', 'state.vscdb')];
}

module.exports = { cursorDesktopStateCandidates };
