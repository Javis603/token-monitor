'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  discoverHermesProfileScanPaths,
  resolveHermesHome
} = require('../../src/shared/hermesProfiles');

test('resolveHermesHome prefers HERMES_HOME when set', () => {
  assert.equal(
    resolveHermesHome({ env: { HERMES_HOME: 'C:\\hermes-root' }, homeDir: 'C:\\Users\\u', platform: 'win32' }),
    'C:\\hermes-root'
  );
});

test('resolveHermesHome prefers home-relative .hermes before Windows LocalAppData', () => {
  const homeDir = 'C:\\Users\\u';
  const dotHermes = path.join(homeDir, '.hermes');
  const winNative = path.join(homeDir, 'AppData', 'Local', 'hermes');
  assert.equal(
    resolveHermesHome({
      env: {},
      homeDir,
      platform: 'win32',
      existsSync: (target) => target === path.join(dotHermes, 'state.db')
        || target === path.join(winNative, 'state.db')
    }),
    dotHermes
  );
});

test('resolveHermesHome falls back to Windows LocalAppData when native state.db exists', () => {
  const homeDir = 'C:\\Users\\u';
  const winNative = path.join(homeDir, 'AppData', 'Local', 'hermes');
  assert.equal(
    resolveHermesHome({
      env: {},
      homeDir,
      platform: 'win32',
      existsSync: (target) => target === path.join(winNative, 'state.db')
    }),
    winNative
  );
});

test('resolveHermesHome falls back to ~/.hermes on other platforms', () => {
  assert.equal(
    resolveHermesHome({ env: {}, homeDir: '/home/u', platform: 'linux' }),
    path.join('/home/u', '.hermes')
  );
});

test('discoverHermesProfileScanPaths returns profile dirs that contain state.db', () => {
  const hermesHome = '/home/u/.hermes';
  const paths = discoverHermesProfileScanPaths(hermesHome, {
    existsSync: (target) => {
      if (target === path.join(hermesHome, 'profiles')) return true;
      return target.endsWith(`${path.sep}lab-a${path.sep}state.db`)
        || target.endsWith(`${path.sep}research${path.sep}state.db`);
    },
    readdirSync: () => [
      { name: 'lab-a', isDirectory: () => true },
      { name: 'empty', isDirectory: () => true },
      { name: 'notes.txt', isDirectory: () => false },
      { name: 'research', isDirectory: () => true }
    ]
  });

  assert.deepEqual(paths, [
    path.join(hermesHome, 'profiles', 'lab-a'),
    path.join(hermesHome, 'profiles', 'research')
  ]);
});
