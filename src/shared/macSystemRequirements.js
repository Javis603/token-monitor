'use strict';

const semver = require('semver');

// electron-builder writes the marketing version into LSMinimumSystemVersion,
// while electron-updater compares update metadata against Darwin's os.release().
const MAC_APP_MIN_VERSION = '12.0';
const MAC_APP_MIN_DARWIN_VERSION = '21.0.0';
const MAC_WIDGET_MIN_VERSION = '14.0';
const MAC_WIDGET_MIN_DARWIN_VERSION = '23.0.0';

function macWidgetRuntimeSupport({ platform = process.platform, osRelease = '' } = {}) {
  if (platform !== 'darwin') {
    return { supported: false, reason: 'unsupported-platform' };
  }
  const current = semver.valid(String(osRelease || '').trim());
  if (!current || semver.lt(current, MAC_WIDGET_MIN_DARWIN_VERSION)) {
    return { supported: false, reason: 'unsupported-os' };
  }
  return { supported: true, reason: null };
}

module.exports = {
  MAC_APP_MIN_DARWIN_VERSION,
  MAC_APP_MIN_VERSION,
  MAC_WIDGET_MIN_DARWIN_VERSION,
  MAC_WIDGET_MIN_VERSION,
  macWidgetRuntimeSupport
};
