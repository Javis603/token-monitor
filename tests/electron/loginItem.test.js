'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { loginItemExecutablePath, loginItemSettingsFor, shouldRepinLoginItem, startupApprovalState } = require('../../src/electron/loginItem');

test('pins the startup entry to the running executable', () => {
  assert.deepEqual(loginItemSettingsFor(true, 'C:\\Apps\\Token Monitor\\Token Monitor.exe'), {
    openAtLogin: true,
    path: 'C:\\Apps\\Token Monitor\\Token Monitor.exe',
    args: []
  });
});

test('clears the startup entry without touching the path', () => {
  assert.deepEqual(loginItemSettingsFor(false, 'C:\\Apps\\Token Monitor\\Token Monitor.exe'), { openAtLogin: false });
});

test('repins when the preference is on but no entry matches this build', () => {
  assert.equal(shouldRepinLoginItem({ startAtLogin: true, openAtLogin: false }), true);
});

test('leaves a matching entry alone and never enables a disabled preference', () => {
  assert.equal(shouldRepinLoginItem({ startAtLogin: true, openAtLogin: true }), false);
  assert.equal(shouldRepinLoginItem({ startAtLogin: false, openAtLogin: false }), false);
  assert.equal(shouldRepinLoginItem({ startAtLogin: false, openAtLogin: true }), false);
});

test('keeps a startup entry the user disabled from the Startup tab disabled', () => {
  assert.deepEqual(loginItemSettingsFor(true, 'C:\\Apps\\Token Monitor.exe', false), {
    openAtLogin: true,
    path: 'C:\\Apps\\Token Monitor.exe',
    args: [],
    enabled: false
  });
  assert.equal('enabled' in loginItemSettingsFor(true, 'C:\\Apps\\Token Monitor.exe', true), false);
});

test('reads a StartupApproved listing without mistaking failures for enabled', () => {
  const listing = [
    'HKEY_CURRENT_USER\\Software\\Microsoft\\Windows\\CurrentVersion\\Explorer\\StartupApproved\\Run',
    '    Steam    REG_BINARY    020000000000000000000000',
    '    com.javis.tokenmonitor    REG_BINARY    03000000E282302AE976DC01',
    '    OneDrive    REG_BINARY    03000000869B1531E976DC01'
  ].join('\r\n');
  assert.equal(startupApprovalState(listing, 'com.javis.tokenmonitor'), 'disabled');
  assert.equal(startupApprovalState(listing, 'Steam'), 'enabled');
  assert.equal(startupApprovalState('    Steam    REG_BINARY    0200', 'com.javis.tokenmonitor'), 'enabled');
  assert.equal(startupApprovalState('    com.javis.tokenmonitor    REG_BINARY    0100000084826B01A95EDD01', 'com.javis.tokenmonitor'), 'unknown');
  assert.equal(startupApprovalState('    com.javis.tokenmonitor    REG_SZ    x', 'com.javis.tokenmonitor'), 'unknown');
  assert.equal(startupApprovalState('', 'com.javis.tokenmonitor'), 'enabled');
});

test('prefers the portable launcher path over the extracted executable', () => {
  assert.equal(
    loginItemExecutablePath({ PORTABLE_EXECUTABLE_FILE: 'D:\\Apps\\Token-Monitor-0.81.0.exe' }, 'C:\\Temp\\extract\\Token Monitor.exe'),
    'D:\\Apps\\Token-Monitor-0.81.0.exe'
  );
  assert.equal(
    loginItemExecutablePath({}, 'C:\\Apps\\Token Monitor\\Token Monitor.exe'),
    'C:\\Apps\\Token Monitor\\Token Monitor.exe'
  );
});


