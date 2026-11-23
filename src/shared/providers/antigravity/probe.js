'use strict';

const { abortError } = require('../../probeDeadline');

const { spawn } = require('node:child_process');
const fs = require('node:fs/promises');
const { once } = require('node:events');
const { setTimeout: delay } = require('node:timers/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const https = require('node:https');
const http = require('node:http');
const { appVersion } = require('../../appVersion');
const { hashKey } = require('../../hashKey');
const { limitStage } = require('../../limits/failureDetail');
const { errorWithStatus } = require('../../limits/providerHelpers');
const { quotaGroupRank } = require('./corePolicy');

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_RPC_TIMEOUT_MS = 12000;

function probeTimeoutError() {
  return errorWithStatus('unavailable', 'Antigravity probe timed out');
}

function throwIfAborted(signal) {
  if (signal?.aborted) throw abortError(signal);
}

function remainingMs(deadlineMs) {
  return Math.max(0, deadlineMs - Date.now());
}

function boundedTimeoutMs(deadlineMs, maximum = DEFAULT_RPC_TIMEOUT_MS) {
  const remaining = remainingMs(deadlineMs);
  if (remaining <= 0) throw probeTimeoutError();
  return Math.max(1, Math.min(maximum, remaining));
}

function promiseBeforeDeadline(factory, deadlineMs, maximum = DEFAULT_RPC_TIMEOUT_MS, signal = null) {
  const timeoutMs = boundedTimeoutMs(deadlineMs, maximum);
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      fn(value);
    };
    const onAbort = () => finish(reject, abortError(signal));
    const timer = setTimeout(() => finish(reject, probeTimeoutError()), timeoutMs);
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) {
      onAbort();
      return;
    }
    Promise.resolve()
      .then(() => factory(timeoutMs))
      .then((value) => finish(resolve, value), (error) => finish(reject, error));
  });
}

function callBeforeDeadline(call, args, deadlineMs, maximum = DEFAULT_RPC_TIMEOUT_MS) {
  return promiseBeforeDeadline(
    (timeoutMs) => call({ ...args, timeoutMs }),
    deadlineMs,
    maximum,
    args.signal
  );
}

function firstTrimmedString(...values) {
  for (const value of values) {
    const text = String(value || '').trim();
    if (text) return text;
  }
  return null;
}

function preferredPlanInfoName(planInfo) {
  return firstTrimmedString(
    planInfo?.planDisplayName,
    planInfo?.displayName,
    planInfo?.productName,
    planInfo?.planName,
    planInfo?.planShortName
  );
}

function isLanguageServerCommand(lowerCommand) {
  return /(?:^|[\s/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/.test(lowerCommand);
}

function isAntigravityCommand(lowerCommand) {
  if (lowerCommand.includes('--app_data_dir') && lowerCommand.includes('antigravity')) return true;
  if (lowerCommand.includes('/antigravity/') || lowerCommand.includes('\\antigravity\\')) return true;
  if (lowerCommand.includes('/antigravity.app/') || lowerCommand.includes('\\antigravity\\')) return true;
  return false;
}

// The Antigravity CLI (`agy` / `antigravity-cli`) hosts the same local language
// server as the IDE, but launches it without a `--csrf_token` flag and under a
// different process name. Path-anchor the match so unrelated binaries/arguments
// (e.g. `/opt/imagytool/...`, `legacy-agent`) do not match.
// `--hub` turns the CLI into a network-facing RPC service that does require a
// CSRF token, so the flag is matched once here and reused by the "we saw it but
// it had no token" diagnostic.
function isHubModeCommand(command) {
  return /(?:^|\s)--hub(?:\s|=|$)/.test(command);
}

function isAntigravityCliCommand(lowerCommand) {
  if (/(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/.test(lowerCommand)) return true;
  if (/(^|[/\\])agy(\.exe)?(\s|$)/.test(lowerCommand)) {
    return isLanguageServerCommand(lowerCommand) || isHubModeCommand(lowerCommand);
  }
  return false;
}

function isAntigravityIdeCommand(lowerCommand) {
  return [
    'antigravity ide.app/',
    'antigravity ide.app\\',
    '--app_data_dir antigravity-ide',
    '--app_data_dir=antigravity-ide',
    '/extensions/antigravity/bin/language_server',
    '\\extensions\\antigravity\\bin\\language_server'
  ].some((marker) => lowerCommand.includes(marker));
}

// Classify a process command line as the Antigravity IDE language server, the
// Antigravity CLI language server, or neither. IDE takes precedence so its
// CSRF-token requirement is preserved.
function antigravityProcessKind(lowerCommand) {
  if (isLanguageServerCommand(lowerCommand) && isAntigravityCommand(lowerCommand)) {
    return isAntigravityIdeCommand(lowerCommand) ? 'ide' : 'app';
  }
  if (isAntigravityCliCommand(lowerCommand)) return 'cli';
  return null;
}

const PROCESS_KIND_ORDER = Object.freeze(['app', 'cli', 'ide']);

function sortProcessInfos(infos) {
  const rank = (kind) => {
    const index = PROCESS_KIND_ORDER.indexOf(kind);
    return index === -1 ? PROCESS_KIND_ORDER.length : index;
  };
  return [...infos].sort((a, b) => rank(a.kind) - rank(b.kind) || a.pid - b.pid);
}

function extractFlag(flag, command) {
  const escaped = flag.replace(/[-\\^$*+?.()|[\]{}]/g, '\\$&');
  const re = new RegExp(`${escaped}[=\\s]+([^\\s]+)`, 'i');
  const match = command.match(re);
  return match ? match[1] : null;
}

function extractPortFlag(flag, command) {
  const raw = extractFlag(flag, command);
  if (!raw) return null;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 && n < 65536 ? n : null;
}

// `Win32_Process.CommandLine` reports the command line a process was created
// with, verbatim: whoever launched it quotes the executable path when it
// contains spaces, and PowerShell quotes it even when it does not, so the
// closing quote reaches us as part of the line. Unwrap that one leading pair so
// the matchers above keep anchoring on path separators and whitespace alone;
// quoted flag values further along the line are left untouched.
function commandForMatching(command) {
  return command.replace(/^"([^"]+)"(?=\s|$)/, '$1').toLowerCase();
}

function isDesktopHubCommand(command) {
  return /(?:^|\s)--read_host_bridge_token_from_stdin(?:\s|$)/.test(command)
    && extractFlag('--app_data_dir', command) === 'antigravity';
}

async function readDesktopHubs(homeDir) {
  const directory = path.join(homeDir, '.gemini', 'antigravity', 'daemon');
  const hubs = new Map();
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return hubs;
  }
  for (const entry of entries) {
    const port = Number(/^hub_(\d+)\.json$/.exec(entry.name)?.[1]);
    if (!entry.isFile() || !(port > 0 && port < 65536)) continue;
    const file = path.join(directory, entry.name);
    try {
      const stat = await fs.lstat(file);
      if (!stat.isFile() || stat.size > 4096) continue;
      const { pid, httpPort, csrfToken } = JSON.parse(await fs.readFile(file, 'utf8'));
      if (!Number.isSafeInteger(pid) || pid <= 0 || httpPort !== port
          || typeof csrfToken !== 'string' || !/^[a-f0-9-]{32,}$/i.test(csrfToken)) continue;
      if (!hubs.has(pid) || stat.mtimeMs > hubs.get(pid).modifiedAt) {
        hubs.set(pid, { httpPort, csrfToken, modifiedAt: stat.mtimeMs });
      }
    } catch {
      // The service can replace or remove its descriptor during discovery.
    }
  }
  return hubs;
}

function parseProcessLine(line, desktopHubs) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const split = trimmed.indexOf(' ');
  if (split <= 0) return null;
  const pid = Number(trimmed.slice(0, split));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const command = trimmed.slice(split + 1).trim();
  if (!command) return null;
  const lower = commandForMatching(command);
  const kind = antigravityProcessKind(lower);
  if (!kind) return null;
  const csrfToken = extractFlag('--csrf_token', command);
  const desktopHub = !csrfToken && kind === 'app' && isDesktopHubCommand(lower)
    ? desktopHubs?.get(pid)
    : null;
  const isHubMode = isHubModeCommand(command);
  const hubPort = extractPortFlag('--hub-port', command);
  // Desktop app/IDE language servers require a credential; newer desktop
  // builds supply it in their hub descriptor. The CLI generally needs none,
  // EXCEPT when running in hub mode (--hub flag), which acts as a network-facing
  // RPC service and requires CSRF protection like app/IDE.
  if ((kind !== 'cli' || isHubMode) && !csrfToken && !desktopHub) return null;
  return {
    pid,
    kind,
    csrfToken: csrfToken || desktopHub?.csrfToken || '',
    ...(desktopHub ? { desktopRpcPort: desktopHub.httpPort } : {}),
    extensionPort: extractPortFlag('--extension_server_port', command),
    extensionCsrfToken: extractFlag('--extension_server_csrf_token', command),
    hubPort: hubPort,
    commandLine: command
  };
}

function runProcessText(cmd, args, { timeoutMs = 10000, deps = {}, emptyOnExitOne = false } = {}) {
  const spawnFn = deps.spawn || spawn;
  return new Promise((resolve, reject) => {
    const child = spawnFn(cmd, args, { windowsHide: true });
    let stdout = '';
    let stderr = '';
    let settled = false;
    let timer;
    const signal = deps.signal;
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      fn(value);
    };
    const onAbort = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
      finish(reject, errorWithStatus('unavailable', `${cmd} timed out`));
    };
    timer = setTimeout(onAbort, timeoutMs);
    if (signal?.aborted) onAbort();
    else signal?.addEventListener('abort', onAbort, { once: true });
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => finish(reject, err));
    child.on('close', (code) => {
      if (emptyOnExitOne && code === 1 && !stderr.trim()) {
        finish(resolve, '');
      } else if (code !== 0) {
        finish(reject, errorWithStatus('unavailable', stderr.trim() || `${cmd} exited ${code}`));
      } else {
        finish(resolve, stdout);
      }
    });
    child.stdin?.end();
  });
}

function processInfosFromText(stdout, desktopHubs) {
  const infos = [];
  let sawTokenlessCsrfClient = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const info = parseProcessLine(trimmed, desktopHubs);
    if (info) {
      infos.push(info);
      continue;
    }
    const split = trimmed.indexOf(' ');
    const lower = split === -1 ? '' : commandForMatching(trimmed.slice(split + 1).trim());
    const kind = antigravityProcessKind(lower);
    if (!kind || extractFlag('--csrf_token', trimmed)) continue;
    // Desktop/IDE language servers and hub-mode CLI services both authenticate
    // with `--csrf_token`, so a tokenless one of either is a real
    // misconfiguration worth naming instead of reporting "not running". A plain
    // tokenless CLI is legitimately skippable and does not count here.
    if (kind !== 'cli' || isHubModeCommand(lower)) sawTokenlessCsrfClient = true;
  }
  return { infos: sortProcessInfos(infos), sawTokenlessCsrfClient };
}

async function requireDetectedProcessInfos(stdout, deps) {
  const desktopHubs = stdout.includes('--read_host_bridge_token_from_stdin')
    ? await readDesktopHubs(deps.homeDir || os.homedir())
    : undefined;
  const { infos, sawTokenlessCsrfClient } = processInfosFromText(stdout, desktopHubs);
  if (infos.length > 0) return infos;
  if (sawTokenlessCsrfClient) throw errorWithStatus('unavailable', 'Antigravity LS missing --csrf_token');
  throw errorWithStatus('notConfigured', 'Antigravity language server not running');
}

async function detectProcessInfosPosix(deps = {}) {
  const stdout = await runProcessText('ps', ['-ax', '-o', 'pid=,command='], {
    deps,
    timeoutMs: Math.min(8000, Number(deps.timeoutMs) || 8000)
  });
  return requireDetectedProcessInfos(stdout, deps);
}

async function detectProcessInfosWin32(deps = {}) {
  // Surface both the IDE language server and the CLI (`agy` / `antigravity-cli`)
  // hosts; the command-line classifier (antigravityProcessKind) re-filters for
  // precision, so a broad Name filter here is safe.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -or $_.Name -like 'language-server*' -or $_.Name -like 'agy*' -or $_.Name -like 'antigravity*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
  const stdout = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    deps,
    timeoutMs: Math.min(10000, Number(deps.timeoutMs) || 10000)
  });
  return requireDetectedProcessInfos(stdout, deps);
}

async function detectProcessInfos(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') return detectProcessInfosWin32(deps);
  return detectProcessInfosPosix(deps);
}

async function detectProcessInfo(deps = {}) {
  const infos = await detectProcessInfos(deps);
  return infos[0];
}

async function listeningPortsPosix(pid, deps = {}) {
  let stdout;
  try {
    const sockets = deps.ipv4LoopbackOnly ? '-i4TCP' : '-iTCP';
    stdout = await runProcessText('lsof', ['-nP', sockets, '-sTCP:LISTEN', '-a', '-p', String(pid)], {
      deps,
      timeoutMs: Math.min(6000, Number(deps.timeoutMs) || 6000)
    });
  } catch (err) {
    throw errorWithStatus('unavailable', `lsof failed: ${err.message}`);
  }
  const ports = new Set();
  const re = deps.ipv4LoopbackOnly ? /\s127\.0\.0\.1:(\d+)\s+\(LISTEN\)/g : /:(\d+)\s+\(LISTEN\)/g;
  let match;
  while ((match = re.exec(stdout)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) ports.add(n);
  }
  if (ports.size === 0) throw errorWithStatus('unavailable', 'no listening ports for antigravity LS');
  return [...ports].sort((a, b) => a - b);
}

async function listeningPortsWin32(pid, deps = {}) {
  const loopbackFilter = deps.ipv4LoopbackOnly ? " | Where-Object LocalAddress -eq '127.0.0.1'" : '';
  const script = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue${loopbackFilter} | Select-Object -ExpandProperty LocalPort`;
  const stdout = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], {
    deps,
    timeoutMs: Math.min(6000, Number(deps.timeoutMs) || 6000)
  });
  const ports = new Set();
  for (const line of stdout.split(/\r?\n/)) {
    const n = Number(line.trim());
    if (Number.isFinite(n) && n > 0 && n < 65536) ports.add(n);
  }
  if (ports.size === 0) throw errorWithStatus('unavailable', 'no listening ports for antigravity LS');
  return [...ports].sort((a, b) => a - b);
}

async function listeningPorts(pid, deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') return listeningPortsWin32(pid, deps);
  return listeningPortsPosix(pid, deps);
}

const LS_SERVICE = 'exa.language_server_pb.LanguageServerService';
const USER_AGENT = `token-monitor/${appVersion()} (+https://github.com/Javis603/token-monitor)`;

function statusFromHttpCode(code) {
  if (code === 401 || code === 403) return 'unauthorized';
  if (code === 429) return 'sourceRateLimited';
  if (code >= 500) return 'unavailable';
  return 'unavailable';
}

async function desktopSocketOwned(port, pid, localPort, timeoutMs, deps) {
  if ((deps.platform || process.platform) === 'win32') {
    const script = `Get-NetTCPConnection -OwningProcess ${pid} -State Established -LocalAddress 127.0.0.1 -LocalPort ${port} -RemoteAddress 127.0.0.1 -RemotePort ${localPort} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
    const output = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { timeoutMs, deps });
    return output.split(/\r?\n/).some((line) => line.trim() === String(pid));
  }
  const output = await runProcessText('lsof', ['-nP', '-a', '-p', String(pid), '-i4TCP', '-sTCP:ESTABLISHED', '-Fn'], { timeoutMs, deps, emptyOnExitOne: true });
  return output.split(/\r?\n/).includes(`n127.0.0.1:${port}->127.0.0.1:${localPort}`);
}

async function connectVerifiedDesktopSocket(port, pid, timeoutMs, parentSignal, deps) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signal = parentSignal ? AbortSignal.any([timeout, parentSignal]) : timeout;
  const socket = net.createConnection({ host: '127.0.0.1', port, signal });
  // The HTTP client has not attached its socket listeners yet.
  const ignoreSocketError = () => {};
  socket.on('error', ignoreSocketError);
  try {
    await once(socket, 'connect', { signal });
    const localPort = socket.localPort;
    const ownershipDeps = { ...deps, signal };
    let owned = await desktopSocketOwned(port, pid, localPort, timeoutMs, ownershipDeps);
    throwIfAborted(signal);
    if (!owned && !socket.destroyed) {
      // The handshake can finish before the server accepts the connection.
      await delay(20, undefined, { signal });
      if (!socket.destroyed) {
        owned = await desktopSocketOwned(port, pid, localPort, timeoutMs, ownershipDeps);
      }
    }
    throwIfAborted(signal);
    if (!owned || socket.destroyed) throw errorWithStatus('unavailable', 'Antigravity no longer owns the connected RPC socket');
    return socket;
  } catch (error) {
    socket.destroy();
    throw error;
  }
}

function callLs({
  scheme,
  port,
  csrfToken,
  desktopPid,
  method,
  body,
  host = '127.0.0.1',
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  signal
}, deps = {}) {
  if (desktopPid && (scheme !== 'http' || host !== '127.0.0.1' || !Number.isSafeInteger(desktopPid) || desktopPid <= 0)) {
    return Promise.reject(errorWithStatus('unavailable', 'Invalid Antigravity desktop RPC endpoint'));
  }
  const transport = scheme === 'https' ? https : http;
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host,
      port,
      ...(desktopPid ? {
        // Supplying createConnection without an agent keeps the request buffered
        // until the callback hands it the verified socket.
        createConnection: (_options, done) => {
          void connectVerifiedDesktopSocket(port, desktopPid, timeoutMs, signal, deps)
            .then((socket) => done(null, socket), done);
        }
      } : {}),
      method: 'POST',
      path: `/${LS_SERVICE}/${method}`,
      headers: {
        'content-type': 'application/json',
        'content-length': payload.length,
        'connect-protocol-version': '1',
        'x-codeium-csrf-token': csrfToken,
        'user-agent': USER_AGENT
      },
      timeout: timeoutMs,
      signal,
      ...(scheme === 'https' ? { rejectUnauthorized: false } : {})
    }, (res) => {
      const chunks = [];
      res.on('data', (chunk) => chunks.push(chunk));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        if (res.statusCode === 200) {
          try { resolve(JSON.parse(text)); }
          catch (err) { reject(errorWithStatus('unavailable', `parse error: ${err.message}`)); }
          return;
        }
        let status = statusFromHttpCode(res.statusCode);
        // Check if the error response body mentions CSRF (e.g., Connect-RPC style
        // "invalid_argument" for "missing CSRF token"). If so, classify as
        // unauthorized regardless of HTTP status code.
        try {
          const parsed = JSON.parse(text);
          const message = String(parsed?.message || parsed?.error || '').toLowerCase();
          if (message.includes('csrf')) {
            status = 'unauthorized';
          }
        } catch (_) {
          // If body is not JSON or parse fails, fall back to status from HTTP code.
        }
        const error = errorWithStatus(status, `${method} returned ${res.statusCode}`);
        error.httpStatus = res.statusCode;
        reject(error);
      });
    });
    req.on('timeout', () => { req.destroy(errorWithStatus('unavailable', `${method} timed out`)); });
    req.on('error', (err) => {
      if (err.status) reject(err); else reject(errorWithStatus('unavailable', err.message));
    });
    req.write(payload);
    req.end();
  });
}

function poolForModel(label, modelId) {
  const lc = `${label || ''} ${modelId || ''}`.toLowerCase();
  if (lc.includes('argon')) return 'Gemini 4 Argon';
  if (lc.includes('gemini') && lc.includes('pro')) return 'Gemini Pro';
  if (lc.includes('gemini') && lc.includes('flash')) return 'Gemini Flash';
  return 'Claude';
}

function parseResetTime(value) {
  if (value === null || value === undefined || value === '') return null;
  const d = typeof value === 'number' ? new Date(value > 20_000_000_000 ? value : value * 1000) : new Date(String(value));
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

function quotaRemainingFraction(bucket) {
  const direct = bucket?.remainingFraction;
  if (typeof direct === 'number' && Number.isFinite(direct)) return direct;
  const remaining = bucket?.remaining;
  if (typeof remaining?.remainingFraction === 'number' && Number.isFinite(remaining.remainingFraction)) {
    return remaining.remainingFraction;
  }
  if (remaining?.case === 'remainingFraction' && typeof remaining.value === 'number' && Number.isFinite(remaining.value)) {
    return remaining.value;
  }
  return null;
}

function quotaGroupName(displayName) {
  const name = typeof displayName === 'string' ? displayName.trim().replace(/\s+/g, ' ') : '';
  const lower = name.toLowerCase();
  if (/^gemini(?:\s+models)?$/.test(lower)) return 'Gemini';
  if (/^claude\s*(?:and|&|\/)\s*gpt(?:\s+models)?$/.test(lower)) return 'Claude/GPT';
  if (lower === 'gemini 4 argon') return 'Gemini 4 Argon';
  if (!name) return 'Quota';
  // RPC and OAuth can report different subsets. Derive the same shortened
  // name from the full name, with room for the period within the Hub limit.
  const maxNameLength = 32 - ' 5-hour'.length;
  const clean = name.replace(/[^a-z0-9 +._/-]/gi, '').replace(/ +/g, ' ').trim();
  if (clean === name && clean.length <= maxNameLength) return clean;
  const suffix = `-${hashKey('antigravity-quota-group', lower).slice(-8)}`;
  return `${(clean || 'Quota').slice(0, maxNameLength - suffix.length).trimEnd()}${suffix}`;
}

function quotaBucketKind(bucket) {
  const aliases = new Set(['session', '5h', '5-hour', 'five hour', 'five-hour']);
  const candidates = [];
  for (const value of [bucket?.window, bucket?.bucketId, bucket?.displayName]) {
    const normalized = String(value || '').trim().toLowerCase().replaceAll('_', '-');
    if (!normalized) continue;
    candidates.push(normalized);
    if (normalized.endsWith(' limit')) candidates.push(normalized.slice(0, -' limit'.length));
  }
  for (const candidate of candidates) {
    if (candidate === 'weekly' || candidate.endsWith('-weekly')) return 'weekly';
    if (aliases.has(candidate) || [...aliases].some((alias) => candidate.endsWith(`-${alias}`))) return 'session';
  }
  return null;
}

function quotaSummaryWindows(payload) {
  const summary = payload?.response || payload?.summary || payload;
  const groups = Array.isArray(summary?.groups) ? summary.groups : [];
  const namedGroups = groups
    .map((group) => ({ name: quotaGroupName(group?.displayName), buckets: group?.buckets }))
    .sort((a, b) => quotaGroupRank(a.name) - quotaGroupRank(b.name));
  const windows = [];
  for (const { name, buckets } of namedGroups) {
    const session = [];
    const weekly = [];
    for (const bucket of Array.isArray(buckets) ? buckets : []) {
      const kind = quotaBucketKind(bucket);
      if (!kind) continue;
      const remainingFraction = quotaRemainingFraction(bucket);
      const disabled = bucket?.disabled === true;
      (kind === 'session' ? session : weekly).push({
        kind,
        name: `${name} ${kind === 'session' ? '5-hour' : 'weekly'}`,
        remainingFraction: disabled ? null : remainingFraction,
        resetTime: parseResetTime(bucket?.resetTime),
        resetDescription: typeof bucket?.description === 'string' ? bucket.description : '',
        showMeter: !disabled && remainingFraction !== null
      });
    }
    windows.push(...session, ...weekly);
  }
  return windows;
}

function collapsePools(models) {
  const pools = new Map();
  for (const m of models) {
    const name = poolForModel(m.label, m.modelId);
    const existing = pools.get(name);
    const mFinite = typeof m.remainingFraction === 'number' && Number.isFinite(m.remainingFraction);
    const existingFinite = typeof existing?.remainingFraction === 'number' && Number.isFinite(existing.remainingFraction);
    if (!existing || (mFinite && (!existingFinite || m.remainingFraction < existing.remainingFraction))) {
      pools.set(name, { name, remainingFraction: m.remainingFraction, resetTime: m.resetTime });
    } else if (m.remainingFraction === existing.remainingFraction && m.resetTime && existing.resetTime && m.resetTime < existing.resetTime) {
      // tie-break: earlier reset wins
      pools.set(name, { name, remainingFraction: m.remainingFraction, resetTime: m.resetTime });
    }
  }
  const order = ['Gemini Pro', 'Gemini Flash', 'Claude', 'Gemini 4 Argon'];
  return order.flatMap((name) => (pools.has(name) ? [pools.get(name)] : []));
}

function endpointCandidates(processInfo, listenPorts) {
  if (processInfo.desktopRpcPort) {
    const port = processInfo.desktopRpcPort;
    // Require the port to still belong to the matching process before sending its token.
    return listenPorts.includes(port) ? [{ scheme: 'http', port, csrfToken: processInfo.csrfToken, desktopPid: processInfo.pid }] : [];
  }
  const candidates = [];
  // Try explicit hub port first if available (most authoritative and fastest).
  if (processInfo.hubPort) {
    candidates.push({
      scheme: 'https',
      port: processInfo.hubPort,
      csrfToken: processInfo.csrfToken
    });
    candidates.push({
      scheme: 'http',
      port: processInfo.hubPort,
      csrfToken: processInfo.csrfToken
    });
  }
  for (const port of listenPorts) {
    candidates.push({ scheme: 'https', port, csrfToken: processInfo.csrfToken });
    candidates.push({ scheme: 'http',  port, csrfToken: processInfo.csrfToken });
  }
  if (processInfo.extensionPort) {
    candidates.push({
      scheme: 'http',
      port: processInfo.extensionPort,
      csrfToken: processInfo.extensionCsrfToken || processInfo.csrfToken
    });
  }
  return candidates;
}

const PROBE_METADATA = {
  ideName: 'antigravity',
  extensionName: 'antigravity',
  ideVersion: 'unknown',
  locale: 'en'
};

const UNLEASH_BODY = {
  context: {
    properties: {
      devMode: 'false',
      extensionVersion: 'unknown',
      hasAnthropicModelAccess: 'true',
      ide: 'antigravity',
      ideVersion: 'unknown',
      installationId: 'token-monitor',
      language: 'UNSPECIFIED',
      os: process.platform,
      requestedModelId: 'MODEL_UNSPECIFIED'
    }
  }
};

function prioritizeCandidate(resolved, candidates) {
  return [resolved, ...candidates.filter((candidate) => (
    candidate.scheme !== resolved.scheme
    || candidate.port !== resolved.port
    || candidate.csrfToken !== resolved.csrfToken
    || candidate.desktopPid !== resolved.desktopPid
  ))];
}

function sameEndpoint(left, right) {
  return left.scheme === right.scheme
    && left.port === right.port
    && left.csrfToken === right.csrfToken
    && left.desktopPid === right.desktopPid;
}

function dedupeCandidates(candidates) {
  return candidates.filter((candidate, index) => (
    !candidates.slice(0, index).some((existing) => sameEndpoint(existing, candidate))
  ));
}

function firstSnapshotOrAll(tasks) {
  if (tasks.length === 0) return Promise.resolve({ snapshot: null, results: [] });
  return new Promise((resolve, reject) => {
    const results = new Array(tasks.length);
    let remaining = tasks.length;
    let settled = false;
    tasks.forEach((task, index) => {
      Promise.resolve(task).then((result) => {
        results[index] = result;
        if (settled) return;
        if (result.snapshot) {
          settled = true;
          resolve({ snapshot: result.snapshot, results });
          return;
        }
        remaining -= 1;
        if (remaining === 0) {
          settled = true;
          resolve({ snapshot: null, results });
        }
      }, (error) => {
        if (settled) return;
        settled = true;
        reject(error);
      });
    });
  });
}

async function resolveWorkingEndpoint(candidates, call, deadlineMs, signal) {
  let lastError = errorWithStatus('unavailable', 'no endpoint candidates');
  for (let index = 0; index < candidates.length; index += 1) {
    const candidate = candidates[index];
    const attemptsLeft = candidates.length - index;
    const attemptTimeoutMs = Math.max(1, Math.floor(remainingMs(deadlineMs) / attemptsLeft));
    try {
      await callBeforeDeadline(call, {
        ...candidate,
        method: 'GetUnleashData',
        body: UNLEASH_BODY,
        signal
      }, deadlineMs, attemptTimeoutMs);
      return { candidates: prioritizeCandidate(candidate, candidates), lastError: null };
    } catch (error) {
      throwIfAborted(signal);
      lastError = error;
      // Any HTTP response proves that the port, scheme, and CSRF routing are
      // reachable even when this lightweight endpoint itself is unsupported.
      if (Number.isInteger(error?.httpStatus)) {
        return { candidates: prioritizeCandidate(candidate, candidates), lastError: null };
      }
      if (remainingMs(deadlineMs) <= 0) throw probeTimeoutError();
    }
  }
  // Match CodexBar's best-effort fallback: older servers may not implement the
  // lightweight endpoint even though their quota RPCs are available.
  return { candidates, lastError };
}

function preferQuotaFailure(previous, next) {
  return previous?.status === 'unauthorized' ? previous : next || previous;
}

async function groupedQuotaFromCandidates(candidates, call, {
  previousError,
  csrfToken,
  sourceKey,
  summaryDeadlineMs,
  probeDeadlineMs,
  signal
}) {
  let lastError = previousError || errorWithStatus('unavailable', 'no endpoint candidates');
  for (const candidate of candidates) {
    try {
      const summary = await callBeforeDeadline(call, {
        ...candidate,
        method: 'RetrieveUserQuotaSummary',
        body: { forceRefresh: true },
        signal
      }, summaryDeadlineMs).catch(limitStage('grouped-quota'));
      const windows = quotaSummaryWindows(summary);
      if (windows.some((window) => window.remainingFraction !== null)) {
        let accountPlan = null;
        let accountEmail = null;
        try {
          const identity = await callBeforeDeadline(call, {
            ...candidate,
            method: 'GetUserStatus',
            body: { metadata: PROBE_METADATA },
            signal
          }, probeDeadlineMs, 1000);
          accountPlan =
            firstTrimmedString(identity?.userStatus?.userTier?.name)
            || preferredPlanInfoName(identity?.userStatus?.planStatus?.planInfo)
            || null;
          accountEmail = identity?.userStatus?.email?.trim?.() || null;
        } catch (_) { /* An account lookup can fail after a usable quota response. */ }
        return {
          snapshot: { accountPlan, accountEmail, windows, sourceKey: candidate.csrfToken === csrfToken ? sourceKey : null },
          lastError
        };
      }
      lastError = preferQuotaFailure(lastError, errorWithStatus('unavailable', 'empty quota summary'));
    } catch (err) {
      // An alternate extension credential cannot invalidate the process login.
      const failure = err?.status === 'unauthorized' && candidate.csrfToken !== csrfToken
        ? Object.assign(errorWithStatus('unavailable', 'alternate RPC credential rejected'), { cause: err })
        : err;
      lastError = preferQuotaFailure(lastError, failure);
    }
    if (signal.aborted || remainingMs(summaryDeadlineMs) <= 0) break;
  }
  return { snapshot: null, lastError };
}

function normalizeProcessInfos(infos) {
  return sortProcessInfos((Array.isArray(infos) ? infos : [infos])
    .filter(Boolean)
    .map((info) => ({ ...info, kind: PROCESS_KIND_ORDER.includes(info.kind) ? info.kind : 'app' })));
}

async function detectedProcessInfos(deps) {
  if (deps.detectProcessInfos) return normalizeProcessInfos(await deps.detectProcessInfos(deps));
  // Preserve the existing dependency seam for callers/tests that inject a
  // single process, while production always enumerates every local source.
  if (deps.detectProcessInfo) return normalizeProcessInfos(await deps.detectProcessInfo(deps));
  return normalizeProcessInfos(await detectProcessInfos(deps));
}

async function probe(deps = {}) {
  const probeTimeoutMs = Math.max(1, Number(deps.probeTimeoutMs) || DEFAULT_PROBE_TIMEOUT_MS);
  const probeDeadlineMs = Date.now() + probeTimeoutMs;
  throwIfAborted(deps.signal);
  const abortController = new AbortController();
  const abortTimer = setTimeout(() => abortController.abort(probeTimeoutError()), probeTimeoutMs);
  const signal = deps.signal
    ? AbortSignal.any([abortController.signal, deps.signal])
    : abortController.signal;
  const runtimeDeps = { ...deps, signal };
  const listPorts = deps.listeningPorts || listeningPorts;
  const call = deps.callLs || callLs;
  const sourceFailures = new Map();
  let lastError = errorWithStatus('notConfigured', 'Antigravity language server not running');

  try {
    const infos = await promiseBeforeDeadline(
      (timeoutMs) => detectedProcessInfos({ ...runtimeDeps, timeoutMs }),
      probeDeadlineMs,
      DEFAULT_RPC_TIMEOUT_MS,
      signal
    );

    // Probe scheduling contract:
    // - source priority is independent of ps/PID order;
    // - same-source processes try grouped quota concurrently;
    // - each endpoint is preflighted at most once;
    // - a reachable explicit hub starts quota without awaiting discovery;
    // - preflight failure lowers priority but never drops a quota candidate; and
    // - discovery keeps the full provider deadline when no explicit hub competes.
    for (const kind of PROCESS_KIND_ORDER) {
      const sourceInfos = infos.filter((info) => info.kind === kind);
      const sourceKeys = sourceInfos.map(({ pid, csrfToken }) => hashKey('antigravity-rpc', kind, pid, csrfToken));
      const halfDeadlineMs = () => (
        Date.now() + Math.max(1, Math.floor(remainingMs(probeDeadlineMs) / 2))
      );
      const candidateStates = sourceInfos.map(async (info) => {
        try {
          // An explicit `--hub-port` is authoritative, and discovery must not be
          // able to starve it. Start discovery concurrently, but expose it as a
          // lazy fallback so a reachable hub can begin quota retrieval without
          // waiting for lsof/Get-NetTCPConnection to settle.
          const explicitHub = info.hubPort ? endpointCandidates(info, []) : [];
          const discoveryBudgetMs = explicitHub.length > 0 ? halfDeadlineMs() : probeDeadlineMs;
          const discovery = (async () => {
            try {
              const ports = await promiseBeforeDeadline(
                (timeoutMs) => listPorts(info.pid, { ...runtimeDeps, timeoutMs, ipv4LoopbackOnly: Boolean(info.desktopRpcPort) }),
                discoveryBudgetMs,
                DEFAULT_RPC_TIMEOUT_MS,
                signal
              );
              return { ports, error: null };
            } catch (error) {
              return { ports: [], error };
            }
          })();

          const resolveDiscoveredCandidates = async (failedHub = []) => {
            const { ports, error: discoveryError } = await discovery;
            if (discoveryError && explicitHub.length === 0) throw discoveryError;
            // `endpointCandidates()` always re-prepends the hub port, so remove
            // it here. A hub already failed or passed preflight and must not be
            // resolved a second time through the discovered set.
            const discovered = endpointCandidates(info, ports).filter((candidate) => (
              candidate.port !== info.hubPort
            ));
            let resolved;
            try {
              resolved = await resolveWorkingEndpoint(
                discovered,
                call,
                probeDeadlineMs,
                signal
              );
            } catch (error) {
              if (signal?.aborted) throw error;
              resolved = { candidates: discovered, lastError: error };
            }
            return {
              candidates: dedupeCandidates([...resolved.candidates, ...failedHub]),
              error: resolved.lastError || discoveryError
            };
          };

          if (explicitHub.length > 0) {
            let resolvedHub;
            try {
              resolvedHub = await resolveWorkingEndpoint(
                explicitHub,
                call,
                halfDeadlineMs(),
                signal
              );
            } catch (error) {
              if (signal?.aborted) throw error;
              resolvedHub = { candidates: explicitHub, lastError: error };
            }
            // `GetUnleashData` only proves the endpoint responds (an HTTP error is
            // deliberately accepted for servers that do not implement it). Once
            // the hub is reachable, hand it to the quota stage immediately and
            // await discovery only if those quota calls fail.
            if (resolvedHub.lastError === null) {
              return {
                candidates: resolvedHub.candidates,
                fallbackCandidates: resolveDiscoveredCandidates,
                error: null
              };
            }
            // A failed lightweight preflight lowers the hub's priority but does
            // not remove it: older servers can still implement the quota RPCs.
            return await resolveDiscoveredCandidates(explicitHub);
          }

          return await resolveDiscoveredCandidates();
        } catch (error) {
          return { candidates: [], error };
        }
      });

      const groupedTasks = candidateStates.map(async (state, index) => {
        const entry = await state;
        if (entry.candidates.length === 0) {
          return { snapshot: null, lastError: entry.error };
        }

        const groupOptions = {
          probeDeadlineMs,
          signal,
          csrfToken: sourceInfos[index].csrfToken,
          sourceKey: sourceKeys[index]
        };
        const grouped = await groupedQuotaFromCandidates(entry.candidates, call, {
          ...groupOptions,
          summaryDeadlineMs: halfDeadlineMs(),
          previousError: entry.error
        });
        if (grouped.snapshot || signal.aborted || !entry.fallbackCandidates) return grouped;

        const fallback = await entry.fallbackCandidates().catch(error => ({ candidates: [], error }));
        const previousError = preferQuotaFailure(grouped.lastError, fallback.error);
        if (fallback.candidates.length === 0 || signal.aborted) {
          return { snapshot: null, lastError: previousError };
        }
        return groupedQuotaFromCandidates(fallback.candidates, call, {
          ...groupOptions,
          summaryDeadlineMs: halfDeadlineMs(),
          previousError
        });
      });
      // Kind ordering is semantic; PID ordering within one kind is only stable
      // enumeration. A valid grouped snapshot can therefore finish the kind
      // immediately. Try the next source kind once every grouped task fails.
      const groupedOutcome = await firstSnapshotOrAll(groupedTasks);
      throwIfAborted(deps.signal);
      if (groupedOutcome.snapshot) return { ...groupedOutcome.snapshot, sourceDetail: kind };
      for (const [index, { lastError: error }] of groupedOutcome.results.entries()) {
        if (!error) continue;
        lastError = error;
        sourceFailures.set(sourceKeys[index], { source: kind, error });
      }
      if (signal.aborted) break;
    }
    if (sourceFailures.size) {
      throw Object.assign(errorWithStatus(lastError.status, lastError.message), { cause: lastError, sourceFailures });
    }
    throw lastError;
  } finally {
    clearTimeout(abortTimer);
    abortController.abort();
  }
}

module.exports = {
  probe,
  detectProcessInfo,
  detectProcessInfos,
  listeningPorts,
  callLs,
  _parseProcessLine: parseProcessLine,
  _antigravityProcessKind: antigravityProcessKind,
  _isAntigravityIdeCommand: isAntigravityIdeCommand,
  _isAntigravityCliCommand: isAntigravityCliCommand,
  _sortProcessInfos: sortProcessInfos,
  _extractFlag: extractFlag,
  _errorWithStatus: errorWithStatus,
  _collapsePools: collapsePools,
  _poolForModel: poolForModel,
  _quotaSummaryWindows: quotaSummaryWindows,
  _quotaBucketKind: quotaBucketKind,
  _endpointCandidates: endpointCandidates
};
