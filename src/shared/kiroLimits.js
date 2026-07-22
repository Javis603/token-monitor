'use strict';

// Kiro (AWS) subscription credit lookup via kiro-cli.
//
// Kiro has no usage API, so the only quota source is the CLI's `/usage` slash
// command. kiro-cli is forked from the Amazon Q Developer CLI: it does terminal
// setup on startup and writes the report to stdout/stderr as ANSI text. Running
// `kiro-cli chat --no-interactive /usage` with TERM set captures that output
// without an interactive session (the same approach Win-CodexBar uses, which is
// what keeps this portable to Windows — no PTY required). We strip ANSI and
// regex-parse the report. Parsing mirrors CodexBar's KiroStatusProbe so the
// supported output formats stay aligned with upstream.

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { normalizeLimitProvider } = require('./limits');
const { abortError } = require('./probeDeadline');
const { hashKey } = require('./hashKey');

const DAY_MS = 24 * 60 * 60 * 1000;
const ESC = String.fromCharCode(27);
const BEL = String.fromCharCode(7);
// CSI sequences (ESC [ … letter) and OSC sequences (ESC ] … BEL or ST).
const ANSI_CSI = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const ANSI_OSC = new RegExp(`${ESC}\\].*?(?:${BEL}|${ESC}\\\\)`, 'g');

// Markers that mean kiro-cli ran but the user is signed out / the auth portal
// failed. All of these map to "Run kiro-cli login" rather than a transient error.
const LOGIN_MARKERS = [
  'not logged in',
  'login required',
  'failed to initialize auth portal',
  'kiro-cli login',
  'oauth error'
];

function errorWithStatus(status, message) {
  const error = new Error(message);
  error.status = status;
  return error;
}

function uniqueStrings(values) {
  return [...new Set(values.filter(Boolean))];
}

function stripAnsi(text) {
  return String(text || '').replace(ANSI_CSI, '').replace(ANSI_OSC, '');
}

function clampPercent(value) {
  if (!Number.isFinite(value)) return null;
  return Math.max(0, Math.min(100, value));
}

function firstNumber(text, pattern) {
  const match = String(text).match(pattern);
  return match ? Number(match[1]) : null;
}

function displayPlanName(planName) {
  const cleaned = String(planName || '').replace(/\s+/g, ' ').trim();
  if (!/kiro/i.test(cleaned)) return cleaned;
  return cleaned
    .split(' ')
    .map((word) => (word.toUpperCase() === 'KIRO'
      ? 'Kiro'
      : word.charAt(0).toUpperCase() + word.slice(1).toLowerCase()))
    .join(' ');
}

// The limit row is already labelled "Kiro", so the plan tag drops a redundant
// leading "Kiro " and shows just the tier ("Free"/"Pro"), matching how Cursor
// shows "Free"/"Pro+". Plans without the prefix (e.g. "Q Developer Pro") and a
// bare "Kiro" fallback pass through unchanged.
function planTierLabel(displayName) {
  const stripped = String(displayName || '').replace(/^Kiro\s+/i, '').trim();
  return stripped || displayName;
}

// Resolve "resets on" to an ISO timestamp. kiro-cli emits either YYYY-MM-DD
// (kiro-cli 2.x) or MM/DD (legacy); the MM/DD form has no year, so roll it to
// the next future occurrence the same way CodexBar/Win-CodexBar do.
function parseResetDate(raw, now = new Date()) {
  const value = String(raw || '').trim();
  if (!value) return null;
  if (value.includes('-')) {
    const date = new Date(`${value}T00:00:00`);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  const parts = value.split('/');
  if (parts.length !== 2) return null;
  const month = Number(parts[0]);
  const day = Number(parts[1]);
  if (!Number.isInteger(month) || !Number.isInteger(day)) return null;
  const year = now.getFullYear();
  const candidate = new Date(year, month - 1, day);
  if (Number.isNaN(candidate.getTime())) return null;
  if (candidate.getTime() <= now.getTime()) candidate.setFullYear(year + 1);
  return candidate.toISOString();
}

function parsePlanName(text) {
  // New format (kiro-cli 1.24+, Q Developer): "Plan: Q Developer Pro".
  const newFormat = text.match(/Plan:[ \t]*([^\n]+)/);
  if (newFormat) return { name: newFormat[1].trim(), matchedNewFormat: true };
  // kiro-cli 2.x: "Estimated Usage | resets on 2026-06-01 | KIRO FREE".
  const estimated = text.match(/Estimated Usage[ \t]*\|[^\n|]*\|[ \t]*([A-Z][A-Z0-9 ]+)/);
  if (estimated) return { name: estimated[1].trim(), matchedNewFormat: false };
  // Legacy boxed header: "| KIRO FREE |".
  const legacy = text.match(/\|[ \t]*(KIRO[ \t]+\w+)/);
  if (legacy) return { name: legacy[1].trim(), matchedNewFormat: false };
  return { name: 'Kiro', matchedNewFormat: false };
}

function parseBonus(text) {
  // Only treat an "X/Y credits used" pair as bonus when the label is present.
  if (!/bonus credits/i.test(text)) return null;
  // The boxed layout (docs/kiro.md) splits the "Bonus credits:" label and its
  // number across lines with box borders between, so anchor on the distinctive
  // "X/Y credits used" suffix first; fall back to the same-line "Bonus credits: X/Y".
  let match = text.match(/(\d+\.?\d*)\s*\/\s*(\d+)\s+credits used/i)
    || text.match(/Bonus credits:\s*(\d+\.?\d*)\s*\/\s*(\d+)/i);
  if (!match) return null;
  const used = Number(match[1]);
  const total = Number(match[2]);
  if (!Number.isFinite(used) || !Number.isFinite(total) || total <= 0) return null;
  const expiry = firstNumber(text, /expires in (\d+) days?/i);
  return { used, total, expiryDays: Number.isFinite(expiry) ? expiry : null };
}

// Overages only exist on paid plans that opted into overage billing. Returns the
// extra credits used + estimated USD cost when enabled, else null (so the row
// never shows for plans without it). Mirrors CodexBar/Win-CodexBar's regexes.
function parseOverages(text) {
  const status = (text.match(/Overages:\s*([^\n]+)/i) || [])[1] || '';
  if (!status.trim().toLowerCase().startsWith('enabled')) return null;
  const creditsUsed = firstNumber(text, /Credits used:\s*(\d+\.?\d*)/i);
  const estimatedCostUsd = firstNumber(text, /Est\.?\s*cost:\s*\$?(\d+\.?\d*)\s*USD/i);
  return {
    creditsUsed: Number.isFinite(creditsUsed) ? creditsUsed : null,
    estimatedCostUsd: Number.isFinite(estimatedCostUsd) ? estimatedCostUsd : null
  };
}

// Parse a kiro-cli `/usage` report into a plain shape. Throws errorWithStatus on
// signed-out / unreadable output so the caller can map it to a provider status.
function parseKiroUsage(rawOutput, now = new Date()) {
  const stripped = stripAnsi(rawOutput);
  const trimmed = stripped.trim();
  const lowered = stripped.toLowerCase();

  if (LOGIN_MARKERS.some((marker) => lowered.includes(marker))) {
    throw errorWithStatus('notConfigured', 'Kiro CLI is not logged in.');
  }
  if (!trimmed) {
    throw errorWithStatus('unavailable', 'Kiro CLI returned no output.');
  }
  if (lowered.includes('could not retrieve usage information')) {
    throw errorWithStatus('unavailable', 'Kiro CLI could not retrieve usage information.');
  }

  const { name: planName, matchedNewFormat } = parsePlanName(stripped);
  const managed = lowered.includes('managed by admin') || lowered.includes('managed by organization');

  let creditsPercent = firstNumber(stripped, /█+\s*(\d+)%/);
  const matchedPercent = creditsPercent !== null;

  let creditsUsed = 0;
  let creditsTotal = 50; // free-tier default, matching upstream
  const credits = stripped.match(/\((\d+\.?\d*)\s+of\s+(\d+)\s+covered/);
  const matchedCredits = Boolean(credits);
  if (credits) {
    creditsUsed = Number(credits[1]);
    creditsTotal = Number(credits[2]);
  }
  if (!matchedPercent && matchedCredits && creditsTotal > 0) {
    creditsPercent = (creditsUsed / creditsTotal) * 100;
  }

  // Managed plans (Q Developer via org admin) expose a plan name but no quota.
  if (matchedNewFormat && managed && !matchedPercent && !matchedCredits) {
    return {
      planName,
      displayPlanName: displayPlanName(planName),
      managed: true,
      hasMetrics: false,
      creditsPercent: 0,
      creditsUsed: 0,
      creditsTotal: 0,
      resetsAt: null,
      bonus: null,
      overage: null
    };
  }

  if (!matchedPercent && !matchedCredits) {
    throw errorWithStatus('unavailable', 'Kiro CLI output format was not recognized.');
  }

  const resetRaw = (stripped.match(/resets on (\d{4}-\d{2}-\d{2}|\d{2}\/\d{2})/) || [])[1] || '';
  return {
    planName,
    displayPlanName: displayPlanName(planName),
    managed,
    hasMetrics: true,
    creditsPercent: clampPercent(creditsPercent) ?? 0,
    creditsUsed,
    creditsTotal,
    resetsAt: parseResetDate(resetRaw, now),
    bonus: parseBonus(stripped),
    overage: parseOverages(stripped)
  };
}

// Known install locations used as a fallback after PATH. Windows paths mirror
// Win-CodexBar's find_kiro_cli (Kiro's installer drops kiro-cli.exe under
// %LOCALAPPDATA%\Programs\Kiro or C:\Program Files\Kiro). The non-Windows
// entries cover Electron's commonly-truncated PATH (same reason the Claude/Codex
// probes carry these), since the references rely on PATH there.
function kiroCliCandidates(env = process.env, platform = process.platform) {
  if (env.TOKEN_MONITOR_KIRO_COMMAND) return [env.TOKEN_MONITOR_KIRO_COMMAND];
  const candidates = [];
  if (platform === 'win32') {
    const localAppData = env.LOCALAPPDATA;
    if (localAppData) candidates.push(path.join(localAppData, 'Programs', 'Kiro', 'kiro-cli.exe'));
    candidates.push('C:\\Program Files\\Kiro\\kiro-cli.exe');
  } else {
    if (env.HOME) candidates.push(path.join(env.HOME, '.local', 'bin', 'kiro-cli'));
    candidates.push('/opt/homebrew/bin/kiro-cli', '/usr/local/bin/kiro-cli', '/usr/bin/kiro-cli');
  }
  return uniqueStrings(candidates);
}

function findOnPath(names, env, platform, existsSync) {
  const rawPath = env.PATH || env.Path || '';
  const sep = platform === 'win32' ? ';' : ':';
  for (const dir of rawPath.split(sep).filter(Boolean)) {
    for (const name of names) {
      const full = path.join(dir, name);
      if (existsSync(full)) return full;
    }
  }
  return null;
}

// Resolve kiro-cli to an absolute path, or null when it is not installed.
// Order mirrors Win-CodexBar's find_kiro_cli: explicit override, then PATH (so
// the user's installed/updated binary wins), then known install locations.
// Filesystem-only (no spawn) so the common "Kiro not installed" case stays cheap
// and reports a clean notConfigured instead of a spawn error.
function existingKiroCli(env = process.env, platform = process.platform, deps = {}) {
  const existsSync = deps.existsSync || fs.existsSync;
  if (env.TOKEN_MONITOR_KIRO_COMMAND) return env.TOKEN_MONITOR_KIRO_COMMAND;
  const names = platform === 'win32'
    ? ['kiro-cli.exe', 'kiro-cli.cmd', 'kiro-cli']
    : ['kiro-cli'];
  const onPath = findOnPath(names, env, platform, existsSync);
  if (onPath) return onPath;
  for (const candidate of kiroCliCandidates(env, platform)) {
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

// Spawn kiro-cli and capture the /usage report. TERM is set so the CLI emits its
// formatted report; stdin is ignored so a prompt can never block us. We resolve
// with stdout (or stderr when stdout is empty) regardless of exit code, because
// kiro-cli sometimes prints the report and still exits non-zero.
function runKiroUsageCli(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const env = { ...(deps.env || process.env), TERM: 'xterm-256color' };
  const command = deps.kiroCliPath || 'kiro-cli';
  const timeoutMs = Number(deps.kiroCliTimeoutMs || 20000);
  const signal = deps.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnFn(command, ['chat', '--no-interactive', '/usage'], {
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      });
    } catch (error) {
      reject(error);
      return;
    }
    let stdout = '';
    let stderr = '';
    let settled = false;
    const finish = (callback, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
      callback(value);
    };
    const stopChild = () => {
      try { child.kill('SIGTERM'); } catch (_) {}
    };
    const onAbort = () => {
      stopChild();
      finish(reject, abortError(signal));
    };
    const timer = setTimeout(() => {
      stopChild();
      finish(reject, errorWithStatus('unavailable', 'kiro-cli timed out'));
    }, timeoutMs);
    child.stdout?.on('data', (chunk) => { stdout += chunk.toString(); });
    child.stderr?.on('data', (chunk) => { stderr += chunk.toString(); });
    child.on('error', (error) => finish(reject, error));
    child.on('close', () => {
      finish(resolve, stdout.trim() ? stdout : stderr);
    });
    signal?.addEventListener?.('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
  });
}

function statusOnlyProvider(status, updatedAt) {
  return normalizeLimitProvider({
    provider: 'kiro',
    accountKey: '',
    accountLabel: '',
    source: 'cli',
    status,
    updatedAt,
    windows: []
  });
}

async function fetchKiroLimits(_options = {}, deps = {}) {
  const env = deps.env || process.env;
  const platform = deps.platform || process.platform;
  const nowMs = (deps.now || Date.now)();
  const updatedAt = new Date(nowMs).toISOString();

  let text;
  try {
    if (typeof deps.runKiroUsageCli === 'function') {
      text = await deps.runKiroUsageCli();
    } else {
      const binary = existingKiroCli(env, platform, deps);
      if (!binary) return statusOnlyProvider('notConfigured', updatedAt);
      text = await runKiroUsageCli({ ...deps, env, platform, kiroCliPath: binary });
    }
  } catch (error) {
    if (error && error.code === 'ENOENT') return statusOnlyProvider('notConfigured', updatedAt);
    return statusOnlyProvider(error?.status || 'unavailable', updatedAt);
  }

  let parsed;
  try {
    parsed = parseKiroUsage(text, new Date(nowMs));
  } catch (error) {
    return statusOnlyProvider(error?.status || 'unavailable', updatedAt);
  }

  const windows = [];
  if (parsed.hasMetrics) {
    windows.push({
      kind: 'billing',
      label: 'Credits',
      usedPercent: parsed.creditsPercent,
      used: parsed.creditsUsed,
      limit: parsed.creditsTotal,
      resetsAt: parsed.resetsAt
    });
  }
  if (parsed.bonus) {
    const expiryIso = parsed.bonus.expiryDays !== null
      ? new Date(nowMs + parsed.bonus.expiryDays * DAY_MS).toISOString()
      : null;
    windows.push({
      kind: 'billing',
      label: 'Bonus',
      usedPercent: clampPercent((parsed.bonus.used / parsed.bonus.total) * 100),
      used: parsed.bonus.used,
      limit: parsed.bonus.total,
      resetsAt: expiryIso,
      resetDescription: parsed.bonus.expiryDays !== null ? `expires in ${parsed.bonus.expiryDays}d` : ''
    });
  }
  // Overage is a value, not a quota %, so it rides as a meterless note row (like
  // DeepSeek's Spend line): the estimated USD cost shows as the value, the extra
  // credits used as the subline. Only present when overage billing is enabled.
  if (parsed.overage && (parsed.overage.estimatedCostUsd !== null || parsed.overage.creditsUsed !== null)) {
    windows.push({
      kind: 'billing',
      label: 'Overage',
      showMeter: false,
      used: parsed.overage.creditsUsed, // overage credits used
      remaining: parsed.overage.estimatedCostUsd // estimated USD cost
    });
  }

  return normalizeLimitProvider({
    provider: 'kiro',
    accountKey: hashKey('kiro', 'default'),
    accountLabel: planTierLabel(parsed.displayPlanName),
    source: 'cli',
    status: 'ok',
    updatedAt,
    windows
  });
}

module.exports = {
  stripAnsi,
  displayPlanName,
  parseResetDate,
  parseKiroUsage,
  kiroCliCandidates,
  existingKiroCli,
  runKiroUsageCli,
  fetchKiroLimits
};
