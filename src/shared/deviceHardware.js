'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');

// SMBIOS chassis types, shared by Windows CIM and Linux DMI.
// https://learn.microsoft.com/windows/win32/cimwin32prov/win32-systemenclosure
function chassisKind(values) {
  const types = values.map(Number);
  if (types.some(type => [8, 9, 10, 14, 30, 31, 32].includes(type))) return 'laptop';
  if (types.some(type => [23, 28, 29].includes(type))) return 'server';
  if (types.some(type => [3, 4, 5, 6, 7, 13, 15, 16, 24].includes(type))) return 'desktop';
  return 'computer';
}

function detectDeviceKind({ platform = process.platform, run = execFileSync, read = fs.readFileSync, release = os.release } = {}) {
  const options = { encoding: 'utf8', timeout: 2500, maxBuffer: 256 * 1024,
    windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'] };
  try {
    if (platform === 'darwin') {
      // machine_name remains human-readable on Apple Silicon, unlike hw.model.
      const hardware = JSON.parse(run('/usr/sbin/system_profiler', ['SPHardwareDataType', '-json'], options)).SPHardwareDataType?.[0];
      const name = String(hardware?.machine_name || '');
      if (/MacBook/i.test(name)) return 'laptop';
      if (/Mac mini/i.test(name)) return 'mini';
      if (/Mac Studio|Mac Pro/i.test(name)) return 'workstation';
      if (/iMac/i.test(name)) return 'desktop';
    } else if (platform === 'win32') {
      const output = run('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
        'Get-CimInstance Win32_SystemEnclosure | ForEach-Object { $_.ChassisTypes }'], options);
      return chassisKind(String(output).trim().split(/\s+/));
    } else if (platform === 'linux') {
      if (/microsoft|wsl/i.test(release())) return 'linux';
      const kind = chassisKind([String(read('/sys/class/dmi/id/chassis_type', 'utf8')).trim()]);
      return kind === 'computer' ? 'linux' : kind;
    }
  } catch { /* Keep the known Linux environment or use the generic hardware hint. */ }
  return platform === 'linux' ? 'linux' : 'computer';
}

let cached;
function hostDeviceKind() {
  if (cached === undefined) cached = detectDeviceKind();
  return cached;
}

module.exports = { chassisKind, detectDeviceKind, hostDeviceKind };
