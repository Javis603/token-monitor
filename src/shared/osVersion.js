'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

const MAX_OS_NAME_LENGTH = 64;
const MAX_OS_VERSION_LENGTH = 128;
const WINDOWS_CURRENT_VERSION_KEY = 'HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion';

function normalizeOsName(value) {
  return String(value || '').trim().slice(0, MAX_OS_NAME_LENGTH);
}

function normalizeOsVersion(value) {
  return String(value || '').trim().slice(0, MAX_OS_VERSION_LENGTH);
}

function normalizeOsInfo(value) {
  return {
    name: normalizeOsName(value?.name),
    version: normalizeOsVersion(value?.version)
  };
}

function commandOptions() {
  return {
    encoding: 'utf8',
    timeout: 1000,
    stdio: ['ignore', 'pipe', 'ignore']
  };
}

function registryValues(output) {
  const values = Object.create(null);
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^\s*([^\s]+)\s+REG_[A-Z0-9_]+\s+(.*?)\s*$/i);
    if (match) values[match[1].toLowerCase()] = match[2];
  }
  return values;
}

function windowsProductName(productName, build) {
  const raw = normalizeOsName(productName).replace(/^Microsoft\s+/i, '');
  const server = raw.match(/Windows Server\s+\d{4}/i);
  if (server) return server[0].replace(/^windows server/i, 'Windows Server');
  const desktop = raw.match(/Windows\s+\d+(?:\.\d+)?/i);
  if (desktop) {
    if (/^Windows 10$/i.test(desktop[0]) && build >= 22000) return 'Windows 11';
    return desktop[0].replace(/^windows/i, 'Windows');
  }
  return 'Windows';
}

function detectWindowsInfo(options) {
  const run = options.execFileSync || execFileSync;
  let values = Object.create(null);
  try {
    values = registryValues(run('reg.exe', ['query', WINDOWS_CURRENT_VERSION_KEY], commandOptions()));
  } catch (_) {}

  let release = '';
  try {
    release = normalizeOsVersion((options.release || os.release)());
  } catch (_) {}
  const releaseBuild = release.split('.')[2];
  const build = Number.parseInt(values.currentbuildnumber || values.currentbuild || releaseBuild, 10);
  const name = windowsProductName(values.productname, Number.isFinite(build) ? build : 0);
  const displayVersion = normalizeOsVersion(values.displayversion || values.releaseid);
  const version = displayVersion || (Number.isFinite(build) && build > 0 ? `build ${build}` : release);
  return normalizeOsInfo({ name, version });
}

function unquoteOsReleaseValue(value) {
  const raw = String(value || '').trim();
  if (raw.length >= 2 && raw[0] === "'" && raw.at(-1) === "'") return raw.slice(1, -1);
  if (raw.length >= 2 && raw[0] === '"' && raw.at(-1) === '"') {
    return raw.slice(1, -1).replace(/\\(["\\$`])/g, '$1');
  }
  return raw;
}

function parseOsRelease(output) {
  const values = Object.create(null);
  for (const line of String(output || '').split(/\r?\n/)) {
    const match = line.match(/^([A-Z][A-Z0-9_]*)=(.*)$/);
    if (match) values[match[1]] = unquoteOsReleaseValue(match[2]);
  }
  return values;
}

function systemRelease(options) {
  try {
    return normalizeOsVersion((options.release || os.release)());
  } catch (_) {
    return '';
  }
}

function detectLinuxInfo(options) {
  const readFile = options.readFileSync || fs.readFileSync;
  let values = Object.create(null);
  for (const filePath of ['/etc/os-release', '/usr/lib/os-release']) {
    try {
      values = parseOsRelease(readFile(filePath, 'utf8'));
      break;
    } catch (_) {}
  }

  const name = normalizeOsName(values.NAME);
  const prettyName = normalizeOsVersion(values.PRETTY_NAME);
  if (name) {
    const prettyVersion = prettyName.toLowerCase().startsWith(name.toLowerCase())
      ? prettyName.slice(name.length).trim()
      : '';
    const distroVersion = normalizeOsVersion(prettyVersion || values.VERSION_ID || values.VERSION);
    const release = distroVersion ? '' : systemRelease(options);
    return normalizeOsInfo({
      name,
      version: distroVersion || (release ? `kernel ${release}` : '')
    });
  }

  const release = systemRelease(options);
  return normalizeOsInfo({ name: 'Linux', version: release ? `kernel ${release}` : '' });
}

function detectOsInfo(options = {}) {
  const platform = options.platform || process.platform;
  if (platform === 'darwin') {
    const getSystemVersion = options.getSystemVersion || (() => {
      return typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '';
    });
    try {
      const version = normalizeOsVersion(getSystemVersion());
      if (version) return { name: 'macOS', version };
    } catch (_) {}

    const run = options.execFileSync || execFileSync;
    try {
      return normalizeOsInfo({
        name: 'macOS',
        version: run('/usr/bin/sw_vers', ['-productVersion'], commandOptions())
      });
    } catch (_) {
      return { name: 'macOS', version: '' };
    }
  }
  if (platform === 'win32') return detectWindowsInfo(options);
  if (platform === 'linux') return detectLinuxInfo(options);
  let version = '';
  try { version = (options.release || os.release)(); } catch (_) {}
  return normalizeOsInfo({ name: platform, version });
}

let cachedHostOsInfo;

function hostOsInfo() {
  if (cachedHostOsInfo === undefined) cachedHostOsInfo = detectOsInfo();
  return cachedHostOsInfo;
}

module.exports = { detectOsInfo, hostOsInfo, normalizeOsInfo, normalizeOsName, normalizeOsVersion };
