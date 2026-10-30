'use strict';

// Electron records the executable that was current when the startup entry was
// written, and compares the stored command line against process.execPath when it
// reads the setting back. Pass the path explicitly so an update that installs the
// next build into another directory cannot leave the entry on the previous one.
function loginItemSettingsFor(startAtLogin, execPath, enabled) {
  if (!startAtLogin) return { openAtLogin: false };
  const settings = { openAtLogin: true, path: execPath, args: [] };
  // A Run entry the user disabled from the Startup tab must stay disabled; Electron
  // clears that flag unless `enabled: false` is passed back with the write.
  if (enabled === false) settings.enabled = false;
  return settings;
}

// Reads a StartupApproved\Run listing. Windows writes 0x03 as the first byte when the
// user turned the entry off; 0x00/0x02 are documented as enabled (the remaining
// bytes are a timestamp). A readable key without our value means the
// user never touched it, so the entry counts as enabled. Anything else is reported as
// unknown, so the caller can leave the entry alone instead of clearing an opt-out it
// cannot see.
function startupApprovalState(regOutput, valueName) {
  const line = String(regOutput || '')
    .split(/\r?\n/)
    .find((entry) => entry.trim().split(/\s+/)[0] === valueName);
  if (!line) return 'enabled';
  const match = /REG_BINARY\s+([0-9a-fA-F]+)/.exec(line);
  if (!match || match[1].length < 2) return 'unknown';
  const state = parseInt(match[1].slice(0, 2), 16);
  if (state === 0x00 || state === 0x02) return 'enabled';
  if (state === 0x03) return 'disabled';
  // 0x01 (and anything else) has no documented meaning that both Windows and
  // Electron agree on, so it is reported as unknown rather than guessed.
  return 'unknown';
}

// A missing Run value and a value pointing at another executable both read as
// openAtLogin === false. When the stored preference says the app should start at
// login, either case means the entry has to be written again for this build.
function shouldRepinLoginItem({ startAtLogin, openAtLogin }) {
  return Boolean(startAtLogin) && !openAtLogin;
}

// electron-builder's portable launcher runs the app from a temporary extraction
// directory and removes it on exit, so process.execPath is not the file the user
// keeps. PORTABLE_EXECUTABLE_FILE points at the outer executable.
function loginItemExecutablePath(env, execPath) {
  const portable = env && env.PORTABLE_EXECUTABLE_FILE;
  return portable ? portable : execPath;
}

module.exports = { loginItemExecutablePath, loginItemSettingsFor, shouldRepinLoginItem, startupApprovalState };
