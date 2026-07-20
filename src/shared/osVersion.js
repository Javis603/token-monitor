'use strict';

const { execFileSync } = require('node:child_process');
const os = require('node:os');

const MAX_OS_VERSION_LENGTH = 128;

function normalizeOsVersion(value) {
  return String(value || '').trim().slice(0, MAX_OS_VERSION_LENGTH);
}

function detectOsVersion(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const getSystemVersion = options.getSystemVersion || (() => {
      return typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
    });
    try {
      const version = normalizeOsVersion(getSystemVersion());
      if (version) return version;
    } catch (_) {}

    const run = options.execFileSync || execFileSync;
    try {
      return normalizeOsVersion(run('/usr/bin/sw_vers', ['-productVersion'], {
        encoding: 'utf8',
        timeout: 1000,
        stdio: ['ignore', 'pipe', 'ignore']
      }));
    } catch (_) {
      return '';
    }
  }

  const release = options.release || os.release;
  try {
    return normalizeOsVersion(release());
  } catch (_) {
    return '';
  }
}

let cachedHostOsVersion;

function hostOsVersion() {
  if (cachedHostOsVersion === undefined) cachedHostOsVersion = detectOsVersion();
  return cachedHostOsVersion;
}

module.exports = { detectOsVersion, hostOsVersion, normalizeOsVersion };
