'use strict';

const fs = require('node:fs');
const { execFile, execFileSync } = require('node:child_process');
const { throwIfAborted } = require('./abortSignal');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./providers/reasonix/paths');
const { WSL_DATA_MARKERS, MARKER_CLIENTS } = require('./clientSourceRegistration');
const { isMcodeProfileDir } = require('./providers/mcode/paths');

const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw']);

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

// Default command runner. reg output is ANSI/utf8; wsl.exe output is UTF-16LE.
// stdin is NUL ('ignore') so a non-WSL wsl.exe stub cannot block on "press any
// key to install"; a timeout backstops any hang.
function defaultExec(cmd, args) {
  const isWsl = /wsl(\.exe)?$/i.test(cmd);
  const out = execFileSync(cmd, args, {
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 5000,
    windowsHide: true,
    encoding: 'buffer'
  });
  return Buffer.from(out).toString(isWsl ? 'utf16le' : 'utf8');
}

function emptyWslBundle() {
  return { today: emptyPeriod(), month: emptyPeriod(), allTime: emptyPeriod() };
}

// Install-proof gate: reg.exe is read-only and cannot trigger a WSL install. If
// the Lxss key is absent, reg exits non-zero and execFileSync throws -> false.
function isWslInstalled(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return false;
  const exec = deps.exec || defaultExec;
  try {
    exec('reg', ['query', LXSS_KEY]);
    return true;
  } catch (_) {
    return false;
  }
}

function listRunningWslDistros(deps = {}) {
  if (!isWslInstalled(deps)) return [];
  const exec = deps.exec || defaultExec;
  let out;
  try {
    out = exec('wsl.exe', ['--list', '--quiet', '--running']);
  } catch (_) {
    return [];
  }
  return String(out)
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);
}

// Returns the tracked-client ids whose marker is present in this home (deduped).
// Empty array = no tracked client stores data here.
function wslHomePath(home, relativePath) {
  return `${home}\\${relativePath.replace(/\//g, '\\')}`;
}

function homeHasData(home, existsSync, readdirSync = fs.readdirSync) {
  const ids = new Set();
  for (const rel of WSL_DATA_MARKERS) {
    if (existsSync(wslHomePath(home, rel))) {
      const client = MARKER_CLIENTS[rel];
      if (client) ids.add(client);
    }
  }
  // workspaceStorage is not Copilot-specific, so require the nested source
  // Tokscale 4.5.2 actually parses instead of marking every VS Code WSL home.
  const workspaceRoot = wslHomePath(home, '.config/Code/User/workspaceStorage');
  try {
    for (const workspace of readdirSync(workspaceRoot)) {
      if (existsSync(`${workspaceRoot}\\${workspace}\\chatSessions`)) {
        ids.add('copilot');
        break;
      }
    }
  } catch (_) { /* workspaceStorage missing or unreadable */ }
  // MiniMax Code profiles (`.minimax-<profile>`, `.mavis-<profile>`) have no
  // fixed name to mark, and the fork reads them under --home too.
  if (!ids.has('mcode')) {
    try {
      for (const name of readdirSync(home)) {
        if (isMcodeProfileDir(name) && existsSync(wslHomePath(home, `${name}/v2/sessions`))) {
          ids.add('mcode');
          break;
        }
      }
    } catch (_) { /* home unreadable */ }
  }
  return [...ids];
}

function wslUsageHomes(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const homes = [];
  for (const distro of listRunningWslDistros(deps)) {
    const candidates = [];
    const homeRoot = `\\\\wsl$\\${distro}\\home`;
    try {
      for (const user of readdirSync(homeRoot)) {
        candidates.push(`${homeRoot}\\${user}`);
      }
    } catch (_) { /* distro has no /home or it is unreadable */ }
    candidates.push(`\\\\wsl$\\${distro}\\root`);
    for (const home of candidates) {
      if (homeHasData(home, existsSync, readdirSync).length > 0) homes.push(home);
    }
  }
  return homes;
}

// Cheap WSL readiness probe (no tokscale). Returns 'not-installed' (no Lxss),
// 'not-running' (installed but no running distro), or 'ok'.
function probeWslState(deps = {}) {
  if (!isWslInstalled(deps)) return 'not-installed';
  if (listRunningWslDistros(deps).length === 0) return 'not-running';
  return 'ok';
}

async function collectWslUsage(options = {}, deps = {}) {
  const { clients, trackedClients = clients, allTimeSince, commandTimeoutMs, allTimeTimeoutMs = commandTimeoutMs, runTokscale, logger, decoratePeriods } = options;
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const bundle = emptyWslBundle();
  const detected = new Set();
  throwIfAborted(options.signal, 'WSL usage scan aborted');
  if (!trackedClients) return { bundle, detected: [] };
  // Only attribute markers for clients the user is actually tracking — a marker
  // for an untracked client must not surface in the panel.
  // Reasonix aggregate usage is supported on the host, but remains excluded
  // from WSL scans: Tokscale's Windows PathRoot::ReasonixHome conflicts with
  // the Linux-default `.reasonix/stats` path inside WSL. Native session files
  // are local-only as well.
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  const clientsCsv = String(clients || '').split(',').map((c) => c.trim()).filter(Boolean)
    .filter((client) => !WSL_EXCLUDED_CLIENTS.has(client))
    .join(',');
  for (const home of wslUsageHomes(deps)) {
    throwIfAborted(options.signal, 'WSL usage scan aborted');
    // Attribution is marker-based, independent of whether a parser returns data.
    const homeDataClients = homeHasData(home, existsSync, readdirSync);
    for (const id of homeDataClients) {
      if (tracked.has(id)) detected.add(id);
    }
    // Tokscale 4.6+ keeps explicit --home scans isolated from host-native roots,
    // so every requested client can be passed through for each discovered home.
    // Keep the empty guard because an empty --client expands to all clients.
    if (clientsCsv.length === 0 || typeof runTokscale !== 'function') continue;
    try {
      // Serial on purpose (issue #15): never run these concurrently.
      const todayJson = await runTokscale({ clients: clientsCsv, flags: ['--today', '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const monthJson = await runTokscale({ clients: clientsCsv, flags: ['--month', '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const allTimeJson = await runTokscale({ clients: clientsCsv, flags: ['--since', allTimeSince, '--home', home], commandTimeoutMs: allTimeTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const periods = {
        today: extractUsageFromTokscale(todayJson),
        month: extractUsageFromTokscale(monthJson),
        allTime: extractUsageFromTokscale(allTimeJson)
      };
      if (typeof decoratePeriods === 'function') decoratePeriods(periods, home);
      bundle.today = mergePeriods(bundle.today, periods.today);
      bundle.month = mergePeriods(bundle.month, periods.month);
      bundle.allTime = mergePeriods(bundle.allTime, periods.allTime);
    } catch (error) {
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
  }
  return { bundle, detected: [...detected] };
}

function defaultExecAsync(cmd, args) {
  const isWsl = /wsl(\.exe)?$/i.test(cmd);
  return new Promise((resolve, reject) => {
    const child = execFile(cmd, args, {
      timeout: 5000,
      windowsHide: true,
      encoding: 'buffer'
    }, (error, stdout) => {
      if (error) reject(error);
      else resolve(Buffer.from(stdout).toString(isWsl ? 'utf16le' : 'utf8'));
    });
    child.stdin?.end();
  });
}

async function pathExistsAsync(target) {
  try {
    await fs.promises.access(target);
    return true;
  } catch (_) {
    return false;
  }
}

async function detectWslClientsAsync(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform !== 'win32') return [];
  const target = deps.clients ? new Set([...deps.clients].map((c) => String(c || '').trim().toLowerCase()).filter(Boolean)) : null;
  if (target && target.size === 0) return [];
  const exec = deps.exec || defaultExecAsync;
  const exists = deps.exists || pathExistsAsync;
  const readdir = deps.readdir || fs.promises.readdir;
  try {
    await exec('reg', ['query', LXSS_KEY]);
  } catch (_) {
    return [];
  }
  let out;
  try {
    out = await exec('wsl.exe', ['--list', '--quiet', '--running']);
  } catch (_) {
    return [];
  }
  const distros = String(out)
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);
  const ids = new Set();
  const wants = (client) => Boolean(client) && !ids.has(client) && (!target || target.has(client));
  for (const distro of distros) {
    const candidates = [];
    const homeRoot = `\\\\wsl$\\${distro}\\home`;
    try {
      for (const user of await readdir(homeRoot)) {
        candidates.push(`${homeRoot}\\${user}`);
      }
    } catch (_) { /* distro has no /home or it is unreadable */ }
    candidates.push(`\\\\wsl$\\${distro}\\root`);
    for (const home of candidates) {
      for (const rel of WSL_DATA_MARKERS) {
        const client = MARKER_CLIENTS[rel];
        if (!wants(client)) continue;
        if (await exists(wslHomePath(home, rel))) ids.add(client);
      }
      if (wants('copilot')) {
        const workspaceRoot = wslHomePath(home, '.config/Code/User/workspaceStorage');
        try {
          for (const workspace of await readdir(workspaceRoot)) {
            if (await exists(`${workspaceRoot}\\${workspace}\\chatSessions`)) {
              ids.add('copilot');
              break;
            }
          }
        } catch (_) { /* workspaceStorage missing or unreadable */ }
      }
      if (wants('mcode')) {
        try {
          for (const name of await readdir(home)) {
            if (isMcodeProfileDir(name) && await exists(wslHomePath(home, `${name}/v2/sessions`))) {
              ids.add('mcode');
              break;
            }
          }
        } catch (_) { /* home unreadable */ }
      }
      if (target && ids.size === target.size) return [...ids];
    }
  }
  return [...ids];
}

module.exports = {
  WSL_DATA_MARKERS,
  MARKER_CLIENTS,
  collectWslUsage,
  detectWslClientsAsync,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  listRunningWslDistros,
  probeWslState,
  wslUsageHomes
};
