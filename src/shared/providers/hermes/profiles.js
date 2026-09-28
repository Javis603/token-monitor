'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

function resolveHermesHome({ env = process.env, homeDir, platform = process.platform, existsSync = fs.existsSync } = {}) {
  const home = homeDir || os.homedir();
  const fromEnv = String(env.HERMES_HOME || '').trim();
  if (fromEnv) return fromEnv;

  const dotHermes = path.join(home, '.hermes');
  if (existsSync(path.join(dotHermes, 'state.db'))) return dotHermes;

  // Windows native installs often land in %LOCALAPPDATA%\hermes instead of
  // ~/.hermes. Prefer the real LOCALAPPDATA, falling back to the active home
  // dir so mocked homedirs in tests do not leak the developer machine's AppData.
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA || path.join(home, 'AppData', 'Local');
    const winNative = path.join(localAppData, 'hermes');
    if (existsSync(path.join(winNative, 'state.db'))) return winNative;
  }

  return dotHermes;
}

function discoverHermesProfileScanPaths(hermesHome, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const root = String(hermesHome || '').trim();
  if (!root) return [];

  const profilesDir = path.join(root, 'profiles');
  if (!existsSync(profilesDir)) return [];

  const paths = [];
  let entries;
  try {
    entries = readdirSync(profilesDir, { withFileTypes: true });
  } catch (_) {
    return [];
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profileDir = path.join(profilesDir, entry.name);
    if (existsSync(path.join(profileDir, 'state.db'))) paths.push(profileDir);
  }

  return paths.sort((a, b) => a.localeCompare(b));
}

function hermesProfileWatchDirs(hermesHome, deps = {}) {
  return discoverHermesProfileScanPaths(hermesHome, deps);
}

module.exports = {
  discoverHermesProfileScanPaths,
  hermesProfileWatchDirs,
  resolveHermesHome
};
