'use strict';

const { spawn } = require('node:child_process');
const https = require('node:https');
const http = require('node:http');
const { appVersion } = require('./appVersion');

function errorWithStatus(status, message) {
  const error = new Error(message || status);
  error.status = status;
  return error;
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
  return /(^|[/\\])language_server(_macos|\.exe)?(\s|$)/.test(lowerCommand);
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

// Classify a process command line as the Antigravity IDE language server, the
// Antigravity CLI language server, or neither. IDE takes precedence so its
// CSRF-token requirement is preserved.
function antigravityProcessKind(lowerCommand) {
  if (isLanguageServerCommand(lowerCommand) && isAntigravityCommand(lowerCommand)) return 'ide';
  if (isAntigravityCliCommand(lowerCommand)) return 'cli';
  return null;
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
  // The IDE language server authenticates local requests with `--csrf_token` and
  // must keep requiring it (a tokenless IDE match is skipped so a later valid one
  // can be found). The CLI's language server exposes no token flag and needs none.
  if (kind === 'ide' && !csrfToken) return null;
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
    const timer = setTimeout(() => {
      try { child.kill('SIGTERM'); } catch (_) {}
      reject(errorWithStatus('unavailable', `${cmd} timed out`));
    }, timeoutMs);
    child.stdout.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (err) => { clearTimeout(timer); reject(err); });
    child.on('close', (code) => {
      clearTimeout(timer);
      if (code !== 0) {
        reject(errorWithStatus('unavailable', stderr.trim() || `${cmd} exited ${code}`));
      } else {
        resolve(stdout);
      }
    });
    child.stdin?.end();
  });
}

async function detectProcessInfoPosix(deps = {}) {
  const stdout = await runProcessText('ps', ['-ax', '-o', 'pid=,command='], { deps, timeoutMs: 8000 });
  let sawAntigravityWithoutCsrf = false;
  for (const line of stdout.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const lower = trimmed.toLowerCase();
    const looksLikeAntigravity = isLanguageServerCommand(lower) && isAntigravityCommand(lower);
    const info = parseProcessLine(trimmed);
    if (info) return info;
    if (looksLikeAntigravity) sawAntigravityWithoutCsrf = true;
  }
  if (sawAntigravityWithoutCsrf) throw errorWithStatus('unavailable', 'Antigravity LS missing --csrf_token');
  throw errorWithStatus('notConfigured', 'Antigravity language server not running');
}

async function detectProcessInfoWin32(deps = {}) {
  // Surface both the IDE language server and the CLI (`agy` / `antigravity-cli`)
  // hosts; the command-line classifier (antigravityProcessKind) re-filters for
  // precision, so a broad Name filter here is safe.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.Name -like 'language_server*' -or $_.Name -like 'agy*' -or $_.Name -like 'antigravity*' } | ForEach-Object { "$($_.ProcessId) $($_.CommandLine)" }`;
  const stdout = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { deps, timeoutMs: 10000 });
  let sawAntigravityWithoutCsrf = false;
  for (const rawLine of stdout.split(/\r?\n/)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const info = parseProcessLine(trimmed);
    if (info) return info;
    const lower = trimmed.toLowerCase();
    if (isLanguageServerCommand(lower) && isAntigravityCommand(lower)) sawAntigravityWithoutCsrf = true;
  }
  if (sawAntigravityWithoutCsrf) throw errorWithStatus('unavailable', 'Antigravity LS missing --csrf_token');
  throw errorWithStatus('notConfigured', 'Antigravity language server not running');
}

async function detectProcessInfo(deps = {}) {
  const platform = deps.platform || process.platform;
  if (platform === 'win32') return detectProcessInfoWin32(deps);
  return detectProcessInfoPosix(deps);
}

async function listeningPortsPosix(pid, deps = {}) {
  let stdout;
  try {
    stdout = await runProcessText('lsof', ['-nP', '-iTCP', '-sTCP:LISTEN', '-a', '-p', String(pid)], { deps, timeoutMs: 6000 });
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
  const stdout = await runProcessText('powershell', ['-NoProfile', '-NonInteractive', '-Command', script], { deps, timeoutMs: 6000 });
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

function callLs({ scheme, port, csrfToken, method, body, host = '127.0.0.1', timeoutMs = 12000 }) {
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
        reject(errorWithStatus(statusFromHttpCode(res.statusCode), `${method} returned ${res.statusCode}`));
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

async function probe(deps = {}) {
  const info = await (deps.detectProcessInfo || detectProcessInfo)(deps);
  const ports = await (deps.listeningPorts || listeningPorts)(info.pid, deps);
  const call = deps.callLs || callLs;
  const candidates = endpointCandidates(info, ports);

  let lastError = errorWithStatus('unavailable', 'no endpoint candidates');
  for (const candidate of candidates) {
    try {
      const data = await call({ ...candidate, method: 'GetUserStatus', body: { metadata: PROBE_METADATA } });
      if (data?.userStatus) {
        const configs = data.userStatus.cascadeModelConfigData?.clientModelConfigs;
        const accountPlan =
          firstTrimmedString(data.userStatus.userTier?.name)
          || preferredPlanInfoName(data.userStatus.planStatus?.planInfo)
          || null;
        const accountEmail = data.userStatus.email?.trim?.() || null;
        const models = modelsFromConfigs(configs);
        if (models.length > 0) return { accountPlan, accountEmail, pools: collapsePools(models) };
      }
      // Fall back to GetCommandModelConfigs on the same endpoint.
      const fallback = await call({ ...candidate, method: 'GetCommandModelConfigs', body: { metadata: PROBE_METADATA } });
      const models = modelsFromConfigs(fallback?.clientModelConfigs);
      if (models.length > 0) return { accountPlan: null, accountEmail: null, pools: collapsePools(models) };
      lastError = errorWithStatus('unavailable', 'empty model configs');
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError;
}

module.exports = {
  probe,
  detectProcessInfo,
  listeningPorts,
  callLs,
  _parseProcessLine: parseProcessLine,
  _antigravityProcessKind: antigravityProcessKind,
  _isAntigravityCliCommand: isAntigravityCliCommand,
  _extractFlag: extractFlag,
  _errorWithStatus: errorWithStatus,
  _modelsFromConfigs: modelsFromConfigs,
  _collapsePools: collapsePools,
  _poolForModel: poolForModel,
  _endpointCandidates: endpointCandidates
};
