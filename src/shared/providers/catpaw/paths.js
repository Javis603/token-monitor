'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');
const { readWindowsFolders, nativeWindowsFolders } = require('../../windowsKnownFolders');

// Token Monitor never reads usage here (the fork does); these paths drive watching, health, and the anchor fingerprint.
function catpawDatabaseName(name) {
  const scope = /^catpaw-memory-([A-Za-z0-9_-]+)\.db$/.exec(name)?.[1];
  return Boolean(scope && scope !== 'anon');
}

function sameWindowsDirectory(a, b) {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); }
  catch (_) {
    const components = (value) => {
      const root = path.win32.parse(value).root;
      const prefix = root.replaceAll('/', '\\').replace(/^[a-z]:/i, drive => drive.toUpperCase());
      const parts = value.slice(root.length).split(/[\\/]/).filter(part => part && part !== '.');
      return JSON.stringify([prefix, ...parts]);
    };
    return components(a) === components(b);
  }
}

function catpawDataSources(options = {}) {
  const platform = options.platform || process.platform;
  if (platform !== 'darwin' && platform !== 'win32') return { roots: [], dbPaths: [] };
  const env = options.env || process.env;
  const native = platform === 'win32' && options.useEnvRoots !== false
    ? options.windowsFolders || nativeWindowsFolders() : {};
  const profile = native.profile || os.homedir();
  const requestedHome = options.homeDir || profile;
  const home = options.useEnvRoots === false
    ? requestedHome : tokscaleHomeDir({ ...options, homeDir: requestedHome, env, platform });
  // Windows default matches the fork's reader: native roaming folder, ignoring APPDATA; an explicit or redirected home wins, so watched paths equal read paths.
  const roaming = options.useEnvRoots !== false && sameWindowsDirectory(home, profile)
    && native.roaming ? native.roaming : path.join(home, 'AppData', 'Roaming');
  const support = platform === 'darwin'
    ? path.join(home, 'Library', 'Application Support') : roaming;
  const roots = ['catpaw-moon', 'catpaw-overseas'].map((edition) => path.join(support, edition));
  const dbPaths = roots.flatMap((root) => {
    try {
      return fs.readdirSync(root).filter(catpawDatabaseName).map((name) => path.join(root, name));
    } catch (_) { return []; }
  }).sort();
  return { roots, dbPaths };
}

function catpawSourcesFingerprint(clientsCsv, options = {}) {
  if (!String(clientsCsv || '').split(',').includes('catpaw')) return '';
  return JSON.stringify(catpawDataSources(options));
}

module.exports = { catpawDatabaseName, catpawDataSources, catpawSourcesFingerprint, readWindowsFolders, nativeWindowsFolders };
