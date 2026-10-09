'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { tokscaleHomeDir } = require('../../tokscaleConfig');

// These are source paths for watching/health only. The fork owns all usage reads.
function catpawDatabaseName(name) {
  const scope = /^catpaw-memory-([A-Za-z0-9_-]+)\.db$/.exec(name)?.[1];
  return Boolean(scope && scope !== 'anon');
}

function sameWindowsDirectory(a, b) {
  try { return fs.realpathSync.native(a) === fs.realpathSync.native(b); }
  catch (_) {
    // Match Rust Path components: keep directory case and unresolved `..`.
    const components = (value) => {
      const root = path.win32.parse(value).root;
      const prefix = root.replaceAll('/', '\\').replace(/^[a-z]:/i, drive => drive.toUpperCase());
      const parts = value.slice(root.length).split(/[\\/]/).filter(part => part && part !== '.');
      return JSON.stringify([prefix, ...parts]);
    };
    return components(a) === components(b);
  }
}

let windowsFolders;

function readWindowsFolders(koffi = require('koffi')) {
  const shell = koffi.load('shell32.dll');
  const ole = koffi.load('ole32.dll');
  const getPath = shell.func('int32_t __stdcall SHGetKnownFolderPath(const void *id, uint32_t flags, void *token, _Out_ void **result)');
  const free = ole.func('void __stdcall CoTaskMemFree(void *pointer)');
  const initialize = ole.func('int32_t __stdcall CoInitializeEx(void *reserved, uint32_t flags)');
  const uninitialize = ole.func('void __stdcall CoUninitialize()');
  const initialized = initialize(null, 2);
  try {
    const folder = (guid) => {
      const out = [null];
      try {
        return getPath(Buffer.from(guid, 'hex'), 0, null, out) === 0 && out[0]
          ? koffi.decode(out[0], 'char16_t', -1) : null;
      } finally { if (out[0]) free(out[0]); }
    };
    // Win32 GUID bytes (the first three fields are little-endian).
    return {
      profile: folder('8f856c5e220e60479afeea3317b67173'), // FOLDERID_Profile
      roaming: folder('db85b63ef965f64ca03ae3ef65729f3d') // FOLDERID_RoamingAppData
    };
  } finally { if (initialized >= 0) uninitialize(); }
}

function nativeWindowsFolders() {
  if (process.platform !== 'win32') return {};
  if (windowsFolders === undefined) {
    try { windowsFolders = readWindowsFolders(); }
    catch (_) { windowsFolders = {}; }
  }
  return windowsFolders;
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
  // PathRoot::AppData follows an explicit/redirected home instead of the host
  // roaming profile. The native known folder is unaffected by env.APPDATA.
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

module.exports = { catpawDatabaseName, catpawDataSources, catpawSourcesFingerprint, readWindowsFolders };
