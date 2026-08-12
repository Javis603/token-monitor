'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./reasonixPaths');
const { buildPromaPeriods, collectPromaRows } = require('./promaUsage');

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

// Relative (Linux-style) paths under a WSL home. If any exists, a tracked client
// stores data there and the home is worth a tokscale scan. These mirror the roots
// tokscale actually reads (incl. alternate roots: Claude transcripts, Kimi
// Code, legacy OpenClaw bot dirs) so a home holding only an alternate-root client
// is still discovered. The `.vscode-server` entries cover Cline / Kilo Code
// running through the VS Code WSL remote.
const WSL_DATA_MARKERS = [
  '.claude/projects',
  '.claude/transcripts',
  '.codex/sessions',
  '.local/share/opencode',
  '.openclaw/agents',
  '.clawdbot/agents',
  '.moltbot/agents',
  '.moldbot/agents',
  '.hermes',
  '.kimi/sessions',
  '.kimi-code/sessions',
  '.qwen/projects',
  '.grok/sessions',
  '.copilot/otel',
  '.gemini/antigravity-cli/conversations',
  '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks',
  '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks',
  '.pi/agent/sessions',
  '.omp/agent/sessions',
  '.local/share/zed/threads/threads.db',
  '.config/Code/User/globalStorage/kilocode.kilo-code/tasks',
  '.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks',
  '.local/share/mimocode/mimocode.db',
  '.zcode/projects',
  '.kiro/sessions',
  '.local/share/kiro-cli/data.sqlite3',
  '.config/Kiro/User/globalStorage/kiro.kiroagent',
  '.config/kiro/User/globalStorage/kiro.kiroagent',
  '.codebuddy/projects',
  '.workbuddy',
  '.proma/agent-sessions'
];

// Maps every WSL_DATA_MARKERS entry to the tracked-client id that owns it, so a
// matched marker can be attributed back to a client (alt roots collapse to one
// id, e.g. .kimi/.kimi-code -> kimi; the OpenClaw bot dirs -> openclaw; the two
// Cline globalStorage paths -> cline). Ids must match DEFAULT_CLIENTS.
const MARKER_CLIENTS = {
  '.claude/projects': 'claude',
  '.claude/transcripts': 'claude',
  '.codex/sessions': 'codex',
  '.local/share/opencode': 'opencode',
  '.openclaw/agents': 'openclaw',
  '.clawdbot/agents': 'openclaw',
  '.moltbot/agents': 'openclaw',
  '.moldbot/agents': 'openclaw',
  '.hermes': 'hermes',
  '.kimi/sessions': 'kimi',
  '.kimi-code/sessions': 'kimi',
  '.qwen/projects': 'qwen',
  '.grok/sessions': 'grok',
  '.copilot/otel': 'copilot',
  // Antigravity CLI's own parse-local root, mapped to the umbrella `antigravity`
  // id we track; tokscaleClientFilter widens the scan to the antigravity-cli id.
  '.gemini/antigravity-cli/conversations': 'antigravity',
  '.config/Code/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.vscode-server/data/User/globalStorage/saoudrizwan.claude-dev/tasks': 'cline',
  '.pi/agent/sessions': 'pi',
  '.omp/agent/sessions': 'pi',
  '.local/share/zed/threads/threads.db': 'zed',
  '.config/Code/User/globalStorage/kilocode.kilo-code/tasks': 'kilocode',
  '.vscode-server/data/User/globalStorage/kilocode.kilo-code/tasks': 'kilocode',
  '.local/share/mimocode/mimocode.db': 'micode',
  '.zcode/projects': 'zcode',
  '.kiro/sessions': 'kiro',
  '.local/share/kiro-cli/data.sqlite3': 'kiro',
  '.config/Kiro/User/globalStorage/kiro.kiroagent': 'kiro',
  '.config/kiro/User/globalStorage/kiro.kiroagent': 'kiro',
  '.codebuddy/projects': 'codebuddy',
  '.workbuddy': 'workbuddy',
  '.proma/agent-sessions': 'proma'
};

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

function discoverRunningWslDistros(deps = {}) {
  if (!isWslInstalled(deps)) return { distros: [], complete: true, state: 'not-installed' };
  const exec = deps.exec || defaultExec;
  let out;
  try {
    out = exec('wsl.exe', ['--list', '--quiet', '--running']);
  } catch (_) {
    return { distros: [], complete: false, state: 'unavailable' };
  }
  const distros = String(out)
    .split(/\r?\n/)
    .map((line) => line.replace(/\u0000/g, '').trim())
    .filter(Boolean);
  return {
    distros,
    complete: true,
    state: distros.length > 0 ? 'ok' : 'not-running'
  };
}

function listRunningWslDistros(deps = {}) {
  return discoverRunningWslDistros(deps).distros;
}

// Returns the tracked-client ids whose marker is present in this home (deduped).
// Empty array = no tracked client stores data here.
function wslHomePath(home, relativePath) {
  return `${home}\\${relativePath.replace(/\//g, '\\')}`;
}

function missingPathError(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR';
}

function pathProbe(pathValue, deps = {}) {
  if (typeof deps.statSync === 'function') {
    try {
      deps.statSync(pathValue);
      return 'present';
    } catch (error) {
      return missingPathError(error) ? 'absent' : 'inaccessible';
    }
  }
  // Preserve the lightweight boolean seam used by callers and older tests.
  // Production discovery always supplies fs.statSync below, which is what lets
  // it distinguish a real absence from UNC/permission/I/O failure.
  return (deps.existsSync || fs.existsSync)(pathValue) ? 'present' : 'absent';
}

function probeHomeData(home, deps = {}) {
  const ids = new Set();
  let complete = true;
  if (typeof deps.statSync === 'function') {
    const homeState = pathProbe(home, deps);
    if (homeState === 'inaccessible' || (deps.required === true && homeState !== 'present')) {
      return { clients: [], complete: false };
    }
    if (homeState === 'absent') return { clients: [], complete: true };
  }
  for (const rel of WSL_DATA_MARKERS) {
    const markerState = pathProbe(wslHomePath(home, rel), deps);
    if (markerState === 'inaccessible') complete = false;
    if (markerState === 'present') {
      const client = MARKER_CLIENTS[rel];
      if (client) ids.add(client);
    }
  }
  // workspaceStorage is not Copilot-specific, so require the nested source
  // Tokscale 4.5.2 actually parses instead of marking every VS Code WSL home.
  const workspaceRoot = wslHomePath(home, '.config/Code/User/workspaceStorage');
  try {
    for (const workspace of (deps.readdirSync || fs.readdirSync)(workspaceRoot)) {
      const sessionsState = pathProbe(`${workspaceRoot}\\${workspace}\\chatSessions`, deps);
      if (sessionsState === 'inaccessible') complete = false;
      if (sessionsState === 'present') {
        ids.add('copilot');
        break;
      }
    }
  } catch (error) {
    if (!missingPathError(error)) complete = false;
  }
  return { clients: [...ids], complete };
}

function homeHasData(home, existsSync, readdirSync = fs.readdirSync) {
  return probeHomeData(home, { existsSync, readdirSync }).clients;
}

function discoverWslUsageHomes(deps = {}) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const homes = [];
  const homeClients = new Map();
  const running = discoverRunningWslDistros(deps);
  let complete = running.complete && running.state !== 'not-running';
  for (const distro of running.distros) {
    const candidates = [];
    const homeRoot = `\\\\wsl$\\${distro}\\home`;
    try {
      for (const user of readdirSync(homeRoot)) {
        candidates.push({ home: `${homeRoot}\\${user}`, required: true });
      }
    } catch (_) {
      // Once a running distro is known, an unreadable /home means its tracked
      // stores are unknown rather than absent. Keep the root candidate for
      // best-effort native periods, but flexible History must fail closed.
      complete = false;
    }
    candidates.push({ home: `\\\\wsl$\\${distro}\\root`, required: false });
    for (const candidate of candidates) {
      const probed = probeHomeData(candidate.home, {
        existsSync,
        readdirSync,
        statSync: deps.statSync || (deps.existsSync ? null : fs.statSync),
        required: candidate.required
      });
      if (!probed.complete) complete = false;
      if (probed.clients.length > 0) {
        homes.push(candidate.home);
        homeClients.set(candidate.home, probed.clients);
      }
    }
  }
  return { homes, homeClients, complete, state: running.state };
}

function wslUsageHomes(deps = {}) {
  return discoverWslUsageHomes(deps).homes;
}

// Cheap WSL readiness probe (no tokscale). Returns 'not-installed' (no Lxss),
// 'not-running' (installed but no running distro), or 'ok'.
function probeWslState(deps = {}) {
  const discovery = discoverRunningWslDistros(deps);
  return discovery.state === 'unavailable' ? 'not-running' : discovery.state;
}

async function collectWslUsage(options = {}, deps = {}) {
  const { clients, trackedClients = clients, allTimeSince, commandTimeoutMs, now, runTokscale, logger, decoratePeriods } = options;
  const buildProma = options.buildPromaPeriods || buildPromaPeriods;
  const collectProma = options.collectPromaRows || collectPromaRows;
  const bundle = emptyWslBundle();
  const detected = new Set();
  const discovery = discoverWslUsageHomes(deps);
  let complete = discovery.complete;
  if (!trackedClients) return { bundle, detected: [], complete };
  // Only attribute markers for clients the user is actually tracking — a marker
  // for an untracked client must not surface in the panel.
  // Reasonix aggregate usage is supported on the host, but remains excluded
  // from WSL scans: Tokscale's Windows PathRoot::ReasonixHome conflicts with
  // the Linux-default `.reasonix/stats` path inside WSL. Native session files
  // are local-only as well.
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  const clientsCsv = String(clients || '').split(',').map((c) => c.trim()).filter(Boolean)
    .filter((client) => client !== REASONIX_CLIENT)
    .join(',');
  for (const home of discovery.homes) {
    // Attribution is marker-based, independent of whether a parser returns data.
    const homeDataClients = discovery.homeClients.get(home) || [];
    for (const id of homeDataClients) {
      if (tracked.has(id)) detected.add(id);
    }
    // Proma is locally parsed rather than tokscale-backed. Scan its WSL JSONL
    // root directly so a Proma-only home contributes actual usage, not merely
    // marker detection. The root is isolated per home to avoid double-counting
    // another distro or the host's local Proma sessions.
    if (tracked.has('proma') && homeDataClients.includes('proma')) {
      try {
        const promaOptions = {
          now,
          allTimeSince,
          roots: [wslHomePath(home, '.proma/agent-sessions')]
        };
        if (typeof options.resolvePromaPricing === 'function') {
          const rows = collectProma(promaOptions);
          promaOptions.rows = rows;
          promaOptions.pricingByModel = await options.resolvePromaPricing(rows);
        } else if (options.promaPricingByModel) {
          promaOptions.pricingByModel = options.promaPricingByModel;
        }
        const proma = buildProma(promaOptions);
        bundle.today = mergePeriods(bundle.today, extractUsageFromTokscale(proma.today));
        bundle.month = mergePeriods(bundle.month, extractUsageFromTokscale(proma.month));
        bundle.allTime = mergePeriods(bundle.allTime, extractUsageFromTokscale(proma.allTime));
      } catch (error) {
        complete = false;
        if (typeof logger === 'function') logger(`wsl Proma usage parse failed for ${home}: ${error.message}`);
      }
    }
    // Tokscale 4.6+ keeps explicit --home scans isolated from host-native roots,
    // so every requested client can be passed through for each discovered home.
    // Keep the empty guard because an empty --client expands to all clients.
    if (clientsCsv.length === 0) continue;
    if (typeof runTokscale !== 'function') {
      if (homeDataClients.some((id) => tracked.has(id) && id !== 'proma' && id !== REASONIX_CLIENT)) complete = false;
      continue;
    }
    try {
      // Serial on purpose (issue #15): never run these concurrently.
      const todayJson = await runTokscale({ clients: clientsCsv, flags: ['--today', '--home', home], commandTimeoutMs });
      const monthJson = await runTokscale({ clients: clientsCsv, flags: ['--month', '--home', home], commandTimeoutMs });
      const allTimeJson = await runTokscale({ clients: clientsCsv, flags: ['--since', allTimeSince, '--home', home], commandTimeoutMs });
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
      complete = false;
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
  }
  return { bundle, detected: [...detected], complete };
}

module.exports = {
  WSL_DATA_MARKERS,
  MARKER_CLIENTS,
  collectWslUsage,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  listRunningWslDistros,
  probeWslState,
  wslUsageHomes
};
