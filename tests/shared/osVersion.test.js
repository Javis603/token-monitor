'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { detectOsInfo, normalizeOsInfo } = require('../../src/shared/osVersion');

test('detectOsInfo prefers the macOS product version from Electron', () => {
  let spawned = false;
  const info = detectOsInfo({
    platform: 'darwin',
    getSystemVersion: () => ' 26.0.1 ',
    execFileSync: () => { spawned = true; }
  });

  assert.deepEqual(info, { name: 'macOS', version: '26.0.1' });
  assert.equal(spawned, false);
});

test('detectOsInfo uses sw_vers for a headless macOS agent', () => {
  let invocation;
  const info = detectOsInfo({
    platform: 'darwin',
    getSystemVersion: () => '',
    execFileSync: (...args) => {
      invocation = args;
      return '15.6\n';
    }
  });

  assert.deepEqual(info, { name: 'macOS', version: '15.6' });
  assert.equal(invocation[0], '/usr/bin/sw_vers');
  assert.deepEqual(invocation[1], ['-productVersion']);
});

test('detectOsInfo reports the Windows product family and display version', () => {
  const info = detectOsInfo({
    platform: 'win32',
    release: () => '10.0.26100',
    execFileSync: () => [
      'HKEY_LOCAL_MACHINE\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion',
      '    ProductName    REG_SZ    Windows 10 Pro',
      '    DisplayVersion    REG_SZ    24H2',
      '    CurrentBuildNumber    REG_SZ    26100'
    ].join('\r\n')
  });

  assert.deepEqual(info, { name: 'Windows 11', version: '24H2' });
});

test('detectOsInfo keeps the Windows build fallback product-neutral', () => {
  const info = detectOsInfo({
    platform: 'win32',
    release: () => '10.0.26100',
    execFileSync: () => { throw new Error('registry unavailable'); }
  });

  assert.deepEqual(info, { name: 'Windows', version: 'build 26100' });
});

test('detectOsInfo does not confuse Windows Server with Windows 11', () => {
  const info = detectOsInfo({
    platform: 'win32',
    release: () => '10.0.26100',
    execFileSync: () => [
      '    ProductName    REG_SZ    Windows Server 2025 Datacenter',
      '    DisplayVersion    REG_SZ    24H2',
      '    CurrentBuildNumber    REG_SZ    26100'
    ].join('\r\n')
  });

  assert.deepEqual(info, { name: 'Windows Server 2025', version: '24H2' });
});

test('detectOsInfo uses the Linux distribution name and product version', () => {
  const info = detectOsInfo({
    platform: 'linux',
    readFileSync: (filePath) => {
      assert.equal(filePath, '/etc/os-release');
      return [
        'NAME="Ubuntu"',
        'VERSION_ID="24.04"',
        'PRETTY_NAME="Ubuntu 24.04.2 LTS"'
      ].join('\n');
    }
  });

  assert.deepEqual(info, { name: 'Ubuntu', version: '24.04.2 LTS' });
});

test('detectOsInfo falls back to the vendor os-release file', () => {
  const visited = [];
  const info = detectOsInfo({
    platform: 'linux',
    readFileSync: (filePath) => {
      visited.push(filePath);
      if (filePath === '/etc/os-release') throw new Error('missing');
      return 'NAME="Fedora Linux"\nPRETTY_NAME="Fedora Linux 42 (Workstation Edition)"\n';
    }
  });

  assert.deepEqual(visited, ['/etc/os-release', '/usr/lib/os-release']);
  assert.deepEqual(info, { name: 'Fedora Linux', version: '42 (Workstation Edition)' });
});

test('detectOsInfo keeps a rolling distro name and labels its kernel fallback', () => {
  const info = detectOsInfo({
    platform: 'linux',
    readFileSync: () => 'NAME="Arch Linux"\nPRETTY_NAME="Arch Linux"\n',
    release: () => '6.15.7-arch1-1'
  });

  assert.deepEqual(info, { name: 'Arch Linux', version: 'kernel 6.15.7-arch1-1' });
});

test('detectOsInfo labels a Linux kernel fallback honestly', () => {
  assert.deepEqual(detectOsInfo({
    platform: 'linux',
    readFileSync: () => { throw new Error('unavailable'); },
    release: () => '6.8.0-60-generic'
  }), { name: 'Linux', version: 'kernel 6.8.0-60-generic' });
});

test('detectOsInfo keeps a macOS label when product detection fails', () => {
  assert.deepEqual(detectOsInfo({
    platform: 'darwin',
    getSystemVersion: () => { throw new Error('unavailable'); },
    execFileSync: () => { throw new Error('unavailable'); }
  }), { name: 'macOS', version: '' });
});

test('normalizeOsInfo trims and bounds external values', () => {
  assert.deepEqual(normalizeOsInfo({
    name: `  ${'n'.repeat(100)}  `,
    version: `  ${'1'.repeat(200)}  `
  }), {
    name: 'n'.repeat(64),
    version: '1'.repeat(128)
  });
});
