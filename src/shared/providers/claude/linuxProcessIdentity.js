'use strict';

const fs = require('node:fs');
const path = require('node:path');

function readLinuxPidDomain({ procRoot = '/proc', machineIdFile = '/etc/machine-id' } = {}) {
  try {
    const machineId = fs.readFileSync(machineIdFile, 'utf8').trim();
    const pidNamespace = fs.readlinkSync(path.join(procRoot, 'self', 'ns', 'pid'));
    if (!machineId || !pidNamespace) return null;
    return `linux:${machineId}:${pidNamespace}`;
  } catch (_) { return null; }
}

function parseLinuxStartTicks(stat) {
  if (typeof stat !== 'string') return null;
  // comm is parenthesized but may itself contain spaces or closing parentheses.
  const commandEnd = stat.lastIndexOf(')');
  if (commandEnd < 0) return null;
  const fields = stat.slice(commandEnd + 1).trim().split(/\s+/);
  if (['Z', 'X', 'x'].includes(fields[0])) return null;
  const ticks = fields[19]; // /proc/<pid>/stat field 22; fields[0] is field 3.
  return typeof ticks === 'string' && /^\d+$/.test(ticks) ? ticks : null;
}

function readLinuxProcessStarts(pids, { procRoot = '/proc' } = {}) {
  const result = new Map();
  for (const pid of pids) {
    try {
      const ticks = parseLinuxStartTicks(fs.readFileSync(path.join(procRoot, String(pid), 'stat'), 'utf8'));
      if (ticks !== null) result.set(pid, ticks);
    } catch (_) { /* Missing and unreadable proc entries are not identity evidence. */ }
  }
  return result;
}

module.exports = { readLinuxPidDomain, parseLinuxStartTicks, readLinuxProcessStarts };
