'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { customPricingPath } = require('./tokscaleConfig');
const { abortReason, throwIfAborted } = require('./abortSignal');
const { readJson, sharedDataDir } = require('./config');
const { appVersion } = require('./appVersion');
const { normalizeClientsCsv } = require('./clientTracking');
const { FORK_ONLY_CLIENT_IDS } = require('./clientCatalog');
const { antigravityCliDataDir, canonicalWatchPath, cherryStudioTranscriptRoots, clientSourceRoots, copilotExporterWatch } = require('./clientSources');
const { clientDiagnosticRoots, clientSourceChecks, dirExists, visibleDiagnosticRoots } = require('./clientSourceObservations');
const {
  CLIENT_HEALTH_VERSION,
  MAX_DIAGNOSTICS_PER_CLIENT,
  deriveClientOverall
} = require('./clientHealth');
const { tokscalePackageNameForPlatform } = require('./tokscalePlatform');
const { createTokscaleCapabilityResolver, filterSupportedClients, parseSupportedClients } = require('./tokscaleCapabilities');
const { normalizeCustomScanPaths, customScanPathsFingerprint, tokscaleExtraDirsEnv } = require('./customScanPaths');
const { TOKSCALE_CLIENT_ALIASES, tokscaleScanClientIds } = require('./tokscaleClientMapping');
const {
  applyPeriodDelta,
  emptyPeriod,
  extractUsageBundleFromTokscale,
  extractUsageFromTokscale,
  mergePeriods,
  normalizeClientName,
  UNATTRIBUTED_USAGE_CLIENT
} = require('./usage');
const { collectWslUsage: collectWslUsageImpl, emptyWslBundle, probeWslState: probeWslStateImpl } = require('./wslUsage');
const { createWatcherHost } = require('./watcherHost');
const { localDayKey, parseGraphResult, normalizeHistory } = require('./history');
const { retainDailyHistory, retainLiveDailyHistory } = require('./dailyHistoryArchive');
const {
  createSubprocessTermination,
  terminationUnconfirmedError
} = require('./subprocessTermination');
const { antigravityDataRoots, createAntigravitySelfSync } = require('./providers/antigravity/selfSync');
const { withCursorLifecycle } = require('./providers/cursor/lifecycle');
const { createCursorSelfSync } = require('./providers/cursor/selfSync');
const {
  applySessionMetadata,
  applyTokscaleSessionMetadata,
  projectIdentity,
  projectPathFromJsonl,
  sessionMetadataMap
} = require('./sessionMetadata');
const { kimiWorkSessionsRoots } = require('./providers/kimi/sessionMetadata');
const { qoderCnDataPaths } = require('./providers/qodercn/paths');
const {
  createReasonixNativeSessionCache,
  isReasonixNativeSessionPath,
  isReasonixNativeSessionSidecar,
  reasonixNativeSessionWatchRoots,
  emptyNativeView
} = require('./providers/reasonix/sessions');
const { hostOsInfo, normalizeOsInfo } = require('./osVersion');
const {
  clampTimerDelayMs,
  createSelfSyncThrottle,
  createSourceSyncQueue,
  mergeSelfSyncSelection,
  SELF_SYNC_KINDS
} = require('./selfSyncThrottle');
const {
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  nextLimitsResetBoundary,
  pruneAttemptedResetBoundaries
} = require('./limits/resetBoundary');

function toUnpackedPath(p) {
  // electron-builder asarUnpack stores real files at .../app.asar.unpacked/...
  // require.resolve() returns the .../app.asar/... path, which spawn() can't read.
  const asarSeg = `${path.sep}app.asar${path.sep}`;
  return p && p.includes(asarSeg) ? p.replace(asarSeg, `${path.sep}app.asar.unpacked${path.sep}`) : p;
}

const TOKSCALE_BIN_JS = toUnpackedPath(require.resolve('tokscale/bin.js'));

function bundledPackageCandidates() {
  const primary = tokscalePackageNameForPlatform();
  if (primary) return [primary];
  if (process.platform === 'linux') {
    if (process.arch === 'arm64') return ['@tokscale/cli-linux-arm64-gnu', '@tokscale/cli-linux-arm64-musl'];
    if (process.arch === 'x64') return ['@tokscale/cli-linux-x64-gnu', '@tokscale/cli-linux-x64-musl'];
  }
  return [];
}

function locateBundledBinary() {
  const binaryName = process.platform === 'win32' ? 'tokscale.exe' : 'tokscale';
  for (const pkg of bundledPackageCandidates()) {
    try {
      const pkgPath = require.resolve(`${pkg}/package.json`);
      const binPath = toUnpackedPath(path.join(path.dirname(pkgPath), 'bin', binaryName));
      const pkgJson = readJson(pkgPath, {});
      if (fs.existsSync(binPath)) {
        return { source: 'bundled', path: binPath, version: String(pkgJson.version || '0.0.0'), packageName: pkg };
      }
    } catch (_) {}
  }
  return null;
}

// The bundled binary is the only native candidate: packaging swaps the pinned
// fork build into @tokscale/cli-<platform>, and an upstream npm build would
// silently drop the downstream session/workspace report grouping. A
// `current.json` pointer left behind by the retired npm updater is ignored.
function resolvePlatformBinary() {
  return locateBundledBinary() || { source: 'shim', path: TOKSCALE_BIN_JS, version: null };
}

// Declared app build metadata, not verification of the executable's bytes.
function readTokscaleBundledBuild(manifest = readJson(path.join(__dirname, '../../scripts/vendor/tokscale.json'), null)) {
  if (!manifest || ![undefined, null, 'override'].includes(manifest.mode)) return null;
  if (typeof manifest.commit !== 'string' || !/^[0-9a-f]{40}$/i.test(manifest.commit)) return null;
  if (typeof manifest.releaseTag !== 'string' || !manifest.releaseTag) return null;
  return { releaseTag: manifest.releaseTag, commit: manifest.commit };
}

function getTokscaleStatus() {
  if (bundledPackageCandidates().length === 0) return { supported: false };
  const current = resolvePlatformBinary();
  return {
    supported: true,
    current: { source: current.source, version: current.version, path: current.path },
    bundledBuild: readTokscaleBundledBuild()
  };
}

// Tokscale reads a few XDG environment variables with a bare
// `std::env::var(...)`, so ANY present value wins — including "" and "   ".
// Token Monitor resolves those same roots with nonBlankEnvPath(), which treats a
// blank value as unset (matching the XDG basedir spec, where $XDG_DATA_HOME is
// "either not set or empty"). A blank value therefore makes the watcher and the
// health check resolve ~/.local/share while the scan resolves "" or "   " as the
// root — a directory that is not even absolute — so health can read `detected`
// while the collector looks somewhere else entirely.
//
// Dropping the blank key entirely (rather than rewriting it to another value)
// is what makes the two agree: tokscale then takes its own fallback, which is
// the same root Token Monitor already resolved. It also stays correct if
// tokscale later adopts blank-as-unset itself, and it fixes every client behind
// the affected roots at once — PathRoot::XdgData (opencode, amp, kilo, crush,
// goose, zed, micode, devin-cli, hindsight), PathRoot::Config's Linux arm
// (antigravity, trae, warp, mcode, hindsight) and the codex headless roots.
//
// Only these three are listed. TOKSCALE_CONFIG_DIR is deliberately NOT here,
// because both sides already agree on it: an empty value is unset, while any
// non-empty value — whitespace included — is an override. Tokscale spells that
// `!custom.is_empty()` and Token Monitor `override.length > 0`, so there is
// nothing to reconcile.
//
// Blank is the whole predicate, so one case is knowingly left alone: a
// NON-blank but relative XDG_CONFIG_HOME. Token Monitor rejects it via
// absoluteEnvPath() (and so does the `dirs` crate behind Tokscale's own
// fallback) while Tokscale's raw read would accept it, but that is a separate
// divergence on an invalid-per-spec value, and the Linux-only arm it lives in
// cannot be exercised from this repo's test matrix. Relative XDG_DATA_HOME is
// fine as-is: nonBlankEnvPath keeps it, and Tokscale reads it the same way.
const TOKSCALE_BLANK_SENSITIVE_ENV_KEYS = Object.freeze([
  'XDG_DATA_HOME',
  'XDG_CONFIG_HOME',
  'TOKSCALE_HEADLESS_DIR'
]);

// Windows environment names are case-insensitive, and `{ ...process.env }`
// preserves whatever casing the OS handed Node — a shell can export
// `Xdg_Data_Home` and a canonical-spelling lookup then misses it entirely,
// leaving the blank value in the child's environment. Match case-insensitively
// there so the key we delete is the one that is actually present. POSIX names
// are case-sensitive, so an exact match stays the narrower correct rule.
function tokscaleEnvWithBlanksDropped(env, platform = process.platform) {
  const caseInsensitive = platform === 'win32';
  const namesFor = (key) => {
    if (!caseInsensitive) return Object.prototype.hasOwnProperty.call(env, key) ? [key] : [];
    const lowered = key.toLowerCase();
    return Object.keys(env).filter((name) => name.toLowerCase() === lowered);
  };
  let dropped = null;
  for (const key of TOKSCALE_BLANK_SENSITIVE_ENV_KEYS) {
    for (const name of namesFor(key)) {
      const value = env[name];
      if (typeof value !== 'string' || value.trim()) continue;
      if (!dropped) dropped = { ...env };
      delete dropped[name];
    }
  }
  return dropped || env;
}

function tokscaleCommand(options = {}) {
  const resolved = resolvePlatformBinary();
  const useDirect = Boolean(resolved && resolved.source !== 'shim');
  const customExtraDirs = tokscaleExtraDirsEnv(
    options.customScanPaths,
    process.env.TOKSCALE_EXTRA_DIRS,
    { platform: options.platform || process.platform, home: options.homeDir }
  );
  const extraDirsEnv = customExtraDirs
    ? { ...process.env, TOKSCALE_EXTRA_DIRS: customExtraDirs }
    : process.env;
  const env = tokscaleEnvWithBlanksDropped(extraDirsEnv, options.platform || process.platform);
  const command = useDirect
    ? { bin: resolved.path, prefixArgs: [], env }
    : { bin: process.execPath, prefixArgs: [TOKSCALE_BIN_JS], env: { ...env, ELECTRON_RUN_AS_NODE: '1' } };
  return {
    ...command,
    identity: [resolved?.source || 'none', resolved?.path || '', resolved?.version || '', resolved?.integrity || ''].join('|')
  };
}

function parseJsonOutput(stdout) {
  const text = String(stdout || '').trim();
  if (!text) throw new Error('tokscale produced empty stdout');
  try { return JSON.parse(text); } catch (_) {
    const starts = [text.indexOf('{'), text.indexOf('[')].filter((value) => value >= 0).sort((a, b) => a - b);
    for (const start of starts) {
      try { return JSON.parse(text.slice(start)); } catch (_inner) {}
    }
  }
  throw new Error(`Could not parse tokscale JSON output: ${text.slice(0, 300)}`);
}

function spawnTokscaleJson(userArgs, commandTimeoutMs, command = tokscaleCommand(), signal, options = {}) {
  const { bin, prefixArgs, env } = command;
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    const child = spawn(bin, [...prefixArgs, ...userArgs], { env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timeout = null;
    let terminalError = null;
    const termination = createSubprocessTermination(child, {
      ...(options.terminationOptions || {}),
      onUnconfirmed() {
        const error = terminationUnconfirmedError(terminalError, options.operation || 'tokscale');
        try { options.onTerminationUnconfirmed?.(error); } catch (_) {}
        finish(error);
      }
    });

    function finish(error, value) {
      if (settled) return;
      settled = true;
      if (timeout) clearTimeout(timeout);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error);
      else resolve(value);
    }

    function onAbort() {
      if (terminalError) return;
      terminalError = abortReason(signal);
      if (timeout) clearTimeout(timeout);
      timeout = null;
      termination.request();
    }

    timeout = setTimeout(() => {
      if (terminalError) return;
      terminalError = new Error(`tokscale timed out after ${commandTimeoutMs}ms`);
      timeout = null;
      termination.request();
    }, commandTimeoutMs);
    // Keep draining both pipes after termination is requested, but stop retaining
    // data the result can no longer use. A stubborn child must not grow our heap
    // while the physical-close barrier waits for TERM/KILL to take effect.
    child.stdout.on('data', (chunk) => { if (!settled && !terminalError) stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => {
      if (settled || terminalError || stderr.length >= MAX_TOKSCALE_STDERR_LENGTH) return;
      stderr += chunk.toString().slice(0, MAX_TOKSCALE_STDERR_LENGTH - stderr.length);
    });
    child.on('error', (error) => {
      if (terminalError) return;
      finish(error);
    });
    child.on('close', (code) => {
      termination.confirmClosed();
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) {
        const error = new Error(`tokscale exited with code ${code}: ${stderr.trim() || stdout.trim()}`);
        error.tokscaleExitCode = code;
        error.tokscaleStderr = stderr;
        return finish(error);
      }
      try { finish(null, parseJsonOutput(stdout)); } catch (error) { finish(error); }
    });
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

const TOKSCALE_CAPABILITY_PROBE_TIMEOUT_MS = 10_000;
const MAX_TOKSCALE_STDERR_LENGTH = 64 * 1024;
// tokscale rejects an unknown --client value with this exact exit code (see
// the umbrella-client mapping comment below) — verified on 4.7.0 and 4.8.0.
const TOKSCALE_UNKNOWN_CLIENT_EXIT_CODE = 2;

function spawnTokscaleHelp(command, options = {}) {
  const timeoutMs = options.timeoutMs ?? TOKSCALE_CAPABILITY_PROBE_TIMEOUT_MS;
  return new Promise((resolve, reject) => {
    const child = spawn(command.bin, [...command.prefixArgs, '--help'], { env: command.env, windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let terminalError = null;
    const termination = createSubprocessTermination(child, {
      ...(options.terminationOptions || {}),
      onUnconfirmed() {
        const error = terminationUnconfirmedError(terminalError, 'tokscale capability probe');
        try { options.onTerminationUnconfirmed?.(error); } catch (_) {}
        finish(error);
      }
    });
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (error) reject(error);
      else resolve(value);
    };
    const timeout = setTimeout(() => {
      if (terminalError) return;
      terminalError = new Error(`tokscale capability probe timed out after ${timeoutMs}ms`);
      termination.request();
    }, timeoutMs);
    child.stdout.on('data', (chunk) => {
      if (!settled && !terminalError) stdout += chunk.toString();
    });
    child.stderr.on('data', (chunk) => {
      if (settled || terminalError || stderr.length >= MAX_TOKSCALE_STDERR_LENGTH) return;
      stderr += chunk.toString().slice(0, MAX_TOKSCALE_STDERR_LENGTH - stderr.length);
    });
    child.on('error', (error) => {
      if (terminalError) return;
      finish(error);
    });
    child.on('close', (code) => {
      termination.confirmClosed();
      if (settled) return;
      if (terminalError) return finish(terminalError);
      if (code !== 0) return finish(new Error(`--help exited with code ${code}: ${stderr.trim() || stdout.trim()}`));
      try { finish(null, parseSupportedClients(`${stdout}\n${stderr}`)); } catch (error) { finish(error); }
    });
  });
}

const tokscaleCapabilityResolver = createTokscaleCapabilityResolver({
  warn: (message) => console.warn(message)
});

// A few tools surface as one umbrella client in our tracked-client list but as
// several client ids inside tokscale. Antigravity splits its CLI source into
// `antigravity-cli`, while Tokscale 4.13.0+ gives Oh My Pi's `.omp` source sole
// ownership under `omp`. Widen the tokscale --client filter so those sub-source
// rows aren't filtered out;
// extractUsageFromTokscale's normalizeClientName folds them back into the umbrella
// id. Every alias must be a real tokscale client id: an unknown --client value is
// rejected with exit 2 and takes the whole scan down with it (verified on 4.7.0
// and 4.8.0), so the shared mapping is not a free-form place to invent
// sub-source names.
// Fork-only clients are split out of argv before clap parses it, so they never
// appear in --help even on the pinned fork. Ask the binary instead: a scan of
// only those ids over an empty home exits 0 on the fork and fails with the
// unknown-client exit code on an upstream build.
async function forkOnlyClientsAccepted(command, options = {}) {
  if (FORK_ONLY_CLIENT_IDS.length === 0) return false;
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-tokscale-probe-'));
  try {
    await spawnTokscaleJson(
      ['--json', '--client', FORK_ONLY_CLIENT_IDS.join(','), '--today', '--home', home, '--no-spinner'],
      options.timeoutMs ?? TOKSCALE_CAPABILITY_PROBE_TIMEOUT_MS,
      command,
      undefined,
      {
        operation: 'tokscale capability probe',
        terminationOptions: options.terminationOptions,
        onTerminationUnconfirmed: options.onTerminationUnconfirmed
      }
    );
    return true;
  } catch (error) {
    if (isUnknownTokscaleClientError(error)) return false;
    throw error;
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

async function probeTokscaleCapabilities(command, options = {}) {
  const supported = await spawnTokscaleHelp(command, options);
  if (await forkOnlyClientsAccepted(command, options)) {
    for (const client of FORK_ONLY_CLIENT_IDS) supported.add(client);
  }
  return supported;
}

function tokscaleClientFilter(clients) {
  const ordered = [];
  const seen = new Set();
  for (const id of String(clients ?? '').split(',').map((value) => value.trim()).filter(Boolean)) {
    for (const scanId of tokscaleScanClientIds(id)) {
      if (!seen.has(scanId)) { seen.add(scanId); ordered.push(scanId); }
    }
  }
  return ordered.join(',');
}

function resetTokscaleCapabilityCache() {
  tokscaleCapabilityResolver.reset();
  // Same category of state: what this binary identity was observed to support.
  // Leaving it behind would keep a replaced binary pinned to the fallback grouping.
  tokscaleWorkspaceGroupBySupport.clear();
}

// Exit code 2 alone is clap's generic "argument parsing failed" code, not a
// --client-specific one — a malformed value for some other flag would exit
// the same way. Requiring stderr to actually mention --client keeps a real
// probe+retry reserved for the one flag this call site varies by binary
// identity; anything else still surfaces as-is.
// The workspace-joined grouping is a downstream addition: the vendored fork
// returns the session's workspace on the same row, which is what lets one scan
// answer "which project does this session belong to". An upstream build rejects
// the value outright, so the fallback grouping is the one it has always known.
const TOKSCALE_SESSION_GROUP_BY = 'client,session,model';
const TOKSCALE_WORKSPACE_GROUP_BY = 'client,workspace,session,model';

// Keyed by binary identity like the client-capability cache: a rejection is a
// property of the binary, not of the tick, so one scan pays for the discovery
// and every later scan on the same binary starts with the grouping it accepts.
const tokscaleWorkspaceGroupBySupport = new Map();

function workspaceGroupBySupported(identity) {
  return tokscaleWorkspaceGroupBySupport.get(identity) !== false;
}

// Clap exits 1 with this message for an unparseable --group-by value. Matching
// the message rather than the exit code alone keeps the retry reserved for the
// one flag that varies by binary; anything else still surfaces as-is.
function isUnknownTokscaleGroupByError(error) {
  return Boolean(error) && /invalid group-by value/i.test(error?.tokscaleStderr || '');
}

function isUnknownTokscaleClientError(error) {
  return Boolean(error)
    && error.tokscaleExitCode === TOKSCALE_UNKNOWN_CLIENT_EXIT_CODE
    && /--client/i.test(error.tokscaleStderr || '');
}

// The capability lookup is process-wide and must keep running so it can fill
// the shared cache for a later collector. A superseded collector only gives up
// its own wait: otherwise its in-flight tick keeps whenIdle() pending and holds
// the replacement behind a probe it may no longer need.
function waitForSharedCapabilityProbe(probe, signal) {
  if (!signal) return Promise.resolve(probe);
  if (signal.aborted) return Promise.reject(abortReason(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      signal.removeEventListener('abort', onAbort);
      callback(value);
    };
    const onAbort = () => finish(reject, abortReason(signal));
    signal.addEventListener('abort', onAbort, { once: true });
    Promise.resolve(probe).then(
      (supported) => finish(resolve, supported),
      (error) => finish(reject, error)
    );
  });
}

// Reactive, not proactive: a binary that recognizes every requested client
// never pays for a capability probe. Only once tokscale has actually
// rejected the CSV (exit 2) do we spend one `--help` probe (plus one empty
// fork-only scan, see forkOnlyClientsAccepted) to learn what the resolved
// binary really supports, then retry with just those ids. A probe
// success is cached per binary identity so a later tick on the same binary
// filters proactively instead of failing first; a probe failure is cached
// too (and warned once) so we don't re-probe on every subsequent failure —
// the original tokscale error surfaces instead, same as before this filter
// existed.
function retryWithKnownCapabilities(error, requested, command, emptyResult, retry, signal, options = {}) {
  if (signal?.aborted) return Promise.reject(abortReason(signal));
  if (!isUnknownTokscaleClientError(error)) return Promise.reject(error);
  // The resolver caches failed probes as well as successful ones. Do not bind
  // this process-wide capability lookup to one collector's lifetime: aborting a
  // superseded collector must not poison the cache for every later runtime.
  const sharedProbe = tokscaleCapabilityResolver.probe(
    command.identity,
    () => probeTokscaleCapabilities(command, options)
  );
  return waitForSharedCapabilityProbe(sharedProbe, signal).then((supported) => {
    throwIfAborted(signal);
    if (!supported) return Promise.reject(error);
    const filtered = filterSupportedClients(requested, supported);
    if (filtered === requested) return Promise.reject(error);
    if (!filtered) return emptyResult;
    return retry(filtered);
  });
}

function applyKnownCapabilityFilter(clientFilter, identity) {
  const supported = tokscaleCapabilityResolver.known(identity);
  return supported ? filterSupportedClients(clientFilter, supported) : clientFilter;
}

function runCursorAwareTokscale(clientFilter, operation, signal) {
  const includesCursor = String(clientFilter || '').split(',').includes('cursor');
  return includesCursor ? withCursorLifecycle(operation, { signal }) : operation();
}

function runTokscale({
  clients,
  flags,
  commandTimeoutMs,
  signal,
  terminationOptions,
  onTerminationUnconfirmed,
  customScanPaths,
  homeDir,
  workspaces = true
}) {
  throwIfAborted(signal);
  const command = tokscaleCommand({ customScanPaths, homeDir });
  const requested = tokscaleClientFilter(clients);
  if (!requested) return Promise.resolve({ entries: [] });
  const clientFilter = applyKnownCapabilityFilter(requested, command.identity);
  if (!clientFilter) return Promise.resolve({ entries: [] });
  // Asking for the join is what makes the scan resolve and label workspaces, so
  // the Projects opt-out has to be applied here rather than on the way out: a
  // scan that still resolved them and had its answer discarded would keep
  // charging for a feature the user turned off. Session titles and activity
  // bounds ride the plain session grouping too, so they are unaffected.
  // Read per spawn rather than once per call: a rejection recorded by the
  // fallback below must already be visible to the unknown-client retry, which
  // would otherwise re-offer the grouping this binary just refused.
  const groupBy = () => (workspaces && workspaceGroupBySupported(command.identity)
    ? TOKSCALE_WORKSPACE_GROUP_BY
    : TOKSCALE_SESSION_GROUP_BY);
  const runArgs = (filter, grouping) => ['--json', '--client', filter, '--group-by', grouping, ...flags];
  const subprocessOptions = {
    operation: 'tokscale scan',
    terminationOptions,
    onTerminationUnconfirmed
  };
  const scan = (filter, grouping = groupBy()) => spawnTokscaleJson(
    runArgs(filter, grouping),
    commandTimeoutMs,
    command,
    signal,
    subprocessOptions
  ).catch((error) => {
    if (!isUnknownTokscaleGroupByError(error)) return Promise.reject(error);
    tokscaleWorkspaceGroupBySupport.set(command.identity, false);
    throwIfAborted(signal);
    return spawnTokscaleJson(
      runArgs(filter, TOKSCALE_SESSION_GROUP_BY),
      commandTimeoutMs,
      command,
      signal,
      subprocessOptions
    );
  });
  return runCursorAwareTokscale(clientFilter, () => (
    scan(clientFilter).catch((error) => (
      retryWithKnownCapabilities(error, requested, command, { entries: [] }, (filtered) => (
        scan(filtered)
      ), signal, {
        terminationOptions,
        onTerminationUnconfirmed
      })
    ))
  ), signal);
}

function runTokscaleGraph({ clients, commandTimeoutMs, signal, terminationOptions, onTerminationUnconfirmed, customScanPaths, homeDir }) {
  throwIfAborted(signal);
  const command = tokscaleCommand({ customScanPaths, homeDir });
  const requested = tokscaleClientFilter(clients);
  if (!requested) return Promise.resolve({ contributions: [] });
  const clientFilter = applyKnownCapabilityFilter(requested, command.identity);
  if (!clientFilter) return Promise.resolve({ contributions: [] });
  const runArgs = (filter) => ['graph', '--client', filter, '--no-spinner'];
  const subprocessOptions = {
    operation: 'tokscale graph',
    terminationOptions,
    onTerminationUnconfirmed
  };
  return runCursorAwareTokscale(clientFilter, () => (
    spawnTokscaleJson(runArgs(clientFilter), commandTimeoutMs, command, signal, subprocessOptions).catch((error) => (
      retryWithKnownCapabilities(error, requested, command, { contributions: [] }, (filtered) => (
        spawnTokscaleJson(runArgs(filtered), commandTimeoutMs, command, signal, subprocessOptions)
      ), signal, {
        terminationOptions,
        onTerminationUnconfirmed
      })
    ))
  ), signal);
}

function lookupModelPricing(modelId, commandTimeoutMs = 15000) {
  const id = String(modelId || '').trim();
  if (!id) return Promise.reject(new Error('lookupModelPricing: modelId is required'));
  return spawnTokscaleJson(['pricing', id, '--json', '--no-spinner'], commandTimeoutMs);
}

// The collector's stamp and history.js's window/streak boundary have to be the same
// calendar day or the aggregate re-keys what the collector wrote, so there is one
// implementation rather than two formatters free to drift. Kept under the collector's
// own name: it is exported and reads as the stamping side at its call sites.
const localTodayKey = localDayKey;

function collectionDate(now) {
  const value = typeof now === 'function' ? now() : now;
  return value == null ? new Date() : new Date(value);
}

// Stamp each posted snapshot with the UTC instant its today/month windows end
// (next local midnight / next month start, in this device's timezone). The hub
// uses these to expire a frozen snapshot once it goes offline past a day/month
// boundary, instead of counting stale "today" data forever (issue #37).
function computePeriodWindows(now = new Date()) {
  const startOfNextDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 0, 0, 0, 0);
  const startOfNextMonth = new Date(now.getFullYear(), now.getMonth() + 1, 1, 0, 0, 0, 0);
  const monthKey = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}`;
  let timeZone = '';
  try { timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone || ''; } catch (_) {}
  return {
    ...(timeZone ? { timeZone } : {}),
    today: { key: localTodayKey(now), endsAt: startOfNextDay.toISOString() },
    month: { key: monthKey, endsAt: startOfNextMonth.toISOString() }
  };
}

// Copy freshly decorated identities/timestamps from `today` onto the same session
// in the delta-derived periods. Used on watch ticks, where month/allTime are not
// re-decorated: a session that started today is absent from the anchor, so its
// project label would otherwise be missing from the broader-period breakdown.
function propagateTodayProjects(today, periods, titleMetadata = {}) {
  for (const [key, session] of Object.entries(today?.sessions || {})) {
    if (!session) continue;
    for (const period of periods) {
      const target = period?.sessions?.[key];
      if (!target) continue;
      if (session.projectId && !target.projectId) {
        target.projectId = session.projectId;
        target.projectLabel = session.projectLabel;
      }
      // The fresh scan's title is authoritative and replaces the anchor's, like
      // the context pair below: a Cursor rename arrives only through this path
      // on watch ticks, so gap-filling would leave derived periods showing the
      // old name until the hourly full scan. An authoritative removal clears
      // the anchor; a metadata miss or transient reader failure keeps it.
      if (session.title) target.title = session.title;
      else if (titleMetadata.invalidatedTitleKeys?.has(key) && target.title === titleMetadata.t3Titles?.[key]) delete target.title;
      if (session.sessionKind && !target.sessionKind) target.sessionKind = session.sessionKind;
      // Context occupancy is replaced rather than gap-filled: the derived
      // periods carry the last full scan's reading, which is older than this
      // tick's by construction. The copy is unconditional, including a cleared
      // pair — the fresh scan is the authority, and a tick that read no valid
      // pair (a DSH model switch drops the occupancy until the next usage chunk
      // measures against the new window) must clear the stale one rather than
      // leave the derived period showing a gauge the fresh scan dropped. The
      // dock card reads month first, so it was the surface that displayed it.
      target.contextWindow = Number(session.contextWindow) || 0;
      target.contextTokens = Number(session.contextTokens) || 0;
      // Home and Dock prefer month rows; carry the fresh observation (including
      // an explicit cold reading) through anchored watch updates as well.
      // An omitted observation is a metadata miss, not evidence of a cold cache.
      if (Object.prototype.hasOwnProperty.call(session, 'promptCache')) {
        target.promptCache = session.promptCache;
      }
      // The turn boundary is copied in all three states, matching what the
      // fresh scan said: `true` finished, `false` open, absent unknown. Copying
      // only `true` left a stale `true` in a derived period after its session
      // picked the next turn back up, and collapsing `false` into "delete" lost the
      // one value that can clear it — the dock card reads month first, so it kept
      // showing a finished session while today showed it running.
      if (session.turnEnded === true || session.turnEnded === false) {
        target.turnEnded = session.turnEnded;
      } else {
        delete target.turnEnded;
      }
      if (session.startedAt && (!target.startedAt || Date.parse(session.startedAt) < Date.parse(target.startedAt))) {
        target.startedAt = session.startedAt;
      }
      if (session.lastUsedAt && (!target.lastUsedAt || Date.parse(session.lastUsedAt) > Date.parse(target.lastUsedAt))) {
        target.lastUsedAt = session.lastUsedAt;
      }
    }
  }
}

// The process-wide rationing for cursor/antigravity syncs. Deliberately a single
// module-scoped instance with no per-call override: the tokscale cache it guards
// is one directory on disk, so a collector rebuilt by a settings change must
// inherit whether its predecessor consumed or returned the shared allowance. A
// second instance would split the state that decides a sync from the state that
// schedules the catch-up waiting on it, which is the divergence this whole path
// keeps being bitten by. Tests read it through the export to pin a floor without
// driving a whole tick; a test wanting isolation builds its own with
// createSelfSyncThrottle() and drives that directly, rather than threading one
// back in here.
const selfSyncThrottle = createSelfSyncThrottle();

const { maybeSyncCursor } = createCursorSelfSync({ selfSyncThrottle });
const { maybeSyncAntigravity } = createAntigravitySelfSync({ selfSyncThrottle, tokscaleCommand });

const HISTORY_CAP_DAYS = 370;
const HISTORY_TIMEOUT_MS = 60000;
const DEFAULT_HISTORY_INTERVAL_MS = 15 * 60 * 1000;
const HISTORY_INTERVAL_VALUES = new Set([5, 10, 15, 30, 60].map((minutes) => minutes * 60 * 1000));

function normalizeHistoryIntervalMs(value) {
  const parsed = Number(value);
  return HISTORY_INTERVAL_VALUES.has(parsed) ? parsed : DEFAULT_HISTORY_INTERVAL_MS;
}

async function collectHistoryOnce(options) {
  throwIfAborted(options.signal);
  const startedAt = Date.now();
  const attemptedAt = new Date(startedAt).toISOString();
  let failureCode = null;
  const reportStatus = (success) => {
    try {
      options.onHistoryStatus?.({
        attemptedAt,
        successAt: success ? new Date().toISOString() : null,
        failureCode,
        durationMs: Math.max(0, Date.now() - startedAt)
      });
    } catch (_) {
      // Diagnostic observers must never affect history collection.
    }
  };
  const clients = normalizeClientsCsv(options.clients);
  if (options.historyEnabled === false) return null;
  let liveHistory = null;
  const rawGraphs = [];
  const runGraph = options.runGraph || runTokscaleGraph;
  const capDays = Number.isFinite(options.capDays) ? options.capDays : HISTORY_CAP_DAYS;
  const todayKey = options.todayKey || localTodayKey();
  if (clients) {
    try {
      const graphJson = await runGraph({
        clients,
        commandTimeoutMs: options.commandTimeoutMs || HISTORY_TIMEOUT_MS,
        signal: options.signal
      });
      throwIfAborted(options.signal);
      rawGraphs.push(graphJson);
      liveHistory = normalizeHistory(parseGraphResult(graphJson), { capDays, todayKey });
    } catch (error) {
      if (options.signal?.aborted) throw abortReason(options.signal);
      failureCode = 'history-graph-failed';
      if (typeof options.logger === 'function') options.logger(`tokscale graph failed: ${error.message}`);
    }
  }
  if (options.dailyHistoryArchiveEnabled) {
    try {
      const retainedGraph = retainDailyHistory(rawGraphs, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: options.dailyHistoryLiveDays,
        pricingRevision: options.pricingRevision,
        customPricingActive: options.customPricingActive,
        todayKey,
        capDays,
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      const retained = normalizeHistory(parseGraphResult(retainedGraph), { capDays, todayKey });
      const result = retained.daily.length || retained.monthly.length ? retained : null;
      reportStatus(failureCode === null);
      return result;
    } catch (error) {
      failureCode = failureCode || 'daily-history-archive-failed';
      if (typeof options.logger === 'function') options.logger(`daily history archive failed: ${error.message}`);
    }
  }
  if (!liveHistory) {
    reportStatus(false);
    return null;
  }
  const result = liveHistory.daily.length || liveHistory.monthly.length ? liveHistory : null;
  reportStatus(failureCode === null);
  return result;
}

function shouldIncludeHistory(nowMs, lastHistoryAtMs, historyIntervalMs, force, enabled = true) {
  if (enabled === false) return false;
  if (force) return true;
  return nowMs - (lastHistoryAtMs || 0) >= historyIntervalMs;
}
async function collectUsageOnce(options) {
  throwIfAborted(options.signal);
  const { clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion = appVersion(), agentRuntime = '' } = options;
  // One snapshot, one instant: capture the clock before any tokscale scan and
  // reuse it for the today-window key and updatedAt, so a collection that
  // straddles local midnight cannot pair a day-N today scan with a day-N+1
  // window (issue #37 follow-up). Injectable for tests.
  const collectedAt = collectionDate(options.now);
  const reportTerminationUnconfirmed = (operation) => {
    try {
      options.onDiagnosticEvent?.({
        subsystem: 'collector',
        code: 'subprocess-termination-unconfirmed',
        operation
      });
    } catch (_) {
      // Diagnostics observers must never affect collection or cancellation.
    }
  };
  const projectsEnabled = options.projectsEnabled !== false;
  const runTokscaleScan = options.runTokscale || ((input) => runTokscale({
    ...input,
    workspaces: projectsEnabled,
    customScanPaths: options.customScanPaths,
    homeDir: options.homeDir,
    terminationOptions: options.subprocessTerminationOptions,
    onTerminationUnconfirmed: () => reportTerminationUnconfirmed('tokscale-scan')
  }));
  const runTokscaleFn = async (input) => {
    const json = await runTokscaleScan(input);
    applyTokscaleSessionMetadata(json, { resolveProjects: projectsEnabled });
    return json;
  };
  const runGraphFn = options.runGraph || ((input) => runTokscaleGraph({
    ...input,
    customScanPaths: options.customScanPaths,
    homeDir: options.homeDir,
    terminationOptions: options.subprocessTerminationOptions,
    onTerminationUnconfirmed: () => reportTerminationUnconfirmed('tokscale-graph')
  }));
  const collectWsl = options.collectWslUsage || collectWslUsageImpl;
  const probeWslStateFn = options.probeWslState || probeWslStateImpl;
  // Injectable only for the WSL-status gate, so tests can exercise the win32
  // build path on a non-Windows CI box (the real process.platform stays for
  // tokscale binary resolution, which is genuinely platform-bound).
  const platformValue = options.platform || process.platform;
  const osInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const normalizedClients = normalizeClientsCsv(clients);
  const localSessionMetadataDeps = {
    ...(options.sessionMetadataDeps || {}),
    customScanPaths: options.customScanPaths,
    metadataCache: new Map(),
    resolvedSessionKeys: new Set(),
    attemptedSessionKeys: new Set(),
    invalidatedTitleKeys: new Set(),
    t3Titles: {}
    // dshSessionFileCache is deliberately NOT reset here: it's module-level
    // (declared with jsonlTimestampCache above) precisely so it survives
    // across collectUsageOnce calls. These caches and sets start fresh each
    // call; watch ticks recover title provenance from their local anchor below.
  };
  const decorateLocalPeriods = (periods, { retryMisses = false } = {}) => applySessionMetadata(
    periods,
    options.homeDir || os.homedir(),
    // Still unconditional: only the clients whose parser records a workspace come
    // back from the scan attributed, so the resolvers stay the answer for the rest.
    // applySessionMetadata skips the expensive path read per session, not per tick.
    { ...localSessionMetadataDeps, retryMisses, resolveProjects: projectsEnabled }
  );
  const trackedClientSet = new Set(normalizedClients.split(',').filter(Boolean));
  const targetClients = [...new Set(normalizeClientsCsv(options.targetClients).split(',').filter((client) => trackedClientSet.has(client)))];
  const targetRequested = targetClients.length > 0;
  const targetClientSet = new Set(targetClients);
  const targetClientsCsv = targetClients.join(',');
  let today = emptyPeriod();
  let month = emptyPeriod();
  let allTime = emptyPeriod();
  let dailyHistoryLiveDays = options.dailyHistoryLiveDays;
  let todayPartitions = null;
  const anchor = options.todayOnlyAnchor;
  const anchorUsed = Boolean(
    anchor
    && anchor.dateKey === localTodayKey(collectedAt)
    && canTargetTodayPartitions(anchor, targetClients)
  );
  if (anchorUsed) localSessionMetadataDeps.t3Titles = anchor.todayT3Titles || anchor.t3Titles || {};
  const emitProgress = (periods) => {
    if (typeof options.onProgress !== 'function') return;
    try { options.onProgress({ ...periods, updatedAt: new Date().toISOString() }); } catch (_) {}
  };
  if (normalizedClients) {
    const syncClients = targetRequested ? targetClientsCsv : normalizedClients;
    await maybeSyncCursor(syncClients, options.logger, {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'cursor'),
      signal: options.signal,
      timeoutMs: options.selfSyncTimeoutMs,
      terminationOptions: options.subprocessTerminationOptions,
      onTerminationUnconfirmed: () => reportTerminationUnconfirmed('cursor-sync'),
      onFailure: options.onSelfSyncFailed
    });
    await maybeSyncAntigravity(syncClients, options.logger, options.homeDir || os.homedir(), {
      minIntervalMs: selfSyncThrottle.minIntervalForTick(options, 'antigravity'),
      run: options.runAntigravitySync,
      syncLockPath: options.antigravitySyncLockPath,
      signal: options.signal,
      timeoutMs: options.selfSyncTimeoutMs,
      terminationOptions: options.subprocessTerminationOptions,
      onTerminationUnconfirmed: () => reportTerminationUnconfirmed('antigravity-sync'),
      onFailure: options.onSelfSyncFailed
    });
    throwIfAborted(options.signal);
    throwIfAborted(options.signal);
    if (anchorUsed) {
      // Anchored tick (watch-triggered): every tokscale period scan costs the
      // same full load + filter, so scan only --today and update the broader
      // windows exactly via applyPeriodDelta — one spawn instead of three.
      const scanClients = targetRequested ? targetClientsCsv : normalizedClients;
      let freshPartitions = Object.create(null);
      let useTargetedPartitions = targetRequested;
      if (scanClients) {
        const todayJson = await runTokscaleFn({ clients: scanClients, flags: ['--today'], commandTimeoutMs, signal: options.signal });
        throwIfAborted(options.signal);
        const bundle = extractUsageBundleFromTokscale(todayJson);
        freshPartitions = bundle.byClient;
        const unattributed = freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        const attributedClients = Object.keys(freshPartitions).filter((client) => client !== UNATTRIBUTED_USAGE_CLIENT);
        const hasMissingTargetPartition = (
          targetClients.length > 1
          && targetClients.some((client) => !Object.prototype.hasOwnProperty.call(freshPartitions, client))
        );
        const hasUnsafeTargetedResult = (
          periodHasUsage(unattributed)
          || attributedClients.some((client) => !targetClientSet.has(client))
          || hasMissingTargetPartition
        );

        // A unioned watch scan can hide cross-attribution inside its own target
        // set, and a missing partition cannot distinguish deletion from an
        // incomplete or polluted union. Rebuild one authoritative full snapshot
        // rather than trying to repair a partial result client by client.
        if (targetRequested && hasUnsafeTargetedResult) {
          // Every attributed row from a targeted scan must normalize back into
          // the requested set. An unattributed row or an unexpected client would
          // otherwise clear the target while partially overwriting an unrelated
          // anchor partition. Rebuild the complete today snapshot instead.
          const fullTodayJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--today'], commandTimeoutMs, signal: options.signal });
          throwIfAborted(options.signal);
          freshPartitions = extractUsageBundleFromTokscale(fullTodayJson).byClient;
          useTargetedPartitions = false;
        } else if (targetRequested) {
          // Empty tokscale output uses the unattributed fallback shape. Keep the
          // anchor's real unattributed partition while clearing the target.
          delete freshPartitions[UNATTRIBUTED_USAGE_CLIENT];
        }
      }
      todayPartitions = useTargetedPartitions
        ? replaceTodayPartitions(anchor.todayPartitions, freshPartitions, targetClients)
        : completeTodayPartitions(freshPartitions, normalizedClients);
      today = mergeTodayPartitions(todayPartitions);
      month = applyPeriodDelta(anchor.month, today, anchor.today);
      allTime = applyPeriodDelta(anchor.allTime, today, anchor.today);
    } else if (normalizedClients) {
      // Serial on purpose: concurrent scans triple the peak CPU/IO load, which
      // is what let the issue #15 self-trigger loop spike tokscale past 500% CPU.
      const todayJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--today'], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal);
      const todayBundle = extractUsageBundleFromTokscale(todayJson);
      today = todayBundle.period;
      todayPartitions = todayBundle.byClient;
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today });
      emitProgress({ today });
      const monthJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--month'], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal);
      month = extractUsageFromTokscale(monthJson);
      if (typeof options.onProgress === 'function') decorateLocalPeriods({ today, month });
      emitProgress({ today, month });
      const allTimeJson = await runTokscaleFn({ clients: normalizedClients, flags: ['--since', allTimeSince], commandTimeoutMs, signal: options.signal });
      throwIfAborted(options.signal);
      allTime = extractUsageFromTokscale(allTimeJson);
    }
    // Always decorate: session timestamps drive the recency sort regardless of the
    // Projects opt-out (issue #182). decorateLocalPeriods gates only project identity
    // on projectsEnabled, so opting out still costs the timestamp backfill and nothing
    // more.
    if (anchorUsed) {
      // Watch tick: `today` is a fresh scan and must be decorated, but month/
      // allTime are derived from the last full-scan anchor and already carry each
      // session's project label + timestamps through applyPeriodDelta. Decorating
      // them again would re-stat every historical session file every few seconds
      // (the perceived UI stutter). Decorate only today, then propagate its freshly
      // resolved identities onto sessions that started today (absent from the anchor).
      decorateLocalPeriods({ today }, { retryMisses: true });
      propagateTodayProjects(today, [month, allTime], {
        invalidatedTitleKeys: localSessionMetadataDeps.invalidatedTitleKeys,
        t3Titles: anchor.t3Titles
      });
    } else {
      decorateLocalPeriods({ today, month, allTime }, { retryMisses: true });
    }
    todayPartitions = completeTodayPartitions(todayPartitions, normalizedClients);
    // Partition metadata is internal but must remain as complete as the public
    // period: a later targeted tick re-merges these sessions into `today`.
    propagateTodayProjects(today, Object.values(todayPartitions), localSessionMetadataDeps);
  }

  // WSL contribution (Windows only; no-op elsewhere). Full tick scans running WSL
  // homes; watch tick reuses the frozen snapshot so the Windows-only delta anchor
  // above stays exact (issue #15). Merged before deriveClientStatus so a client
  // that only exists inside WSL still reports as active.
  //
  // Three WSL refresh modes:
  // 1. refreshWsl (interval anchored tick): scan WSL fresh — the 5-minute interval
  //    is too long to let WSL go stale, but re-scanning tokscale is avoided.
  // 2. wslAnchor (watch anchored tick): reuse the frozen snapshot — WSL is heavy
  //    and watch ticks fire every few seconds.
  // 3. !anchorUsed (full scan): scan WSL as part of the complete rescan.
  const windowsPeriods = { today, month, allTime };
  let wslBundle = emptyWslBundle();
  let wslDetected = [];
  if (normalizedClients && options.wslScanEnabled !== false) {
    if (options.refreshWsl) {
      const wslResult = await collectWsl({
        clients: normalizedClients,
        trackedClients: normalizedClients,
        allTimeSince,
        commandTimeoutMs,
        signal: options.signal,
        runTokscale: runTokscaleFn,
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionMetadata(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    } else if (options.wslAnchor) {
      wslBundle = options.wslAnchor;
    } else if (!anchorUsed) {
      const wslResult = await collectWsl({
        clients: normalizedClients,
        trackedClients: normalizedClients,
        allTimeSince,
        commandTimeoutMs,
        signal: options.signal,
        runTokscale: runTokscaleFn,
        logger: options.logger,
        decoratePeriods: (periods, home) => applySessionMetadata(periods, home, { scopedHome: true, resolveProjects: projectsEnabled })
      });
      wslBundle = wslResult.bundle;
      wslDetected = wslResult.detected;
    }
  }
  today = mergePeriods(windowsPeriods.today, wslBundle.today);
  month = mergePeriods(windowsPeriods.month, wslBundle.month);
  allTime = mergePeriods(windowsPeriods.allTime, wslBundle.allTime);
  throwIfAborted(options.signal);

  // The renderer intentionally uses the live today period while a day is in
  // progress. Callers that do not defer capture persist the largest complete
  // live snapshot here; startCollector defers it until after transformUsage so
  // the saved value matches the period delivered to the renderer.
  if (
    options.historyEnabled !== false
    && options.dailyHistoryArchiveEnabled
    && options.deferLiveHistoryCapture !== true
  ) {
    try {
      const retainedLive = retainLiveDailyHistory(today, {
        ...(options.dailyHistoryArchiveOptions || {}),
        liveDays: dailyHistoryLiveDays,
        todayKey: localTodayKey(collectedAt),
        pricingRevision: options.pricingRevision,
        writeEnabled: options.dailyHistoryArchiveWriteEnabled
      });
      dailyHistoryLiveDays = retainedLive.liveDays || {};
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`daily live history archive failed: ${error.message}`);
    }
  }

  // WSL attribution (Windows only; null elsewhere). detected = markers found,
  // withData = clients whose WSL scan or local parser returned tokens. The gap
  // is the diagnostic (e.g. Hermes detected but unreadable over 9P).
  //
  // Like wslBundle, this is FROZEN between full scans: anchored watch ticks
  // (which skip the WSL scan) reuse the snapshot via options.wslStatus instead
  // of re-probing — otherwise every few-second watch tick would spawn wsl.exe
  // and stall the fast refresh path (issue #15's load concern).
  let wslStatus = null;
  if (platformValue === 'win32' && normalizedClients) {
    const reuseFrozen = !options.refreshWsl && options.wslAnchor && options.wslStatus;
    if (options.wslScanEnabled === false) {
      wslStatus = { state: 'disabled', detected: [], withData: [] };
    } else if (reuseFrozen) {
      wslStatus = options.wslStatus;
    } else {
      const probe = probeWslStateFn({});
      if (probe !== 'ok') {
        wslStatus = { state: probe, detected: [], withData: [] };
      } else {
        const withData = Object.keys(wslBundle.allTime.clients || {});
        const state = withData.length > 0 ? 'active' : 'no-data';
        wslStatus = { state, detected: wslDetected, withData };
      }
    }
  }

  // One filesystem probe per tick, shared by the legacy status and the health
  // record below. Probing twice cost a second pass over every client's roots —
  // including the per-workspace walk Copilot needs — and let one snapshot report
  // a directory as both present and absent when it appeared between the two.
  const sourceChecks = clientSourceChecks(normalizedClients, {
    customScanPaths: options.customScanPaths,
    env: options.env,
    homeDir: options.homeDir,
    platform: platformValue,
    wslDetected: wslStatus?.detected
  });

  const summary = {
    deviceId,
    hostname: os.hostname(),
    platform: `${process.platform}-${process.arch}`,
    ...(osInfo.name ? { osName: osInfo.name } : {}),
    ...(osInfo.version ? { osVersion: osInfo.version } : {}),
    updatedAt: collectedAt.toISOString(),
    agentVersion,
    ...(agentRuntime ? { agentRuntime } : {}),
    projectsEnabled,
    trackedClients: normalizedClients ? normalizedClients.split(',') : [],
    clientStatus: deriveClientStatus(normalizedClients, allTime, { sourceChecks }),
    wslStatus,
    periodWindows: computePeriodWindows(collectedAt),
    historyAvailable: options.historyEnabled !== false,
    today,
    month,
    allTime
  };
  if (options.reasonixNativeSessionsEnabled === true && trackedClientSet.has('reasonix')) {
    try {
      const nativeCache = options.reasonixNativeSessionCache || createReasonixNativeSessionCache({
        env: options.env || process.env,
        homeDir: options.homeDir || os.homedir(),
        platform: platformValue,
        cwdDir: options.cwdDir || process.cwd(),
        projectIdentity
      });
      const nativeView = nativeCache.getView({ now: collectedAt, projectsEnabled, allTimeSince });
      summary.nativeSessions = nativeView.sessions;
      summary.nativeProjects = nativeView.projects;
    } catch (error) {
      if (typeof options.logger === 'function') options.logger(`reasonix native session scan failed: ${error.message}`);
      const empty = emptyNativeView();
      summary.nativeSessions = empty.sessions;
      summary.nativeProjects = empty.projects;
    }
  }
  if (typeof options.onAnchorComputed === 'function') {
    // Title provenance belongs to the local anchor, never to published rows.
    const t3Titles = { ...localSessionMetadataDeps.t3Titles };
    for (const key of localSessionMetadataDeps.invalidatedTitleKeys) t3Titles[key] = null;
    for (const [key, meta] of localSessionMetadataDeps.metadataCache) {
      if (meta.t3Title) t3Titles[key] = meta.t3Title;
    }
    options.onAnchorComputed({
      windowsPeriods,
      todayPartitions,
      t3Titles,
      wslBundle,
      wslStatus,
      ...(summary.nativeSessions ? { nativeSessions: summary.nativeSessions } : {}),
      ...(summary.nativeProjects ? { nativeProjects: summary.nativeProjects } : {})
    });
  }
  if (options.historyEnabled === false) {
    summary.history = null;
  } else if (options.includeHistory) {
    throwIfAborted(options.signal);
    const history = await collectHistoryOnce({
      clients: normalizedClients,
      historyEnabled: options.historyEnabled,
      commandTimeoutMs: options.historyTimeoutMs,
      capDays: options.historyCapDays,
      todayKey: localTodayKey(collectedAt),
      runGraph: runGraphFn,
      signal: options.signal,
      dailyHistoryArchiveEnabled: options.dailyHistoryArchiveEnabled,
      dailyHistoryArchiveWriteEnabled: options.dailyHistoryArchiveWriteEnabled,
      dailyHistoryArchiveOptions: options.dailyHistoryArchiveOptions,
      dailyHistoryLiveDays,
      pricingRevision: options.pricingRevision,
      customPricingActive: options.customPricingActive,
      onHistoryStatus: options.onHistoryStatus,
      logger: options.logger
    });
    throwIfAborted(options.signal);
    if (history) summary.history = history;
  }
  // After history, so `lastActivityDay` can come from the daily buckets this
  // scan already produced rather than from a second source of truth.
  const clientHealth = deriveClientHealth(normalizedClients, allTime, {
    sourceChecks,
    wslStatus,
    observedAt: collectedAt,
    lastActivityDays: mergeClientActivityDays(
      options.lastActivityDays,
      summary.history,
      today,
      localTodayKey(collectedAt)
    )
  });
  if (clientHealth) summary.clientHealth = clientHealth;
  return summary;
}

// Sources that remain part of collection, health, and diagnostics but are too
// broad for a persistent recursive watcher. Kiro globalStorage accepts every
// `.chat`, `.json`, and extensionless file at any depth in tokscale, so a real
// tree can require thousands of native directory watches; after descriptor
// exhaustion the same tree becomes an even more expensive 2-second polling
// watch. Regular interval ticks (five minutes by default), manual refreshes, and
// hourly full reconciliation still scan it through the unchanged Kiro client.
const INTERVAL_ONLY_SOURCE_CHECK_IDS = new Set(['kiro-ide-globalstorage']);

// The watcher only ever wants paths, so it keeps its original shape rather than
// learning about check ids it would immediately discard.
function clientWatchCandidates(clientsCsv, options = {}) {
  const byClient = {};
  for (const [client, roots] of Object.entries(clientSourceRoots(clientsCsv, options))) {
    // The Copilot data root already keeps its `otel/` child through the
    // matcher below. Keep that child as a diagnostic/source check, but do not
    // hand both nested paths to chokidar or it may install two native watches
    // over the same tree.
    byClient[client] = roots
      .filter((root) => (
        !(client === 'copilot' && root.id === 'copilot-otel')
        && !INTERVAL_ONLY_SOURCE_CHECK_IDS.has(root.id)
      ))
      .map((root) => root.dir);
  }
  return byClient;
}

// Clients whose dirs are tokscale caches written only by our own maybeSync* calls.
// Watching them turns every tick into the trigger for the next one (issue #15).
const SELF_SYNCED_CLIENTS = new Set(SELF_SYNC_KINDS);

// Watch roots that feed a self-sync, keyed by client. Antigravity's IDE cache is
// written by our sync and must stay watch-excluded, but the native session roots
// are read-only inputs to that sync (tokscale only ever readdir/stats them —
// every write it makes lands in its own cache dir). Watching those gives the
// collector an event to target without recreating the issue #15
// cache-write -> watcher -> sync loop, and an event here is what earns the sync
// its short source-event floor.
//
// The parse-local antigravity-cli dir is deliberately not in here even though it
// shares the umbrella client id: tokscale reads it directly, so a CLI write has
// nothing to re-sync and must not pay for the subprocess.
function selfSyncSourceRootsForClients(clientsCsv) {
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const rootsByClient = {};
  if (enabled.has('antigravity')) {
    const sourceRoots = [...new Set(antigravityDataRoots().filter(dirExists))];
    if (sourceRoots.length > 0) rootsByClient.antigravity = sourceRoots;
  }
  return rootsByClient;
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
  for (const [client, dirs] of Object.entries(selfSyncSourceRootsForClients(clientsCsv))) {
    rootsByClient[client] = [...new Set([...(rootsByClient[client] || []), ...dirs])];
  }
  // The Antigravity CLI writes parse-local SQLite that tokscale reads directly,
  // so it is also safe to watch and shares the umbrella client id. The filter
  // expands that id to antigravity-cli when the targeted scan runs.
  const enabled = new Set(String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean));
  const antigravityCliDir = antigravityCliDataDir();
  if (enabled.has('antigravity') && dirExists(antigravityCliDir)) {
    rootsByClient.antigravity = [...new Set([...(rootsByClient.antigravity || []), antigravityCliDir])];
  }
  if (enabled.has('reasonix')) {
    const nativeRoots = reasonixNativeSessionWatchRoots();
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
// differ in exactly one place: a custom Copilot exporter has to be *watched* by
// its parent directory (the file can appear later), while attributing by that
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
  const exporter = copilotExporterWatch(os.homedir());
  if (!exporter || !rootsByClient.copilot) return rootsByClient;
  const exporterDir = path.resolve(exporter.dir);
  const ownedByOtherSource = new Set(
    (clientSourceRoots(clientsCsv, options).copilot || [])
      .filter((root) => root.id !== 'copilot-otel-exporter')
      .map((root) => path.resolve(root.dir))
  );
  const copilot = rootsByClient.copilot
    .filter((root) => path.resolve(root) !== exporterDir || ownedByOtherSource.has(exporterDir));
  copilot.push(exporter.canonicalFile);
  return { ...rootsByClient, copilot: [...new Set(copilot)] };
}

function clientsForWatchPath(filePath, rootsByClient) {
  if (!filePath) return [];
  const resolved = path.resolve(filePath);
  const matched = [];
  for (const [client, roots] of Object.entries(rootsByClient || {})) {
    if (roots.some((root) => {
      const resolvedRoot = path.resolve(root);
      return resolved === resolvedRoot || resolved.startsWith(resolvedRoot + path.sep);
    })) matched.push(client);
  }
  return matched;
}

// Inside a Hermes home dir tokscale only reads the SQLite db; the rest is the
// Desktop App runtime (hermes-agent/node_modules/venv, logs, cache — 150k+ files
// for some users). A plain recursive watch of ~/.hermes pegged CPU at 100%+
// (issue #38). Watching the db files directly instead would miss the WAL/SHM
// sidecars Hermes creates after startup (no seconds-level refresh on a cold
// start), so we keep watching the dir but hand chokidar an `ignored` matcher
// that prunes everything under a Hermes home except the db family. chokidar
// never recurses into an ignored dir (so the runaway poll is gone), yet a
// newly created state.db-wal is still seen on the next top-level readdir.
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
// Both Codex homes an agent can own — `agent/codex-home` and the legacy
// `agent/cli-auth/codex/<profile>` — expose their rollouts under the same two
// directory names, so one set covers both.
const OPENCLAW_CODEX_HOME_DIRS = new Set(['sessions', 'archived_sessions']);
// OpenCode discovers only direct opencode.db / opencode-<channel>.db files.
// WAL/SHM are not database inputs to tokscale, but they are the live-write
// signals that must remain watched so a transaction committed before a
// checkpoint refreshes the usage view.
const OPENCODE_DB_WATCH_PATTERN = /^opencode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// MiMo keeps a multi-gigabyte log/ tree alongside its SQLite state files.
// A plain recursive watch of ~/.local/share/mimocode storms the watcher (every
// SQLite WAL/SHM transaction is a chokidar event, the log dir holds thousands
// of rotated files). Tokscale discovers mimocode.db and
// mimocode-<channel>.db directly under each data root; the sidecars are not
// parsed but must stay watched so a write through WAL/SHM triggers a refresh.
// Keep the home dir watched but ignore everything except that direct db family.
// The home root itself stays watched so a freshly created database or sidecar
// still surfaces on the next top-level readdir.
const MIMO_DB_WATCH_PATTERN = /^mimocode(?:-[A-Za-z0-9._-]+)?\.db(?:-(?:wal|shm))?$/;
// Kiro CLI and Zed expose one SQLite database at a known path. Keep their
// parent dirs watched so the database can appear after startup, but do not
// recurse through the application data trees around them.
const KIRO_DB_WATCH_PATTERN = /^data\.sqlite3(?:-(?:wal|shm))?$/;
const ZED_DB_WATCH_PATTERN = /^threads\.db(?:-(?:wal|shm))?$/;
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

// Tokscale opens one exact database directly under this root instead of walking
// it. Keep the direct children it names — including the WAL/SHM sidecars, which
// are the live-write signal even though tokscale never parses them as databases
// — so a database created later is still discovered, and never recurse into the
// runtime files beside it.
function directChildOnly(isSource) {
  return (parts) => parts.length > 1 || !isSource(parts[0]);
}

// Every source root of every tracked client, paired with its policy. Bounded
// roots are counted so a client set with nothing to prune can skip the matcher
// entirely rather than hand chokidar a predicate that always answers false.
function watchPolicyEntries(clientsCsv, options = {}) {
  const candidates = clientWatchCandidates(clientsCsv, options);
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
      entries.push({ root, prefix: root + path.sep, policy });
      boundedCount += 1;
    }
  };
  const withBasename = (client, basename) =>
    (candidates[client] || []).filter((dir) => path.basename(dir) === basename);

  // Hermes: the SQLite trio is the only source, at any depth. Each explicit
  // watch root — the home AND every profile dir under it — is kept by the
  // matcher itself, so a profile's own database still reports.
  bound('hermes', candidates.hermes || [], (parts) => !HERMES_DB_FILES.has(parts[parts.length - 1]));

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
    if (parts[2] === 'codex-home') return !OPENCLAW_CODEX_HOME_DIRS.has(parts[3]);
    if (parts[2] !== 'cli-auth') return true;
    // Only `cli-auth/codex/<profile>` is a Codex home; `cli-auth/<other>` is an
    // authentication profile Tokscale never reads. The profile level is kept so
    // a login added after startup still reports, and `history.jsonl` beside its
    // session dirs is pruned the same way it is under codex-home.
    if (parts[3] !== 'codex') return true;
    if (parts.length <= 5) return false;
    return !OPENCLAW_CODEX_HOME_DIRS.has(parts[5]);
  });

  bound('copilot', withBasename('copilot', '.copilot'), (parts) => {
    if (parts[0] === 'otel') return false;
    if (parts.length === 1) return !COPILOT_DB_WATCH_PATTERN.test(parts[0]);
    return true;
  });
  bound('copilot', withBasename('copilot', 'workspaceStorage'), (parts) => {
    if (parts.length === 1) return false; // workspace hash dir
    if (parts[1] === 'chatSessions') return false;
    if (parts.length === 2 && parts[1] === 'workspace.json') return false;
    return true;
  });
  // Tokscale ingests exactly the file COPILOT_OTEL_FILE_EXPORTER_PATH names
  // (`path.is_file()`, no glob), but that file need not exist yet, so its parent
  // is what gets watched. The parent is an arbitrary user-chosen directory and
  // can be $HOME — everything in it except that one file is pruned, and
  // watchAttributionRootsForClients keeps it from becoming a copilot prefix.
  const exporter = copilotExporterWatch(os.homedir());
  if (exporter) bound('copilot', [exporter.dir], (_parts, resolved) => resolved !== exporter.canonicalFile);

  const antigravityEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('antigravity');
  bound('antigravity', antigravityEnabled ? antigravityDataRoots() : [], (parts) => {
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

  const reasonixEnabled = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).includes('reasonix');
  bound(
    'reasonix',
    reasonixEnabled ? reasonixNativeSessionWatchRoots().filter(dirExists) : [],
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
  bound('cherrystudio', withBasename('cherrystudio', 'Data'), directChildOnly((name) => CHERRY_STUDIO_DB_WATCH_PATTERN.test(name)));
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
  const builtInBySource = new Map(Object.entries(clientSourceRoots(clientsCsv, options)).map(([client, roots]) => [
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
        .map((dir) => ({ root: canonicalRoot(dir), custom: isCustomOnly(client, canonicalRoot(dir)) }))),
    ...(antigravityEnabled && dirExists(antigravityCliDataDir())
      ? [{ root: canonicalRoot(antigravityCliDataDir()), custom: false }]
      : [])
  ];
  // A directory that is a built-in root for any client keeps everything, even
  // where it is also named as a custom root, by that client or another: the
  // built-in contract is the one that must hold.
  const builtInRoots = new Set(recursive.filter((entry) => !entry.custom).map((entry) => entry.root));
  for (const root of builtInRoots) {
    entries.push({ root, prefix: root + path.sep, policy: KEEP_EVERYTHING });
  }
  for (const root of new Set(recursive.filter((entry) => entry.custom).map((entry) => entry.root))) {
    if (builtInRoots.has(root)) continue;
    entries.push({ root, prefix: root + path.sep, policy: pruneDependencyTrees });
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

// Whether each tracked client has at least one data directory on disk. Takes
// pre-computed checks when the caller already has them: a tick derives the
// legacy status and the health record from one probe, so the two cannot
// disagree about a directory created between two scans of the same snapshot.
function clientDataDirPresence(clientsCsv, options = {}) {
  const presence = {};
  for (const [client, checks] of Object.entries(options.sourceChecks || clientSourceChecks(clientsCsv, options))) {
    presence[client] = checks.some((check) => check.exists);
  }
  return presence;
}

// Pure detection-status derivation, given the two existing signals per client:
// `active`  — tokscale read all-time usage for it,
// `waiting` — its data directory exists but no usage was found,
// `missing` — no data directory on disk.
function statusFromSignals(clients, presence, usageClients) {
  const status = {};
  for (const client of clients) {
    if (Number(usageClients?.[client] || 0) > 0) status[client] = 'active';
    else if (presence?.[client]) status[client] = 'waiting';
    else status[client] = 'missing';
  }
  return status;
}

function deriveClientStatus(clientsCsv, allTimePeriod, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  return statusFromSignals(clients, clientDataDirPresence(clientsCsv, options), allTimePeriod?.clients || {});
}

// The most recent day each client has recorded usage on, read out of the daily
// history buckets this scan already produced. Deliberately not called "last
// used": it is the newest day the collector *holds data for*, which is the
// honest answer to "is this tool quiet, or are we failing to read it". Per-turn
// timestamps would be the stronger signal and tokscale does not expose them.
function clientActivityDaysFromHistory(history) {
  const days = {};
  for (const bucket of history?.daily || []) {
    const key = String(bucket?.date || '').slice(0, 10);
    if (!key) continue;
    for (const [rawClient, usage] of Object.entries(bucket?.perClient || {})) {
      if (Number(usage?.tokens || 0) <= 0) continue;
      // Folds tokscale's aliases onto the umbrella id, so an antigravity-cli day
      // counts as an antigravity day — the same id the health record is keyed on.
      const client = normalizeClientName(rawClient);
      if (!client) continue;
      if (!days[client] || key > days[client]) days[client] = key;
    }
  }
  return days;
}

// A history refresh runs on its own slower cadence than a usage tick, so a tick
// that skipped it keeps the caller's previous map rather than blanking the
// field. Merged per client rather than swapped wholesale: a refresh only carries
// the clients its window still shows, so one that no longer returns a client's
// days must not erase what the last one knew about it. Today's already-collected period is also authoritative for the date: it
// closes the cadence gap without another graph scan. A day only ever moves
// forward, so the newest value wins where sources overlap.
function mergeClientActivityDays(previous, history, todayPeriod, todayKey) {
  const merged = { ...(previous || {}) };
  const candidates = clientActivityDaysFromHistory(history);
  const currentDay = String(todayKey || '').slice(0, 10);
  if (currentDay) {
    for (const [rawClient, tokens] of Object.entries(todayPeriod?.clients || {})) {
      if (Number(tokens || 0) <= 0) continue;
      const client = normalizeClientName(rawClient);
      if (client && (!candidates[client] || currentDay > candidates[client])) {
        candidates[client] = currentDay;
      }
    }
  }
  for (const [client, day] of Object.entries(candidates)) {
    // Per client, newest wins. A plain spread would let a fresh-but-older value
    // push a known day backwards — history is a rolling window and a refresh can
    // legitimately return a shorter one, so "fresh" does not imply "later".
    if (!merged[client] || day > merged[client]) merged[client] = day;
  }
  return merged;
}

// Per-client diagnostics. Every input is a filesystem or subprocess observation
// that only this process can make, which is why the record is built here;
// clientHealth.js owns the shape, the enums and the validation the hub re-runs.
//
// Detail is attached only to clients that are not healthy. A working client is
// fully described by the fixed core, and this record is per client per device on
// a document the hub keeps — so "which of Copilot's two roots is missing" is
// worth its bytes exactly when something is wrong.
function deriveClientHealth(clientsCsv, allTimePeriod, options = {}) {
  const clients = String(clientsCsv || '').split(',').map((value) => value.trim().toLowerCase()).filter(Boolean);
  if (clients.length === 0) return null;
  // Injectable so a test can state the filesystem instead of depending on one:
  // every `overall` below turns on whether a directory exists, which makes the
  // developer's machine and a CI runner disagree about the same input.
  const checksByClient = options.sourceChecks || clientSourceChecks(clientsCsv);
  const usageClients = allTimePeriod?.clients || {};
  const wslDetected = new Set(options.wslStatus?.detected || []);
  const wslWithData = new Set(options.wslStatus?.withData || []);
  const activityDays = options.lastActivityDays || {};
  const throttle = options.selfSyncThrottle || selfSyncThrottle;
  const result = {};
  for (const client of clients) {
    const checks = checksByClient[client] || [];
    const detected = checks.filter((check) => check.exists);
    const liveTokens = Number(usageClients[client] || 0);
    const sync = SELF_SYNCED_CLIENTS.has(client) ? throttle.syncStatus(client) : null;
    const entry = {
      source: {
        state: checks.length === 0 ? 'unknown' : (detected.length > 0 ? 'detected' : 'missing'),
        detectedCount: detected.length,
        checkedCount: checks.length
      },
      collection: { state: sync ? sync.state : 'direct' },
      data: { liveTokens: liveTokens > 0 ? liveTokens : 0 }
    };
    // Kept even for a healthy self-synced client: "last synced two minutes ago"
    // is the answer to "why is today still 0", not a fault report.
    if (sync?.lastAttemptAt) entry.collection.lastAttemptAt = new Date(sync.lastAttemptAt).toISOString();
    if (sync?.lastSuccessAt) entry.collection.lastSuccessAt = new Date(sync.lastSuccessAt).toISOString();
    if (sync?.state === 'failed') {
      if (sync.failureStage) entry.collection.syncFailureStage = sync.failureStage;
      if (sync.detailCode) entry.collection.syncDetailCode = sync.detailCode;
      if (sync.exitCode !== null && sync.exitCode !== undefined) entry.collection.syncExitCode = sync.exitCode;
    }
    const activityDay = activityDays[client];
    if (activityDay) entry.data.lastActivityDay = activityDay;
    const overall = deriveClientOverall(entry);
    if (overall !== 'healthy') {
      if (checks.length > 0 && detected.length < checks.length) {
        entry.source.checks = checks.map(({ id, exists }) => ({ id, exists }));
      }
      const codes = [];
      // Only "nothing at all" is a fault. A client's roots are alternatives, not
      // dependencies — Antigravity's IDE cache, native sources and CLI data are
      // three ways to have it installed, and so are Kiro's three — so a partial
      // set is the normal shape of a normal install. `checks` still ships as
      // neutral evidence of which ones were found.
      if (checks.length > 0 && detected.length === 0) codes.push('source-missing');
      if (sync?.detailCode === 'sync-lock-present') codes.push('sync-lock-present');
      else if (sync?.failureCode) codes.push(sync.failureCode);
      if (detected.length > 0 && liveTokens <= 0) codes.push('no-usage-observed');
      // States a fact, not a cause: a marker without usage can equally mean the
      // tool is installed in that distro and simply unused.
      if (wslDetected.has(client) && !wslWithData.has(client)) codes.push('wsl-detected-no-data');
      // An object per diagnostic even though `code` is the only field today: the
      // extension point is inside the entry, and every diagnostics format worth
      // copying (LSP, ESLint, SARIF, RFC 9457) is shaped this way. Growing an
      // object stays compatible; turning `string[]` into `object[]` would not.
      // Severity is deliberately absent — it depends on which client the code
      // lands on, which only the renderer knows.
      if (codes.length > 0) {
        entry.diagnostics = codes.slice(0, MAX_DIAGNOSTICS_PER_CLIENT).map((code) => ({ code }));
      }
    }
    entry.overall = overall;
    result[client] = entry;
  }
  const health = { version: CLIENT_HEALTH_VERSION, clients: result };
  if (options.observedAt) health.observedAt = new Date(options.observedAt).toISOString();
  return health;
}

// The frozen wslAnchor is only valid to merge into a preview period when it was
// captured in the same calendar window: today only if the anchor is from today,
// month only if from the same month. Otherwise a cross-day / cross-month full
// scan would briefly add the previous period's WSL usage to the preview before
// the final fresh scan corrects it. Returns the WSL period to merge, or null.
function wslPeriodsForPreview(wslAnchor, anchorDateKey, todayKey) {
  if (!wslAnchor) return { today: null, month: null };
  const key = anchorDateKey || '';
  return {
    today: key === todayKey ? wslAnchor.today : null,
    month: key.slice(0, 7) === todayKey.slice(0, 7) ? wslAnchor.month : null
  };
}

function completeTodayPartitions(partitions, clientsCsv) {
  const completed = { ...(partitions || {}) };
  for (const client of normalizeClientsCsv(clientsCsv).split(',').filter(Boolean)) {
    if (!Object.prototype.hasOwnProperty.call(completed, client)) completed[client] = emptyPeriod();
  }
  return completed;
}

function replaceTodayPartitions(current, fresh, targetClients) {
  const next = { ...(current || {}) };
  for (const client of targetClients || []) next[client] = emptyPeriod();
  for (const [client, period] of Object.entries(fresh || {})) next[client] = period;
  return next;
}

function mergeTodayPartitions(partitions) {
  return mergePeriods(...Object.values(partitions || {}));
}

function periodHasUsage(period) {
  if (!period) return false;
  return Number(period.totalTokens || 0) > 0
    || Number(period.costUsd || 0) > 0
    || Object.keys(period.sessions || {}).length > 0;
}

function canTargetTodayPartitions(anchor, targetClients) {
  if (!targetClients?.length) return true;
  return Boolean(
    anchor?.todayPartitions
    && !periodHasUsage(anchor.todayPartitions[UNATTRIBUTED_USAGE_CLIENT])
    && targetClients.every((client) => Object.prototype.hasOwnProperty.call(anchor.todayPartitions, client))
  );
}

// Prices affect every scan window. Read the effective file (including entries
// hand-authored outside the widget), and distinguish fork builds whose npm
// version is identical. No transcript cache is changed by this fingerprint.
function pricingFingerprint(options = {}) {
  const pricingPath = options.pricingPath || customPricingPath({
    env: tokscaleEnvWithBlanksDropped(process.env)
  });
  const hash = createHash('sha256');
  hash.update(pricingPath);
  try { hash.update(fs.readFileSync(pricingPath)); }
  catch (error) { hash.update(`|file:${error.code || 'unreadable'}`); }
  if (options.binaryRevision !== undefined) {
    hash.update(`|binary:${options.binaryRevision}`);
  } else {
    const binary = resolvePlatformBinary();
    hash.update(JSON.stringify([binary.source, binary.path, binary.version, readTokscaleBundledBuild()]));
    try {
      const stat = fs.statSync(binary.path);
      hash.update(JSON.stringify([stat.size, stat.mtimeMs, stat.ctimeMs]));
    } catch (_) { hash.update('|binary:missing'); }
  }
  return hash.digest('hex');
}

function configFingerprint(clientsCsv, allTimeSince, projectsEnabled = true, qoderCnDbPath = '', qoderCnProjectsDir = '', customScanPaths = null, pricingRevision = pricingFingerprint()) {
  // Deterministic string that captures the config inputs anchor correctness
  // depends on. When this changes, the persisted anchor is invalidated.
  const qoderCn = String(qoderCnDbPath || '').trim();
  const qoderCnPart = qoderCn ? `|qodercn:${path.resolve(qoderCn)}` : '';
  const qoderCnProjects = String(qoderCnProjectsDir || '').trim();
  const qoderCnProjectsPart = qoderCnProjects ? `|qodercnProjects:${path.resolve(qoderCnProjects)}` : '';
  // Custom scan paths change which files Tokscale reads, so an anchor captured
  // before a path was added or removed must not be reused. Empty when none are
  // configured, keeping the fingerprint (and existing anchors) stable for the
  // common case.
  const scanKey = customScanPathsFingerprint(customScanPaths);
  const scanPart = scanKey ? `|scan:${scanKey}` : '';
  return `${normalizeClientsCsv(clientsCsv)}|${allTimeSince}|projects:${projectsEnabled !== false ? 'on' : 'off'}${qoderCnPart}${qoderCnProjectsPart}${scanPart}|pricing:${pricingRevision}`;
}

function qoderCnSourcesForClients(clientsCsv, options = {}) {
  if (!normalizeClientsCsv(clientsCsv).split(',').includes('qodercn')) return { dbPath: '', projectsDir: '' };
  const paths = qoderCnDataPaths({
    homeDir: options.homeDir,
    platform: options.platform || process.platform,
    env: options.env || process.env
  });
  return { dbPath: paths.dbPaths[0] || '', projectsDir: paths.projectsDir || '' };
}

function qoderCnDbPathForClients(clientsCsv, options = {}) {
  return qoderCnSourcesForClients(clientsCsv, options).dbPath;
}

function qoderCnProjectsDirForClients(clientsCsv, options = {}) {
  return qoderCnSourcesForClients(clientsCsv, options).projectsDir;
}

// The one place that decides whether a persisted anchor may be reused, shared by
// startCollector and by the widget's cold-start seed. Two consumers with two
// copies of these rules is how they drift, and a drifted copy shows the previous
// configuration's totals as if they were current.
//
// Returns null when the anchor is unusable at all. Otherwise `capturedAtMs` is
// the moment it was written, or null when that moment cannot be trusted: the
// collector still reuses the periods then and simply forces a full scan, while
// a seed has nothing to stand on and declines.
function collectorAnchorTrust(saved, options = {}) {
  const { clients = '', allTimeSince = '', projectsEnabled = true, qoderCnDbPath = '', qoderCnProjectsDir = '', customScanPaths = null, now = new Date() } = options;
  if (!saved || saved.dateKey !== localTodayKey(now)) return null;
  if (!saved.today || !saved.month || !saved.allTime) return null;
  // Old Cursor anchors preserve `default` in their broad-period model maps;
  // applying a new `cursor-auto` Today delta to them would split one mode.
  if (normalizeClientsCsv(clients).split(',').includes('cursor') && saved.cursorAutoModelVersion !== 1) return null;
  const pricingRevision = options.pricingRevision ?? pricingFingerprint(options);
  if (saved.configFingerprint !== configFingerprint(clients, allTimeSince, projectsEnabled, qoderCnDbPath, qoderCnProjectsDir, customScanPaths, pricingRevision)) return null;
  const parsed = Date.parse(saved.fullScanAt || '');
  const capturedAtMs = Number.isFinite(parsed) && parsed <= now.getTime() ? parsed : null;
  return { capturedAtMs };
}

// Force a full scan at least this often even when the anchor is otherwise
// valid, so a long-running session periodically rescans month/allTime
// and picks up any changes that the delta-derivation might miss.
const FULL_SCAN_INTERVAL_MS = 60 * 60 * 1000;

// Ceiling on how long an unbroken run of watch events may keep deferring the
// tick. Every event clears the pending debounce timer and re-arms a fresh one,
// so a source that changes more often than once per `watchDebounceMs` would
// hold the live refresh back until the interval fallback. Concurrent agents
// streaming to their transcripts do exactly that. The re-arm itself stays — it
// is what keeps a mid-tick event from coalescing — and 5s is the far end of
// the promised 3-5s refresh, so the ceiling only ever fires where the promise
// was already broken.
const WATCH_MAX_WAIT_MS = 5000;

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
  const pending = [...dirs];
  while (pending.length > 0) {
    const dir = pending.pop();
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
function openWatch(chokidar, config = {}) {
  const ignored = watchIgnoreMatcher(config.clients, { customScanPaths: config.customScanPaths });
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
  return chokidar.watch(config.dirs, watcherOptions(usePolling, ignored));
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
// its -wal, so a genuine change still produces an event; a client whose scan was
// measured NOT to rewrite its sidecar (mimo) is deliberately absent here, and
// adding a client to this list asserts a measurement rather than a hunch.
// Cherry Studio also rewrites its wal-index on repeated read-only WAL scans.
const SELF_WATCHED_SQLITE_SIDECAR_CLIENTS = Object.freeze(['antigravity', 'cherrystudio', 'qodercn', 'zcode']);

function isSelfWatchSqliteSidecarEvent(filePath, rootsByClient = {}) {
  // Match SQLite's wal-index suffix, not one client's database basename: ZCode's
  // file is db.sqlite-shm, whose name does not contain '.db-'. The suffix is
  // required to be one of the SQLite extensions this collector's clients use, so
  // the match cannot widen into an unrelated '-shm' sidecar, and it never matches
  // the -wal or the database itself.
  const name = path.basename(String(filePath || ''));
  if (!/^[^/]+\.(?:db|sqlite|sqlite3)-shm$/.test(name)) return false;
  const resolved = path.resolve(filePath);
  return SELF_WATCHED_SQLITE_SIDECAR_CLIENTS.some((client) => (rootsByClient[client] || [])
    .some((root) => resolved.startsWith(path.resolve(root) + path.sep)));
}

function startCollector(options) {
  const {
    clients, allTimeSince, commandTimeoutMs, deviceId, agentVersion, agentRuntime,
    historyIntervalMs = 15 * 60 * 1000, historyEnabled = true, watchEnabled,
    watchTriggersCollection = true, intervalRequiresActivity = false,
    onUpdate, onPreview, onError, onDiagnosticEvent, logger
  } = options;
  // Normalized once, at the edge. These arrive straight from CLI flags and env
  // vars (TOKEN_MONITOR_WATCH_DEBOUNCE_MS, TOKEN_MONITOR_INTERVAL_MS) by way of
  // a bare Number(), so Infinity and past-32-bit values reach us intact — and
  // setTimeout rewrites those to 1ms, turning the debounce's mid-tick re-arm and
  // the interval loop into spins. Clamping here means no timer below can
  // reintroduce that by forgetting.
  const watchDebounceMs = clampTimerDelayMs(options.watchDebounceMs, 1500);
  // Floored at the debounce: a ceiling shorter than one debounce window would
  // pull every lone event forward and make the debounce itself unobservable.
  const watchMaxWaitMs = Math.max(watchDebounceMs, clampTimerDelayMs(options.watchMaxWaitMs, WATCH_MAX_WAIT_MS));
  const intervalMs = clampTimerDelayMs(options.intervalMs, 5 * 60 * 1000);
  const historyRetryMs = clampTimerDelayMs(options.historyRetryMs, 60 * 1000);
  const watchUsePolling = resolveWatchUsePolling(options.watchUsePolling);
  // Overridable so tests need not build a 20k-entry tree to cross it.
  const watchPollingEntryLimit = Number.isInteger(options.watchPollingEntryLimit) && options.watchPollingEntryLimit >= 0
    ? options.watchPollingEntryLimit
    : WATCH_POLLING_ENTRY_LIMIT;
  const watchNativeForced = watchPollingForbidden();
  const runtimeAbortController = new AbortController();
  const runtimeSignal = runtimeAbortController.signal;
  let startBarrier = options.startBarrier ? Promise.resolve(options.startBarrier) : null;
  const trackedClients = new Set(normalizeClientsCsv(clients).split(',').filter(Boolean));
  const reasonixNativeSessionsEnabled = options.reasonixNativeSessionsEnabled === true;
  const reasonixNativeSessionCache = reasonixNativeSessionsEnabled && trackedClients.has('reasonix')
    ? options.reasonixNativeSessionCache || createReasonixNativeSessionCache({
      env: options.env || process.env,
      homeDir: options.homeDir || os.homedir(),
      platform: options.platform || process.platform,
      cwdDir: options.cwdDir || process.cwd(),
      projectIdentity
    })
    : null;
  const deviceOsInfo = options.osInfo === undefined
    ? hostOsInfo()
    : normalizeOsInfo(options.osInfo);
  const log = logger || (() => {});
  const normalizedClients = normalizeClientsCsv(clients);
  const sourceOptions = {
    customScanPaths: options.customScanPaths,
    env: options.env,
    homeDir: options.homeDir,
    platform: options.platform
  };
  const qoderCnSources = qoderCnSourcesForClients(normalizedClients, {
    homeDir: options.homeDir,
    platform: options.platform,
    env: options.env
  });
  const qoderCnDbPath = qoderCnSources.dbPath;
  const qoderCnProjectsDir = qoderCnSources.projectsDir;
  let tickInFlight = false;
  let idleWaiters = [];
  let tickPending = false;
  let pendingForceHistory = false;
  let pendingRolloverHistoryRetry = false;
  let pendingForceSelfSync = null;
  let pendingSourceSelfSync = null;
  // null until something is actually pending. Tracked separately from the
  // force-sync flags on purpose: a coalesced replay must stay a full scan
  // unless *every* tick folded into it asked for today-only, and deriving that
  // from a force flag would let a manual refresh quietly become a warm scan.
  let pendingTodayOnly = null;
  // null means no pending scope yet; true means an all-client replay; otherwise
  // this Set is the union of targeted today-only requests waiting behind the
  // active tick. A broader request can upgrade this scope but never narrow it.
  let pendingTargetClients = null;
  let pendingActivityRevision = null;
  let lastHistoryAt = 0;
  let lastHistoryAttemptAt = 0;
  let lastHistorySuccessAt = 0;
  let lastHistoryFailureCode = null;
  let lastHistoryScanDurationMs = null;
  let rolloverHistoryPending = false;
  let rolloverHistoryRetryTimer = null;
  // Last full-scan snapshot; lets watch ticks scan only --today and derive
  // month/allTime exactly (applyPeriodDelta). Reset by every full tick.
  // anchor holds Windows-only periods; wslAnchor is the WSL contribution frozen
  // between full ticks (WSL is not scanned on watch ticks).
  let anchor = null;
  let wslAnchor = null;
  let wslStatusAnchor = null;
  // The last-activity days a history refresh produced, carried across the ticks
  // that skip history. Read back out of the record this collector just published
  // rather than kept as a second copy, so the two cannot drift; a restart simply
  // relearns them from the first tick, which always includes history.
  let activityDaysAnchor = {};
  // Keep the highest complete live day in this collector even when another
  // process owns the shared archive. A watch tick can then hand its value to a
  // later full/history tick instead of losing it at the tick boundary.
  let liveDailyHistoryDays = {};
  let pricingRevision = pricingFingerprint(options);
  let lastFullScanAt = 0;
  let pendingWaiters = [];
  let debounceTimer = null;
  // Monotonic ms (performance.now()) by which the current run of watch events
  // must have ticked, or 0 when no run is pending. Not Date.now(): a wall-clock
  // step backwards mid-storm would push the deadline out by the same amount. Set by the first scheduleTick of a run, cleared when
  // a tick actually starts so the next quiet period begins its own run.
  let watchDeadlineAt = 0;
  let intervalTimer = null;
  let stopped = false;
  let lastTickAttemptAt = 0;
  let lastTickSuccessAt = 0;
  let lastTickFailureAt = 0;
  let lastTickDurationMs = null;
  let lastTickScope = 'full';
  let lastTickReasonCode = null;
  let lastTickFailureCode = null;
  let watchFallbackCode = null;
  let lastWatchFailureCode = null;
  let tickHadFailure = false;
  const scheduledWatchClients = new Set();
  let scheduledWatchNeedsFullScan = false;
  // Source events waiting on the shared throttle, and the timer that comes back
  // for them. Built here rather than at module scope because its timer has to
  // die with this collector; the throttle it reads deadlines from is shared, so
  // a rebuild inherits the floors it must not reset. `retryMs` mirrors the watch
  // debounce so a catch-up displaced by an in-flight tick lands just after it.
  const sourceSyncQueue = createSourceSyncQueue({
    throttle: selfSyncThrottle,
    retryMs: watchDebounceMs,
    isBusy: () => tickInFlight,
    // The tick that carried this event already scanned against the stale cache,
    // so the catch-up has to rescan the same clients behind the sync.
    onDue: (sourceSelfSync) => runTick('source-sync', {
      todayOnly: true,
      targetClients: sourceSelfSync,
      sourceSelfSync
    })
  });
  const selfSyncedClients = normalizeClientsCsv(clients).split(',').filter((client) => SELF_SYNCED_CLIENTS.has(client));
  let activityRevision = 0;
  let collectedActivityRevision = 0;
  let initialCollectionComplete = false;
  const watchers = [];
  let watchedDirectoryKey = null;
  // Sticky: once the kernel has refused us watch descriptors, every later
  // rebuild (a client gaining or losing a data directory) stays on polling for
  // the rest of the process. Retrying native events on each rebuild would just
  // rediscover the same exhausted budget.
  let watchDescriptorFallback = false;
  // Also sticky: set when polling would have to cover more than
  // WATCH_POLLING_ENTRY_LIMIT paths. No watcher runs from then on, and the
  // interval loop stops waiting for watch activity, since none can arrive.
  let watchIntervalFallback = false;
  // Sticky as well: the watch host switched to polling on its own.
  let watchHostPolling = false;

  function emitDiagnosticEvent(event) {
    try {
      onDiagnosticEvent?.(event);
    } catch (_) {
      // Diagnostics observers must never affect collection or watcher state.
    }
  }

  function tickReasonCode(reason) {
    const value = String(reason || '').trim().toLowerCase();
    if (value.startsWith('watch:')) return 'watch-event';
    if (value.startsWith('client:')) return 'targeted-client';
    if (value === 'source-sync') return 'source-sync';
    if (value === 'coalesced') return 'coalesced';
    if (value === 'interval') return 'interval';
    if (value === 'manual') return 'manual';
    return 'other';
  }

  function tickScopeCode(tickOptions = {}) {
    if (tickOptions.todayOnly === true && Array.isArray(tickOptions.targetClients) && tickOptions.targetClients.length > 0) {
      return 'targeted';
    }
    return tickOptions.todayOnly === true ? 'today' : 'full';
  }

  function timestampOrNull(value) {
    return Number.isFinite(Number(value)) && Number(value) > 0
      ? new Date(Number(value)).toISOString()
      : null;
  }

  function cloneDiagnosticValue(value) {
    if (value === null || value === undefined) return value ?? null;
    try { return JSON.parse(JSON.stringify(value)); } catch (_) { return null; }
  }

  // On-disk anchor: persist full-scan snapshots so the collector can reuse
  // month/allTime across restarts. On the first interval tick the anchor is
  // valid for today and configFingerprint matches, only --today is scanned
  // and month/allTime are derived via applyPeriodDelta.
  const anchorPath = path.join(sharedDataDir(), 'collector-anchor.json');
  if (options.anchorPersistenceEnabled !== false) {
    try {
      const saved = readJson(anchorPath, null);
      const trust = collectorAnchorTrust(saved, {
        clients,
        allTimeSince,
        projectsEnabled: options.projectsEnabled,
        qoderCnDbPath,
        qoderCnProjectsDir,
        customScanPaths: options.customScanPaths,
        pricingRevision
      });
      if (trust) {
        anchor = {
          dateKey: saved.dateKey,
          today: saved.today,
          month: saved.month,
          allTime: saved.allTime,
          t3Titles: saved.t3Titles,
          todayT3Titles: saved.todayT3Titles,
          // Per-client partitions are deliberately rebuilt by the first
          // anchored all-client tick after restart. Persisted partitions
          // could be stale for clients that changed while the app was down.
          todayPartitions: null
        };
        // Don't restore a persisted WSL snapshot when WSL scanning is now off —
        // the configFingerprint intentionally ignores the toggle (host periods
        // stay valid), so without this gate a warm-scan preview would briefly
        // re-merge the old WSL totals before the first full tick clears them.
        wslAnchor = options.wslScanEnabled !== false ? (saved.wslBundle || null) : null;
        wslStatusAnchor = options.wslScanEnabled !== false ? (saved.wslStatus || null) : null;
        // An untrustworthy capture time leaves lastFullScanAt at 0, which forces
        // a full scan on the first interval tick (see loop()).
        if (trust.capturedAtMs !== null) lastFullScanAt = trust.capturedAtMs;
      }
    } catch (_) {}
  }

  function persistAnchor(tickPricingRevision) {
    if (options.anchorPersistenceEnabled === false) return;
    try {
      fs.mkdirSync(path.dirname(anchorPath), { recursive: true });
      fs.writeFileSync(anchorPath, JSON.stringify({
        dateKey: anchor.dateKey,
        cursorAutoModelVersion: 1,
        today: anchor.today,
        month: anchor.month,
        allTime: anchor.allTime,
        t3Titles: anchor.t3Titles,
        todayT3Titles: anchor.todayT3Titles,
        wslBundle: wslAnchor,
        wslStatus: wslStatusAnchor,
        ...(anchor.nativeSessions ? { nativeSessions: anchor.nativeSessions } : {}),
        ...(anchor.nativeProjects ? { nativeProjects: anchor.nativeProjects } : {}),
        configFingerprint: configFingerprint(clients, allTimeSince, options.projectsEnabled, qoderCnDbPath, qoderCnProjectsDir, options.customScanPaths, tickPricingRevision),
        fullScanAt: new Date(lastFullScanAt).toISOString()
      }));
    } catch (_) {}
  }

  function resolveWaiters(waiters, result) {
    for (const resolve of waiters) resolve(result);
  }

  function clearRolloverHistoryRetry() {
    if (rolloverHistoryRetryTimer) clearTimeout(rolloverHistoryRetryTimer);
    rolloverHistoryRetryTimer = null;
  }

  function settleRolloverHistoryAttempt(success, retryAttempt) {
    if (!rolloverHistoryPending) return;
    if (success || retryAttempt) {
      rolloverHistoryPending = false;
      clearRolloverHistoryRetry();
      return;
    }
    if (rolloverHistoryRetryTimer || stopped) return;
    rolloverHistoryRetryTimer = setTimeout(() => {
      rolloverHistoryRetryTimer = null;
      if (stopped || !rolloverHistoryPending) return;
      // One targeted retry closes a transient midnight graph failure without
      // making every few-second watch event pay for another History scan. A
      // second failure falls back to the normal History interval.
      void runTick('history-rollover-retry', {
        forceHistory: true,
        rolloverHistoryRetry: true,
        todayOnly: true
      });
    }, historyRetryMs);
  }

  const pricingChangedDuringScan = Symbol('pricing changed during scan');

  async function performTick(reason, tickOptions = {}) {
    const tickStartedAt = Date.now();
    const collectedAt = collectionDate(options.now);
    const todayKey = localTodayKey(collectedAt);
    const tickPricingRevision = pricingFingerprint(options);
    const pricingChanged = tickPricingRevision !== pricingRevision;
    if (pricingChanged) {
      anchor = null;
      wslAnchor = null;
      wslStatusAnchor = null;
      liveDailyHistoryDays = {};
      lastFullScanAt = 0;
      lastHistoryAt = 0;
      pricingRevision = tickPricingRevision;
    }
    // The previous live DAY becomes durable history at local midnight. Finalize
    // it before publishing the new day, even when the normal History interval
    // is not due yet, so fixed ranges never wait for the next scheduled graph.
    const localDayRolledOver = Boolean(anchor?.dateKey && anchor.dateKey !== todayKey);
    if (localDayRolledOver && historyEnabled) rolloverHistoryPending = true;
    const includeHistory = shouldIncludeHistory(
      collectedAt.getTime(),
      lastHistoryAt,
      historyIntervalMs,
      Boolean(tickOptions.forceHistory) || localDayRolledOver || pricingChanged,
      historyEnabled
    );
    if (includeHistory) {
      lastHistoryAt = collectedAt.getTime();
      lastHistoryAttemptAt = tickStartedAt;
    }
    let historyScanSucceeded = !includeHistory;
    const requestedTargetClients = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    const targetAnchorReady = canTargetTodayPartitions(anchor, requestedTargetClients);
    const anchored = Boolean(tickOptions.todayOnly && anchor && anchor.dateKey === todayKey);
    const refreshWsl = Boolean(tickOptions.refreshWsl);
    const hadPreviousFailure = tickHadFailure;
    lastTickAttemptAt = tickStartedAt;
    lastTickReasonCode = tickReasonCode(reason);
    lastTickScope = tickScopeCode(tickOptions);
    try {
      let captured = null;
      const summary = await collectUsageOnce({
        ...options,
        signal: runtimeSignal,
        clients,
        allTimeSince,
        commandTimeoutMs,
        deviceId,
        agentVersion,
        agentRuntime,
        osInfo: deviceOsInfo,
        now: collectedAt,
        includeHistory,
        pricingRevision: tickPricingRevision,
        customPricingActive: Object.keys(readJson(options.pricingPath || customPricingPath({ env: tokscaleEnvWithBlanksDropped(process.env) }), {})?.models || {}).length > 0,
        // Capture after the runtime's transformUsage hook so the archive uses
        // the same today period that the user actually sees. The process-local
        // liveDays overlay is passed into any graph scan that happens first.
        deferLiveHistoryCapture: true,
        dailyHistoryLiveDays: liveDailyHistoryDays,
        onHistoryStatus: includeHistory ? (status) => {
          lastHistoryAttemptAt = Date.parse(status.attemptedAt) || lastHistoryAttemptAt;
          const successAt = Date.parse(status.successAt);
          if (Number.isFinite(successAt)) lastHistorySuccessAt = successAt;
          lastHistoryFailureCode = status.failureCode || null;
          lastHistoryScanDurationMs = status.durationMs;
          historyScanSucceeded = Boolean(status.successAt && !status.failureCode);
        } : null,
        forceSelfSync: tickOptions.forceSelfSync ?? null,
        sourceSelfSync: tickOptions.sourceSelfSync ?? null,
        reasonixNativeSessionsEnabled,
        reasonixNativeSessionCache,
        // Both selections name clients whose pending source event this tick has
        // already consumed — the queue's drain for one, its acknowledgement for
        // the other — so either is a legitimate restore.
        onSelfSyncFailed: (kind) => sourceSyncQueue.restore(
          mergeSelfSyncSelection(tickOptions.sourceSelfSync, tickOptions.acknowledgedSourceSync) || [],
          kind
        ),
        targetClients: anchored && targetAnchorReady ? requestedTargetClients : [],
        todayOnlyAnchor: anchored ? anchor : null,
        wslAnchor: anchored ? wslAnchor : null,
        wslStatus: anchored ? wslStatusAnchor : null,
        lastActivityDays: activityDaysAnchor,
        refreshWsl: anchored ? refreshWsl : false,
        onAnchorComputed: (x) => { captured = x; },
        onProgress: (partial) => {
          if (!partial.today) return;
          if (pricingChanged || pricingFingerprint(options) !== tickPricingRevision) return;
          try {
            if (typeof onPreview === 'function') {
              // Frozen WSL snapshot, gated so a cross-day/cross-month full scan
              // doesn't merge a stale period's WSL usage into the preview.
              const wsl = wslPeriodsForPreview(wslAnchor, anchor?.dateKey, todayKey);
              const preview = {
                deviceId, hostname: os.hostname(),
                platform: `${process.platform}-${process.arch}`,
                ...(deviceOsInfo.name ? { osName: deviceOsInfo.name } : {}),
                ...(deviceOsInfo.version ? { osVersion: deviceOsInfo.version } : {}),
                updatedAt: partial.updatedAt,
                agentVersion, agentRuntime,
                trackedClients: (clients || '').split(',').filter(Boolean),
                // Merge the frozen WSL snapshot into today (as month/allTime do
                // below) so the today card keeps its WSL contribution during a
                // warm scan instead of dropping to host-only until the final tick.
                // The upstream wsl.today guard is preserved: non-WSL machines
                // keep the identity pass-through instead of a normalize round
                // trip on this shared preview path.
                today: wsl.today ? mergePeriods(partial.today, wsl.today) : partial.today
              };
              // Only include month/allTime when actually scanned. During warm
              // full scans the main.js handler carries the previous values
              // forward for omitted fields, so these cards don't flash empty.
              if (partial.month) {
                preview.month = wsl.month
                  ? mergePeriods(partial.month, wsl.month)
                  : partial.month;
              }
              if (partial.allTime) {
                preview.allTime = wslAnchor
                  ? mergePeriods(partial.allTime, wslAnchor.allTime)
                  : partial.allTime;
              }
              // Only derive clientStatus when allTime is available; warm
              // scans carry the previous status forward in main.js.
              if (partial.allTime) {
                preview.clientStatus = deriveClientStatus(clients, partial.allTime);
              }
              onPreview(preview);
            }
          } catch (_) {
            // Progressive push errors must not abort the remaining period scans.
            // The final onUpdate will report the complete data.
          }
        }
      });
      if (stopped) return;
      // A settings save can land between the serial period scans. Discard that
      // mixed result and replay all windows against one pricing revision.
      if (pricingFingerprint(options) !== tickPricingRevision) {
        return pricingChangedDuringScan;
      }
      if (includeHistory) {
        settleRolloverHistoryAttempt(
          historyScanSucceeded,
          tickOptions.rolloverHistoryRetry === true
        );
      }
      for (const [client, entry] of Object.entries(summary.clientHealth?.clients || {})) {
        if (entry.data?.lastActivityDay) activityDaysAnchor[client] = entry.data.lastActivityDay;
      }
      if (!anchored && captured) {
        anchor = {
          dateKey: todayKey,
          today: captured.windowsPeriods.today,
          month: captured.windowsPeriods.month,
          allTime: captured.windowsPeriods.allTime,
          todayPartitions: captured.todayPartitions,
          t3Titles: captured.t3Titles,
          todayT3Titles: captured.t3Titles,
          ...(captured.nativeSessions ? { nativeSessions: captured.nativeSessions } : {}),
          ...(captured.nativeProjects ? { nativeProjects: captured.nativeProjects } : {})
        };
        wslAnchor = captured.wslBundle;
        wslStatusAnchor = captured.wslStatus || null;
        lastFullScanAt = Date.now();
        persistAnchor(tickPricingRevision);
      } else if (anchored && captured) {
        // Keep the rolling per-client today partitions fresh for targeted
        // watch ticks. WSL stays independently frozen between interval ticks.
        if (captured.todayPartitions) anchor.todayPartitions = captured.todayPartitions;
        const titlesChanged = JSON.stringify(anchor.todayT3Titles || anchor.t3Titles || {}) !== JSON.stringify(captured.t3Titles);
        if (titlesChanged) {
          // Only labels move: the exact usage baseline and full-scan time stay
          // frozen. This also keeps cold-start previews at the latest title.
          for (const [key, title] of Object.entries(captured.t3Titles || {})) {
            for (const period of ['today', 'month', 'allTime']) {
              const session = anchor[period]?.sessions?.[key];
              if (!session) continue;
              if (title) session.title = title;
              else if (session.title === anchor.t3Titles?.[key]) {
                const fallback = summary[period]?.sessions?.[key]?.title;
                if (fallback) session.title = fallback;
                else delete session.title;
              }
            }
          }
          anchor.t3Titles = captured.t3Titles;
        }
        anchor.todayT3Titles = captured.t3Titles;
        if (captured.nativeSessions) anchor.nativeSessions = captured.nativeSessions;
        if (captured.nativeProjects) anchor.nativeProjects = captured.nativeProjects;
        if (refreshWsl) {
          wslAnchor = captured.wslBundle;
          wslStatusAnchor = captured.wslStatus || null;
        }
        if (titlesChanged) persistAnchor(tickPricingRevision);
      }
      const transformedSummary = await onUpdate?.(summary, reason);
      const visibleSummary = transformedSummary && typeof transformedSummary === 'object'
        ? transformedSummary
        : summary;
      if (historyEnabled !== false && options.dailyHistoryArchiveEnabled) {
        try {
          const visibleAt = visibleSummary.updatedAt || summary.updatedAt;
          const visibleDate = visibleAt ? new Date(visibleAt) : new Date();
          const visibleDateKey = Number.isFinite(visibleDate.getTime())
            ? localTodayKey(visibleDate)
            : todayKey;
          const retainedLive = retainLiveDailyHistory(visibleSummary.today, {
            ...(options.dailyHistoryArchiveOptions || {}),
            liveDays: liveDailyHistoryDays,
            todayKey: visibleDateKey,
            pricingRevision: tickPricingRevision,
            // Watch ticks update the in-memory maximum on every refresh, but
            // only full/history ticks write it. This avoids a disk write for
            // every few-second watch event without dropping the value before
            // the next tick or local-day rollover.
            writeEnabled: !anchored || includeHistory
              || anchor?.dateKey !== visibleDateKey
              ? options.dailyHistoryArchiveWriteEnabled
              : false
          });
          liveDailyHistoryDays = retainedLive.liveDays || {};
        } catch (error) {
          log(`daily live history archive failed: ${error.message}`);
        }
      }
      const tickFinishedAt = Date.now();
      lastTickSuccessAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = null;
      tickHadFailure = false;
      if (hadPreviousFailure) {
        emitDiagnosticEvent({
          subsystem: 'collector',
          code: 'collector-recovered',
          durationMs: lastTickDurationMs
        });
      }
      if (!anchored) setupWatchers();
      if (Number.isFinite(tickOptions.activityRevision)) {
        collectedActivityRevision = Math.max(collectedActivityRevision, tickOptions.activityRevision);
        initialCollectionComplete = true;
      }
      return true;
    } catch (error) {
      if (stopped) return;
      if (includeHistory) {
        settleRolloverHistoryAttempt(false, tickOptions.rolloverHistoryRetry === true);
      }
      const tickFinishedAt = Date.now();
      lastTickFailureAt = tickFinishedAt;
      lastTickDurationMs = Math.max(0, tickFinishedAt - tickStartedAt);
      lastTickFailureCode = 'tick-failed';
      tickHadFailure = true;
      emitDiagnosticEvent({
        subsystem: 'collector',
        code: 'collector-tick-failed',
        scope: lastTickScope,
        durationMs: lastTickDurationMs
      });
      // takeWatchClients() already drained the pending set, so the clients this
      // tick was meant to cover are gone. Force the next tick to scan all of
      // them in every mode: in live mode the next watch event would otherwise
      // target only its own client and leave the failed one serving the stale
      // anchor partition until the 5–30 minute interval reconciles it, which
      // breaks the seconds-level freshness live mode promises.
      scheduledWatchNeedsFullScan = true;
      if (onError) onError(error, reason); else log(`collector tick failed (${reason}): ${error.message}`);
      return false;
    }
  }

  function mergePendingTargetScope(tickOptions) {
    const todayOnly = tickOptions.todayOnly === true;
    const targets = [...new Set(normalizeClientsCsv(tickOptions.targetClients).split(',').filter(Boolean))];
    if (!todayOnly || targets.length === 0) {
      pendingTargetClients = true;
      return;
    }
    if (pendingTargetClients === true) return;
    if (!(pendingTargetClients instanceof Set)) pendingTargetClients = new Set();
    for (const client of targets) pendingTargetClients.add(client);
  }

  async function runTick(reason, tickOptions = {}) {
    if (stopped || runtimeSignal.aborted) return false;
    if (startBarrier) {
      const barrier = startBarrier;
      try {
        await barrier;
      } finally {
        if (startBarrier === barrier) startBarrier = null;
      }
      if (stopped || runtimeSignal.aborted) return false;
    }
    const tickActivityRevision = Number.isFinite(tickOptions.activityRevision)
      ? tickOptions.activityRevision
      : activityRevision;
    const effectiveTickOptions = { ...tickOptions, activityRevision: tickActivityRevision };
    if (tickInFlight) {
      tickPending = true;
      pendingForceHistory = pendingForceHistory || Boolean(tickOptions.forceHistory);
      pendingRolloverHistoryRetry = pendingRolloverHistoryRetry
        || Boolean(tickOptions.rolloverHistoryRetry);
      pendingForceSelfSync = mergeSelfSyncSelection(pendingForceSelfSync, tickOptions.forceSelfSync);
      pendingSourceSelfSync = mergeSelfSyncSelection(pendingSourceSelfSync, tickOptions.sourceSelfSync);
      pendingTodayOnly = pendingTodayOnly === null
        ? Boolean(tickOptions.todayOnly)
        : pendingTodayOnly && Boolean(tickOptions.todayOnly);
      mergePendingTargetScope(tickOptions);
      pendingActivityRevision = pendingActivityRevision === null
        ? tickActivityRevision
        : Math.max(pendingActivityRevision, tickActivityRevision);
      return new Promise((resolve) => pendingWaiters.push(resolve));
    }
    tickInFlight = true;
    let pricingReplayUsed = false;
    const performWithPricingReplay = async (tickReason, scanOptions) => {
      const result = await performTick(tickReason, scanOptions);
      if (result !== pricingChangedDuringScan || pricingReplayUsed || stopped) return result;
      pricingReplayUsed = true;
      // At most one automatic replay belongs to this initiating tick, including
      // its coalesced work. A second mismatch waits for a normal tick; neither
      // mixed result is published. Already acknowledged source sync stays consumed.
      return performTick('pricing-change', {
        ...scanOptions,
        forceHistory: true,
        todayOnly: false,
        targetClients: [],
        forceSelfSync: null,
        sourceSelfSync: null,
        acknowledgedSourceSync: null
      });
    };
    try {
      const initialResult = await performWithPricingReplay(reason, {
        ...effectiveTickOptions,
        acknowledgedSourceSync: sourceSyncQueue.acknowledge(effectiveTickOptions.forceSelfSync)
      });
      while (tickPending && !stopped) {
        const forceHistory = pendingForceHistory;
        const rolloverHistoryRetry = pendingRolloverHistoryRetry;
        const forceSelfSync = pendingForceSelfSync;
        const sourceSelfSync = pendingSourceSelfSync;
        const todayOnly = pendingTodayOnly === true;
        const targetClients = todayOnly && pendingTargetClients instanceof Set
          ? [...pendingTargetClients]
          : [];
        const activityRevision = pendingActivityRevision;
        const waiters = pendingWaiters;
        pendingWaiters = [];
        tickPending = false;
        pendingForceHistory = false;
        pendingRolloverHistoryRetry = false;
        pendingForceSelfSync = null;
        pendingSourceSelfSync = null;
        pendingTodayOnly = null;
        pendingTargetClients = null;
        pendingActivityRevision = null;
        const acknowledgedSourceSync = sourceSyncQueue.acknowledge(forceSelfSync);
        const result = await performWithPricingReplay('coalesced', {
          forceHistory,
          rolloverHistoryRetry,
          forceSelfSync,
          sourceSelfSync,
          acknowledgedSourceSync,
          todayOnly,
          targetClients,
          ...(activityRevision === null ? {} : { activityRevision })
        });
        resolveWaiters(waiters, result === true);
      }
      return initialResult === true;
    } finally {
      tickInFlight = false;
      if (idleWaiters.length > 0) {
        const waiters = idleWaiters;
        idleWaiters = [];
        resolveWaiters(waiters, true);
      }
      if (stopped && pendingWaiters.length > 0) {
        const waiters = pendingWaiters;
        pendingWaiters = [];
        resolveWaiters(waiters, false);
      }
    }
  }

  function recordWatchClients(eventClients) {
    if (Array.isArray(eventClients)) {
      if (eventClients.length === 0) scheduledWatchNeedsFullScan = true;
      else for (const client of eventClients) scheduledWatchClients.add(client);
    }
  }

  function takeWatchClients(additionalClients = []) {
    const targetClients = scheduledWatchNeedsFullScan
      ? []
      : [...new Set([...scheduledWatchClients, ...additionalClients])];
    scheduledWatchClients.clear();
    scheduledWatchNeedsFullScan = false;
    return targetClients;
  }

  function scheduleTick(reason, eventClients) {
    if (stopped) return;
    recordWatchClients(eventClients);
    // The first event of a run pins the deadline; every re-arm after it waits
    // out whichever of the debounce and the remaining ceiling comes first, so a
    // storm faster than the debounce still ticks instead of deferring forever.
    // Time behind an in-flight tick does not count toward the ceiling: the timer
    // can only re-arm there, and a slow tick under a steady write stream would
    // otherwise chain scans back-to-back once it finished. Floored at 1ms
    // because clampTimerDelayMs' reason applies here too: a zero or negative
    // delay is rewritten to 1ms by setTimeout, and an expired deadline must arm
    // a real timer rather than spin.
    const nowMs = performance.now();
    if (tickInFlight) watchDeadlineAt = 0;
    else if (watchDeadlineAt === 0) watchDeadlineAt = nowMs + watchMaxWaitMs;
    const delayMs = watchDeadlineAt === 0
      ? watchDebounceMs
      : Math.max(1, Math.min(watchDebounceMs, watchDeadlineAt - nowMs));
    if (debounceTimer) clearTimeout(debounceTimer);
    debounceTimer = setTimeout(() => {
      debounceTimer = null;
      // Re-arm instead of queueing onto the in-flight tick: the coalesce path
      // would re-run immediately on completion, stacking scans back-to-back.
      // There is deliberately no cooldown on top of the debounce: the product
      // promises 3–5 s updates, and a cooldown would break that promise.
      if (tickInFlight) { scheduleTick(reason); return; }
      watchDeadlineAt = 0;
      // A raw source event means that client's synced cache may now be stale, so
      // its sync drops to the short floor instead of waiting out the idle
      // cadence. Its cache is deliberately outside the watcher, so a sync here
      // cannot create the issue #15 self-trigger loop.
      runTick(reason, {
        todayOnly: true,
        targetClients: takeWatchClients(),
        sourceSelfSync: sourceSyncQueue.takeDue()
      });
    }, delayMs);
  }

  // chokidar's close() walks every watched entry and closes every fs.watch
  // handle inline, and its cost grows superlinearly with that count, so on a
  // tree the size of ~/.claude/projects it runs for about a second. That cost
  // has not gone away — watcherHost.js just decides who pays it, and by
  // default that is a child process rather than the thread driving the UI. `skipClose`
  // is the quit path: descriptors go with the process, so there is nothing to
  // wait for.
  function closeWatchers({ skipClose = false } = {}) {
    for (const host of watchers) {
      try { host.close({ skipClose }); } catch (_) {}
    }
    watchers.length = 0;
  }

  function enterIntervalFallback(error) {
    if (watchIntervalFallback) return;
    watchIntervalFallback = true;
    emitDiagnosticEvent({
      subsystem: 'watcher',
      code: 'watcher-interval-fallback',
      ...(watchFallbackCode ? { detailCode: watchFallbackCode } : {})
    });
    log(`Cannot watch safely (${error.message}); collecting every ${Math.round(intervalMs / 1000)}s instead.`);
    // Reported from inside the host's own dispatch, so the teardown waits a turn.
    setImmediate(() => {
      if (!stopped) closeWatchers();
    });
  }

  function handleWatchError(error) {
    log(`chokidar error: ${error.message}`);
    if (stopped) return;
    if (WATCH_REFUSAL_CODES.has(error?.code)) {
      enterIntervalFallback(error);
      return;
    }
    if (stopped || watchUsePolling || watchNativeForced || watchDescriptorFallback || watchIntervalFallback) return;
    if (!WATCH_DESCRIPTOR_ERROR_CODES.has(error?.code)) return;
    watchDescriptorFallback = true;
    watchFallbackCode = error.code;
    emitDiagnosticEvent({
      subsystem: 'watcher',
      code: 'watcher-polling-fallback',
      detailCode: error.code
    });
    log(`Native file events unavailable (${error.code}); falling back to 2s polling.`);
    // Rebuilding from inside chokidar's own error emit would close the watcher
    // mid-dispatch, so hand it to the next tick of the loop instead.
    setImmediate(() => {
      if (stopped) return;
      watchedDirectoryKey = null;
      setupWatchers();
    });
  }

  function setupWatchers() {
    if (!watchEnabled || watchIntervalFallback) return;
    // Canonicalise before anything derives from these roots, so the paths handed
    // to chokidar and the paths clientsForWatchPath matches against are the same
    // strings. Resolving only one of the two would silently break attribution.
    // One dirExists sweep feeds both maps: probing twice would let a directory
    // created between the sweeps land in the watch list and not the attribution
    // list, or the reverse.
    const watchRoots = watchClientRootsForClients(clients, sourceOptions);
    const rootsByClient = Object.fromEntries(
      Object.entries(watchRoots)
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    // Watch targets and attribution prefixes are the same list everywhere except
    // a custom Copilot exporter, whose parent must be watched without becoming a
    // copilot prefix. Canonicalised through the same function so both still
    // compare equal to the paths chokidar reports.
    const attributionRootsByClient = Object.fromEntries(
      Object.entries(watchAttributionRootsForClients(clients, watchRoots, sourceOptions))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    // A subset of the same roots, matched separately so a write to a client's
    // parse-local data cannot pass for a write to its self-sync source.
    const sourceSyncRootsByClient = Object.fromEntries(
      Object.entries(selfSyncSourceRootsForClients(clients))
        .map(([client, dirs]) => [client, dirs.map(canonicalWatchPath)])
    );
    const dirs = [...new Set(Object.values(rootsByClient).flat())];
    const directoryKey = dirs.join('\0');
    if (directoryKey === watchedDirectoryKey) return;
    closeWatchers();
    if (dirs.length === 0) {
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      log('No watchable client data directories found; relying on fallback interval only.');
      return;
    }
    function handleWatchEvent(event, filePath) {
      // The quit path leaves the watcher open (see stop), so events can still
      // arrive after the collector is done with them.
      if (stopped) return;
      // Drop the wal-index sidecar of clients whose own scan recreates it, so
      // the collector cannot re-trigger itself. See
      // SELF_WATCHED_SQLITE_SIDECAR_CLIENTS for the measured per-client evidence.
      if (isSelfWatchSqliteSidecarEvent(filePath, rootsByClient)) return;
      activityRevision += 1;
      if (tickPending) {
        pendingActivityRevision = pendingActivityRevision === null
          ? activityRevision
          : Math.max(pendingActivityRevision, activityRevision);
      }
      const eventClients = clientsForWatchPath(filePath, attributionRootsByClient);
      if (
        reasonixNativeSessionCache
        && isReasonixNativeSessionSidecar(filePath)
        && isReasonixNativeSessionPath(
          filePath,
          typeof reasonixNativeSessionCache.sessionRoots === 'function'
            ? reasonixNativeSessionCache.sessionRoots()
            : reasonixNativeSessionWatchRoots()
        )
      ) {
        reasonixNativeSessionCache.invalidate(filePath);
      }
      for (const client of clientsForWatchPath(filePath, sourceSyncRootsByClient)) {
        sourceSyncQueue.record(client);
      }
      if (watchTriggersCollection) {
        scheduleTick(
          `watch:${event}:${path.basename(filePath || '')}`,
          eventClients
        );
      } else recordWatchClients(eventClients);
    }

    const usePolling = watchUsePolling || watchDescriptorFallback;
    try {
      const host = createWatcherHost(
        {
          dirs,
          clients,
          customScanPaths: sourceOptions.customScanPaths,
          usePolling,
          pollingEntryLimit: watchPollingEntryLimit
        },
        {
          onHostFallback: (error, fallback = {}) => {
            // The host moves to polling by itself when a watch process never
            // confirmed its exit; diagnostics have to say so.
            if (fallback.usePolling === true) watchHostPolling = true;
            emitDiagnosticEvent({ subsystem: 'watcher', code: 'watcher-host-fallback' });
            log(`Watch worker unavailable (${error.message}); watching on this thread.`);
          },
          onError: handleWatchError,
          onEvent: handleWatchEvent
        }
      );
      watchers.push(host);
      watchedDirectoryKey = directoryKey;
      lastWatchFailureCode = null;
      for (const dir of dirs) log(`Watching ${dir} (${usePolling ? 'polling 2s' : 'native events'})`);
    } catch (error) {
      watchedDirectoryKey = null;
      lastWatchFailureCode = 'watcher-rebuild-failed';
      emitDiagnosticEvent({ subsystem: 'watcher', code: 'watcher-rebuild-failed' });
      log(`Cannot watch ${dirs.join(', ')}: ${error.message}`);
    }
  }

  function loop() {
    if (stopped) return;
    const activityRevisionAtStart = activityRevision;
    // Native watchers are an optimization, not the source of truth. Always
    // retain the hourly reconciliation path for missed events, newly created
    // client directories, WSL-only activity, and cross-day metadata refreshes.
    const fullScanDue = lastFullScanAt === 0 || Date.now() - lastFullScanAt >= FULL_SCAN_INTERVAL_MS;
    // Smart mode trusts the watcher to say which clients moved. Without one it
    // is plain interval collection, or it would scan nothing but the hourly
    // reconciliation.
    const activityGated = intervalRequiresActivity && !watchIntervalFallback;
    if (
      activityGated &&
      initialCollectionComplete &&
      !fullScanDue &&
      activityRevisionAtStart <= collectedActivityRevision
    ) {
      intervalTimer = setTimeout(loop, intervalMs);
      return;
    }
    // Full scan at least once per FULL_SCAN_INTERVAL_MS so the anchor
    // does not drift from reality over a long-running session.
    // lastFullScanAt === 0 means no valid timestamp exists (cold start,
    // unparseable, or future timestamp) — force a full scan immediately.
    const anchorToday = Boolean(!fullScanDue && anchor && anchor.dateKey === localTodayKey());
    const sourceSelfSync = activityGated ? sourceSyncQueue.takeDue() : null;
    // Smart mode carries the clients its watch events named since the last tick
    // and unions the self-synced ones on top regardless. Their tokscale cache
    // dirs are deliberately unwatched to avoid a self-triggering loop, so a sync
    // can refresh what tokscale reads without any event naming the client it
    // belongs to. Antigravity's source roots are watched and do name it, but that
    // tracks the IDE writing rather than the sync landing, so targeting alone
    // would still miss the sync output.
    const targetClients = activityGated ? takeWatchClients(selfSyncedClients) : [];
    runTick('interval', {
      ...(anchorToday ? { todayOnly: true, refreshWsl: true, targetClients } : {}),
      ...(sourceSelfSync ? { sourceSelfSync } : {}),
      activityRevision: activityRevisionAtStart
    }).finally(() => {
      if (stopped) return;
      intervalTimer = setTimeout(loop, intervalMs);
    });
  }

  // Stays synchronous and never returns a promise: startMode() and friends rely
  // on stop() having severed the old collector by the time it returns. Setting
  // `stopped` is what does the severing, so a watcher left alive by
  // skipCloseWatchers still cannot drive a tick.
  function stop(options = {}) {
    if (stopped) return;
    stopped = true;
    runtimeAbortController.abort(new Error('collector stopped'));
    if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null; }
    if (intervalTimer) { clearTimeout(intervalTimer); intervalTimer = null; }
    clearRolloverHistoryRetry();
    sourceSyncQueue.stop();
    closeWatchers({ skipClose: options.skipCloseWatchers === true });
    watchedDirectoryKey = null;
  }

  function whenIdle() {
    // startCollector() calls loop() synchronously before returning this handle,
    // so runTick's reaction to this same barrier is always registered first.
    // It clears startBarrier before this continuation asks again; the regression
    // test pins that startup ordering because reversing it would microtask-spin.
    if (startBarrier) return Promise.resolve(startBarrier).then(() => whenIdle());
    if (!tickInFlight) return Promise.resolve();
    return new Promise((resolve) => idleWaiters.push(resolve));
  }

  function getDiagnostics() {
    const watchMode = !watchEnabled
      ? 'disabled'
      : watchIntervalFallback
        ? 'interval'
        : (watchUsePolling || watchDescriptorFallback || watchHostPolling ? 'polling' : 'native');
    const state = stopped
      ? 'stopped'
      : tickInFlight
        ? 'running'
        : lastTickFailureCode
          ? 'failed'
          : 'idle';
    return {
      state,
      collectionMode: watchTriggersCollection ? 'live' : intervalRequiresActivity ? 'smart' : 'interval',
      intervalMs,
      watchDebounceMs,
      watchEnabled,
      watchMode,
      watchFallbackCode,
      lastWatchFailureCode,
      tickInFlight,
      tickPending,
      lastTickReasonCode,
      lastTickScope,
      lastTickAttemptAt: timestampOrNull(lastTickAttemptAt),
      lastTickSuccessAt: timestampOrNull(lastTickSuccessAt),
      lastTickFailureAt: timestampOrNull(lastTickFailureAt),
      lastTickDurationMs,
      lastFullScanAt: timestampOrNull(lastFullScanAt),
      lastHistoryAttemptAt: timestampOrNull(lastHistoryAttemptAt),
      lastHistorySuccessAt: timestampOrNull(lastHistorySuccessAt),
      lastHistoryFailureCode,
      lastHistoryScanDurationMs,
      lastFailureCode: lastTickFailureCode,
      wslStatus: cloneDiagnosticValue(wslStatusAnchor)
    };
  }

  setupWatchers();
  loop();

  // A rescan of one tool. Was cursor-only because a Cursor sign-in was the only
  // caller; the machinery underneath was always per-client, so the guard was a
  // narrower contract than the implementation. `targetClients` keeps the scan to
  // the partition being asked about instead of every client's today.
  function refreshClient(clientId, refreshOptions = {}) {
    const normalized = String(clientId || '').trim().toLowerCase();
    if (!normalized || !trackedClients.has(normalized)) {
      throw new TypeError(`Unsupported targeted usage client: ${normalized || '(empty)'}`);
    }
    return runTick(`client:${normalized}`, {
      todayOnly: true,
      targetClients: [normalized],
      // Only the self-synced clients have a sync to force; naming any other here
      // would be read by nothing.
      forceSelfSync: refreshOptions.forceSync === true && SELF_SYNCED_CLIENTS.has(normalized) ? [normalized] : null
    });
  }

  return {
    getDiagnostics,
    refreshClient,
    stop,
    tick: (reason = 'manual', tickOptions = {}) => runTick(reason, tickOptions),
    whenIdle
  };
}

module.exports = {
  applySessionTimestamps: applySessionMetadata,
  projectIdentity,
  projectPathFromJsonl,
  collectHistoryOnce,
  collectUsageOnce,
  clientActivityDaysFromHistory,
  clientDataDirPresence,
  clientDiagnosticRoots,
  visibleDiagnosticRoots,
  clientSourceChecks,
  clientSourceRoots,
  cherryStudioTranscriptRoots,
  clientsForWatchPath,
  clientWatchCandidates,
  computePeriodWindows,
  collectorAnchorTrust,
  pricingFingerprint,
  configFingerprint,
  qoderCnDbPathForClients,
  qoderCnProjectsDirForClients,
  qoderCnSourcesForClients,
  deriveClientHealth,
  deriveClientStatus,
  mergeClientActivityDays,
  wslPeriodsForPreview,
  statusFromSignals,
  DEFAULT_HISTORY_INTERVAL_MS,
  HISTORY_INTERVAL_VALUES,
  LIMITS_RESET_BOUNDARY_MAX_TIMER_MS,
  localTodayKey,
  nextLimitsResetBoundary,
  normalizeHistoryIntervalMs,
  sessionTimestampMap: sessionMetadataMap,
  locateBundledBinary,
  lookupModelPricing,
  pruneAttemptedResetBoundaries,
  getTokscaleStatus,
  readTokscaleBundledBuild,
  resolvePlatformBinary,
  resetTokscaleCapabilityCache,
  kimiWorkSessionsRoots,
  resolveWatchUsePolling,
  selfSyncSourceRootsForClients,
  // The process-wide sync throttle this module drives. Exported so a test can
  // read or pin a client's floor directly instead of inferring it from tick
  // timings; the collector never takes a second instance.
  selfSyncThrottle,
  isSelfWatchSqliteSidecarEvent,
  shouldIncludeHistory,
  spawnTokscaleHelp,
  startCollector,
  tokscaleCommand,
  tokscaleClientFilter,
  tokscaleEnvWithBlanksDropped,
  TOKSCALE_CLIENT_ALIASES,
  watchAttributionRootsForClients,
  watcherOptions,
  watchIgnoreMatcher,
  openWatch,
  WATCH_POLLING_LIMIT_CODE,
  WATCH_POLLING_UNAVAILABLE_CODE,
  WATCH_REFUSAL_CODES,
  watchPathsForClients
};
