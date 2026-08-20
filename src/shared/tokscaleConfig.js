'use strict';

const os = require('node:os');
const path = require('node:path');

// Mirror tokscale-core get_config_dir() (tmp/tokscale/crates/tokscale-core/src/paths.rs)
// so the file we write is the exact file the spawned tokscale reads — on every
// OS and whether we run via `npm start` (dev) or the packaged app. We read the
// same process.env the collector passes to the spawned binary, so TOKSCALE_CONFIG_DIR
// and the per-OS rules stay in lockstep.
function windowsNativeAbsolutePath(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  return /^[A-Za-z]:[\\/]/.test(raw) || /^[\\/]{2}[^\\/]+[\\/][^\\/]+/.test(raw);
}

function profileHomeDir(homeDir) {
  return typeof homeDir === 'string' && homeDir.length > 0 ? homeDir : os.homedir();
}

function tokscaleHomeDir({ env, platform, profileHome }) {
  if (platform === 'win32' && windowsNativeAbsolutePath(env.HOME)) return env.HOME.trim();
  return profileHome;
}

function tokscaleConfigDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const homeDir = profileHomeDir(options.homeDir);
  const override = env.TOKSCALE_CONFIG_DIR;
  if (typeof override === 'string' && override.length > 0) return override;

  if (platform === 'darwin') return path.join(homeDir, '.config', 'tokscale');

  if (platform === 'win32') {
    const appData = (typeof env.APPDATA === 'string' && env.APPDATA.length > 0)
      ? env.APPDATA
      : path.join(homeDir, 'AppData', 'Roaming');
    return path.join(appData, 'tokscale');
  }

  // Linux + other: dirs::config_dir() = absolute XDG_CONFIG_HOME, else $HOME/.config
  const xdg = env.XDG_CONFIG_HOME;
  const configHome = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(homeDir, '.config');
  return path.join(configHome, 'tokscale');
}

// Mirror tokscale-core's canonical cache root plus its two pre-#470 legacy
// fallbacks. An explicit TOKSCALE_CONFIG_DIR is hermetic upstream, so it must
// never reach back into a real profile's legacy cache.
function tokscaleCacheDirs(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const profileHome = profileHomeDir(options.homeDir);
  const tokscaleHome = tokscaleHomeDir({ env, platform, profileHome });
  const canonical = path.join(tokscaleConfigDir({ env, platform, homeDir: profileHome }), 'cache');
  const override = env.TOKSCALE_CONFIG_DIR;
  if (typeof override === 'string' && override.length > 0) return [canonical];

  let platformCache;
  if (platform === 'darwin') {
    platformCache = path.join(profileHome, 'Library', 'Caches', 'tokscale');
  } else if (platform === 'win32') {
    const localAppData = (typeof env.LOCALAPPDATA === 'string' && env.LOCALAPPDATA.length > 0)
      ? env.LOCALAPPDATA
      : path.join(profileHome, 'AppData', 'Local');
    platformCache = path.join(localAppData, 'tokscale');
  } else {
    const xdg = env.XDG_CACHE_HOME;
    const cacheHome = (typeof xdg === 'string' && path.isAbsolute(xdg)) ? xdg : path.join(profileHome, '.cache');
    platformCache = path.join(cacheHome, 'tokscale');
  }

  return [...new Set([
    canonical,
    platformCache,
    path.join(tokscaleHome, '.cache', 'tokscale')
  ])];
}

function customPricingPath(opts) {
  return path.join(tokscaleConfigDir(opts), 'custom-pricing.json');
}

module.exports = { tokscaleCacheDirs, tokscaleConfigDir, customPricingPath };
