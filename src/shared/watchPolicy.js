'use strict';

// Watch policy and the one chokidar instance factory.
//
// The watcher child is deliberately a separate process so chokidar's
// descriptors and native memory never sit in the owner. It must therefore load
// only this module: requiring collector.js here would pull the entire
// collection graph (usage, history, session metadata, providers) into a process
// whose only job is to answer path predicates. Keep new watch policy here and
// have collector.js re-export it for existing callers and tests.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { senpiWatchSources } = require('./providers/senpi/paths');
const {
  antigravityCliDataDir, canonicalWatchPath, canonicalWatchFilePath,
  clientSourceRoots, copilotExporterWatch
} = require('./clientSources');
const { dirExists } = require('./clientSourceObservations');
const { normalizeCustomScanPaths } = require('./customScanPaths');
const { activityWatchIgnored } = require('./sessionActivityWatch');
const { antigravityDataRoots } = require('./providers/antigravity/selfSync');
const { antigravityConversationSummaryCandidates } = require('./providers/antigravity/sessionMetadata');
const { cursorDesktopWatchRoots, isCursorDesktopStateWrite } = require('./providers/cursor/desktopState');
const { catpawDatabaseName } = require('./providers/catpaw/paths');
const { isDshSessionLogName } = require('./providers/dsh/sessionFiles');
const {
  isReasonixNativeSessionSidecar, reasonixNativeSessionWatchRoots
} = require('./providers/reasonix/watchPaths');
const { SELF_SYNC_KINDS } = require('./selfSyncThrottle');

// A volume root already ends with the platform separator ("/" or "D:\"), so
// appending another one would build a prefix no descendant can match.
function descendantPrefix(root) {
  return root.endsWith(path.sep) ? root : root + path.sep;
}

// GlobalStorage contains legacy conversations beside arbitrary project-file
// checkpoints. Tokscale still traverses the complete tree on each Kiro scan;
// pruning watcher paths alone cannot make frequent scans cheap. Keep this
// source on interval/manual collection until the scanner bounds it too.
const INTERVAL_ONLY_SOURCE_CHECK_IDS = new Set(['kiro-ide-globalstorage']);

// The watcher only ever wants paths, so it keeps its original shape rather than
// learning about check ids it would immediately discard.
function clientWatchCandidates(clientsCsv, options = {}) {
  const senpiSources = String(clientsCsv).split(',').map(id => id.trim()).includes('senpi')
    ? options.senpiSources || senpiWatchSources(options) : null;
  if (senpiSources) options = { ...options, senpiSources };
  const byClient = {};
  for (const [client, roots] of Object.entries(clientSourceRoots(clientsCsv, options))) {
    // The Copilot data root already keeps its otel and session-state children
    // through the matcher below. Keep both as diagnostic/source checks, but do not
    // hand overlapping parent and child paths to chokidar or it may install
    // duplicate native watches over the same tree.
    byClient[client] = roots
      .filter((root) => (
        !(client === 'copilot' && ['copilot-otel', 'copilot-session-state'].includes(root.id))
        && !INTERVAL_ONLY_SOURCE_CHECK_IDS.has(root.id)
      ))
      .map((root) => root.dir);
  }
  if (senpiSources) byClient.senpi = [...new Set([...byClient.senpi, ...senpiSources.dirs])];
  return byClient;
}

// Clients whose dirs are tokscale caches written only by our own maybeSync* calls.
// Watching them turns every tick into the trigger for the next one (issue #15).
const SELF_SYNCED_CLIENTS = new Set(SELF_SYNC_KINDS);

// Native activity sources that request a self-sync, keyed by client. Cursor's
// desktop database is a signal to fetch cloud usage, while Antigravity's native
// sessions are inputs to its sync. Both caches written by us stay unwatched;
// only external source changes earn the short source-event floor.
//
// The parse-local antigravity-cli dir is deliberately not in here even though it
// shares the umbrella client id: tokscale reads it directly, so a CLI write has
// nothing to re-sync and must not pay for the subprocess.
function selfSyncSourceRootsForClients(clientsCsv, options = {}) {
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const rootsByClient = {};
  if (enabled.has('cursor')) {
    const sourceRoots = cursorDesktopWatchRoots(options).filter(dirExists);
    if (sourceRoots.length > 0) rootsByClient.cursor = sourceRoots;
  }
  if (enabled.has('antigravity')) {
    const sourceRoots = [...new Set(antigravityDataRoots(options.homeDir || os.homedir()).filter(dirExists))];
    if (sourceRoots.length > 0) rootsByClient.antigravity = sourceRoots;
  }
  return rootsByClient;
}

function antigravitySummaryWatchSources(options = {}) {
  return antigravityConversationSummaryCandidates({
    home: options.homeDir || os.homedir(),
    env: options.env || process.env
  }).map((candidate) => {
    const file = canonicalWatchFilePath(candidate);
    return { file, dir: path.dirname(file) };
  });
}

function watchClientRootsForClients(clientsCsv, options = {}) {
  const rootsByClient = {};
  const customScanPaths = normalizeCustomScanPaths(options.customScanPaths, {
    platform: options.platform || process.platform
  });
  for (const [client, dirs] of Object.entries(clientWatchCandidates(clientsCsv, options))) {
    // Cursor and Antigravity's built-in roots are caches written by our own
    // self-sync. A custom root is external input, so it must remain watchable.
    const candidates = SELF_SYNCED_CLIENTS.has(client)
      ? dirs.filter((dir) => customScanPaths[client]?.includes(dir))
      : dirs;
    const existing = [...new Set(candidates.filter(dirExists))];
    if (existing.length > 0) rootsByClient[client] = existing;
  }
  for (const [client, dirs] of Object.entries(selfSyncSourceRootsForClients(clientsCsv, options))) {
    rootsByClient[client] = [...new Set([...(rootsByClient[client] || []), ...dirs])];
  }
  // The Antigravity CLI writes parse-local SQLite that tokscale reads directly,
  // so it is also safe to watch and shares the umbrella client id. The filter
  // expands that id to antigravity-cli when the targeted scan runs.
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const antigravityCliDir = antigravityCliDataDir(options);
  if (enabled.has('antigravity') && dirExists(antigravityCliDir)) {
    rootsByClient.antigravity = [...new Set([...(rootsByClient.antigravity || []), antigravityCliDir])];
  }
  if (enabled.has('antigravity')) {
    // Watch the parent so a summary DB or WAL created after startup is seen.
    // Its policy below admits only those exact files, never the surrounding tree.
    const summaryDirs = antigravitySummaryWatchSources(options).map(({ dir }) => dir).filter(dirExists);
    if (summaryDirs.length > 0) {
      rootsByClient.antigravity = [...new Set([...(rootsByClient.antigravity || []), ...summaryDirs])];
    }
  }
  if (enabled.has('reasonix')) {
    const nativeRoots = reasonixNativeSessionWatchRoots(options);
    const existingNativeRoots = nativeRoots.filter(dirExists);
    if (existingNativeRoots.length > 0) {
      rootsByClient.reasonix = [...new Set([...(rootsByClient.reasonix || []), ...existingNativeRoots])];
    }
  }
  return rootsByClient;
}

function watchPathsForClients(clientsCsv, options = {}) {
  return [...new Set(Object.values(watchClientRootsForClients(clientsCsv, options)).flat())];
}

// The same roots, but as attribution prefixes rather than watch targets. The two
// differ for exact-file sources: a custom Copilot exporter or summary database
// has to be *watched* by its parent (the file can appear later), while attributing by that
// parent would be wrong — it is an arbitrary user-chosen path, and one pointing
// at a file in $HOME would make every other client's event also target copilot,
// turning each targeted scan into a two-client scan. The exact file attributes
// instead. The parent survives only when another copilot source already owns it
// (an exporter written straight into ~/.copilot), so `otel/` keeps its prefix.
// Takes the watch roots when the caller already has them: setupWatchers() needs
// both maps from one probe, and deriving them from two separate dirExists sweeps
// would let a directory created between the two land in one map and not the
// other — the same "two derivations of one thing" trap the exporter had.
function watchAttributionRootsForClients(clientsCsv, watchRoots = null, options = {}) {
  const rootsByClient = watchRoots || watchClientRootsForClients(clientsCsv, options);
  const attributed = { ...rootsByClient };
  if (rootsByClient.senpi) {
    const sources = options.senpiSources || senpiWatchSources(options);
    attributed.senpi = [...sources.targets.map(target => target.path), ...(normalizeCustomScanPaths(options.customScanPaths, options).senpi || [])];
  }
  const exporter = options.copilotExporter ?? copilotExporterWatch(os.homedir());
  if (exporter && rootsByClient.copilot) {
    const exporterDir = path.resolve(exporter.dir);
    const ownedByOtherSource = new Set(
      (clientSourceRoots(clientsCsv, options).copilot || [])
        .filter((root) => root.id !== 'copilot-otel-exporter')
        .map((root) => path.resolve(root.dir))
    );
    const copilot = rootsByClient.copilot
      .filter((root) => path.resolve(root) !== exporterDir || ownedByOtherSource.has(exporterDir));
    copilot.push(exporter.canonicalFile);
    attributed.copilot = [...new Set(copilot)];
  }
  if (rootsByClient.antigravity) {
    const canonicalRoot = (dir) => path.resolve(canonicalWatchPath(dir));
    const usageRoots = new Set([
      ...antigravityDataRoots(options.homeDir || os.homedir()), antigravityCliDataDir(options),
      ...(normalizeCustomScanPaths(options.customScanPaths, options).antigravity || [])
    ].map(canonicalRoot));
    const summaries = antigravitySummaryWatchSources(options);
    const summaryDirs = new Set(summaries.map(({ dir }) => dir));
    const watched = new Set(rootsByClient.antigravity.map(canonicalRoot));
    const antigravity = rootsByClient.antigravity.filter((dir) => !summaryDirs.has(canonicalRoot(dir)) || usageRoots.has(canonicalRoot(dir)));
    for (const { file, dir } of summaries) {
      if (watched.has(dir)) antigravity.push(file, `${file}-wal`);
    }
    attributed.antigravity = [...new Set(antigravity)];
  }
  return attributed;
}

function clientsForWatchPath(filePath, rootsByClient, ignoreByClient = null, copilotExporter = null, unlinkedExporter) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const matched = [];
  for (const [client, roots] of Object.entries(rootsByClient || {})) {
    // The watcher may be the only matcher that saw this alias on disk.
    if (client === 'copilot' && unlinkedExporter && unlinkedExporter === copilotExporter?.canonicalFile
      && roots.includes(unlinkedExporter)) {
      matched.push(client);
      continue;
    }
    if (ignoreByClient?.[client]?.(resolved)) continue;
    if (roots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(descendantPrefix(resolvedRoot))
        || (client === 'copilot' && resolvedRoot === copilotExporter?.canonicalFile && copilotExporter.matches(resolved));
    })) matched.push(client);
  }
  return matched;
}

// Hermes database totals also use direct logs/agent.log* siblings as per-call
// date evidence. Keep those narrow lanes and dynamically created WAL/SHM files
// under each home/profile watch root, while pruning the Desktop runtime and
// unrelated logs/cache (issue #38's unbounded polling regression).
const HERMES_DB_FILES = new Set(['state.db', 'state.db-wal', 'state.db-shm']);
// OpenClaw keeps each agent's usage sources in a small set of lanes under
// ~/.openclaw/agents/<agentId>: legacy/published JSONL under sessions/, doctor
// migration archives beside it, the current per-agent SQLite store, and Codex
// app-server rollouts under agent/codex-home and the legacy per-profile CLI
// homes at agent/cli-auth/codex/<profile>. The rest of an agent directory is
// runtime/workspace state and can contain dependency trees large enough to make
// chokidar allocate thousands of directory watches. Keep the official source
// lanes live; Tokscale's periodic full scan remains the fallback for a
// non-standard JSONL placed elsewhere under agents/.
const OPENCLAW_TRANSCRIPT_DIRS = new Set(['sessions', 'session-sqlite-import-archive']);
const OPENCLAW_AGENT_DB_WATCH_PATTERN = /^openclaw-agent\.sqlite(?:-(?:wal|shm))?$/;
// Every Codex home exposes its rollouts under these two directories: the
// built-in home, a custom root that is a home, and both homes an OpenClaw agent
// can own (`agent/codex-home` and the legacy `agent/cli-auth/codex/<profile>`).
const CODEX_HOME_TRANSCRIPT_DIRS = new Set(['sessions', 'archived_sessions']);
// OpenCode discovers only direct opencode.db / opencode-<channel>.db files.
// WAL/SHM are not database inputs to tokscale. WAL events refresh transactions
// committed before a checkpoint; scan-generated SHM events are filtered below.
const OPENCODE_DB_WATCH_PATTERN = /^opencode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// MiMo keeps a multi-gigabyte log/ tree alongside its SQLite state files.
// A plain recursive watch of ~/.local/share/mimocode storms the watcher (every
// SQLite WAL/SHM transaction is a chokidar event, the log dir holds thousands
// of rotated files). Tokscale discovers mimocode.db and
// mimocode-<channel>.db directly under each data root; the sidecars are not
// parsed. WAL writes trigger a refresh; scan-generated SHM events are filtered.
// Keep the home dir watched but ignore everything except that direct db family.
// The home root itself stays watched so a freshly created database or sidecar
// still surfaces on the next top-level readdir.
const MIMO_DB_WATCH_PATTERN = /^mimocode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// Kiro CLI and Zed expose one SQLite database at a known path. Keep their
// parent dirs watched so the database can appear after startup, but do not
// recurse through the application data trees around them.
const KIRO_DB_WATCH_PATTERN = /^data\.sqlite3(?:-(?:wal|shm))?$/;
const ZED_DB_WATCH_PATTERN = /^threads\.db(?:-(?:wal|shm))?$/;
const KILO_DB_WATCH_PATTERN = /^kilo\.db(?:-(?:wal|shm))?$/;
// Copilot is two exact databases directly under ~/.copilot, not one: `data.db`
// (desktop) and `session-store.db` (CLI, tokscale's copilot_session_store
// parser). Both are `path.is_file()` reads upstream, so the directory stays the
// watch root and each file rides along with its WAL/SHM sidecars. Leaving
// session-store.db out of this pattern prunes it from the watcher, so CLI usage
// would only appear on the next full tick instead of within the refresh window.
const COPILOT_DB_WATCH_PATTERN = /^(?:data|session-store)\.db(?:-(?:wal|shm))?$/;
const ZCODE_DB_WATCH_PATTERN = /^db\.sqlite(?:-(?:wal|shm))?$/;
const CHERRY_STUDIO_DB_WATCH_PATTERN = /^cherrystudio\.sqlite(?:-(?:wal|shm))?$/;
const UNSLOTH_DB_WATCH_PATTERN = /^studio\.db(?:-(?:wal|shm))?$/;
// Bounded to sessions.db directly under each *default* Devin CLI root; the WAL
// and SHM sidecars ride along as the live-write signal, as with every other
// direct-database client. Tokscale's own discovery walks those roots to any
// depth, so a nested sessions.db still counts toward usage — it just does not
// get a watcher or a health check, which matches where the product actually
// installs. The acp-events roots stay recursive event trees.
const DEVIN_CLI_DB_WATCH_PATTERN = /^sessions\.db(?:-(?:wal|shm))?$/;
const GOOSE_DB_WATCH_PATTERN = /^sessions\.db(?:-(?:wal|shm))?$/;
const GROK_UNIFIED_LOG_FILE = 'unified.jsonl';
// Tokscale scans only these two CodeBuddy extension log subtrees. Keep their
// recursive layout intact, but prune unrelated siblings under Logs before
// chokidar allocates watches for them.
const CODEBUDDY_EXTENSION_SOURCE_DIRS = new Set(['CodeBuddyIDE', 'VSCode']);
// Which parts of an Antigravity IDE home are worth an event. Not "what tokscale
// parses" — tokscale gets the token data over RPC from the running language
// server and only reads `brain/`+`conversations/` to enumerate session ids.
// These are the paths the IDE touches while a turn is in progress, so they are
// what tells us the synced cache went stale. The rest of the home is runtime and
// cache material (bin/, builtin/, crashes/, antigravity_state.pbtxt …) that
// would make every background write a scan trigger.
const ANTIGRAVITY_SOURCE_DIRS = new Set(['annotations', 'brain', 'conversations']);
const ANTIGRAVITY_SOURCE_FILES = new Set(['agyhub_summaries_proto.pb']);
// `brain/` is watched one level deep only. Its children are per-session working
// dirs holding plans, uploads and screenshots — on a 26-session home that is
// ~508 directories and ~780 files for ~4 changes a week, while the actual
// per-turn signal is `conversations/<id>.db-wal`. Recursing costs an inotify
// descriptor per directory on Linux, which is what makes the ENOSPC fallback to
// polling (sticky for the process) more likely, and once polling that whole tree
// gets stat'd every interval — the Hermes runaway of issue #38 in miniature.
// Watching `brain/` itself still catches a new session directory appearing.
const ANTIGRAVITY_SHALLOW_SOURCE_DIRS = new Set(['brain']);

// A watch policy answers one question about one source root: given a path
// inside it, does this source want the event? It never sees the root itself,
// which is always kept, so `parts` is a non-empty relative path already split.
//
// Roots overlap. An explicit CODEX_HOME can sit inside another client's data
// root, a custom Copilot exporter can name a file inside OpenCode's, and two
// clients can resolve to the same directory outright. chokidar's `ignored` is
// global to the instance, so every root containing a path shares one answer for
// it, and the only safe one is the union of what they read: prune when EVERY
// containing root declines the path, keep it as soon as one wants it.
//
// This replaced an ordered chain of per-client branches in which the first
// matching root answered for all of them, so overlap resolved by declaration
// order rather than by what tokscale reads. A bounded root pruned an
// equally-rooted recursive source out of existence, two bounded roots resolved
// by whichever branch was written first, and the exporter needed its own checks
// hoisted above the chain to survive a broader root declared over it.
const KEEP_EVERYTHING = () => false;
const EMPTY_SET = new Set();

// A custom root is whatever directory the user picked, and in practice that can
// be a whole projects folder (#857: ~1.1M files, mostly dependency and VCS
// trees). No agent writes a transcript into these, but every one of their
// directories costs a watch descriptor, and every file a stat once polling
// takes over. Tokscale still walks them, so a full scan misses nothing; only
// the live trigger is pruned. Built-in recursive roots keep their contract
// untouched, since their shape is the client's own.
const CUSTOM_ROOT_PRUNED_DIRS = new Set([
  '.git', '.hg', '.svn', 'node_modules', '.venv', 'venv', '__pycache__', '.tox'
]);
const pruneDependencyTrees = (parts) => parts.some((part) => CUSTOM_ROOT_PRUNED_DIRS.has(part));

// A custom root that is itself a Codex home keeps the built-in Codex contract:
// only its transcript trees are live sources. Session titles are read from the
// home's thread catalog every tick, and while Codex is idle that read-only open
// recreates the catalog's -wal/-shm; watching the rest of the home would turn
// each title lookup into another collection. The catalog is what identifies a
// home: a root without one has nothing for the lookup to open, and a `sessions`
// directory alone can belong to a parent of several homes or to another tool.
function isCodexHome(dir) {
  return [dir, path.join(dir, 'sqlite')].some((catalogDir) => {
    try {
      return fs.readdirSync(catalogDir).some((name) =>
        /^state_\d+\.sqlite$/.test(name)
        && fs.statSync(path.join(catalogDir, name), { throwIfNoEntry: false })?.isFile());
    } catch (_) { return false; }
  });
}
const pruneCodexHome = (parts) => !CODEX_HOME_TRANSCRIPT_DIRS.has(parts[0]) || pruneDependencyTrees(parts);

function ignoreDesktopTranscriptPath(parts, resolved) {
  const marker = parts.indexOf('.claude');
  const discovery = marker < 0 ? parts : parts.slice(0, marker);
  if (pruneDependencyTrees(discovery)) return true;
  if (marker >= 0 && parts.length > marker + 1
    && !['projects', 'transcripts'].includes(parts[marker + 1])) return true;

  const root = parts.reduce((parent) => path.dirname(parent), resolved);
  let current = root;
  for (let index = 0; index < parts.length; index += 1) {
    current = path.join(current, parts[index]);
    let stat;
    try { stat = fs.lstatSync(current); } catch (_) {
      // A removed directory or transcript must still invalidate the scan.
      // Missing entries cannot cause chokidar to descend into a new tree.
      return marker < 0 || parts.length <= marker + 2 ? false : !resolved.endsWith('.jsonl');
    }
    const laneRoot = marker >= 0 && index === marker + 1;
    const transcriptFile = marker >= 0 && index === parts.length - 1 && index > marker + 1;
    if (stat.isSymbolicLink()) {
      // WalkDir does not follow discovery/.claude or interior directory links.
      // Its explicitly discovered scan root and individual file links do work.
      if (!laneRoot && !transcriptFile) return true;
      try { stat = fs.statSync(current); } catch (error) {
        // A previously admitted link can outlive its target. Keep its removal
        // signal; a missing target cannot cause traversal outside the source.
        const missing = error.code === 'ENOENT' || error.code === 'ENOTDIR';
        return !missing || (!laneRoot && !resolved.endsWith('.jsonl'));
      }
      if (laneRoot ? !stat.isDirectory() : !stat.isFile()) return true;
    }
    if (index < parts.length - 1 || !transcriptFile) {
      if (!stat.isDirectory()) return true;
    } else if (!stat.isDirectory() && (!stat.isFile() || !resolved.endsWith('.jsonl'))) {
      return true;
    }
  }
  return false;
}

// Tokscale opens one exact database directly under this root instead of walking
// it. Keep the direct children it names, including WAL/SHM sidecars, so a
// database created later is still discovered. The event handler filters SHM
// for measured self-writing clients; DB/WAL changes remain usage signals.
// Never recurse into the runtime files beside it.
function directChildOnly(isSource) {
  return (parts) => parts.length > 1 || !isSource(parts[0]);
}

// Keep directories for recursive discovery, but ignore files neither usage nor
// metadata reads. Attachments, runtime databases and locks are not activity.
// Reject directory links even when their names look like sources. Missing
// source paths still pass so unlink events remain observable.
function recursiveSourceFiles(isSource) {
  return (parts, resolved) => {
    const source = isSource(parts[parts.length - 1], parts);
    try {
      const stat = fs.lstatSync(resolved);
      if (stat.isSymbolicLink()) return !source || !fs.statSync(resolved).isFile();
      return !stat.isDirectory() && !source;
    } catch (_) { return !source; }
  };
}

// Every source root of every tracked client, paired with its policy. Bounded
// roots are counted so a client set with nothing to prune can skip the matcher
// entirely rather than hand chokidar a predicate that always answers false.
function watchPolicyEntries(clientsCsv, options = {}) {
  const candidates = clientWatchCandidates(clientsCsv, options);
  const rootsByClient = clientSourceRoots(clientsCsv, options);
  const customScanPaths = normalizeCustomScanPaths(options.customScanPaths, {
    platform: options.platform || process.platform
  });
  // canonicalWatchPath must be applied here too: chokidar reports events under
  // whatever root it was handed, so a matcher built on the uncanonicalised path
  // would stop matching on Windows and silently un-prune the Hermes runtime
  // (issue #38) while the watch itself still worked.
  const canonicalRoot = (dir) => path.resolve(canonicalWatchPath(dir));
  const entries = [];
  const claimed = new Map();
  let boundedCount = 0;
  const customRoots = new Map(Object.entries(customScanPaths).map(([client, dirs]) => [
    client,
    new Set(dirs.map(canonicalRoot))
  ]));
  // Same-root duplicates within one client (Kiro's cased globalStorage spellings,
  // Zed's per-platform roots) collapse here. Duplicates ACROSS clients must not:
  // two policies on one directory is precisely the overlap the union resolves,
  // which is why `claimed` is keyed per client — an identical path under two
  // clients would otherwise let the bounded one swallow the recursive one, the
  // very failure this table replaced.
  const bound = (client, dirs, policy) => {
    if (!claimed.has(client)) claimed.set(client, new Set());
    const seen = claimed.get(client);
    // Built-in policies describe each client's default directory shape. A
    // custom root follows Tokscale's recursive extra-root contract instead,
    // even when it belongs to a client whose default root is tightly pruned.
    const boundedDirs = dirs.filter((dir) => !customRoots.get(client)?.has(canonicalRoot(dir)));
    for (const dir of boundedDirs) seen.add(dir);
    for (const root of new Set(boundedDirs.map(canonicalRoot))) {
      entries.push({ root, prefix: descendantPrefix(root), policy });
      boundedCount += 1;
    }
  };
  const withBasename = (client, basename) =>
    (candidates[client] || []).filter((dir) => path.basename(dir) === basename);

  const sourceRoots = (client, ...ids) => (rootsByClient[client] || [])
    .filter((root) => ids.includes(root.id)).map((root) => root.dir);
  // Watch the parent for late creation of COPILOT_OTEL_FILE_EXPORTER_PATH.
  // Check it before other policies can accept an overlapping path, so even
  // discovery with ignoreInitial can record the alias for a later unlink.
  const exporter = options.copilotExporter ?? copilotExporterWatch(os.homedir());
  if (candidates.copilot && exporter) bound('copilot', [exporter.dir], (_parts, resolved) => !exporter.matches(resolved));

  // Claude's parser and source fingerprint also read same-stem agent metadata.
  bound('claude', sourceRoots('claude', 'claude-projects', 'claude-transcripts'),
    recursiveSourceFiles((name) => name.endsWith('.jsonl') || name.endsWith('.meta.json')));
  // Codex compresses a finished rollout to `.jsonl.zst` beside it. chokidar
  // holds a native watcher per discovered file, so an archive that can never
  // grow again keeps a descriptor for the rest of the session — 5.8k of them on
  // a real profile. Scans still read archives, and compressing a live rollout
  // removes its watched `.jsonl`, whose unlink event already triggers the scan.
  bound('codex', sourceRoots('codex', 'codex-sessions'),
    (_parts, resolved) => path.basename(resolved).endsWith('.jsonl.zst'));
  bound('gemini', candidates.gemini || [],
    recursiveSourceFiles((name) => name.endsWith('.json') || name.endsWith('.jsonl')));
  bound('kilo', sourceRoots('kilo', 'kilo-db'), directChildOnly((name) => KILO_DB_WATCH_PATTERN.test(name)));
  // Task history supplies legacy model/agent identity beside ui_messages.json.
  const taskFiles = recursiveSourceFiles((name) => name === 'ui_messages.json' || name === 'api_conversation_history.json');
  bound('kilo', sourceRoots('kilo', 'kilocode-tasks'), taskFiles);
  bound('cline', sourceRoots('cline', 'cline-tasks'), taskFiles);
  // Cline CLI reads a sibling <session>.json manifest for model and workspace.
  bound('cline', sourceRoots('cline', 'cline-cli-sessions'), recursiveSourceFiles((name) => name.endsWith('.json')));
  bound('dsh', candidates.dsh || [], recursiveSourceFiles(isDshSessionLogName));
  // Rollups and model/session metadata can change without updates.jsonl growing.
  bound('grok', sourceRoots('grok', 'grok-sessions'),
    recursiveSourceFiles((name) => ['updates.jsonl', 'summary.json', 'signals.json', 'events.jsonl'].includes(name)));
  // Tokscale accepts session.json in sess_* directories at any depth and
  // reads messages.jsonl beside it. Keep the same discovery/link boundary.
  const kiroSessionFiles = recursiveSourceFiles((name, parts) => parts[0] === 'cli'
    ? name.endsWith('.json') || name.endsWith('.jsonl')
    : parts.length > 1 && parts[parts.length - 2].startsWith('sess_')
      && ['session.json', 'messages.jsonl'].includes(name));
  bound('kiro', sourceRoots('kiro', 'kiro-sessions'), (parts, resolved) => {
    // CLI is its own Tokscale scan root, so its root directory link is valid.
    if (parts.length === 1 && parts[0] === 'cli') return false;
    if (parts[0] !== 'cli' && parts.some((part, index) => part === 'snapshots' && index > 0 && parts[index - 1].startsWith('sess_'))) return true;
    return kiroSessionFiles(parts, resolved);
  });

  if (candidates.senpi) {
    const sources = options.senpiSources || senpiWatchSources(options);
    const targets = sources.targets.map(target => ({ ...target, path: canonicalRoot(target.path) }));
    bound('senpi', candidates.senpi, (_parts, file) => !targets.some(target =>
      file === target.path || target.path.startsWith(file + path.sep)
      || (target.recursive && file.startsWith(target.path + path.sep))
      || (target.projectChildren && file.startsWith(target.path + path.sep)
        && (() => {
          const parts = path.relative(target.path, file).split(path.sep);
          return parts.length === 1 || (parts[1] === 'senpi-task'
            && (parts.length === 2 || parts[2] === 'children'));
        })())));
  }

  // Hermes: SQLite totals and per-call logs provide usage and date evidence. Each explicit
  // watch root — the home AND every profile dir under it — is kept by the
  // matcher itself, so a profile's own database still reports.
  bound('hermes', candidates.hermes || [], (parts) => {
    if (HERMES_DB_FILES.has(parts[parts.length - 1])) return false;
    // Cross-day allocation reads direct logs/agent.log* siblings of state.db.
    // Keep rotation/create/remove events, but never recurse into runtime logs.
    return !(parts[0] === 'logs' && (parts.length === 1
      || (parts.length === 2 && parts[1].startsWith('agent.log'))));
  });

  // Desktop contains VM/runtime files beside its retained `.claude` trees.
  // Keep dynamic discovery ancestors, pruning dependency/VCS trees. Link
  // handling differs between discovery, scan roots and individual JSONL files.
  // IndexedDB roots and external blob trees are separate.
  const desktopRoots = rootsByClient.claude || [];
  bound('claude', desktopRoots.filter(({ id, dir }) => id === 'claude-desktop-transcripts' && dirExists(dir)).map(({ dir }) => dir),
    ignoreDesktopTranscriptPath);

  bound('openclaw', candidates.openclaw || [], (parts) => {
    // The first level is the dynamic agent id. Keep it so newly created agents
    // can expose one of the bounded source lanes below.
    if (parts.length === 1) return false;
    if (OPENCLAW_TRANSCRIPT_DIRS.has(parts[1])) return false;
    if (parts[1] !== 'agent') return true;

    // Keep the parent so a fresh SQLite store, codex-home or cli-auth home can
    // appear after startup, then limit its contents to those sources.
    if (parts.length === 2) return false;
    if (parts.length === 3) {
      return parts[2] !== 'codex-home'
        && parts[2] !== 'cli-auth'
        && !OPENCLAW_AGENT_DB_WATCH_PATTERN.test(parts[2]);
    }
    if (parts[2] === 'codex-home') return !CODEX_HOME_TRANSCRIPT_DIRS.has(parts[3]);
    if (parts[2] !== 'cli-auth') return true;
    // Only `cli-auth/codex/<profile>` is a Codex home; `cli-auth/<other>` is an
    // authentication profile Tokscale never reads. The profile level is kept so
    // a login added after startup still reports, and `history.jsonl` beside its
    // session dirs is pruned the same way it is under codex-home.
    if (parts[3] !== 'codex') return true;
    if (parts.length <= 5) return false;
    return !CODEX_HOME_TRANSCRIPT_DIRS.has(parts[5]);
  });

  bound('copilot', sourceRoots('copilot', 'copilot-data', 'copilot-session-store'), (parts) => {
    if (parts[0] === 'otel') return false;
    if (parts[0] === 'session-state') {
      // Native CLI sessions can appear after the watcher starts. Keep their
      // discovery directories and direct legacy JSONL files, but prune each
      // session's plans, checkpoints and other non-usage content.
      return parts.length > 2 && !(parts.length === 3 && parts[2] === 'events.jsonl');
    }
    if (parts.length === 1) return !COPILOT_DB_WATCH_PATTERN.test(parts[0]);
    return true;
  });
  bound('copilot', sourceRoots('copilot', 'vscode-workspace-storage'), (parts) => {
    if (parts.length === 1) return false; // workspace hash dir
    if (parts[1] === 'chatSessions') return false;
    if (parts.length === 2 && parts[1] === 'workspace.json') return false;
    return true;
  });
  bound('copilot', sourceRoots('copilot', 'vscode-empty-window-sessions'),
    (parts) => parts.length !== 1 || !parts[0].endsWith('.jsonl'));
  const cursorEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('cursor');
  // Cursor owns this source; Tokscale only reads its credentials/titles and
  // writes a separate usage cache. Never descend into extension storage, and
  // never watch the wal-index our own read-only SQLite queries can recreate.
  bound('cursor', cursorEnabled ? options.cursorDesktopRoots || cursorDesktopWatchRoots(options) : [],
    directChildOnly(isCursorDesktopStateWrite));

  const antigravityEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('antigravity');
  bound('antigravity', antigravityEnabled ? antigravityDataRoots(options.homeDir || os.homedir()) : [], (parts) => {
    if (parts.length === 1) {
      return !ANTIGRAVITY_SOURCE_DIRS.has(parts[0]) && !ANTIGRAVITY_SOURCE_FILES.has(parts[0]);
    }
    const firstChild = parts[0];
    if (!ANTIGRAVITY_SOURCE_DIRS.has(firstChild)) return true;
    // brain/<session> is kept (a new session shows up there); brain/<session>/**
    // is not — see ANTIGRAVITY_SHALLOW_SOURCE_DIRS.
    if (ANTIGRAVITY_SHALLOW_SOURCE_DIRS.has(firstChild)) return parts.length > 2;
    return false;
  });
  if (antigravityEnabled) {
    for (const { file, dir } of antigravitySummaryWatchSources(options)) {
      const name = path.basename(file);
      bound('antigravity', [dir], directChildOnly((child) => child === name || child === `${name}-wal`));
    }
  }

  const reasonixEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('reasonix');
  bound(
    'reasonix',
    reasonixEnabled ? reasonixNativeSessionWatchRoots(options).filter(dirExists) : [],
    (_parts, resolved) => {
      if (isReasonixNativeSessionSidecar(resolved)) return false;
      try {
        if (fs.statSync(resolved).isDirectory()) return false;
      } catch (_) {
        // A removed sidecar is still delivered by chokidar; other removed
        // files do not need to invalidate the native-session cache.
      }
      return true;
    }
  );

  // Prime's sessionDir may be cwd or the whole home. Its normal root sessions
  // are direct JSONL files; RLM transcripts are artifacts/<parent>/sub-*/*.jsonl.
  // Bound live traversal to that layout, while full Tokscale scans remain
  // recursive. Explicit extra scan roots keep the custom-root policy below.
  if (candidates['prime-agent']) {
    const roots = rootsByClient['prime-agent'];
    const isTranscript = (name) => name.endsWith('.jsonl') && name !== 'rlm-subagents.jsonl';
    bound('prime-agent', roots.filter(({ id }) => id === 'prime-agent-sessions').map(({ dir }) => dir),
      directChildOnly(isTranscript));
    bound('prime-agent', roots.filter(({ id }) => id === 'prime-agent-artifacts').map(({ dir }) => dir), (parts, resolved) => {
      if (pruneDependencyTrees(parts)) return true;
      if (parts.length === 1) {
        try { return !fs.statSync(resolved).isDirectory(); } catch (_) {
          // Removed parents can contain transcripts; keep their removal signal.
          return false;
        }
      }
      if (!parts[1].startsWith('sub-')) return true;
      if (parts.length === 2) return false;
      return parts.length !== 3 || !isTranscript(parts[2]);
    });
  }

  // Command Code recursively stores session transcripts below projects/, but
  // checkpoint streams use the same JSONL suffix and are explicitly skipped by
  // Tokscale. Keep directories for traversal and ordinary JSONL files (including
  // removed paths), while pruning checkpoints and unrelated project metadata.
  bound('commandcode', candidates.commandcode || [], (_parts, resolved) => {
    const name = path.basename(resolved);
    if (name.endsWith('.jsonl') && !name.endsWith('.checkpoints.jsonl')) return false;
    try {
      if (fs.statSync(resolved).isDirectory()) return false;
    } catch (_) {
      // Removed transcript paths are handled by the suffix check above.
    }
    return true;
  });

  bound('opencode', candidates.opencode || [], (parts) => {
    if (parts.length === 1) {
      // Keep the root's readdir visible for newly created channel DBs, but
      // do not descend into unrelated app files or directories.
      return parts[0] !== 'storage' && !OPENCODE_DB_WATCH_PATTERN.test(parts[0]);
    }
    if (parts[0] !== 'storage') return true;
    if (parts.length === 2) return parts[1] !== 'message';
    if (parts[1] !== 'message') return true;
    // Tokscale's legacy OpenCode source is storage/message/*/*.json. Keep
    // the message root, one session directory, and its direct JSON files;
    // prune deeper runtime trees before chokidar allocates more watches.
    if (parts.length === 3) return false;
    if (parts.length === 4) return !parts[3].endsWith('.json');
    return true;
  });

  // Tokscale reads only direct children of each MiMo root, so log/* and every
  // other recursive subtree is pruned before chokidar descends into it.
  bound('mimo', candidates.mimo || [], directChildOnly((name) => MIMO_DB_WATCH_PATTERN.test(name)));
  bound('junie', sourceRoots('junie', 'junie-sessions'), recursiveSourceFiles(name => name === 'events.jsonl'));
  bound('opencodereview', sourceRoots('opencodereview', 'opencodereview-sessions'), recursiveSourceFiles(name => name.endsWith('.jsonl')));
  bound('goose', candidates.goose || [], directChildOnly((name) => GOOSE_DB_WATCH_PATTERN.test(name)));
  bound('cherrystudio', withBasename('cherrystudio', 'Data'), directChildOnly((name) => CHERRY_STUDIO_DB_WATCH_PATTERN.test(name)));
  bound('catpaw', candidates.catpaw || [], directChildOnly((name) => catpawDatabaseName(name.replace(/-(?:wal|shm)$/, ''))));
  bound('unsloth', candidates.unsloth || [], directChildOnly((name) => UNSLOTH_DB_WATCH_PATTERN.test(name)));
  bound('devin', withBasename('devin', 'cli'), directChildOnly((name) => DEVIN_CLI_DB_WATCH_PATTERN.test(name)));
  // The dual-source Grok scanner derives exactly logs/unified.jsonl from each
  // Grok home.
  bound('grok', withBasename('grok', 'logs'), directChildOnly((name) => name === GROK_UNIFIED_LOG_FILE));
  // ZCode v2 is a direct SQLite path, not a recursive project source.
  bound('zcode', withBasename('zcode', 'db'), directChildOnly((name) => ZCODE_DB_WATCH_PATTERN.test(name)));
  bound('kiro', withBasename('kiro', 'kiro-cli'), directChildOnly((name) => KIRO_DB_WATCH_PATTERN.test(name)));
  bound('zed', withBasename('zed', 'threads'), directChildOnly((name) => ZED_DB_WATCH_PATTERN.test(name)));
  bound('codebuddy', withBasename('codebuddy', 'Logs'), (parts) => !CODEBUDDY_EXTENSION_SOURCE_DIRS.has(parts[0]));

  // Everything left is a recursive transcript tree: tokscale walks it, so every
  // path inside it is a potential source. Copilot's built-in roots are bounded
  // above, but its custom roots still follow Tokscale's recursive extra-root
  // contract. The self-synced cache roots are never handed to chokidar in the
  // first place. The parse-local Antigravity CLI dir is added back explicitly —
  // it shares the umbrella client id but is written by `agy`, not by our sync.
  // Candidates are bare paths, so a client that names its own built-in root as
  // a custom path too would read as custom twice over. Whether a root is
  // built-in comes from the source list instead, which still says so.
  const builtInBySource = new Map(Object.entries(rootsByClient).map(([client, roots]) => [
    client,
    new Set(roots.filter((root) => !root.custom).map((root) => canonicalRoot(root.dir)))
  ]));
  const isCustomOnly = (client, root) => Boolean(customRoots.get(client)?.has(root))
    && !builtInBySource.get(client)?.has(root);
  const recursive = [
    ...Object.entries(candidates)
      .flatMap(([client, dirs]) => dirs
        .filter((dir) => (
          (client !== 'copilot' || customRoots.get(client)?.has(canonicalRoot(dir)))
          && (!SELF_SYNCED_CLIENTS.has(client) || customScanPaths[client]?.includes(dir))
          && !(claimed.get(client) || EMPTY_SET).has(dir)
        ))
        .map((dir) => ({ client, root: canonicalRoot(dir), custom: isCustomOnly(client, canonicalRoot(dir)) }))),
    ...(antigravityEnabled && dirExists(antigravityCliDataDir(options))
      ? [{ client: 'antigravity', root: canonicalRoot(antigravityCliDataDir(options)), custom: false }]
      : [])
  ];
  // A directory that is a built-in root for any client keeps everything, even
  // where it is also named as a custom root, by that client or another: the
  // built-in contract is the one that must hold.
  const builtInRoots = new Set(recursive.filter((entry) => !entry.custom).map((entry) => entry.root));
  for (const root of builtInRoots) {
    entries.push({ root, prefix: descendantPrefix(root), policy: KEEP_EVERYTHING });
  }
  // A path stays watched while any policy on its root keeps it, so a root
  // named by two clients keeps the union of their contracts.
  const codexHomes = new Set(options.codexHomes ?? recursive
    .filter(({ client, custom, root }) => client === 'codex' && custom && isCodexHome(root))
    .map(({ root }) => root));
  const codexCustomPolicy = (root) => {
    if (codexHomes.has(root)) return pruneCodexHome;
    const nestedHomes = [...codexHomes]
      .filter((home) => home !== root && home.startsWith(descendantPrefix(root)))
      .sort((a, b) => b.length - a.length);
    if (nestedHomes.length === 0) return pruneDependencyTrees;
    return (parts, resolved) => {
      const target = path.resolve(resolved);
      for (const home of nestedHomes) {
        if (!target.startsWith(descendantPrefix(home))) continue;
        // A recognized home owns its catalog. Without this, an enclosing
        // generic custom root keeps state_*.sqlite(-wal|-shm) watched and the
        // title lookup's own read schedules another collection.
        return pruneCodexHome(path.relative(home, target).split(path.sep), target);
      }
      return pruneDependencyTrees(parts);
    };
  };
  const customPolicies = new Map();
  for (const { client, root, custom } of recursive) {
    if (!custom || builtInRoots.has(root)) continue;
    const policy = client === 'codex' ? codexCustomPolicy(root) : pruneDependencyTrees;
    if (!customPolicies.has(root)) customPolicies.set(root, new Set());
    customPolicies.get(root).add(policy);
  }
  for (const [root, policies] of customPolicies) for (const policy of policies) {
    entries.push({ root, prefix: descendantPrefix(root), policy });
    boundedCount += 1;
  }
  return { entries, boundedCount };
}

function watchIgnoreMatcher(clientsCsv, options = {}) {
  const { entries, boundedCount } = watchPolicyEntries(clientsCsv, options);
  if (boundedCount === 0) return undefined;
  return (target) => {
    const resolved = path.resolve(target);
    let contained = false;
    for (const { root, prefix, policy } of entries) {
      // A watch root is a source in its own right — a Hermes profile dir inside
      // the Hermes home, the parent of a database created later — so it survives
      // whatever the roots around it would say about a path at that depth.
      if (resolved === root) return false;
      if (!resolved.startsWith(prefix)) continue;
      contained = true;
      if (!policy(path.relative(root, resolved).split(path.sep), resolved)) return false;
    }
    return contained; // a path under no source root at all is never ignored
  };
}

// Escape hatch for filesystems that never deliver native events — network
// mounts, some FUSE drivers, container bind mounts. chokidar has its own
// CHOKIDAR_USEPOLLING override, but that is chokidar's surface, not ours: it
// is undocumented for our users and can change with a dependency bump, so
// support asks would have no stable answer. Resolved here rather than in each
// entry point so the widget and the headless agent cannot drift apart.
// Tri-state on purpose: unset must fall through to the caller's value, which
// is why parseBoolean's fallback semantics don't fit. The default is native on
// every platform — chokidar 4 has no per-platform backend left to differ on,
// and the failure cases it cannot cover are handled by the watch-descriptor
// fallback below rather than by pre-emptively polling everywhere.
//
// Returns undefined when unset, which is what keeps that tri-state readable to
// callers that need to tell "no opinion" from an explicit "never poll".
function watchPollingEnvOverride(env = process.env) {
  const raw = String(env.TOKEN_MONITOR_WATCH_POLLING ?? '').trim().toLowerCase();
  if (!raw) return undefined;
  return !['0', 'false', 'no', 'off'].includes(raw);
}

// Whether the environment rules polling out, resolved in the same order as
// resolveWatchUsePolling so the two can never disagree about who decides.
function watchPollingForbidden(env = process.env) {
  const chokidarOverride = chokidarPollingEnv(env);
  if (chokidarOverride !== undefined) return chokidarOverride === false;
  return watchPollingEnvOverride(env) === false;
}

function resolveWatchUsePolling(preferred, env = process.env) {
  // chokidar's own variable overrides whatever we pass it, so it has to win
  // here too or diagnostics would report native events while chokidar polls.
  const chokidarOverride = chokidarPollingEnv(env);
  if (chokidarOverride !== undefined) return chokidarOverride;
  const override = watchPollingEnvOverride(env);
  if (override !== undefined) return override;
  if (typeof preferred === 'boolean') return preferred;
  return false;
}

// Kernel watch descriptors are a per-user budget shared with every other
// watcher on the machine (inotify on Linux, file descriptors on macOS/BSD), and
// editors are the usual heavy consumer — a busy Linux desktop can hand us
// ENOSPC on startup through no fault of ours. chokidar reports that
// asynchronously on the watcher, so without this the watch would just stop
// delivering events and live mode would silently decay to hourly
// reconciliation. Polling needs no descriptors at all, which makes it the
// correct degraded mode rather than merely a slower one. An explicit
// TOKEN_MONITOR_WATCH_POLLING=0 opts out: with native events now the default
// everywhere, suppressing this fallback is the only thing that direction of the
// override still does.
const WATCH_DESCRIPTOR_ERROR_CODES = new Set(['ENOSPC', 'EMFILE', 'ENFILE']);

// Polling needs no descriptors, but it holds a stat watcher per path and stats
// every one of them each interval, so its cost grows with the tree rather than
// with activity. Over a tree large enough to have exhausted the descriptors in
// the first place, that took the app down (#857: the main process grew by
// ~1.7 GB/min polling ~1.1M paths). Past this many entries the watcher is
// dropped instead and the interval loop collects on its own. A heavy user's
// default roots measured about 5.6k entries, so the limit leaves real headroom.
const WATCH_POLLING_ENTRY_LIMIT = 20000;

// Counts what chokidar would watch — the same roots through the same ignore
// matcher — and stops as soon as the count passes `limit`, so a million-entry
// tree costs no more than a small one. opendir rather than readdir, because a
// single flat directory can itself hold the whole tree.
// Overlapping roots walk each lexical directory once, just as chokidar does.
//
// Symlinked directories are followed, as chokidar follows them by default, and
// every link is walked on its own: chokidar dedupes by the link's own path, not
// its target, so two links into one tree are two trees to poll. Nothing here
// dedupes cycles either. A link back into its own ancestry stops resolving at
// the kernel's symlink limit (ELOOP), which is where chokidar stops too, and
// failing that the counter itself ends the walk — refusing to poll, which is
// the safe answer for a tree chokidar could not finish either.
function watchEntriesExceed(dirs, ignored, limit) {
  let count = 0;
  const pending = dirs.map((dir) => path.resolve(dir));
  const visited = new Set();
  while (pending.length > 0) {
    const dir = pending.pop();
    if (visited.has(dir)) continue;
    visited.add(dir);
    let handle;
    try { handle = fs.opendirSync(dir); } catch (_) { continue; }
    try {
      let entry;
      while ((entry = handle.readSync()) !== null) {
        const entryPath = path.join(dir, entry.name);
        if (ignored?.(entryPath)) continue;
        count += 1;
        if (count > limit) return true;
        if (entry.isDirectory()) {
          pending.push(entryPath);
        } else if (entry.isSymbolicLink()) {
          try {
            if (fs.statSync(entryPath).isDirectory()) pending.push(entryPath);
          } catch (_) {
            // A dangling or looping link is one entry and nothing below it.
          }
        }
      }
    } catch (_) {
      // A directory removed or made unreadable mid-walk is simply not counted.
    } finally {
      handle.closeSync();
    }
  }
  return false;
}

// chokidar reads CHOKIDAR_USEPOLLING after the options it is handed and lets it
// win, so the polling mode it actually runs can differ from the one we asked
// for. Parsed exactly as chokidar 4 parses it; undefined when unset.
function chokidarPollingEnv(env = process.env) {
  const raw = env.CHOKIDAR_USEPOLLING;
  if (raw === undefined) return undefined;
  const lower = String(raw).toLowerCase();
  if (lower === 'false' || lower === '0') return false;
  if (lower === 'true' || lower === '1') return true;
  return Boolean(lower);
}

// Reported in place of a watcher when polling would cover more than the limit,
// or when the owner required polling and the environment forbids it. The
// collector answers either by dropping to interval collection.
const WATCH_POLLING_LIMIT_CODE = 'watch-polling-limit';
const WATCH_POLLING_UNAVAILABLE_CODE = 'watch-polling-unavailable';
const WATCH_REFUSAL_CODES = new Set([WATCH_POLLING_LIMIT_CODE, WATCH_POLLING_UNAVAILABLE_CODE]);

// The one place a chokidar instance is created, in the watch process and in the
// in-process fallback alike. The bound lives here rather than in the collector
// because the host can switch to polling on its own (a watch process that never
// confirmed its exit), and a check the host can route around bounds nothing.
function openWatch(chokidar, config = {}, onEvent) {
  const copilotEnabled = String(config.clients || '').split(',').some(client => client.trim().toLowerCase() === 'copilot');
  const copilotExporter = copilotEnabled ? copilotExporterWatch(os.homedir()) : null;
  const ignored = activityWatchIgnored(watchIgnoreMatcher(config.clients, {
    customScanPaths: config.customScanPaths,
    cursorDesktopRoots: config.cursorDesktopRoots,
    homeDir: config.homeDir,
    env: config.env,
    cwdDir: config.cwdDir,
    codexHomes: config.codexHomes,
    senpiSources: config.senpiSources,
    copilotExporter
  }), config.usageDirs || config.dirs || [], config.activitySources || []);
  const limit = Number.isInteger(config.pollingEntryLimit) && config.pollingEntryLimit >= 0
    ? config.pollingEntryLimit
    : WATCH_POLLING_ENTRY_LIMIT;
  // Bounded on the mode that will really run, through the same resolver every
  // other watch decision uses: CHOKIDAR_USEPOLLING, then our own override, then
  // what was asked for.
  const usePolling = resolveWatchUsePolling(config.usePolling === true);
  // `requirePolling` is not a preference: the host sets it when native
  // descriptors from a previous watcher may still be held, so falling through
  // to native here would put two sets in flight. Not watching is the safe answer.
  if (config.requirePolling === true && !usePolling) {
    const error = new Error('polling required but forbidden by the environment');
    error.code = WATCH_POLLING_UNAVAILABLE_CODE;
    throw error;
  }
  if (usePolling && watchEntriesExceed(config.dirs || [], ignored, limit)) {
    const error = new Error(`over ${limit} paths to poll`);
    error.code = WATCH_POLLING_LIMIT_CODE;
    throw error;
  }
  const watcher = chokidar.watch(config.dirs, watcherOptions(usePolling, ignored));
  if (onEvent) watcher.on('all', (event, filePath) => {
    // Reuse the matcher that saw initial discovery. Keep the reported path so
    // the collector can still apply every other client's own source policy.
    const unlinkedExporter = event === 'unlink' && copilotExporter?.matches(path.resolve(filePath))
      ? copilotExporter.canonicalFile : undefined;
    onEvent(event, filePath, unlinkedExporter);
  });
  return watcher;
}

function watcherOptions(usePolling, ignored) {
  return {
    ignoreInitial: true,
    persistent: true,
    ...(usePolling
      ? { usePolling: true, interval: 2000, binaryInterval: 5000 }
      : { usePolling: false }),
    ...(ignored ? { ignored } : {}),
    awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 200 }
  };
}

// Clients whose SQLite wal-index sidecar our own read-only scan recreates.
//
// Opening a WAL database read-only still maps the shared-memory index, and
// SQLite rewrites <db>-shm when it does. That write is indistinguishable from a
// real data change to a filesystem watcher, so watching the sidecar re-triggers
// the scan that caused it: watch event -> targeted scan -> shm write -> watch
// event, forever. Measured on darwin for zcode: 0 shm changes while idle over
// 40s, then 20 of 20 consecutive tokscale zcode --today scans rewrote
// db.sqlite-shm. The same shape was already fixed for Qoder CN (#301), where it
// was 142 events/5min with the client stopped. Antigravity keeps one database
// per conversation, so each scan rewrites every one of their sidecars: with the
// app closed, 0 changes over 15s idle, then 37 of 37 conversations' .db-shm on
// each of 5 consecutive scans. A widget that uploads every tick then republished
// its unchanged record to the Hub about every 2 s.
//
// Only the sidecar is dropped. The real data signal lives in the database and
// its -wal, so a genuine change still produces an event. With the bundled 4.23
// scanner, unchanged WAL fixtures also rewrite SHM on every Kilo, Kiro, Zed,
// Hermes, Copilot, Unsloth, Devin and OpenClaw scan. OpenCode and MiMo rewrite
// it on the first read before their source cache is warm. A read-only SQLite
// connection can write its wal-index; it is not evidence of new token usage.
// Adding a client to this list asserts a measurement rather than a hunch.
// MiniMax Code rewrites runtime-state.sqlite-shm on every read-only metadata scan of a watched data directory (measured on darwin with the pinned 4.23 scanner, first and repeat scans).
// Cherry Studio, CatPaw and Goose also rewrite their wal-index on repeated read-only WAL scans.
// Cursor's read-only desktop credential/title queries change state.vscdb-shm too.
const SELF_WATCHED_SQLITE_SIDECAR_CLIENTS = Object.freeze([
  'antigravity', 'catpaw', 'cherrystudio', 'copilot', 'cursor', 'devin', 'goose',
  'hermes', 'kilo', 'kiro', 'mimo', 'mcode', 'opencode', 'openclaw', 'unsloth', 'zcode', 'zed'
]);

function isSelfWatchSqliteSidecarEvent(filePath, rootsByClient = {}) {
  // Match SQLite's wal-index suffix, not one client's database basename: ZCode's
  // file is db.sqlite-shm, whose name does not contain '.db-'. The suffix is
  // required to be one of the SQLite extensions this collector's clients use, so
  // the match cannot widen into an unrelated '-shm' sidecar, and it never matches
  // the -wal or the database itself.
  const name = path.basename(String(filePath || ''));
  if (!/^[^/]+\.(?:db|sqlite|sqlite3|vscdb)-shm$/.test(name)) return false;
  const resolved = path.resolve(filePath);
  return SELF_WATCHED_SQLITE_SIDECAR_CLIENTS.some((client) => (rootsByClient[client] || [])
    .some((root) => resolved.startsWith(descendantPrefix(path.resolve(root)))));
}

module.exports = {
  clientWatchCandidates,
  selfSyncSourceRootsForClients,
  antigravitySummaryWatchSources,
  watchClientRootsForClients,
  watchPathsForClients,
  watchAttributionRootsForClients,
  clientsForWatchPath,
  isCodexHome,
  SELF_SYNCED_CLIENTS,
  watchPolicyEntries,
  watchIgnoreMatcher,
  watchPollingEnvOverride,
  watchPollingForbidden,
  resolveWatchUsePolling,
  chokidarPollingEnv,
  watchEntriesExceed,
  isSelfWatchSqliteSidecarEvent,
  watcherOptions,
  openWatch,
  WATCH_DESCRIPTOR_ERROR_CODES,
  WATCH_POLLING_ENTRY_LIMIT,
  WATCH_POLLING_LIMIT_CODE,
  WATCH_POLLING_UNAVAILABLE_CODE,
  WATCH_REFUSAL_CODES
};
