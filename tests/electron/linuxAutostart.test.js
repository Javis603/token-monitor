'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');

const {
  autostartSupported,
  desktopFilePath,
  desktopFileContents,
  isAutostartEnabled,
  setAutostartEnabled
} = require('../../src/electron/linuxAutostart');

function tmpConfigHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'routed-monitoring-autostart-'));
}

test('autostartSupported requires linux and a running AppImage', () => {
  assert.equal(autostartSupported({ platform: 'linux', env: { APPIMAGE: '/opt/Routed Monitoring.AppImage' } }), true);
  assert.equal(autostartSupported({ platform: 'linux', env: {} }), false);
  assert.equal(autostartSupported({ platform: 'linux', env: { APPIMAGE: '' } }), false);
  assert.equal(autostartSupported({ platform: 'darwin', env: { APPIMAGE: '/x.AppImage' } }), false);
  assert.equal(autostartSupported({ platform: 'win32', env: { APPIMAGE: '/x.AppImage' } }), false);
});

test('desktopFilePath honors XDG_CONFIG_HOME and falls back to ~/.config', () => {
  assert.equal(
    desktopFilePath({ env: { XDG_CONFIG_HOME: '/custom/config' } }),
    '/custom/config/autostart/routed-monitoring.desktop'
  );
  assert.equal(
    desktopFilePath({ env: { HOME: '/home/frank' } }),
    '/home/frank/.config/autostart/routed-monitoring.desktop'
  );
});

test('desktopFileContents produces a desktop entry pointing at the AppImage', () => {
  const contents = desktopFileContents('/opt/apps/Routed Monitoring.AppImage');
  assert.match(contents, /^\[Desktop Entry\]\n/);
  assert.match(contents, /\nType=Application\n/);
  assert.match(contents, /\nName=Routed Monitoring\n/);
  assert.match(contents, /\nExec="\/opt\/apps\/Routed Monitoring\.AppImage"\n/);
  assert.match(contents, /\nX-GNOME-Autostart-enabled=true\n/);
  assert.ok(contents.endsWith('\n'));
});

test('desktopFileContents escapes reserved characters inside the quoted Exec argument', () => {
  const contents = desktopFileContents('/home/a"b/$HOME/`x`/App\\Image.AppImage');
  const execLine = contents.split('\n').find((line) => line.startsWith('Exec='));
  assert.equal(execLine, 'Exec="/home/a\\\\"b/\\\\$HOME/\\\\`x\\\\`/App\\\\\\\\Image.AppImage"');
});

test('desktopFileContents escapes literal percent signs in Exec arguments', () => {
  const contents = desktopFileContents('/opt/apps/Routed Monitoring 100%.AppImage');
  const execLine = contents.split('\n').find((line) => line.startsWith('Exec='));
  assert.equal(execLine, 'Exec="/opt/apps/Routed Monitoring 100%%.AppImage"');
});

test('setAutostartEnabled(true) writes the desktop file, creating the autostart dir', () => {
  const configHome = tmpConfigHome();
  const env = { XDG_CONFIG_HOME: configHome, APPIMAGE: '/opt/Routed Monitoring.AppImage' };
  assert.equal(isAutostartEnabled({ env }), false);
  assert.equal(setAutostartEnabled(true, { env }), true);
  assert.equal(isAutostartEnabled({ env }), true);
  const written = fs.readFileSync(path.join(configHome, 'autostart', 'routed-monitoring.desktop'), 'utf8');
  assert.match(written, /Exec="\/opt\/Routed Monitoring\.AppImage"/);
});

test('isAutostartEnabled requires the desktop file to target the current AppImage', () => {
  const configHome = tmpConfigHome();
  const env = { XDG_CONFIG_HOME: configHome, APPIMAGE: '/opt/Routed Monitoring.AppImage' };
  const staleEnv = { XDG_CONFIG_HOME: configHome, APPIMAGE: '/old/Routed Monitoring.AppImage' };
  setAutostartEnabled(true, { env: staleEnv });
  assert.equal(isAutostartEnabled({ env }), false);
  assert.equal(setAutostartEnabled(true, { env }), true);
  assert.equal(isAutostartEnabled({ env }), true);
});

test('setAutostartEnabled(false) removes the desktop file and is idempotent', () => {
  const configHome = tmpConfigHome();
  const env = { XDG_CONFIG_HOME: configHome, APPIMAGE: '/opt/Routed Monitoring.AppImage' };
  setAutostartEnabled(true, { env });
  assert.equal(setAutostartEnabled(false, { env }), false);
  assert.equal(isAutostartEnabled({ env }), false);
  assert.equal(setAutostartEnabled(false, { env }), false); // no file present — must not throw
});

test('setAutostartEnabled(true) without an AppImage path reports failure', () => {
  const configHome = tmpConfigHome();
  const env = { XDG_CONFIG_HOME: configHome };
  assert.equal(setAutostartEnabled(true, { env }), false);
  assert.equal(isAutostartEnabled({ env }), false);
});
