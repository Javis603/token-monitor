'use strict';

const fs = require('node:fs');
const { execFileSync } = require('node:child_process');
const { throwIfAborted } = require('./abortSignal');
const { emptyPeriod, extractUsageFromTokscale, extractUsageBundleFromTokscale, mergePeriods } = require('./usage');
const { REASONIX_CLIENT } = require('./providers/reasonix/paths');
const { WSL_DATA_MARKERS, MARKER_CLIENTS } = require('./clientSourceRegistration');
const { isMcodeProfileDir } = require('./providers/mcode/paths');

const WSL_EXCLUDED_CLIENTS = new Set([REASONIX_CLIENT, 'catpaw', 'qodercn']);

// Read WSL transcript metadata from identities already returned by the joint
// scan; no second Claude token report is needed. Metadata has no additive usage.
const CLAUDE_METADATA_FIELDS = [
  'client', 'sessionId', 'title', 'sessionKind', 'projectId', 'projectLabel',
  'startedAt', 'lastUsedAt', 'parentSessionId', 'parentClient', 't3ThreadId',
  'contextTokens', 'contextWindow', 'promptCache', 'turnEnded', 'liveActivity', 'archived'
];

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

function wslUsageHomes(deps = {}, runningDistros = listRunningWslDistros(deps)) {
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const existsSync = deps.existsSync || fs.existsSync;
  const homes = [];
  for (const distro of runningDistros) {
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

// Keep source discovery out of watch ticks. The scanner can join fresh host
// events with these sources' cached messages without opening their UNC paths.
function discoverWslClaudeSources(previous = [], deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const runningDistros = listRunningWslDistros(deps);
  const homes = wslUsageHomes(deps, runningDistros);
  for (const { home } of previous) {
    if (homes.includes(home) || !runningDistros.some((distro) =>
      home.toLowerCase().startsWith(`\\\\wsl$\\${distro}\\`.toLowerCase()))) continue;
    try {
      // A readable running home can have lost every data marker. Its old roots
      // must still be attempted so the scanner can prune confirmed deletions.
      // Child read failures must use the scanner's cached fallback; a readable
      // home is not proof that a transcript root can be scanned successfully.
      // Never probe a stopped distro; an unreadable home stays cached-only.
      readdirSync(home);
      homes.push(home);
    } catch (_) { /* unreachable is not evidence of deletion */ }
  }
  const sources = new Map(previous.map((source) => [source.home, source]));
  const activeRoots = [];
  const sharedClaudeHomes = [];
  for (const home of homes) {
    // Extra transcript roots cannot represent Desktop's IndexedDB billing.
    // Preserve the existing whole-home scan for those homes until the scanner
    // can join that source too; never silently discard its usage.
    const desktop = WSL_DATA_MARKERS.some((marker) =>
      MARKER_CLIENTS[marker] === 'claude' && !marker.startsWith('.claude/')
      && existsSync(wslHomePath(home, marker)));
    const roots = ['.claude/projects', '.claude/transcripts'].map((dir) => wslHomePath(home, dir));
    if (desktop || roots.some((root) => /[,\0\r\n]/.test(root))) {
      sources.delete(home);
      continue;
    }
    const source = { home, roots };
    sources.set(home, source);
    sharedClaudeHomes.push(home);
    activeRoots.push(...roots);
  }
  return { homes, sources: [...sources.values()], activeRoots, sharedClaudeHomes };
}

async function collectWslUsage(options = {}, deps = {}) {
  const { clients, trackedClients = clients, allTimeSince, commandTimeoutMs, runTokscale, logger, decoratePeriods } = options;
  const existsSync = deps.existsSync || fs.existsSync;
  const readdirSync = deps.readdirSync || fs.readdirSync;
  const bundle = emptyWslBundle();
  const detected = new Set();
  const sharedWithData = new Set();
  throwIfAborted(options.signal, 'WSL usage scan aborted');
  if (!trackedClients) return { bundle, detected: [] };
  // Only attribute markers for clients the user is actually tracking — a marker
  // for an untracked client must not surface in the panel.
  // Reasonix aggregate usage is supported on the host, but remains excluded
  // from WSL scans: Tokscale's Windows PathRoot::ReasonixHome conflicts with
  // the Linux-default `.reasonix/stats` path inside WSL. Native session files
  // are local-only as well. Qoder CN is excluded for the same kind of reason:
  // under a Windows host the fork resolves its legacy database from the host's
  // APPDATA rather than from --home, so a WSL scan would recount host usage.
  const tracked = new Set(String(trackedClients).split(',').map((c) => c.trim()).filter(Boolean));
  const scanClients = String(clients || '').split(',').map((c) => c.trim()).filter(Boolean)
    .filter((client) => !WSL_EXCLUDED_CLIENTS.has(client));
  const sharedClaudeHomes = new Set(options.sharedClaudeHomes || []);
  for (const home of options.homes || wslUsageHomes(deps)) {
    throwIfAborted(options.signal, 'WSL usage scan aborted');
    // Attribution is marker-based, independent of whether a parser returns data.
    const homeDataClients = homeHasData(home, existsSync, readdirSync);
    for (const id of homeDataClients) {
      if (tracked.has(id)) detected.add(id);
    }
    try {
      if (sharedClaudeHomes.has(home) && options.sharedClaudePeriods) {
        const metadata = Object.fromEntries(Object.entries(options.sharedClaudePeriods).map(([name, period]) => [name, {
          ...emptyPeriod(), sessions: Object.fromEntries(Object.entries(period.sessions || {})
            .filter(([, session]) => session.client === 'claude')
            .map(([key, session]) => [key, { client: 'claude', sessionId: session.sessionId }]))
        }]));
        if (typeof decoratePeriods === 'function') decoratePeriods(metadata, home);
        for (const [name, period] of Object.entries(metadata)) {
          for (const [key, session] of Object.entries(period.sessions)) {
            if (!session.lastUsedAt && !session.startedAt && !session.title) continue;
            sharedWithData.add('claude');
            bundle[name].sessions[key] = Object.fromEntries(CLAUDE_METADATA_FIELDS
              .filter((field) => Object.hasOwn(session, field)).map((field) => [field, session[field]]));
          }
        }
      }
    } catch (error) {
      throwIfAborted(options.signal, 'WSL metadata read aborted');
      if (typeof logger === 'function') logger(`wsl Claude metadata failed for ${home}: ${error.message}`);
    }
    const clientsCsv = scanClients.filter((client) => client !== 'claude' || !sharedClaudeHomes.has(home)).join(',');
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
      const allTimeJson = await runTokscale({ clients: clientsCsv, flags: ['--since', allTimeSince, '--home', home], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      const rawPeriods = { today: todayJson, month: monthJson, allTime: allTimeJson };
      const periods = Object.fromEntries(Object.entries(rawPeriods).map(([name, json]) => {
        if (!sharedClaudeHomes.has(home)) return [name, extractUsageFromTokscale(json)];
        // Synthetic selects gateway traffic across clients, including Claude
        // even when omitted from --client. The joint scan already owns those
        // rows; retain every other source using the scanner's client identity.
        const { byClient } = extractUsageBundleFromTokscale(json);
        const period = Object.entries(byClient).reduce((sum, [client, usage]) =>
          client === 'claude' ? sum : mergePeriods(sum, usage), emptyPeriod());
        return [name, period];
      }));
      if (typeof decoratePeriods === 'function') decoratePeriods(periods, home);
      bundle.today = mergePeriods(bundle.today, periods.today);
      bundle.month = mergePeriods(bundle.month, periods.month);
      bundle.allTime = mergePeriods(bundle.allTime, periods.allTime);
    } catch (error) {
      throwIfAborted(options.signal, 'WSL usage scan aborted');
      if (typeof logger === 'function') logger(`wsl usage scan failed for ${home}: ${error.message}`);
    }
  }
  return { bundle, detected: [...detected], ...(sharedWithData.size ? { sharedWithData: [...sharedWithData] } : {}) };
}

module.exports = {
  WSL_DATA_MARKERS,
  MARKER_CLIENTS,
  collectWslUsage,
  discoverWslClaudeSources,
  emptyWslBundle,
  homeHasData,
  isWslInstalled,
  listRunningWslDistros,
  probeWslState,
  wslUsageHomes
};
