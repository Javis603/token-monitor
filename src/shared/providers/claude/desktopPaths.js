'use strict';

// Claude Desktop (Anthropic's Electron app) userData roots. Read-only
// discovery for the local plan-usage history and the Desktop session index;
// nothing here opens a network connection, reads a credential or touches the
// running app.
//
// The app picks its userData directory per platform and per build:
// - macOS: ~/Library/Application Support/Claude
// - Linux: $XDG_CONFIG_HOME/Claude (default ~/.config/Claude)
// - Windows: %APPDATA%\Claude for the Squirrel build, but the MSIX package
//   that Anthropic's download now ships is filesystem-virtualised, so its real
//   directory is %LOCALAPPDATA%\Packages\<family>\LocalCache\Roaming\Claude and
//   %APPDATA%\Claude does not exist at all. Newer builds may also use
//   %LOCALAPPDATA%\Claude-Data[\<family>].
// - The enterprise / third-party-inference build appends `-3p` to the
//   directory name. It is never billed against a claude.ai subscription, so
//   every root carries a `variant` and callers decide what a 3p root means.
// `CLAUDE_USER_DATA_DIR` is the app's own override; TOKEN_MONITOR_CLAUDE_DESKTOP_DIR
// lets a user point Token Monitor at a copy or a non-standard install.
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const MSIX_PACKAGE_FAMILIES = Object.freeze(['Claude_pzs8sxrjxfjjc', 'AnthropicPBC.Claude_fnn82j28hfe8t']);
const APP_DIR_NAMES = Object.freeze(['Claude', 'Claude-3p']);

function nonBlank(value) {
  const text = String(value ?? '').trim();
  return text || '';
}

// A drive-letter or UNC path is a Windows filesystem path whatever platform
// layout is being resolved (tests simulate macOS/Linux layouts inside a real
// Windows temp dir); joining it with path.posix would produce a path that
// never exists.
function isWindowsAbsolutePath(value) {
  return /^(?:[A-Za-z]:[\\/]|\\\\)/.test(String(value || ''));
}

function pathApiFor(platform, homeDir) {
  if (platform === 'win32' || isWindowsAbsolutePath(homeDir)) return path.win32;
  return path.posix;
}

function variantForDir(dir) {
  return /-3p$/i.test(path.basename(String(dir || '').replace(/[\\/]+$/, ''))) ? '3p' : '1p';
}

function splitPathList(value, platform) {
  const delimiter = platform === 'win32' ? ';' : ':';
  return String(value || '').split(delimiter).map((entry) => entry.trim()).filter(Boolean);
}

// Every candidate in priority order, existing or not; `exists` filtering is the
// caller's job so tests can pin the list without a filesystem.
function claudeDesktopUserDataCandidates(options = {}) {
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const homeDir = options.homeDir || os.homedir();
  const p = pathApiFor(platform, homeDir);
  const out = [];
  const add = (dir, source) => {
    if (!dir) return;
    const resolved = p.resolve(dir);
    if (out.some((entry) => entry.dir === resolved)) return;
    out.push({ dir: resolved, variant: variantForDir(resolved), source });
  };
  for (const dir of splitPathList(env.TOKEN_MONITOR_CLAUDE_DESKTOP_DIR, platform)) add(dir, 'override');
  add(nonBlank(env.CLAUDE_USER_DATA_DIR), 'app-override');
  if (options.explicitOnly === true) return out;
  if (platform === 'darwin') {
    for (const name of APP_DIR_NAMES) add(p.join(homeDir, 'Library', 'Application Support', name), 'default');
  } else if (platform === 'win32') {
    const appData = nonBlank(env.APPDATA) || p.join(homeDir, 'AppData', 'Roaming');
    const localAppData = nonBlank(env.LOCALAPPDATA) || p.join(homeDir, 'AppData', 'Local');
    for (const name of APP_DIR_NAMES) add(p.join(appData, name), 'default');
    for (const family of MSIX_PACKAGE_FAMILIES) {
      for (const name of APP_DIR_NAMES) add(p.join(localAppData, 'Packages', family, 'LocalCache', 'Roaming', name), 'msix');
    }
    add(p.join(localAppData, 'Claude-Data'), 'local');
    for (const family of MSIX_PACKAGE_FAMILIES) add(p.join(localAppData, 'Claude-Data', family), 'local');
    add(p.join(localAppData, 'Claude-3p'), 'local');
  } else {
    const configHome = nonBlank(env.XDG_CONFIG_HOME) || p.join(homeDir, '.config');
    for (const name of APP_DIR_NAMES) add(p.join(configHome, name), 'default');
  }
  return out;
}

function dirExists(dir, fsApi) {
  try { return fsApi.statSync(dir).isDirectory(); } catch (_) { return false; }
}

function claudeDesktopUserDataRoots(options = {}) {
  const fsApi = options.fs || fs;
  return claudeDesktopUserDataCandidates(options).filter((entry) => dirExists(entry.dir, fsApi));
}

module.exports = {
  APP_DIR_NAMES,
  MSIX_PACKAGE_FAMILIES,
  claudeDesktopUserDataCandidates,
  claudeDesktopUserDataRoots,
  variantForDir
};
