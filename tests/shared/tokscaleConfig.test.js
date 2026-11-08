'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { tokscaleConfigDir, tokscaleHomeDir, customPricingPath } = require('../../src/shared/tokscaleConfig');

test('TOKSCALE_CONFIG_DIR override wins verbatim on every platform', () => {
  for (const platform of ['darwin', 'win32', 'linux']) {
    assert.equal(
      tokscaleConfigDir({ platform, homeDir: '/home/u', env: { TOKSCALE_CONFIG_DIR: '/tmp/iso' } }),
      '/tmp/iso'
    );
  }
});

test('empty TOKSCALE_CONFIG_DIR is treated as unset', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'darwin', homeDir: '/Users/u', env: { TOKSCALE_CONFIG_DIR: '' } }),
    path.join('/Users/u', '.config', 'tokscale')
  );
});

test('macOS forces $HOME/.config/tokscale', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'darwin', homeDir: '/Users/u', env: {} }),
    path.join('/Users/u', '.config', 'tokscale')
  );
});

test('Windows uses APPDATA only when the native folder is unavailable', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'win32', windowsFolders: {}, homeDir: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'tokscale')
  );
});

test('Windows falls back to <home>/AppData/Roaming when APPDATA unset', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'win32', windowsFolders: {}, homeDir: 'C:\\Users\\u', env: {} }),
    path.join('C:\\Users\\u', 'AppData', 'Roaming', 'tokscale')
  );
});

test('Windows prefers an absolute native HOME over the profile', () => {
  assert.equal(
    tokscaleHomeDir({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { HOME: 'D:\\sandbox\\home' } }),
    'D:\\sandbox\\home'
  );
});

test('Windows ignores POSIX-shaped and drive-relative HOME overrides', () => {
  for (const home of ['/home/u', 'C:relative']) {
    assert.equal(
      tokscaleHomeDir({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { HOME: home } }),
      'C:\\Users\\u'
    );
  }
});

test('Linux honors absolute XDG_CONFIG_HOME', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'linux', homeDir: '/home/u', env: { XDG_CONFIG_HOME: '/xdg' } }),
    path.join('/xdg', 'tokscale')
  );
});

test('Linux ignores relative XDG_CONFIG_HOME and uses $HOME/.config', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'linux', homeDir: '/home/u', env: { XDG_CONFIG_HOME: 'relative/dir' } }),
    path.join('/home/u', '.config', 'tokscale')
  );
});

test('customPricingPath appends the filename', () => {
  assert.equal(
    customPricingPath({ platform: 'darwin', homeDir: '/Users/u', env: {} }),
    path.join('/Users/u', '.config', 'tokscale', 'custom-pricing.json')
  );
});

// Tokscale uses dirs::config_dir(), which resolves the native roaming folder
// on Windows independently of APPDATA or redirected HOME.
test('Windows native roaming folder wins over APPDATA and HOME', () => {
  const options = {
    platform: 'win32', homeDir: 'C:\\Users\\u',
    windowsFolders: { roaming: 'D:\\Roaming' },
    env: { APPDATA: 'Z:\\wrong', HOME: 'Z:\\other' }
  };
  assert.equal(tokscaleConfigDir(options), path.join('D:\\Roaming', 'tokscale'));
  assert.equal(customPricingPath(options), path.join('D:\\Roaming', 'tokscale', 'custom-pricing.json'));
  assert.equal(tokscaleConfigDir({ ...options, env: { ...options.env, TOKSCALE_CONFIG_DIR: 'Z:\\explicit' } }), 'Z:\\explicit');
});

test('native Windows config ignores an independent APPDATA override', { skip: process.platform !== 'win32' }, () => {
  const { readWindowsFolders } = require('../../src/shared/providers/catpaw/paths');
  const native = readWindowsFolders();
  assert.ok(path.win32.isAbsolute(native.roaming));
  assert.equal(tokscaleConfigDir({ env: { APPDATA: 'Z:\\tm-wrong-roaming' } }), path.join(native.roaming, 'tokscale'));
});
