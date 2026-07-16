'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
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

// Clients whose tokscale `--home` scan can fall back to a HOST-native database
// that ignores `--home`, mapped to the WSL-home file whose presence suppresses
// that fallback. Only `zed` qualifies among tracked clients: tokscale 3.1.3's
// Windows build, even with `--home` (use_env_roots=false), unconditionally
// reads the host's %LOCALAPPDATA%\Zed\threads\threads.db when the WSL home has
// no Linux Zed DB (scanner.rs #[cfg(target_os="windows")] block, ignores
// use_env_roots). Passing `zed` to a home that lacks its own threads.db would
// re-read the host's native Zed usage once per such home and `mergePeriods`
// would add the duplicates — so we drop `zed` from a home's scan unless that
// exact file exists. tokscale checks the DB as a *file* (xdg.is_file()), so an
// empty `threads/` directory does NOT suppress the fallback; the gate is the
// file itself. (macOS has the same cfg fallback but no WSL scanning, so it can
// never double-count.) Every non-listed client is passed through untouched so
// tokscale's own alternate-root handling is preserved.
const WSL_HOST_FALLBACK_GATES = {
  zed: '.local/share/zed/threads/threads.db'
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
  return [...ids];
}

// Scope the requested client CSV for one WSL home: pass every client through
// untouched EXCEPT a host-fallback-gated client (zed) whose gate file is absent
// in this home — dropping it prevents tokscale from re-reading the host-native
// DB and double-counting (see WSL_HOST_FALLBACK_GATES). Returns a CSV string.
function clientsForHomeScan(clientsCsv, home, existsSync) {
  const requested = String(clientsCsv || '').split(',').map((c) => c.trim()).filter(Boolean);
  const kept = requested.filter((client) => {
    const gate = WSL_HOST_FALLBACK_GATES[client];
    if (!gate) return true; // not host-fallback-prone — always pass through
    return existsSync(wslHomePath(home, gate));
  });
  return kept.join(',');
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
  const { clients, trackedClients = clients, allTimeSince, commandTimeoutMs, now, runTokscale, logger, decoratePeriods } = options;
  const buildProma = options.buildPromaPeriods || buildPromaPeriods;
  const collectProma = options.collectPromaRows || collectPromaRows;
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const bundle = emptyWslBundle();
  const detected = new Set();
  if (!trackedClients) return { bundle, detected: [] };
  // Only attribute markers for clients the user is actually tracking — a marker
  // for an untracked client must not surface in the panel.
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  for (const home of wslUsageHomes(deps)) {
    // Attribution: every marker hit in this home counts as "detected", even if
    // clientsForHomeScan drops it from the scan (e.g. a zed-only home with no
    // threads.db) — detection is marker-based, independent of whether we scan.
    const homeDataClients = homeHasData(home, existsSync, readdirSync);
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
        if (typeof logger === 'function') logger(`wsl Proma usage parse failed for ${home}: ${error.message}`);
      }
    }
    // Pass the requested clients through, dropping only a host-fallback-gated
    // client (zed) whose gate file is missing here — otherwise tokscale's
    // Windows Zed scanner would re-read the host %LOCALAPPDATA% DB and
    // mergePeriods would add that native usage once per such home. An empty
    // result means the request was zed-only and this home has no WSL Zed DB, so
    // there's nothing to scan — skip rather than pass an empty --client
    // (tokscale would expand that to ALL clients).
    const homeClientsCsv = clientsForHomeScan(clients, home, existsSync);
    if (homeClientsCsv.length === 0 || typeof runTokscale !== 'function') continue;
    try {
      // Serial on purpose (issue #15): never run these concurrently.
      const todayJson = await runTokscale({ clients: homeClientsCsv, flags: ['--today', '--home', home], commandTimeoutMs });
      const monthJson = await runTokscale({ clients: homeClientsCsv, flags: ['--month', '--home', home], commandTimeoutMs });
      const allTimeJson = await runTokscale({ clients: homeClientsCsv, flags: ['--since', allTimeSince, '--home', home], commandTimeoutMs });
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
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
  }
  return { bundle, detected: [...detected] };
}

module.exports = {
  WSL_DATA_MARKERS,
  WSL_HOST_FALLBACK_GATES,
  MARKER_CLIENTS,
  clientsForHomeScan,
  collectWslUsage,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  listRunningWslDistros,
  probeWslState,
  wslUsageHomes
};
