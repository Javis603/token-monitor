'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { simpleHostSourceRoots } = require('./clientSourceRegistration');
const { normalizeCustomScanPaths } = require('./customScanPaths');
const { tokscaleConfigDir, tokscaleHomeDir } = require('./tokscaleConfig');
const { claudeSessionRoots } = require('./providers/claude/paths');
const { hermesProfileWatchDirs, resolveHermesHome } = require('./providers/hermes/profiles');
const { kimiCodeSessionsHome, kimiWorkSessionsRoots } = require('./providers/kimi/sessionMetadata');
const { qoderCnDataPaths } = require('./providers/qodercn/usage');
const { resolveReasonixStatsDir, REASONIX_SOURCE_CHECK_ID } = require('./providers/reasonix/paths');
const { resolveDshSessionsDir, DSH_SOURCE_CHECK_ID } = require('./providers/dsh/paths');
const {
  DEVIN_CLI_SOURCE_CHECK_ID,
  DEVIN_DESKTOP_SOURCE_CHECK_ID,
  devinCliDbDirs,
  devinDesktopAcpDirs
} = require('./providers/devin/paths');

// Windows only: libuv asserts that the filename ReadDirectoryChangesW hands
// back starts with the directory string it was given, and calls abort() when it
// does not (src/win/fs-event.c). An 8.3 short path such as C:\Users\RUNNER~1\…
// is reported back in its long form and trips exactly that assert, taking the
// whole process down. That is a native abort, so handleWatchError can never see
// it and the polling fallback cannot save us — the only guard is to hand
// chokidar the canonical long path in the first place. Junctions reach the same
// assert by the same route. Identity off Windows, so watch roots elsewhere stay
// byte-identical to the paths tokscale reads.
function canonicalWatchPath(dir) {
  if (process.platform !== 'win32') return dir;
  try { return fs.realpathSync.native(dir); }
  catch (_) { return dir; }
}

// The exporter file may not exist when the watcher starts, so canonicalise its
// existing parent and append the original basename instead of realpathing the
// file itself. This keeps exact-file matching in the same path space as the
// canonical directory root handed to chokidar on Windows.
function canonicalWatchFilePath(file) {
  return path.join(path.resolve(canonicalWatchPath(path.dirname(file))), path.basename(file));
}

function nonBlankEnvPath(name, fallback, env = process.env) {
  const value = env[name];
  return typeof value === 'string' && value.trim() ? value : fallback;
}

function absoluteEnvPath(name, fallback, env = process.env) {
  const value = env[name];
  return typeof value === 'string' && path.isAbsolute(value) ? value : fallback;
}

function cherryStudioTranscriptRoots({ homeDir, platform = process.platform, env = process.env } = {}) {
  const home = homeDir || os.homedir();
  const appDataRoot = platform === 'win32'
    ? nonBlankEnvPath('APPDATA', path.join(home, 'AppData', 'Roaming'), env)
    : platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : absoluteEnvPath('XDG_CONFIG_HOME', path.join(home, '.config'), env);
  return [
    ['cherrystudio-transcripts', path.join(appDataRoot, 'CherryStudio', 'Data', 'Agents', '.claude', 'projects')],
    ['cherrystudio-transcripts', path.join(appDataRoot, 'CherryStudio', '.claude', 'projects')]
  ];
}

// `env` is threaded through rather than read off process.env here: every other
// resolver in clientSourceRoots() takes the caller's injected env, and a scan of
// this function that reached for the real environment would resolve a different
// root than the one its caller passed in.
function xdgDataHome(home, env = process.env) {
  return nonBlankEnvPath('XDG_DATA_HOME', path.join(home, '.local', 'share'), env);
}

// Where tokscale looks for captured `codex exec --json` output. Both defaults
// are scanned on every platform — upstream pushes them with no cfg gate, so the
// Application Support one is not a macOS variant of the .config one — and
// TOKSCALE_HEADLESS_DIR replaces the pair rather than adding to it
// (scanner.rs `headless_roots_with_env_strategy`). Neither default follows
// XDG_CONFIG_HOME: upstream spells the .config path as a literal.
//
// `optional` marks a root whose absence carries no information. Nobody has
// these unless they opted into a capture workflow, so the diagnostics panel
// hides them when they are missing rather than showing them struck through
// beside a real "Codex wrote nothing here". A configured root is the opposite:
// the user named that path, so its absence is exactly what they want to see.
function tokscaleHeadlessRoots(home) {
  const configured = nonBlankEnvPath('TOKSCALE_HEADLESS_DIR', null);
  if (configured) return [{ dir: configured, optional: false }];
  return [
    { dir: path.join(home, '.config', 'tokscale', 'headless'), optional: true },
    { dir: path.join(home, 'Library', 'Application Support', 'tokscale', 'headless'), optional: true }
  ];
}

function copilotExporterPath() {
  const configured = process.env.COPILOT_OTEL_FILE_EXPORTER_PATH;
  if (typeof configured !== 'string') return null;
  const trimmed = configured.trim();
  return trimmed ? path.resolve(trimmed) : null;
}

function hasWatchableParent(file) {
  return path.dirname(file) !== path.parse(file).root;
}

// The one derivation of the custom Copilot OTel exporter, shared by the source
// table, the watcher's ignore matcher and the attribution map. It used to exist
// in two places that canonicalised differently before comparing against
// ~/.copilot/otel, and the two answers diverge as soon as any part of that path
// is a symlink — which either leaves the exporter's parent watched with no
// pruning at all, or silently drops the exporter's own events.
//
// tokscale reads exactly the file this env var names (`path.is_file()`, no glob,
// no directory walk), so the watch is pinned to that one file. Anything under
// ~/.copilot/otel is already covered recursively and returns null here.
function copilotExporterWatch(home) {
  const file = copilotExporterPath();
  if (!file || !hasWatchableParent(file)) return null;
  const otelRoot = path.resolve(canonicalWatchPath(path.join(home, '.copilot', 'otel')));
  const canonicalFile = canonicalWatchFilePath(file);
  if (canonicalFile.startsWith(otelRoot + path.sep)) return null;
  return { file, canonicalFile, dir: path.dirname(file) };
}

function clineCliSessionRoot(home) {
  const sessionDataDir = nonBlankEnvPath('CLINE_SESSION_DATA_DIR', null);
  if (sessionDataDir) return sessionDataDir;
  const dataDir = nonBlankEnvPath('CLINE_DATA_DIR', null);
  if (dataDir) return path.join(dataDir, 'sessions');
  const clineDir = nonBlankEnvPath('CLINE_DIR', null);
  if (clineDir) return path.join(clineDir, 'data', 'sessions');
  return path.join(home, '.cline', 'data', 'sessions');
}

// Per-client data-dir candidates, keyed by client. The collector projects these
// into detection status and, after interval-only/self-synced filtering, the
// chokidar watch list; it adds Antigravity's read-only source roots separately.
// The roots are tagged with a stable id for their *kind*. One id may
// cover several paths: Copilot's workspaceStorage has a variant per platform and
// Kiro's IDE globalStorage has four, but "the VS Code workspace storage is
// missing" is the useful statement, not which spelling was probed. Absolute
// paths contain the user's home directory and never leave this process, so a
// health record carries the id instead — CLIENT_SOURCE_CHECK_IDS in
// clientHealth.js is the allowlist every id here must appear in.
function clientSourceRoots(clientsCsv, options = {}) {
  const home = options.homeDir || os.homedir();
  const platform = options.platform || process.platform;
  const env = options.env || process.env;
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const byClient = {};
  const add = (client, ...roots) => {
    if (enabled.has(client)) {
      byClient[client] = roots.map(([id, dir, sourcePath, optional, custom]) => ({
        id,
        dir,
        ...(sourcePath ? { sourcePath } : {}),
        ...(optional ? { optional: true } : {}),
        ...(custom ? { custom: true } : {})
      }));
    }
  };
  const claudeRoots = claudeSessionRoots({ homeDir: home });
  add('claude', ['claude-projects', claudeRoots.projects], ['claude-transcripts', claudeRoots.transcripts]);
  const codexHome = nonBlankEnvPath('CODEX_HOME', path.join(home, '.codex'));
  add(
    'codex',
    ['codex-sessions', path.join(codexHome, 'sessions')],
    ['codex-sessions', path.join(codexHome, 'archived_sessions')],
    ...tokscaleHeadlessRoots(home).map(({ dir, optional }) => ['codex-sessions', path.join(dir, 'codex'), null, optional])
  );
  const hermesHome = resolveHermesHome({ env: process.env, homeDir: home });
  add('hermes', ['hermes-home', hermesHome], ...hermesProfileWatchDirs(hermesHome).map((dir) => ['hermes-profile', dir]));
  // Within the default OpenCode data root, Tokscale reads the direct
  // opencode*.db family and the legacy storage/message/*/*.json source. The
  // watcher prunes the rest of this broad app data root below.
  //
  // Only the roots tokscale declares as `PathRoot::XdgData` go through this —
  // opencode, zed, kilo and micode (clients.rs), plus the CodeBuddy extension
  // logs it resolves via `dirs::data_local_dir()`. Kiro's CLI database is
  // deliberately NOT one of them: tokscale spells it as a home-relative literal
  // (`{home}/.local/share/kiro-cli/data.sqlite3`, scanner.rs), so following XDG
  // there would watch a directory it never reads. The split is upstream's, not
  // an oversight — check clients.rs before adding or removing a root here.
  // The XDG fallback hangs off Tokscale's *effective* home, not the Win32
  // profile. A normal scan passes no --home, so the CLI hands the scanner
  // `paths::home_dir()`, and on Windows that returns an absolute native $HOME
  // in preference to the user profile (paths.rs home_dir()). Deriving the
  // fallback from os.homedir() instead pointed the watcher and the health check
  // at the profile while the scan read the $HOME tree, so Amp could show
  // `detected` next to usage collected from another directory.
  const tokscaleHome = tokscaleHomeDir({ env, platform, homeDir: home });
  const xdgHome = xdgDataHome(tokscaleHome, env);
  add('opencode', ['opencode-data', path.join(xdgHome, 'opencode')]);
  add('openclaw', ['openclaw-agents', path.join(home, '.openclaw', 'agents')]);
  // Amp (Sourcegraph / AmpCode): tokscale reads the XDG-data root on every
  // platform — clients.rs declares PathRoot::XdgData + relative "amp/threads",
  // pattern T-*.json (the thread JSON holds a usageLedger and per-assistant-
  // message usage). So this follows XDG_DATA_HOME like opencode/zed/kilo rather
  // than a home-relative literal; a Windows or macOS install keeps the XDG
  // convention instead of an Application Support tree.
  add('amp', ['amp-threads', path.join(xdgHome, 'amp', 'threads')]);
  // Droid (Factory): tokscale reads the home-relative ~/.factory/sessions tree on
  // every platform (clients.rs PathRoot::Home). The Factory desktop app is an
  // Electron shell over the same bundled droid kernel and keeps no session data
  // of its own, so this one root covers both.
  add('droid', ...simpleHostSourceRoots('droid', home));
  // Tokscale resolves these two caches differently and the split is deliberate
  // upstream, so mirror it rather than picking whichever looks tidier:
  //   cursor.rs      — `home_dir().join(".config/tokscale/cursor-cache")`, a
  //                    home-relative literal that never consults
  //                    `get_config_dir()`. On Windows that is
  //                    `%USERPROFILE%\.config\tokscale\`, not `%APPDATA%\tokscale\`,
  //                    and TOKSCALE_CONFIG_DIR does not move it.
  //   antigravity.rs — `paths::get_config_dir().join("antigravity-cache")`,
  //                    routed that way on purpose so an isolated profile covers
  //                    the sync cache too.
  const tokscaleConfigRoot = tokscaleConfigDir({ env, platform, homeDir: home });
  add('cursor', ['tokscale-cursor-cache', path.join(tokscaleHome, '.config', 'tokscale', 'cursor-cache')]);
  add('antigravity', ['tokscale-antigravity-cache', path.join(tokscaleConfigRoot, 'antigravity-cache')]);
  // A whitespace-only KIMI_CODE_HOME counts as unset, matching tokscale: it
  // joins `sessions` onto the raw value, so a blank export would resolve to the
  // root-level /sessions and hide the real one.
  const kimiCodeRoot = kimiCodeSessionsHome(home, { env });
  const kimiWorkRoots = kimiWorkSessionsRoots(home, platform, env);
  add(
    'kimi',
    ['kimi-sessions', path.join(home, '.kimi', 'sessions')],
    ['kimi-code-sessions', kimiCodeRoot],
    ...kimiWorkRoots.map((root) => ['kimi-code-sessions', root, null, true])
  );
  add('qwen', ...simpleHostSourceRoots('qwen', home));
  const grokHome = nonBlankEnvPath('GROK_HOME', path.join(home, '.grok'));
  add(
    'grok',
    ['grok-sessions', path.join(grokHome, 'sessions')],
    ['grok-unified-log', path.join(grokHome, 'logs'), path.join(grokHome, 'logs', 'unified.jsonl')]
  );
  // Tokscale 4.5.2 also parses VS Code Copilot Chat JSONL under each
  // workspaceStorage/*/chatSessions directory. Watch the workspaceStorage roots
  // so newly created workspaces are picked up; watchIgnoreMatcher prunes every
  // sibling except chatSessions + workspace.json to keep polling bounded.
  const copilotWorkspaceRoots = [
    path.join(home, 'Library', 'Application Support', 'Code', 'User', 'workspaceStorage'),
    path.join(home, '.config', 'Code', 'User', 'workspaceStorage'),
    ...(process.platform === 'win32'
      ? [path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'workspaceStorage')]
      : []),
    path.join(home, 'AppData', 'Roaming', 'Code', 'User', 'workspaceStorage')
  ];
  const copilotOtelRoot = path.join(home, '.copilot', 'otel');
  const copilotRoots = [
    ['copilot-otel', copilotOtelRoot],
    ['copilot-data', path.join(home, '.copilot'), path.join(home, '.copilot', 'data.db')],
    ['copilot-session-store', path.join(home, '.copilot'), path.join(home, '.copilot', 'session-store.db')],
    ...[...new Set(copilotWorkspaceRoots)].map((dir) => ['vscode-workspace-storage', dir])
  ];
  // The parent is the watch root because the exporter file may not exist yet;
  // the exact file is the source. watchAttributionRootsForClients() keeps that
  // parent from becoming a copilot attribution prefix — it is an arbitrary
  // user-chosen directory and can be $HOME.
  const exporter = copilotExporterWatch(home);
  if (exporter) copilotRoots.push(['copilot-otel-exporter', exporter.dir, exporter.file]);
  add('copilot', ...copilotRoots);
  // Pi and Oh My Pi are two products with two fixed roots. Oh My Pi reads
  // PI_CODING_AGENT_DIR too, but so does Pi — which is exactly why Tokscale
  // keeps its root fixed and ignores that variable for `omp`; mirror that here
  // rather than inventing an env override the scan does not honor.
  add('pi', ...simpleHostSourceRoots('pi', home));
  add('omp', ...simpleHostSourceRoots('omp', home));
  // Zed: tokscale reads the XdgData root on every platform AND the native macOS
  // (Application Support) / Windows (LOCALAPPDATA) roots (see tokscale scanner.rs
  // cfg(macos)/cfg(windows) blocks) — watch all three so native mac/win users get
  // seconds-level refresh and a correct waiting/missing status.
  add(
    'zed',
    ['zed-threads', path.join(xdgHome, 'zed', 'threads')],
    ['zed-threads', path.join(home, 'Library', 'Application Support', 'Zed', 'threads')],
    ['zed-threads', path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Zed', 'threads')]
  );
  // Kilo is one Token Monitor client backed by two Tokscale sources. `kilo`
  // reads the CLI's XDG-data SQLite database, while `kilocode` reads the VS Code
  // extension's Linux/local and remote task roots. Keep the native macOS and
  // Windows VS Code roots out until Tokscale scans them; otherwise they would be
  // dead watches and false presence signals.
  add(
    'kilo',
    ['kilo-db', path.join(xdgHome, 'kilo'), path.join(xdgHome, 'kilo', 'kilo.db')],
    ['kilocode-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')],
    ['kilocode-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'kilocode.kilo-code', 'tasks')]
  );
  add('commandcode', ...simpleHostSourceRoots('commandcode', home));
  // MiMo: tokscale 4.8.0 unions the XDG data dir with orca's hook-sandbox
  // copy (scanner.rs `discover_micode_dbs_in_dirs`), and that copy can hold
  // sessions the XDG one is missing. Watch both so an orca-driven install still
  // refreshes in seconds; the orca root only exists on macOS in practice and a
  // missing dir is dropped by watchClientRootsForClients.
  add(
    'mimo',
    ['mimocode-data', path.join(xdgHome, 'mimocode')],
    ['mimocode-orca-data', path.join(home, 'Library', 'Application Support', 'orca', 'mimocode-hooks', 'shared', 'data')]
  );
  const zcodeDbDir = path.join(home, '.zcode', 'cli', 'db');
  add(
    'zcode',
    ['zcode-projects', path.join(home, '.zcode', 'projects')],
    ['zcode-cli-db', zcodeDbDir, path.join(zcodeDbDir, 'db.sqlite')]
  );
  // CodeBuddy (Tencent): tokscale reads the home-relative CLI/WebUI JSONL dir on
  // every platform, plus the IDE / VS Code extension logs under a platform-
  // specific CodeBuddyExtension/Logs root (scanner.rs). Watch both so CLI and
  // IDE usage each refresh in seconds; the shared Code/logs tree is deliberately
  // not watched (too broad for polling — full ticks still scan it). No --home
  // host-DB fallback, so every root is safe to watch cross-platform.
  // Two extension-log roots, because tokscale scans two (scanner.rs). It seeds
  // the list with the home-relative Windows-shaped path on EVERY platform, and
  // only then adds the native `dirs::data_local_dir()` root — so a home carried
  // over from Windows is scanned on macOS/Linux too, and watching only the
  // native one would let the periodic scan see usage the watcher never does.
  //
  // `dirs::data_local_dir()` is %LOCALAPPDATA% on Windows, Application Support
  // on macOS, and the XDG data home on Linux, so the Linux arm follows
  // XDG_DATA_HOME rather than a hardcoded .local/share. Being a `dirs` lookup
  // rather than a path literal is why it does not appear in tokscale's strings.
  //
  // On Windows the two normally resolve to the same directory and the Set
  // collapses them; elsewhere watchClientRootsForClients drops whichever is
  // absent, which is the usual case for the Windows-shaped one.
  const codebuddyExtLogRoots = [
    path.join(home, 'AppData', 'Local', 'CodeBuddyExtension', 'Logs'),
    process.platform === 'win32'
      ? path.join(process.env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'CodeBuddyExtension', 'Logs')
      : process.platform === 'darwin'
        ? path.join(home, 'Library', 'Application Support', 'CodeBuddyExtension', 'Logs')
        : path.join(xdgHome, 'CodeBuddyExtension', 'Logs')
  ];
  add(
    'codebuddy',
    ['codebuddy-projects', path.join(home, '.codebuddy', 'projects')],
    ...[...new Set(codebuddyExtLogRoots)].map((dir) => ['codebuddy-extension-logs', dir])
  );
  // WorkBuddy (Tencent): watch only the detailed session dirs (projects/*.jsonl,
  // the preferred source) — not the whole app homes, whose config / auth churn
  // would add polling load and spurious ticks with no usage change. WorkBuddy
  // 5.5 moved to ~/.workbuddy-ai; keep the legacy ~/.workbuddy root because
  // tokscale 4.17.0 still scans both. A db-only install still refreshes via the
  // periodic full tick; the WSL markers stay broader so those homes are found.
  add(
    'workbuddy',
    ['workbuddy-projects', path.join(home, '.workbuddy', 'projects')],
    ['workbuddy-projects', path.join(home, '.workbuddy-ai', 'projects')]
  );
  // Proma — session transcripts at ~/.proma/agent-sessions/*.jsonl
  add('proma', ['proma-sessions', path.join(home, '.proma', 'agent-sessions')]);
  // Qoder CN — SQLite DB under the platform Application Support dir.
  const qoderCnPaths = qoderCnDataPaths({ homeDir: home, platform: process.platform, env: process.env });
  add('qodercn', ...qoderCnPaths.dbPaths.map((dbPath) => ['qodercn-db', path.dirname(dbPath), dbPath]));
  add('reasonix', [
    REASONIX_SOURCE_CHECK_ID,
    resolveReasonixStatsDir({ env: process.env, homeDir: home, platform: process.platform, cwdDir: process.cwd() })
  ]);
  // DeepSeek Harness (DSH) — zstd JSONL session transcripts at
  // `<dshHome>/sessions/` (default `~/.dsh`, overridable via `DSH_HOME`).
  add('dsh', [
    DSH_SOURCE_CHECK_ID,
    resolveDshSessionsDir({ env: process.env, homeDir: home, platform: process.platform })
  ]);
  // Kiro (AWS): tokscale reads home-relative roots — the sessions tree used by
  // both CLI and IDE, the Kiro IDE globalStorage root (native macOS / Linux /
  // Windows), and the kiro-cli sqlite dir. None falls back to a host-absolute
  // path under --home (unlike Zed), so every root remains a valid source and
  // presence signal. The globalStorage kind is deliberately interval-only in
  // clientWatchCandidates() because real trees can contain tens of thousands of
  // files; the sessions and sqlite roots retain seconds-level refresh.
  //
  // Note the deliberate Kiro-vs-kiro casing asymmetry below (do not "fix" it to
  // list both cases everywhere): tokscale scans both `Kiro` and `kiro` cased
  // globalStorage roots, but watchPathsForClients filters by dirExists, so the
  // COST of listing both differs by filesystem:
  //   - Linux/WSL (case-sensitive): a missing variant is filtered out at zero
  //     cost, and a real lowercase build is genuinely distinct — so list BOTH
  //     `.config/Kiro` and `.config/kiro` (free insurance for the case ambiguity
  //     that tokscale scanning both already signals exists in the wild).
  //   - macOS/Windows (case-insensitive): `Kiro` and `kiro` resolve to the SAME
  //     dir, so both would pass dirExists and double-watch one directory with no
  //     functional gain — so list only the canonical `Kiro` (it already resolves
  //     a lowercase install on these filesystems). Same reason zed lists one case.
  // Usage counting is unaffected either way: full scans run tokscale, which reads
  // every root; the watch list only governs refresh latency + the presence dot.
  // (APPDATA || home AppData\Roaming mirrors how cline resolves the Windows root.)
  add(
    'kiro',
    ['kiro-sessions', path.join(home, '.kiro', 'sessions')],
    ['kiro-ide-globalstorage', path.join(home, 'Library', 'Application Support', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(home, '.config', 'kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-ide-globalstorage', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Kiro', 'User', 'globalStorage', 'kiro.kiroagent')],
    ['kiro-cli-data', path.join(home, '.local', 'share', 'kiro-cli')],
    ['kiro-cli-data', path.join(home, 'Library', 'Application Support', 'kiro-cli')]
  );
  add(
    'cline',
    ['cline-tasks', path.join(home, '.config', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, 'Library', 'Application Support', 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Code', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-tasks', path.join(home, '.vscode-server', 'data', 'User', 'globalStorage', 'saoudrizwan.claude-dev', 'tasks')],
    ['cline-cli-sessions', clineCliSessionRoot(home)]
  );
  // Cherry Studio (Electron desktop) writes standard Claude Code transcripts
  // under its per-user app-data directory: %APPDATA%\CherryStudio\.claude\
  // projects on Windows, ~/Library/Application Support/CherryStudio/.claude/
  // projects on macOS, and $XDG_CONFIG_HOME/CherryStudio/.claude/projects (or
  // ~/.config) on Linux — mirroring the `PathRoot::AppData` resolution in
  // tokscale's clients.rs. tokscale's dedicated cherrystudio parser reads
  // these files (deduping the same API call appended 3-4 times per streaming
  // response) and tags them as `cherrystudio`.
  //
  // Cherry Studio V2 (2026-08) moved live transcripts to
  // `<appdata>/CherryStudio/Data/Agents/.claude/projects`; the legacy root
  // keeps the pre-V2 snapshot. Both are watched; tokscale dedupes same-named
  // sessions (V2 copy wins, legacy fills in sessions V2 lacks).
  const cherryRoots = cherryStudioTranscriptRoots({
    homeDir: home,
    platform: options.platform || process.platform,
    env: options.env || process.env
  });
  add(
    'cherrystudio',
    ...cherryRoots
  );
  // LM Studio's OpenAI-compatible local server writes nested monthly `.log`
  // files under this root. Tokscale's PathRoot::EnvVar treats a blank override
  // as unset, so keep the watcher and source-health path on the same fallback.
  const lmStudioHome = nonBlankEnvPath('LM_STUDIO_HOME', path.join(home, '.lmstudio'), env);
  add('lmstudio', ['lmstudio-server-logs', path.join(lmStudioHome, 'server-logs')]);
  const unslothHome = nonBlankEnvPath('UNSLOTH_STUDIO_HOME', path.join(home, '.unsloth', 'studio'), env);
  add('unsloth', ['unsloth-db', unslothHome, path.join(unslothHome, 'studio.db')]);
  // Devin (Cognition): tokscale splits the product into two scanners, both
  // mirrored here — devin-cli reads `devin/cli/sessions.db` under the XDG data
  // root on every platform plus %APPDATA%/devin/cli on Windows and the
  // unconditional home-relative AppData/Roaming spelling
  // (scanner.rs devin_cli_additional_roots); devin-desktop reads the ACP
  // `acp-events` NDJSON dirs across the macOS Application Support root, both
  // .config casings, and the Windows Roaming roots
  // (devin_desktop_additional_roots). The bare `devin` id is ours alone —
  // tokscaleClientMapping expands it to the two tokscale ids, and the db root
  // pins sessions.db as the source since the scanner resolves that exact file.
  const devinRoots = {
    cli: devinCliDbDirs({ homeDir: tokscaleHome, platform, env }),
    desktop: devinDesktopAcpDirs({ homeDir: tokscaleHome, platform, env })
  };
  add(
    'devin',
    ...devinRoots.cli.map((dir) => [DEVIN_CLI_SOURCE_CHECK_ID, dir, path.join(dir, 'sessions.db')]),
    ...devinRoots.desktop.map((dir) => [DEVIN_DESKTOP_SOURCE_CHECK_ID, dir])
  );
  const customScanPaths = normalizeCustomScanPaths(options.customScanPaths, { platform });
  for (const [client, dirs] of Object.entries(customScanPaths)) {
    if (!enabled.has(client)) continue;
    const roots = byClient[client] || (byClient[client] = []);
    roots.push(...dirs.map((dir) => ({ id: 'custom-scan-path', dir, custom: true })));
  }
  return byClient;
}

module.exports = {
  canonicalWatchPath,
  cherryStudioTranscriptRoots,
  clientSourceRoots,
  copilotExporterWatch
};
