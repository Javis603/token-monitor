'use strict';

const semver = require('semver');

function resolveElectronVersionOverride(env = process.env) {
  const value = String(env.TOKEN_MONITOR_LINUX_ELECTRON_VERSION || '').trim();
  if (!value) return undefined;
  const target = String(env.TOKEN_MONITOR_ELECTRON_TARGET || '').trim();
  if (target !== 'linux') {
    throw new Error('TOKEN_MONITOR_LINUX_ELECTRON_VERSION is only valid for a Linux build');
  }
  if (!semver.valid(value)) {
    throw new Error(`TOKEN_MONITOR_LINUX_ELECTRON_VERSION must be an exact semver version: ${value}`);
  }
  return value;
}

module.exports = {
  resolveElectronVersionOverride
};
