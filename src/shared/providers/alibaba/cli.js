'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFile } = require('node:child_process');
const { abortError } = require('../../probeDeadline');
const { throwIfAborted } = require('../../abortSignal');

const CLI_TIMEOUT_MS = 15000;
const MAX_SEATS = 1000;
const PAGE_SIZE = 10;

function existingExecutable(file, deps) {
  if (deps.existsSync) return deps.existsSync(file);
  try {
    fs.accessSync(file, fs.constants.X_OK);
    return fs.statSync(file).isFile();
  } catch { return false; }
}

function existingBailianCli(env, platform = process.platform, deps = {}) {
  const paths = platform === 'win32' ? path.win32 : path.posix;
  const dirs = (env.PATH || env.Path || '').split(platform === 'win32' ? ';' : ':').filter(Boolean);
  const home = env.HOME || env.USERPROFILE;
  if (home) dirs.push(paths.join(home, '.local', 'bin'));
  if (platform !== 'win32') dirs.push('/opt/homebrew/bin', '/usr/local/bin', '/usr/bin');
  const name = platform === 'win32' ? 'bl.exe' : 'bl';
  for (const dir of dirs.filter(paths.isAbsolute)) {
    const binary = paths.join(dir, name);
    if (existingExecutable(binary, deps)) return binary;
    if (platform === 'win32') {
      // npm's supported global layout. Never interpret or execute shim text.
      const entry = paths.join(dir, 'node_modules', 'bailian-cli', 'dist', 'bailian.mjs');
      if (existingExecutable(paths.join(dir, 'bl.cmd'), deps) && existingExecutable(entry, deps)) return entry;
    }
  }
  return null;
}

function cliEnvironment(env, variant) {
  // Reuse the CLI's saved login, without forwarding unrelated app credentials.
  const allowed = new Set(['PATH', 'HOME', 'USERPROFILE', 'APPDATA', 'LOCALAPPDATA', 'SystemRoot',
    'XDG_CONFIG_HOME', 'BAILIAN_CONFIG_DIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'TZ',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
    'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']);
  const result = Object.fromEntries(Object.entries(env).filter(([key]) => allowed.has(key)));
  // Background quota reads must not update the CLI or generate CLI telemetry.
  result.NO_UPDATE_NOTIFIER = '1';
  result.DO_NOT_TRACK = '1';
  if (env.Path && !result.PATH) result.PATH = env.Path;
  if (!variant.personal) {
    const base = variant.id === 'intl' ? 'https://dashscope-intl.aliyuncs.com' : 'https://dashscope.aliyuncs.com';
    result.BAILIAN_BASE_URL = base;
    result.DASHSCOPE_BASE_URL = base;
  }
  return result;
}

function runBailian(command, args, env, timeout, deps) {
  throwIfAborted(deps.signal);
  return new Promise((resolve, reject) => {
    const onAbort = () => child.kill('SIGKILL');
    const child = (deps.execFile || execFile)(command, args, {
      cwd: os.tmpdir(), env, encoding: 'utf8', windowsHide: true,
      timeout, killSignal: 'SIGKILL', maxBuffer: 64 * 1024
    }, (error, stdout) => {
      deps.signal?.removeEventListener('abort', onAbort);
      if (deps.signal?.aborted) return reject(abortError(deps.signal));
      if (error) {
        // Bailian's documented ExitCode.AUTH is 3 (missing/expired credentials).
        if (error.code === 3) error.status = 'notConfigured';
        return reject(error);
      }
      resolve(stdout);
    });
    child.stdin?.end();
    deps.signal?.addEventListener('abort', onAbort, { once: true });
    if (deps.signal?.aborted) onAbort();
  });
}

function invalidOutput() {
  return new Error('Bailian CLI returned unsupported quota data');
}

// The CLI emits native JSON scalars. Reject malformed ratios rather than let
// the web parser's compatibility coercion turn them into a plausible meter.
function validatePersonalCLIUsage(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (/^per(?:5Hour|1Week|1Month)Percentage$/i.test(key) && item != null
      && (typeof item !== 'number' || !Number.isFinite(item) || item < 0 || item > 1)) throw invalidOutput();
    if (/^per(?:5Hour|1Week|1Month)ResetTime$/i.test(key) && item != null
      && (typeof item !== 'number' || !Number.isFinite(item) || item < 0
        || !Number.isFinite(new Date(item).getTime()))) throw invalidOutput();
    validatePersonalCLIUsage(item);
  }
}

async function fetchBailianCLI(variant, deps = {}) {
  const env = deps.env || process.env;
  const command = existingBailianCli(env, deps.platform || process.platform, deps);
  if (!command) return null;
  const childEnv = cliEnvironment(env, variant);
  const paths = (deps.platform || process.platform) === 'win32' ? path.win32 : path.posix;
  // Relative/empty PATH entries would search the child's temporary directory.
  // Keep the discovered CLI directory if none remain; an empty PATH also searches cwd.
  const absolutePath = (childEnv.PATH || '').split(paths.delimiter).filter(paths.isAbsolute);
  childEnv.PATH = absolutePath.length ? absolutePath.join(paths.delimiter) : paths.dirname(command);
  // Preserve the parent's config lookup when the child runs in the temp dir.
  if (childEnv.BAILIAN_CONFIG_DIR && !paths.isAbsolute(childEnv.BAILIAN_CONFIG_DIR)) {
    childEnv.BAILIAN_CONFIG_DIR = paths.resolve(childEnv.BAILIAN_CONFIG_DIR);
  }
  // npm's env-node entry also needs its adjacent interpreter after fallback discovery.
  const commandDir = paths.dirname(command);
  if ((deps.platform || process.platform) !== 'win32'
    && !(childEnv.PATH || '').split(':').includes(commandDir)
    && existingExecutable(paths.join(commandDir, 'node'), deps)) {
    childEnv.PATH = childEnv.PATH ? `${childEnv.PATH}:${commandDir}` : commandDir;
  }
  let executable = command;
  let prefix = [];
  if ((deps.platform || process.platform) === 'win32' && command.endsWith('.mjs')) {
    const npmDir = path.win32.resolve(path.win32.dirname(command), '..', '..', '..');
    const dirs = [npmDir, ...(env.PATH || env.Path || '').split(';').filter(Boolean)];
    executable = dirs.filter(path.win32.isAbsolute).map(dir => path.win32.join(dir, 'node.exe'))
      .find(file => existingExecutable(file, deps));
    if (!executable) return null;
    prefix = [command];
  }
  const deadline = Date.now() + CLI_TIMEOUT_MS;
  const run = args => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Bailian CLI quota deadline exceeded');
    return runBailian(executable, [...prefix, ...args], childEnv, remaining, deps);
  };
  if (variant.personal) {
    return { usageText: await run(['console', 'call', '--api',
      'zeldaHttp.apikeyMgr./tokenplan/personal/api/v2/usage', '--data', '{}',
      '--console-region', variant.regionId, '--console-site',
      variant.id === 'cn-personal' ? 'domestic' : 'international', '--output', 'json']) };
  }

  const now = (deps.now || Date.now)();
  const seats = new Set();
  const ends = new Set();
  let expectedTotal;
  let activeSeats = 0;
  let total = 0;
  let remaining = 0;
  for (let pageNo = 1; pageNo <= MAX_SEATS / PAGE_SIZE; pageNo++) {
    const page = JSON.parse(await run(['token-plan', 'list-seats', '--page-no', String(pageNo),
      '--page-size', String(PAGE_SIZE), '--output', 'json']));
    const data = page?.Data;
    if (page?.Success !== true || !data || !Array.isArray(data.Items)
      || !Number.isInteger(data.Total) || data.Total < 0 || data.Total > MAX_SEATS
      || data.PageNo !== pageNo || data.PageSize !== PAGE_SIZE || data.Items.length > PAGE_SIZE
      || (expectedTotal !== undefined && data.Total !== expectedTotal)) throw invalidOutput();
    expectedTotal = data.Total;
    for (const seat of data.Items) {
      if (!seat || typeof seat.SeatId !== 'string' || !seat.SeatId || seats.has(seat.SeatId)
        || typeof seat.Status !== 'string') throw invalidOutput();
      seats.add(seat.SeatId);
      if (seat.Status !== 'NORMAL') continue;
      if (![seat.StartTime, seat.EndTime].every(Number.isFinite)
        || seat.StartTime <= 0 || seat.EndTime <= seat.StartTime) throw invalidOutput();
      if (now < seat.StartTime || now >= seat.EndTime) continue;
      activeSeats++;
      if (!Array.isArray(seat.EquityList)) throw invalidOutput();
      const credits = seat.EquityList.filter(equity => equity?.EquityType === 'CREDITS');
      if (credits.length !== 1) throw invalidOutput();
      const equity = credits[0];
      const { CycleStartTime: start, CycleEndTime: end, CycleTotalValue: limit, CycleSurplusValue: left } = equity;
      if (![start, end, limit, left].every(Number.isFinite) || start <= 0 || start > now || end <= now
        || !Number.isFinite(new Date(end).getTime()) || limit < 0 || left < 0 || left > limit) throw invalidOutput();
      total += limit;
      remaining += left;
      ends.add(end);
    }
    if (seats.size > expectedTotal) throw invalidOutput();
    if (seats.size === expectedTotal) {
      // A complete seat list can legitimately contain no current subscription.
      if (activeSeats === 0) return { summary: { uid: '', planName: 'Token Plan',
        used: null, total: null, remaining: null, resetsAt: null } };
      if (!Number.isFinite(total) || total <= 0 || !Number.isFinite(remaining)) throw invalidOutput();
      return { summary: { uid: '', planName: 'Token Plan', used: total - remaining,
        total, remaining, resetsAt: ends.size === 1 ? new Date([...ends][0]).toISOString() : null } };
    }
    if (data.Items.length !== PAGE_SIZE) throw invalidOutput();
  }
  throw invalidOutput();
}

module.exports = { existingBailianCli, cliEnvironment, fetchBailianCLI, validatePersonalCLIUsage };
