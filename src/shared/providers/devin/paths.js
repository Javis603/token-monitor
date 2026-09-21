'use strict';

// Devin (Cognition) data roots, mirroring the upstream tokscale scanners
// (clients.rs + scanner.rs `devin_*_additional_roots`):
//
//   devin-cli      PathRoot::XdgData, relative "devin/cli/sessions.db" —
//                  $XDG_DATA_HOME/devin/cli (fallback ~/.local/share) on every
//                  platform — plus `devin_cli_additional_roots`: %APPDATA%/
//                  devin/cli when Windows env roots apply, and the
//                  unconditional home-relative AppData/Roaming/devin/cli.
//   devin-desktop  PathRoot::Home, relative "Library/Application Support/
//                  Devin/User/acp-events" — plus
//                  `devin_desktop_additional_roots`: ~/.config/Devin/... and
//                  ~/.config/devin/... (both casings), %APPDATA%/Devin/... on
//                  Windows, and the unconditional home-relative
//                  AppData/Roaming/Devin/User/acp-events.
//
// Kept free of Node built-ins so it stays vendorable like the other
// providers/*/paths.js modules.
const DEVIN_CLIENT = 'devin';
const DEVIN_CLI_SOURCE_CHECK_ID = 'devin-cli-db';
const DEVIN_DESKTOP_SOURCE_CHECK_ID = 'devin-desktop-acp';

function nonEmpty(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

function joinPath(platform, root, ...parts) {
  const separator = platform === 'win32' ? '\\' : '/';
  // Only Windows treats '\' as a separator; on POSIX it is a valid filename
  // character, so stripping it there would corrupt a HOME ending in one.
  const trailing = platform === 'win32' ? /[\\/]+$/ : /\/+$/;
  const leading = platform === 'win32' ? /^[\\/]+/ : /^\/+/;
  let current = nonEmpty(root);
  for (const part of parts) {
    const next = nonEmpty(part);
    if (!next) continue;
    current = current
      ? `${current.replace(trailing, '')}${separator}${next.replace(leading, '')}`
      : next;
  }
  return current;
}

// Mirror tokscaleHomeDir(): on Windows an absolute $HOME wins over the
// profile home, everywhere else the profile is the home. Callers pass the
// collector's effective home as homeDir, so this mainly matters when the
// module is driven with only env/homeDir inputs (tests, scoped lookups).
function windowsNativeAbsolutePath(value) {
  const raw = nonEmpty(value);
  return /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(raw);
}

function homeDirFor({ env = {}, homeDir = '', platform = '' } = {}) {
  const profile = nonEmpty(homeDir)
    || (platform === 'win32' ? nonEmpty(env.USERPROFILE) : '')
    || nonEmpty(env.HOME)
    || (platform === 'win32' ? joinPath(platform, env.HOMEDRIVE, env.HOMEPATH) : '');
  if (platform === 'win32' && windowsNativeAbsolutePath(env.HOME)) return nonEmpty(env.HOME);
  return profile;
}

// PathRoot::XdgData resolves through $XDG_DATA_HOME with a ~/.local/share
// fallback on every platform (tokscale does not consult the platform data dir
// for this root), so no macOS Application Support arm belongs here.
function devinCliDbDirs(options = {}) {
  const platform = options.platform || '';
  const env = options.env || {};
  const home = homeDirFor(options);
  const xdgData = nonEmpty(env.XDG_DATA_HOME) || joinPath(platform, home, '.local', 'share');
  const dirs = [joinPath(platform, xdgData, 'devin', 'cli')];
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA);
    if (appData) dirs.push(joinPath(platform, appData, 'devin', 'cli'));
  }
  dirs.push(joinPath(platform, home, 'AppData', 'Roaming', 'devin', 'cli'));
  return [...new Set(dirs)];
}

function devinCliDbPaths(options = {}) {
  return devinCliDbDirs(options).map((dir) => joinPath(options.platform || '', dir, 'sessions.db'));
}

function devinDesktopAcpDirs(options = {}) {
  const platform = options.platform || '';
  const env = options.env || {};
  const home = homeDirFor(options);
  const dirs = [
    joinPath(platform, home, 'Library', 'Application Support', 'Devin', 'User', 'acp-events'),
    joinPath(platform, home, '.config', 'Devin', 'User', 'acp-events'),
    joinPath(platform, home, '.config', 'devin', 'User', 'acp-events')
  ];
  if (platform === 'win32') {
    const appData = nonEmpty(env.APPDATA);
    if (appData) dirs.push(joinPath(platform, appData, 'Devin', 'User', 'acp-events'));
  }
  dirs.push(joinPath(platform, home, 'AppData', 'Roaming', 'Devin', 'User', 'acp-events'));
  return [...new Set(dirs)];
}

module.exports = {
  DEVIN_CLIENT,
  DEVIN_CLI_SOURCE_CHECK_ID,
  DEVIN_DESKTOP_SOURCE_CHECK_ID,
  devinCliDbDirs,
  devinCliDbPaths,
  devinDesktopAcpDirs
};
