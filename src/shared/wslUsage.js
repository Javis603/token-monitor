'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { emptyPeriod, extractUsageFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./reasonixPaths');
const { buildPromaPeriods, collectPromaRows } = require('./promaUsage');

const LXSS_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Lxss';

// ZCode stores usage in a SQLite DB under `.zcode/cli/db`. Tokscale discovers
// the file under a `\\wsl$` home but its SQLite read silently returns zero
// messages over the 9P redirector (same class of issue as hermes WSL homes,
// which report detected-but-empty), so the DB is staged into a local temp home
// and tokscale scans the staged copy instead. WAL sidecars are copied alongside
// so writes not yet checkpointed into the main DB are not lost; a torn copy at
// worst yields one empty scan, never a crash.
const ZCODE_CLIENT = 'zcode';
const ZCODE_DB_MARKER = '.zcode/cli/db';
const ZCODE_DB_FILES = ['db.sqlite', 'db.sqlite-wal', 'db.sqlite-shm'];
const ZCODE_STAGE_MAX_BYTES = 512 * 1024 * 1024;

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
  '.zcode/cli/db',
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
  '.zcode/cli/db': 'zcode',
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

// Copies a WSL home's zcode SQLite DB (plus WAL sidecars) into a fresh local
// temp home tokscale can read, and returns the staged home path. Throws when
// the DB is missing/unreadable or too large to stage; the caller logs and moves
// on, leaving detection-only attribution for that home.
function stageZcodeHome(home, deps = {}) {
  const mkdtempSync = deps.mkdtempSync || fs.mkdtempSync;
  const mkdirSync = deps.mkdirSync || fs.mkdirSync;
  const cpSync = deps.cpSync || fs.cpSync;
  const statSync = deps.statSync || fs.statSync;
  const dbDir = wslHomePath(home, ZCODE_DB_MARKER);
  const staged = mkdtempSync(path.join(os.tmpdir(), 'token-monitor-zcode-'));
  try {
    const stagedDbDir = path.join(staged, '.zcode', 'cli', 'db');
    mkdirSync(stagedDbDir, { recursive: true });
    for (const name of ZCODE_DB_FILES) {
      const source = `${dbDir}\\${name}`; // Windows-style join: dbDir is a \\wsl$ UNC path
      let size;
      try {
        size = statSync(source).size;
      } catch (_) {
        continue; // sidecars are optional; a missing main DB fails at the tokscale scan
      }
      if (name === 'db.sqlite' && size > ZCODE_STAGE_MAX_BYTES) {
        throw new Error(`zcode DB too large to stage (${size} bytes)`);
      }
      cpSync(source, path.join(stagedDbDir, name));
    }
    return staged;
  } catch (error) {
    try {
      fs.rmSync(staged, { recursive: true, force: true });
    } catch (_) { /* best-effort cleanup */ }
    throw error;
  }
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
  // Reasonix aggregate usage is supported on the host, but remains excluded
  // from WSL scans: Tokscale's Windows PathRoot::ReasonixHome conflicts with
  // the Linux-default `.reasonix/stats` path inside WSL. Native session files
  // are local-only as well. zcode is excluded for a different reason: its
  // SQLite DB reads empty over the 9P redirector, so WSL zcode usage is
  // collected via the staged-home scan below instead of the per-home tokscale
  // pass (also preventing double counting once tokscale's UNC read is fixed).
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  const clientsCsv = String(clients || '').split(',').map((c) => c.trim()).filter(Boolean)
    .filter((client) => client !== REASONIX_CLIENT && client !== ZCODE_CLIENT)
    .join(',');
  for (const home of wslUsageHomes(deps)) {
    // Attribution is marker-based, independent of whether a parser returns data.
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
    // ZCode usage lives in a SQLite DB, which tokscale cannot read in place
    // over `\\wsl$` (zero messages; see stageZcodeHome). Stage the DB into a
    // local temp home and scan that so WSL zcode contributes real usage, not
    // merely marker detection.
    if (tracked.has(ZCODE_CLIENT) && homeDataClients.includes(ZCODE_CLIENT) && typeof runTokscale === 'function') {
      let stagedHome = null;
      try {
        stagedHome = stageZcodeHome(home, deps);
        const stagedPeriods = {
          today: extractUsageFromTokscale(await runTokscale({ clients: ZCODE_CLIENT, flags: ['--today', '--home', stagedHome], commandTimeoutMs })),
          month: extractUsageFromTokscale(await runTokscale({ clients: ZCODE_CLIENT, flags: ['--month', '--home', stagedHome], commandTimeoutMs })),
          allTime: extractUsageFromTokscale(await runTokscale({ clients: ZCODE_CLIENT, flags: ['--since', allTimeSince, '--home', stagedHome], commandTimeoutMs }))
        };
        if (typeof decoratePeriods === 'function') decoratePeriods(stagedPeriods, home);
        bundle.today = mergePeriods(bundle.today, stagedPeriods.today);
        bundle.month = mergePeriods(bundle.month, stagedPeriods.month);
        bundle.allTime = mergePeriods(bundle.allTime, stagedPeriods.allTime);
      } catch (error) {
        if (typeof logger === 'function') logger(`wsl ZCode usage scan failed for ${home}: ${error.message}`);
      } finally {
        if (stagedHome) {
          const rmSync = deps.rmSync || fs.rmSync;
          try {
            rmSync(stagedHome, { recursive: true, force: true });
          } catch (_) { /* best-effort cleanup */ }
        }
      }
    }
    // Tokscale 4.6+ keeps explicit --home scans isolated from host-native roots,
    // so every requested client can be passed through for each discovered home.
    // Keep the empty guard because an empty --client expands to all clients.
    if (clientsCsv.length === 0 || typeof runTokscale !== 'function') continue;
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
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
  }
  return { bundle, detected: [...detected] };
}

module.exports = {
  WSL_DATA_MARKERS,
  MARKER_CLIENTS,
  ZCODE_DB_MARKER,
  collectWslUsage,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  listRunningWslDistros,
  probeWslState,
  stageZcodeHome,
  wslUsageHomes
};
