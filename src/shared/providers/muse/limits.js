'use strict';

const fs = require('node:fs');
const os = require('node:os');
const nodePath = require('node:path');
const { execFile } = require('node:child_process');
const { normalizeLimitProvider } = require('../../limits/core');
const { abortError } = require('../../probeDeadline');
const {
  errorWithStatus,
  pathDelimiterForPlatform,
  providerStatusFromError
} = require('../../limits/providerHelpers');

// pathApiForPlatform returns the host-default `path` for non-win32, which is
// path.win32 on a Windows host; an explicit POSIX simulation there would then
// join with '\'. Pick posix/win32 explicitly from the requested platform so
// resolution is deterministic regardless of host.
function pathApiForRequestedPlatform(platform) {
  return platform === 'win32' ? nodePath.win32 : nodePath.posix;
}

function existingMuseCli(env = process.env, platform = process.platform, deps = {}) {
  const path = pathApiForRequestedPlatform(platform);
  const exists = deps.existsSync || fs.existsSync;
  // Native launchers only: never run a shell or interpret a user-controlled command.
  const name = platform === 'win32' ? 'muse.exe' : 'muse';
  const directories = (env.PATH || env.Path || '').split(pathDelimiterForPlatform(platform)).filter(Boolean);
  const home = env.HOME || env.USERPROFILE;
  if (home) directories.push(path.join(home, '.local', 'bin'));
  if (platform !== 'win32') directories.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  return directories.map((dir) => path.join(dir, name)).find((file) => path.isAbsolute(file) && exists(file)) || null;
}

function runMuseUsageCli(command, deps = {}) {
  if (deps.signal?.aborted) return Promise.reject(abortError(deps.signal));
  const run = deps.execFile || execFile;
  return new Promise((resolve, reject) => {
    // execFile does not forward killSignal to its native AbortSignal handler.
    // Own cancellation so it also hard-stops the child and waits for close.
    const onAbort = () => child.kill('SIGKILL');
    const child = run(command, ['usage', '--json'], {
      // Quota polling must neither update Muse nor load a project's configuration.
      cwd: os.tmpdir(),
      env: { ...(deps.env || process.env), MUSE_NO_AUTO_UPDATE: '1' },
      encoding: 'utf8',
      timeout: deps.museCliTimeoutMs || 15000,
      // This read-only probe needs no graceful shutdown. Enforce timeout,
      // output overflow and cancellation even if the CLI handles SIGTERM.
      killSignal: 'SIGKILL',
      maxBuffer: 256 * 1024,
      windowsHide: true
    }, (error, stdout, stderr) => {
      deps.signal?.removeEventListener('abort', onAbort);
      if (deps.signal?.aborted) return reject(abortError(deps.signal));
      if (!error) return resolve(stdout);
      if (/not logged in: run [`']?muse login/i.test(String(stderr))) {
        return reject(errorWithStatus('unauthorized', 'Sign in with muse login'));
      }
      reject(error);
    });
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    if (deps.signal?.aborted) onAbort();
    child.stdin?.end();
  });
}

function allowanceWindow(period, kind) {
  if (period == null) return null;
  if (typeof period !== 'object' || Array.isArray(period)
    || typeof period.usedPercent !== 'number' || !Number.isFinite(period.usedPercent)
    || period.usedPercent < 0 || period.usedPercent > 100) {
    throw errorWithStatus('unavailable', 'Invalid Muse allowance period');
  }
  const reset = period.resetsAtMs;
  if (reset != null && (typeof reset !== 'number' || !Number.isFinite(reset)
    || reset <= 0 || !Number.isFinite(new Date(reset).getTime()))) {
    throw errorWithStatus('unavailable', 'Invalid Muse reset time');
  }
  const duration = period.windowDurationMins;
  if (duration != null && (typeof duration !== 'number' || !Number.isFinite(duration) || duration <= 0)) {
    throw errorWithStatus('unavailable', 'Invalid Muse window duration');
  }
  return {
    kind,
    label: kind === 'weekly' ? 'Weekly' : 'Session',
    usedPercent: period.usedPercent,
    ...(reset != null ? { resetsAt: new Date(reset).toISOString(), boundaryKind: 'reset' } : {}),
    ...(duration != null ? { windowMinutes: duration } : {})
  };
}

function parseMuseUsage(text) {
  const data = JSON.parse(text);
  if (!data || data.schemaVersion !== 1 || !Object.hasOwn(data, 'allowance')) {
    throw errorWithStatus('unavailable', 'Unsupported Muse usage schema');
  }
  // Null is not a zero reading. API-key billing and a quiet new window may
  // both have no allowance; neither proves a bad credential or a full quota.
  if (data.allowance === null) return { windows: [], planLabel: '' };
  const allowance = data.allowance;
  if (typeof allowance !== 'object' || Array.isArray(allowance)) {
    throw errorWithStatus('unavailable', 'Invalid Muse allowance');
  }
  const windows = [allowanceWindow(allowance.window, 'session'), allowanceWindow(allowance.weekly, 'weekly')].filter(Boolean);
  const planLabel = typeof allowance.tier === 'string' ? allowance.tier : '';
  // asOfMs is the server observation time when present. Validate it so a
  // malformed timestamp cannot masquerade as a fresh reading; fetch caps it
  // at the local clock so a skewed server clock cannot hide staleness.
  let asOfMs = null;
  if (allowance.asOfMs != null) {
    if (typeof allowance.asOfMs !== 'number' || !Number.isFinite(allowance.asOfMs) || allowance.asOfMs <= 0) {
      throw errorWithStatus('unavailable', 'Invalid Muse observation time');
    }
    asOfMs = allowance.asOfMs;
  }
  return { windows, planLabel, asOfMs };
}

async function fetchMuseLimits(_options = {}, deps = {}) {
  const nowMs = (deps.now || Date.now)();
  const base = { provider: 'muse', source: 'cli', updatedAt: new Date(nowMs).toISOString(), windows: [] };
  try {
    const command = existingMuseCli(deps.env || process.env, deps.platform || process.platform, deps);
    if (!command) return normalizeLimitProvider({ ...base, status: 'notConfigured' });
    const parsed = parseMuseUsage(await runMuseUsageCli(command, deps));
    const { asOfMs, ...providerFields } = parsed;
    const updatedAt = asOfMs != null
      ? new Date(Math.min(asOfMs, nowMs)).toISOString()
      : base.updatedAt;
    // The CLI does not expose a stable account id. Do not invent one from the
    // plan tier or a token, or claim that two devices have the same account.
    return normalizeLimitProvider({ ...base, ...providerFields, updatedAt, status: parsed.windows.length ? 'ok' : 'unavailable' });
  } catch (error) {
    if (deps.signal?.aborted) throw error;
    return normalizeLimitProvider({ ...base, status: providerStatusFromError(error) });
  }
}

module.exports = { existingMuseCli, runMuseUsageCli, parseMuseUsage, fetchMuseLimits };
