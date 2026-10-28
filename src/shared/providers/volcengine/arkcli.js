'use strict';

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const { normalizeLimitProvider } = require('../../limits/core');
const {
  envValue,
  pathApiForPlatform,
  pathDelimiterForPlatform,
  uniqueStrings
} = require('../../limits/providerHelpers');
const { hashKey } = require('../../hashKey');
const { abortError } = require('../../probeDeadline');
const { createSubprocessTermination } = require('../../subprocessTermination');

const WINDOWS = {
  '5h': ['session', '5-hour', 300],
  daily: ['daily', 'Daily', 1440],
  weekly: ['weekly', 'Weekly', 10080],
  monthly: ['billing', 'Monthly', 43200]
};

const PERSONAL_PLANS = {
  'agent-plan': 'Agent Plan',
  'coding-plan': 'Coding Plan'
};

function probeError(status = 'unavailable') {
  return Object.assign(new Error('arkcli quota probe failed'), { status });
}

// npm's launcher uses execFileSync and does not forward cancellation. Prefer
// its installed native executable, also avoiding .cmd shell shims on Windows.
function resolveArkcliCommand(env, platform = process.platform, arch = process.arch) {
  const command = env.TOKEN_MONITOR_ARKCLI_COMMAND || 'arkcli';
  const pathApi = pathApiForPlatform(platform);
  const suffixes = platform === 'win32' ? ['', '.exe', '.cmd'] : [''];
  const paths = command.includes('/') || command.includes('\\')
    ? [command]
    : uniqueStrings([
      ...String(envValue(env, 'PATH') || '')
        .split(pathDelimiterForPlatform(platform))
        .filter(Boolean),
      ...(platform === 'win32'
        ? [
          envValue(env, 'APPDATA') && pathApi.join(envValue(env, 'APPDATA'), 'npm'),
          envValue(env, 'LOCALAPPDATA') && pathApi.join(envValue(env, 'LOCALAPPDATA'), 'npm'),
          envValue(env, 'LOCALAPPDATA') && pathApi.join(envValue(env, 'LOCALAPPDATA'), 'pnpm'),
          envValue(env, 'USERPROFILE') && pathApi.join(envValue(env, 'USERPROFILE'), '.npm-global')
        ]
        : [
          '/opt/homebrew/bin',
          '/usr/local/bin',
          '/usr/bin',
          '/bin',
          env.HOME && path.join(env.HOME, '.npm-global', 'bin'),
          env.HOME && path.join(env.HOME, '.bun', 'bin'),
          env.HOME && path.join(env.HOME, '.local', 'bin')
        ])
    ]).flatMap((dir) => suffixes.map((suffix) => pathApi.join(dir, command + suffix)));
  const targetPlatform = { win32: 'windows', darwin: 'darwin', linux: 'linux' }[platform];
  const targetArch = { x64: 'amd64', arm64: 'arm64' }[arch];
  for (const candidate of paths) {
    try {
      const real = fs.realpathSync(candidate);
      const roots = [pathApi.resolve(pathApi.dirname(real), '..'),
        pathApi.join(pathApi.dirname(candidate), 'node_modules', '@volcengine', 'ark-cli')];
      for (const root of uniqueStrings(roots)) {
        if (pathApi.basename(root) !== 'ark-cli') continue;
        const binary = pathApi.join(root, 'bin', `arkcli-${targetPlatform}-${targetArch}${platform === 'win32' ? '.exe' : ''}`);
        if (fs.existsSync(binary)) return binary;
      }
      if (!/\.(cmd|bat)$/i.test(real)) return real;
    } catch { /* Try the next PATH entry. */ }
  }
  return command;
}

// Never log stdout/stderr: auth status may contain identity and credential data.
// Wait for close after cancellation, including escalation for a stuck child.
function runArkcli(args, deps = {}) {
  const env = deps.env || process.env;
  const signal = deps.signal;
  if (signal?.aborted) return Promise.reject(abortError(signal));
  return new Promise((resolve, reject) => {
    let output = '';
    let bytes = 0;
    let failure;
    let settled = false;
    let timer;
    let termination;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener('abort', onAbort);
      if (error) reject(error); else resolve(value);
    };
    const cancel = (error) => {
      failure ||= error;
      termination.request();
    };
    const onAbort = () => cancel(abortError(signal));
    let child;
    try {
      child = (deps.spawn || spawn)(resolveArkcliCommand(env), args, {
        shell: false,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
        env: { ...env, ARKCLI_NO_UPDATE_NOTIFIER: '1', ARKCLI_CALLER_TYPE: 'ai_agent',
          ARKCLI_CALLER_NAME: 'token-monitor', ARKCLI_SKILL_NAME: 'arkcli-usage' }
      });
    } catch (error) {
      finish(error.code === 'ENOENT' ? probeError('notConfigured') : probeError());
      return;
    }
    termination = createSubprocessTermination(child, {
      onUnconfirmed: () => finish(failure || probeError())
    });
    timer = setTimeout(() => cancel(probeError()), deps.arkcliTimeoutMs || 5000);
    signal?.addEventListener('abort', onAbort, { once: true });
    if (signal?.aborted) onAbort();
    child.on('error', (error) => {
      failure ||= error.code === 'ENOENT' ? probeError('notConfigured') : probeError();
    });
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1024 * 1024) return cancel(probeError());
      output += chunk.toString('utf8');
    });
    child.stdout.on('error', () => cancel(probeError()));
    child.on('close', (code) => {
      termination.confirmClosed();
      if (failure || code !== 0) return finish(failure || probeError());
      try { finish(null, JSON.parse(output)); } catch { finish(probeError()); }
    });
  });
}

function arkcliAccountKey(viewer, product) {
  return hashKey('volcengine', 'arkcli', viewer.account_id, viewer.user_id || '', viewer.region || '', product);
}

function parseArkcliPlan(body, updatedAt, product) {
  const viewer = body?.viewer;
  if (!viewer?.account_id || !Array.isArray(body?.items) || !Object.hasOwn(PERSONAL_PLANS, product)) throw probeError();
  const item = body.items.find((entry) => entry?.product === product);
  if (!item || item.error || typeof item.subscribed !== 'boolean') throw probeError();
  if (!item.subscribed) return null;
  if (!Array.isArray(item.periods)) throw probeError();
  const windows = [];
  for (const [label, [kind, title, windowMinutes]] of Object.entries(WINDOWS)) {
    const period = item.periods.find((entry) => entry?.label === label
      || (label === '5h' && entry?.label === 'session'));
    if (!period) continue;
    const reset = typeof period.reset_at === 'string' ? Date.parse(period.reset_at) : NaN;
    const window = { kind, label: title, windowMinutes,
      resetsAt: Number.isFinite(reset) ? new Date(reset).toISOString() : null, showMeter: true };
    const { total } = period;
    // Coding Plan and newer Agent Plan responses can contain only percentages.
    // Those describe subscription usage, not a known number of tokens/requests.
    if (total === undefined && period.used === undefined) {
      if (typeof period.percent !== 'number' || !Number.isFinite(period.percent) || period.percent < 0) throw probeError();
      const usedPercent = Math.min(100, period.percent);
      windows.push({ ...window, usedPercent, remainingPercent: 100 - usedPercent });
      continue;
    }
    // arkcli omits used after a window resets; only explicit 0% proves zero.
    const used = period.used === undefined && period.percent === 0 ? 0 : period.used;
    if (typeof total !== 'number' || !Number.isFinite(total) || total < 0) throw probeError();
    if (total === 0) continue;
    if (typeof used !== 'number' || !Number.isFinite(used) || used < 0) throw probeError();
    windows.push({ ...window, used, limit: total,
      remaining: Math.max(0, total - used), usedPercent: Math.min(100, used / total * 100) });
  }
  if (!windows.length) throw probeError();
  return normalizeLimitProvider({
    provider: 'volcengine', source: 'cli', status: 'ok', updatedAt,
    accountKey: arkcliAccountKey(viewer, product),
    accountLabel: PERSONAL_PLANS[product], planLabel: typeof item.tier === 'string' ? item.tier : '',
    region: viewer.region, windows
  });
}

// `usage plan --product` reports subscribed:true with all-zero periods for a
// plan the account never bought, so the subscription list is the only authority
// on which products exist. Failed discovery must never fall back to blind probes.
async function fetchPersonalPlanKeys(run, profile) {
  const args = ['plans', 'get', '--format', 'json'];
  if (profile) args.push('--profile', profile);
  const body = await run(args);
  if (!Array.isArray(body?.plans)) throw probeError();
  const subscribed = new Set();
  const unknown = new Set();
  for (const plan of body.plans) {
    if (!plan || typeof plan.key !== 'string') throw probeError();
    if (!Object.hasOwn(PERSONAL_PLANS, plan.key)) continue;
    if (plan.scope !== 'personal' || Object.hasOwn(plan, 'error') || typeof plan.status !== 'string' || !plan.status) unknown.add(plan.key);
    else if (['Effective', 'Running'].includes(plan.status)) subscribed.add(plan.key);
    else if (!['Pending', 'Expired'].includes(plan.status)) unknown.add(plan.key);
  }
  for (const product of unknown) subscribed.delete(product);
  return { subscribed, unknown };
}

async function fetchArkcliLimits(deps, updatedAt, previousLimits) {
  const run = deps.runArkcli || ((args) => runArkcli(args, deps));
  const status = (value) => normalizeLimitProvider({ provider: 'volcengine', source: 'cli',
    status: value, updatedAt, windows: [] });
  const previous = (previousLimits?.providers || []).filter(row => row.provider === 'volcengine');
  const previousCliKeys = new Set(previous.filter(row => row.source === 'cli' && row.accountKey).map(row => row.accountKey));
  let authenticated = false;
  try {
    const auth = await run(['auth', 'status', '--format', 'json']);
    if (typeof auth?.logged_in !== 'boolean') throw probeError();
    if (!auth.logged_in || !['sso', 'sts', 'aksk'].includes(auth.auth_method)) return [status('notConfigured')];
    authenticated = true;
    const profile = auth.active_profile?.name;
    const { subscribed, unknown } = await fetchPersonalPlanKeys(run, profile);
    const products = Object.keys(PERSONAL_PLANS).filter(product => subscribed.has(product));
    const absent = Object.keys(PERSONAL_PLANS).filter(product => !subscribed.has(product) && !unknown.has(product));
    const query = (product) => {
      const args = ['usage', 'plan', '--product', product, '--format', 'json'];
      if (profile) args.push('--profile', profile);
      return run(args);
    };
    const results = await Promise.allSettled(products.map(async (product) => {
      const body = await query(product);
      return { product, viewer: body?.viewer, row: parseArkcliPlan(body, updatedAt, product) };
    }));
    if (deps.signal?.aborted) throw abortError(deps.signal);
    const fulfilled = results.filter(result => result.status === 'fulfilled').map(result => result.value);
    const rows = fulfilled.filter(result => result.row).map(result => result.row);
    const failedProducts = new Set(unknown);
    results.forEach((result, index) => {
      if (result.status === 'rejected') failedProducts.add(products[index]);
    });
    let viewer = fulfilled[0]?.viewer;
    const removals = new Map();
    const remove = (viewer, product) => {
      const accountKey = arkcliAccountKey(viewer, product);
      if (previousCliKeys.has(accountKey)) removals.set(accountKey, { provider: 'volcengine', accountKey, removed: true });
    };
    for (const result of fulfilled) {
      if (!result.row) remove(result.viewer, result.product);
      for (const product of absent) remove(result.viewer, product);
    }
    // plans get has no viewer. If all owned queries failed or no plan remains,
    // one bounded probe can establish the current viewer for scoped removals.
    // Its quota is deliberately ignored: this product is confirmed absent.
    if (!fulfilled.length && absent.length && previousCliKeys.size) {
      const body = await query(absent[0]);
      if (!body?.viewer?.account_id || !Array.isArray(body.items)) throw probeError();
      viewer = body.viewer;
      for (const product of absent) remove(body.viewer, product);
    }
    if (deps.signal?.aborted) throw abortError(deps.signal);
    // Explicit per-product failures preserve both last-good retention and the
    // runtime's retry signal, without marking a successful sibling as failed.
    if (viewer) {
      for (const product of failedProducts) rows.push(normalizeLimitProvider({
        provider: 'volcengine', source: 'cli', status: 'unavailable', updatedAt,
        accountKey: arkcliAccountKey(viewer, product), accountLabel: PERSONAL_PLANS[product],
        region: viewer.region, windows: []
      }));
    }
    if (rows.length || removals.size) return [...rows, ...removals.values()];
    const failed = results.find((result) => result.status === 'rejected');
    if (failed) throw failed.reason;
    return [status(unknown.size || previous.some(row => row.accountKey) ? 'unavailable' : 'notConfigured')];
  } catch (error) {
    if (deps.signal?.aborted) throw abortError(deps.signal);
    return [status(!authenticated && error.status === 'notConfigured' ? 'notConfigured' : 'unavailable')];
  }
}

module.exports = { fetchArkcliLimits, parseArkcliPlan, runArkcli, resolveArkcliCommand };
