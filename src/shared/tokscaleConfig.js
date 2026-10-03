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

// Mirror tokscale-core home_dir(): on Windows an absolute $HOME wins over the
// user profile, everywhere else the profile is the home. Home-rooted tokscale
// paths must resolve through here rather than os.homedir() directly, or the
// redirect holds for some roots and not others.
function tokscaleHomeDir(options = {}) {
  const env = options.env || process.env;
  const platform = options.platform || process.platform;
  const profileHome = profileHomeDir(options.homeDir);
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

function customPricingPath(opts) {
  return path.join(tokscaleConfigDir(opts), 'custom-pricing.json');
}

module.exports = { tokscaleConfigDir, tokscaleHomeDir, customPricingPath };
