'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const path = require('node:path');

const { tokscaleCacheDirs, tokscaleConfigDir, customPricingPath } = require('../../src/shared/tokscaleConfig');

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

test('Windows uses %APPDATA%\\tokscale (Roaming), not .config', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' } }),
    path.join('C:\\Users\\u\\AppData\\Roaming', 'tokscale')
  );
});

test('Windows falls back to <home>/AppData/Roaming when APPDATA unset', () => {
  assert.equal(
    tokscaleConfigDir({ platform: 'win32', homeDir: 'C:\\Users\\u', env: {} }),
    path.join('C:\\Users\\u', 'AppData', 'Roaming', 'tokscale')
  );
});

test('Windows native HOME redirects only the home-rooted legacy cache', () => {
  assert.deepEqual(
    tokscaleCacheDirs({
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      env: { HOME: 'D:\\sandbox\\home' }
    }),
    [
      path.join('C:\\Users\\u', 'AppData', 'Roaming', 'tokscale', 'cache'),
      path.join('C:\\Users\\u', 'AppData', 'Local', 'tokscale'),
      path.join('D:\\sandbox\\home', '.cache', 'tokscale')
    ]
  );
});

test('Windows ignores POSIX-shaped and drive-relative HOME overrides', () => {
  for (const home of ['/home/u', 'C:relative']) {
    assert.deepEqual(
      tokscaleCacheDirs({ platform: 'win32', homeDir: 'C:\\Users\\u', env: { HOME: home } }),
      [
        path.join('C:\\Users\\u', 'AppData', 'Roaming', 'tokscale', 'cache'),
        path.join('C:\\Users\\u', 'AppData', 'Local', 'tokscale'),
        path.join('C:\\Users\\u', '.cache', 'tokscale')
      ]
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

test('explicit config override keeps cache discovery hermetic', () => {
  assert.deepEqual(
    tokscaleCacheDirs({ platform: 'linux', homeDir: '/home/u', env: { TOKSCALE_CONFIG_DIR: '/tmp/iso' } }),
    [path.join('/tmp/iso', 'cache')]
  );
});

test('macOS cache discovery includes both upstream legacy roots', () => {
  assert.deepEqual(
    tokscaleCacheDirs({ platform: 'darwin', homeDir: '/Users/u', env: {} }),
    [
      path.join('/Users/u', '.config', 'tokscale', 'cache'),
      path.join('/Users/u', 'Library', 'Caches', 'tokscale'),
      path.join('/Users/u', '.cache', 'tokscale')
    ]
  );
});

test('Linux cache discovery honors XDG_CACHE_HOME and keeps dot-cache fallback', () => {
  assert.deepEqual(
    tokscaleCacheDirs({
      platform: 'linux',
      homeDir: '/home/u',
      env: { XDG_CONFIG_HOME: '/config', XDG_CACHE_HOME: '/cache' }
    }),
    [
      path.join('/config', 'tokscale', 'cache'),
      path.join('/cache', 'tokscale'),
      path.join('/home/u', '.cache', 'tokscale')
    ]
  );
});

test('Windows cache discovery uses LocalAppData for the dirs cache root', () => {
  assert.deepEqual(
    tokscaleCacheDirs({
      platform: 'win32',
      homeDir: 'C:\\Users\\u',
      env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming', LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }
    }),
    [
      path.join('C:\\Users\\u\\AppData\\Roaming', 'tokscale', 'cache'),
      path.join('C:\\Users\\u\\AppData\\Local', 'tokscale'),
      path.join('C:\\Users\\u', '.cache', 'tokscale')
    ]
  );
});
