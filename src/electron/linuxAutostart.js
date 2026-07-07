'use strict';

// Linux "start at login" for AppImage builds. Electron's app.setLoginItemSettings
// is a no-op on Linux, so we manage an XDG autostart entry ourselves:
// ~/.config/autostart/token-monitor.desktop pointing Exec= at $APPIMAGE
// (the absolute path the AppImage runtime exports for the running image).

const fs = require('fs');
const os = require('os');
const path = require('path');

const DESKTOP_FILE_NAME = 'token-monitor.desktop';

function autostartSupported({ platform = process.platform, env = process.env } = {}) {
  return platform === 'linux' && Boolean(env.APPIMAGE);
}

function desktopFilePath({ env = process.env } = {}) {
  const configHome = env.XDG_CONFIG_HOME || path.join(env.HOME || os.homedir(), '.config');
  return path.join(configHome, 'autostart', DESKTOP_FILE_NAME);
}

// Desktop Entry spec quoting: the Exec argument is double-quoted with `"`, `` ` ``,
// `$` and `\` backslash-escaped, then the string-value layer doubles every backslash.
function quoteExecArgument(value) {
  const quoted = String(value).replace(/[\\"`$]/g, (char) => `\\${char}`);
  return `"${quoted.replace(/\\/g, '\\\\')}"`;
}

function desktopFileContents(appImagePath) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Name=Token Monitor',
    `Exec=${quoteExecArgument(appImagePath)}`,
    'X-GNOME-Autostart-enabled=true',
    ''
  ].join('\n');
}

function isAutostartEnabled(options) {
  try { return fs.existsSync(desktopFilePath(options)); }
  catch (_) { return false; }
}

function setAutostartEnabled(enabled, options = {}) {
  const env = options.env || process.env;
  const filePath = desktopFilePath({ env });
  try {
    if (enabled) {
      if (!env.APPIMAGE) return false;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, desktopFileContents(env.APPIMAGE), 'utf8');
    } else {
      fs.rmSync(filePath, { force: true });
    }
  } catch (_) { /* fall through to report the actual on-disk state */ }
  return isAutostartEnabled({ env });
}

module.exports = {
  autostartSupported,
  desktopFilePath,
  desktopFileContents,
  isAutostartEnabled,
  setAutostartEnabled
};
