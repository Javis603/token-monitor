'use strict';

const { abortError } = require('./probeDeadline');

const { spawn } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { appVersion } = require('./appVersion');

const DEFAULT_PROBE_TIMEOUT_MS = 8000;
const DEFAULT_RPC_TIMEOUT_MS = 12000;

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
}

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
  return /(^|[/\\])language(?:_|-)server(?:[_-][a-z0-9]+)*(?:\.exe)?(\s|$)/.test(lowerCommand);
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
function isAntigravityCliCommand(lowerCommand) {
  if (/(^|[/\\])(antigravity-cli|antigravity_cli)([\s/\\]|$)/.test(lowerCommand)) return true;
  if (/(^|[/\\])agy(\.exe)?(\s|$)/.test(lowerCommand)) return true;
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

function parseProcessLine(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed) return null;
  const split = trimmed.indexOf(' ');
  if (split <= 0) return null;
  const pid = Number(trimmed.slice(0, split));
  if (!Number.isFinite(pid) || pid <= 0) return null;
  const command = trimmed.slice(split + 1).trim();
  if (!command) return null;
  const lower = command.toLowerCase();
  const kind = antigravityProcessKind(lower);
  if (!kind) return null;
  const csrfToken = extractFlag('--csrf_token', command);
  // Desktop app/IDE language servers authenticate local requests with
  // `--csrf_token`; tokenless matches are skipped so a later valid process can
  // still be used. The CLI language server exposes no token flag and needs none.
  if (kind !== 'cli' && !csrfToken) return null;
  return {
    pid,
    kind,
    csrfToken: csrfToken || '',
    extensionPort: extractPortFlag('--extension_server_port', command),
    extensionCsrfToken: extractFlag('--extension_server_csrf_token', command),
    commandLine: command
  };
}

function runProcessText(cmd, args, { timeoutMs = 10000, deps = {} } = {}) {
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
      if (code !== 0) {
        finish(reject, errorWithStatus('unavailable', stderr.trim() || `${cmd} exited ${code}`));
      } else {
        finish(resolve, stdout);
      }
    });
    child.stdin?.end();
  });
}

function processInfosFromText(stdout) {
  const infos = [];
  let sawDesktopWithoutCsrf = false;
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const info = parseProcessLine(trimmed);
    if (info) {
      infos.push(info);
      continue;
    }
    const split = trimmed.indexOf(' ');
    const lower = split === -1 ? '' : trimmed.slice(split + 1).trim().toLowerCase();
    const kind = antigravityProcessKind(lower);
    if ((kind === 'app' || kind === 'ide') && !extractFlag('--csrf_token', trimmed)) {
      sawDesktopWithoutCsrf = true;
    }
  }
  return { infos: sortProcessInfos(infos), sawDesktopWithoutCsrf };
}

function requireDetectedProcessInfos(stdout) {
  const { infos, sawDesktopWithoutCsrf } = processInfosFromText(stdout);
  if (infos.length > 0) return infos;
  if (sawDesktopWithoutCsrf) throw errorWithStatus('unavailable', 'Antigravity LS missing --csrf_token');
  throw errorWithStatus('notConfigured', 'Antigravity language server not running');
}

async function detectProcessInfosPosix(deps = {}) {
  const stdout = await runProcessText('ps', ['-ax', '-o', 'pid=,command='], {
    deps,
    timeoutMs: Math.min(8000, Number(deps.timeoutMs) || 8000)
  });
  return requireDetectedProcessInfos(stdout);
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
  return requireDetectedProcessInfos(stdout);
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
    stdout = await runProcessText('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], {
      deps,
      timeoutMs: Math.min(6000, Number(deps.timeoutMs) || 6000)
    });
  } catch (err) {
    throw errorWithStatus('unavailable', `lsof failed: ${err.message}`);
  }
  const ports = new Set();
  const re = /:(\d+)\s+\(LISTEN\)/g;
  let match;
  while ((match = re.exec(stdout)) !== null) {
    const n = Number(match[1]);
    if (Number.isFinite(n)) ports.add(n);
  }
  if (ports.size === 0) throw errorWithStatus('unavailable', 'no listening ports for antigravity LS');
  return [...ports].sort((a, b) => a - b);
}

async function listeningPortsWin32(pid, deps = {}) {
  const script = `Get-NetTCPConnection -OwningProcess ${pid} -State Listen -ErrorAction SilentlyContinue | Select-Object -ExpandProperty LocalPort`;
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

function callLs({
  scheme,
  port,
  csrfToken,
  method,
  body,
  host = '127.0.0.1',
  timeoutMs = DEFAULT_RPC_TIMEOUT_MS,
  signal
}) {
  const transport = scheme === 'https' ? https : http;
  const payload = Buffer.from(JSON.stringify(body || {}));
  return new Promise((resolve, reject) => {
    const req = transport.request({
      host,
      port,
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
        const error = errorWithStatus(statusFromHttpCode(res.statusCode), `${method} returned ${res.statusCode}`);
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

// Copied verbatim from openusage/codexbar: placeholder / internal model IDs that
// must be ignored when reading clientModelConfigs.
const CC_MODEL_BLACKLIST = new Set([
  'MODEL_CHAT_20706',
  'MODEL_CHAT_23310',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_THINKING',
  'MODEL_GOOGLE_GEMINI_2_5_FLASH_LITE',
  'MODEL_GOOGLE_GEMINI_2_5_PRO',
  'MODEL_PLACEHOLDER_M19',
  'MODEL_PLACEHOLDER_M9',
  'MODEL_PLACEHOLDER_M12'
]);

function poolForModel(label, modelId) {
  const lc = `${label || ''} ${modelId || ''}`.toLowerCase();
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
  const name = String(displayName || '').trim();
  const lower = name.toLowerCase();
  if (lower.includes('gemini')) return 'Gemini';
  if (lower.includes('claude') || lower.includes('gpt')) return 'Claude/GPT';
  return name || 'Quota';
}

function quotaBucketKind(bucket) {
  const aliases = new Set(['session', '5h', '5-hour', 'five hour', 'five-hour']);
  const candidates = [];
  for (const value of [bucket?.bucketId, bucket?.displayName]) {
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
  const windows = [];
  for (const group of groups) {
    const groupName = quotaGroupName(group?.displayName);
    for (const bucket of Array.isArray(group?.buckets) ? group.buckets : []) {
      const kind = quotaBucketKind(bucket);
      if (!kind) continue;
      const remainingFraction = quotaRemainingFraction(bucket);
      const disabled = bucket?.disabled === true;
      windows.push({
        kind,
        name: `${groupName} ${kind === 'session' ? '5-hour' : 'weekly'}`,
        remainingFraction: disabled ? null : remainingFraction,
        resetTime: parseResetTime(bucket?.resetTime),
        resetDescription: typeof bucket?.description === 'string' ? bucket.description : '',
        showMeter: !disabled && remainingFraction !== null
      });
    }
  }
  const groupRank = (name) => name.startsWith('Gemini ') ? 0 : name.startsWith('Claude/GPT ') ? 1 : 2;
  const kindRank = (kind) => kind === 'session' ? 0 : 1;
  return windows.sort((a, b) => groupRank(a.name) - groupRank(b.name) || kindRank(a.kind) - kindRank(b.kind));
}

function modelsFromConfigs(configs) {
  return (Array.isArray(configs) ? configs : [])
    .map((cfg) => {
      const modelId = cfg?.modelOrAlias?.model;
      if (!modelId || CC_MODEL_BLACKLIST.has(modelId)) return null;
      const quota = cfg?.quotaInfo;
      if (!quota || typeof quota.remainingFraction !== 'number') return null;
      const label = (typeof cfg?.label === 'string' && cfg.label.trim()) || modelId;
      return {
        label,
        modelId,
        remainingFraction: quota.remainingFraction,
        resetTime: parseResetTime(quota.resetTime)
      };
    })
    .filter(Boolean);
}

function collapsePools(models) {
  const pools = new Map();
  for (const m of models) {
    const name = poolForModel(m.label, m.modelId);
    const existing = pools.get(name);
    if (!existing || m.remainingFraction < existing.remainingFraction) {
      pools.set(name, { name, remainingFraction: m.remainingFraction, resetTime: m.resetTime });
    } else if (m.remainingFraction === existing.remainingFraction && m.resetTime && existing.resetTime && m.resetTime < existing.resetTime) {
      // tie-break: earlier reset wins
      pools.set(name, { name, remainingFraction: m.remainingFraction, resetTime: m.resetTime });
    }
  }
  const order = ['Gemini Pro', 'Gemini Flash', 'Claude'];
  return order.flatMap((name) => (pools.has(name) ? [pools.get(name)] : []));
}

function endpointCandidates(processInfo, listenPorts) {
  const candidates = [];
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
  ))];
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

async function groupedQuotaFromCandidates(candidates, call, {
  summaryDeadlineMs,
  probeDeadlineMs,
  signal
}) {
  let lastError = errorWithStatus('unavailable', 'no endpoint candidates');
  for (const candidate of candidates) {
    try {
      const summary = await callBeforeDeadline(call, {
        ...candidate,
        method: 'RetrieveUserQuotaSummary',
        body: { forceRefresh: true },
        signal
      }, summaryDeadlineMs);
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
        } catch (_) {
          throwIfAborted(signal);
        }
        throwIfAborted(signal);
        return { snapshot: { accountPlan, accountEmail, windows }, lastError };
      }
      lastError = errorWithStatus('unavailable', 'empty quota summary');
    } catch (err) {
      throwIfAborted(signal);
      lastError = err;
      if (remainingMs(summaryDeadlineMs) <= 0) break;
    }
  }
  return { snapshot: null, lastError };
}

async function legacyQuotaFromCandidates(candidates, call, { probeDeadlineMs, signal }) {
  let lastError = errorWithStatus('unavailable', 'no endpoint candidates');
  const userStatusDeadlineMs = Date.now() + Math.max(1, Math.floor(remainingMs(probeDeadlineMs) / 2));
  for (const candidate of candidates) {
    try {
      const data = await callBeforeDeadline(call, {
        ...candidate,
        method: 'GetUserStatus',
        body: { metadata: PROBE_METADATA },
        signal
      }, userStatusDeadlineMs);
      if (data?.userStatus) {
        const configs = data.userStatus.cascadeModelConfigData?.clientModelConfigs;
        const accountPlan =
          firstTrimmedString(data.userStatus.userTier?.name)
          || preferredPlanInfoName(data.userStatus.planStatus?.planInfo)
          || null;
        const accountEmail = data.userStatus.email?.trim?.() || null;
        const models = modelsFromConfigs(configs);
        if (models.length > 0) {
          throwIfAborted(signal);
          return { snapshot: { accountPlan, accountEmail, pools: collapsePools(models) }, lastError };
        }
      }
      lastError = errorWithStatus('unavailable', 'empty user status');
    } catch (err) {
      throwIfAborted(signal);
      lastError = err;
      if (remainingMs(userStatusDeadlineMs) <= 0) break;
    }
  }
  for (const candidate of candidates) {
    try {
      const fallback = await callBeforeDeadline(call, {
        ...candidate,
        method: 'GetCommandModelConfigs',
        body: { metadata: PROBE_METADATA },
        signal
      }, probeDeadlineMs);
      const models = modelsFromConfigs(fallback?.clientModelConfigs);
      if (models.length > 0) {
        throwIfAborted(signal);
        return { snapshot: { accountPlan: null, accountEmail: null, pools: collapsePools(models) }, lastError };
      }
      lastError = errorWithStatus('unavailable', 'empty model configs');
    } catch (err) {
      throwIfAborted(signal);
      lastError = err;
      if (remainingMs(probeDeadlineMs) <= 0) break;
    }
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
  let lastError = errorWithStatus('notConfigured', 'Antigravity language server not running');

  try {
    const infos = await promiseBeforeDeadline(
      (timeoutMs) => detectedProcessInfos({ ...runtimeDeps, timeoutMs }),
      probeDeadlineMs,
      DEFAULT_RPC_TIMEOUT_MS,
      signal
    );

    // Source priority is deliberate and independent of ps/PID order. Processes
    // within one source are probed concurrently under the same provider-wide
    // deadline, and grouped quota still wins before any legacy response.
    for (const kind of PROCESS_KIND_ORDER) {
      const sourceInfos = infos.filter((info) => info.kind === kind);
      const prepared = await Promise.all(sourceInfos.map(async (info) => {
        try {
          const ports = await promiseBeforeDeadline(
            (timeoutMs) => listPorts(info.pid, { ...runtimeDeps, timeoutMs }),
            probeDeadlineMs,
            DEFAULT_RPC_TIMEOUT_MS,
            signal
          );
          const initialCandidates = endpointCandidates(info, ports);
          const resolved = await resolveWorkingEndpoint(
            initialCandidates,
            call,
            probeDeadlineMs,
            signal
          );
          return { info, candidates: resolved.candidates, error: resolved.lastError };
        } catch (error) {
          return { info, candidates: [], error };
        }
      }));
      throwIfAborted(signal);
      const candidatesByProcess = prepared.filter((entry) => entry.candidates.length > 0);
      for (const entry of prepared) {
        if (entry.error) lastError = entry.error;
      }
      if (candidatesByProcess.length === 0) continue;

      const summaryDeadlineMs = Date.now() + Math.max(1, Math.floor(remainingMs(probeDeadlineMs) / 2));
      const groupedResults = await Promise.all(candidatesByProcess.map((entry) => (
        groupedQuotaFromCandidates(entry.candidates, call, {
          summaryDeadlineMs,
          probeDeadlineMs,
          signal
        })
      )));
      throwIfAborted(signal);
      const grouped = groupedResults.find((result) => result.snapshot);
      if (grouped?.snapshot) return { ...grouped.snapshot, sourceDetail: kind };
      for (const result of groupedResults) lastError = result.lastError || lastError;

      const legacyResults = await Promise.all(candidatesByProcess.map((entry) => (
        legacyQuotaFromCandidates(entry.candidates, call, {
          probeDeadlineMs,
          signal
        })
      )));
      throwIfAborted(signal);
      const legacy = legacyResults.find((result) => result.snapshot);
      if (legacy?.snapshot) return { ...legacy.snapshot, sourceDetail: kind };
      for (const result of legacyResults) lastError = result.lastError || lastError;
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
  _modelsFromConfigs: modelsFromConfigs,
  _collapsePools: collapsePools,
  _poolForModel: poolForModel,
  _quotaSummaryWindows: quotaSummaryWindows,
  _quotaBucketKind: quotaBucketKind,
  _endpointCandidates: endpointCandidates
};
