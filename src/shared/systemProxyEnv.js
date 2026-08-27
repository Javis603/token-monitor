'use strict';

const { spawn } = require('node:child_process');
const { resolveProxyConfig } = require('./outboundFetch');

// macOS system proxy (as read via `scutil --proxy`) for child processes that
// only honor proxy environment variables. The widget's own outbound fetch
// already follows the OS proxy through Electron's net stack (limitsFetch.js),
// but CLIs it spawns — Grok's `agent stdio` RPC among them — are plain Node
// programs that never see that transport. Without this, a GUI-launched app on
// a proxied network spawns children that cannot reach the network at all, so
// the Grok CLI can neither answer the billing RPC nor refresh its OAuth token
// in ~/.grok/auth.json, and the limit card degrades to `unavailable` /
// `unauthorized` a token lifetime after the last shell-side `grok` use.
//
// Explicit env proxy variables always win untouched; the system proxy is only
// a fallback, matching createOutboundFetch's env precedence. The resolved
// values are injected as standard HTTPS_PROXY/HTTP_PROXY/ALL_PROXY variables
// (uppercase first, lowercase too — CLIs differ in which casing they read).

const SCUTIL_PROXY_TIMEOUT_MS = 2500;

function hasAnyKey(env, names) {
  return names.some((name) => envValue(env, name));
}

function envValue(env = {}, name) {
  if (Object.prototype.hasOwnProperty.call(env, name)) return env[name];
  const key = Object.keys(env).find((candidate) => candidate.toLowerCase() === name.toLowerCase());
  return key ? env[key] : undefined;
}

// `scutil --proxy` prints `key : value` lines; booleans are 0/1 and proxies
// print as `Proxy : host:port`. Returns '' when disabled/absent.
function parseScutilProxy(output = '') {
  const fields = {};
  for (const line of String(output).split('\n')) {
    const match = line.match(/^\s*([A-Za-z]+)\s*:\s*(.+?)\s*$/);
    if (match) fields[match[1]] = match[2];
  }
  const httpEnabled = fields.HTTPEnable === '1';
  const httpsEnabled = fields.HTTPSEnable === '1';
  const socksEnabled = fields.SOCKSEnable === '1';
  const proxyUrl = (host, port, scheme) => (host && port ? `${scheme}://${host}:${port}` : '');
  if (httpsEnabled) {
    const url = proxyUrl(fields.HTTPSProxy, fields.HTTPSPort, 'http');
    if (url) return url;
  }
  if (httpEnabled) {
    const url = proxyUrl(fields.HTTPProxy, fields.HTTPPort, 'http');
    if (url) return url;
  }
  if (socksEnabled) {
    const url = proxyUrl(fields.SOCKSProxy, fields.SOCKSPort, 'socks5');
    if (url) return url;
  }
  return '';
}

function readMacSystemProxyOnce(deps = {}) {
  const spawnFn = deps.spawn || spawn;
  const platform = deps.platform || process.platform;
  if (platform !== 'darwin') return '';
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnFn('scutil', ['--proxy'], { windowsHide: true });
    } catch (_) {
      resolve('');
      return;
    }
    const timer = setTimeout(() => {
      try { child.kill(); } catch (_) {}
      resolve('');
    }, Number(deps.timeoutMs || SCUTIL_PROXY_TIMEOUT_MS));
    let output = '';
    const finish = (value) => {
      clearTimeout(timer);
      resolve(value);
    };
    child.stdout?.on?.('data', (chunk) => { output += chunk.toString('utf8'); });
    // A spawn double shared with the CLI under test can emit stdin errors;
    // scutil never reads stdin, but an unhandled 'error' on it would crash
    // the caller. Same for a missing stdout.
    child.stdin?.on?.('error', () => {});
    child.on?.('error', () => finish(''));
    child.on?.('close', () => finish(parseScutilProxy(output)));
  });
}

// Cache for the process lifetime. System proxy changes are rare; a GUI app
// restarts often enough for the common case (ClashX on/off) and a stale proxy
// degrades exactly to today's no-proxy behavior rather than something worse.
// The cache is primed in the background (primeMacSystemProxy) so callers on
// the probe path never wait on scutil: the first RPC attempt may run without
// injection, the next one picks up the cached value.
let macSystemProxyCache = null;
let macSystemProxyPending = null;

async function readMacSystemProxy(deps = {}) {
  if (typeof deps.forceRefresh === 'boolean') {
    macSystemProxyCache = null;
  }
  if (macSystemProxyCache !== null) return macSystemProxyCache;
  const value = await readMacSystemProxyOnce(deps);
  if (deps.platform === undefined && (deps.spawn === undefined)) {
    macSystemProxyCache = value;
  }
  return value;
}

// Fire-and-forget refresh used at collector startup: resolves the cache
// without blocking any caller. Repeated calls coalesce into one scutil run.
function primeMacSystemProxy(deps = {}) {
  if (macSystemProxyCache !== null || macSystemProxyPending) return macSystemProxyPending || Promise.resolve(macSystemProxyCache || '');
  macSystemProxyPending = readMacSystemProxy(deps)
    .then((value) => {
      macSystemProxyCache = value;
      return value;
    })
    .finally(() => {
      macSystemProxyPending = null;
    });
  return macSystemProxyPending;
}

// Returns env with proxy variables injected when the OS-level proxy is the
// only source available. Never overrides an existing proxy var; copies
// NO_PROXY through untouched so per-host exclusions keep working. Synchronous
// on purpose — it reads only the primed cache, so a probe never pays scutil
// latency, and the very first probes simply run unproxied as they do today.
function withSystemProxyEnv(env = process.env, deps = {}) {
  const source = { ...(env || {}) };
  const existing = resolveProxyConfig(source);
  if (existing.httpProxy || existing.httpsProxy) return source;
  const systemProxy = typeof deps.cachedSystemProxy === 'string'
    ? deps.cachedSystemProxy
    : macSystemProxyCache;
  if (!systemProxy) return source;
  const noProxy = existing.noProxy;
  const merged = { ...source };
  // Both casings must be set: the check below is case-insensitive, so writing
  // HTTPS_PROXY first would make https_proxy look pre-existing and skip it,
  // and CLIs differ in which casing they read.
  const proxyNames = ['HTTPS_PROXY', 'https_proxy', 'HTTP_PROXY', 'http_proxy', 'ALL_PROXY', 'all_proxy'];
  const hasProxyName = proxyNames.some((name) => hasAnyKey(merged, [name]));
  if (!hasProxyName) {
    for (const name of proxyNames) merged[name] = systemProxy;
  }
  if (noProxy && !hasAnyKey(merged, ['NO_PROXY', 'no_proxy'])) merged.NO_PROXY = noProxy;
  return merged;
}

function resetSystemProxyCacheForTests() {
  macSystemProxyCache = null;
}

module.exports = {
  parseScutilProxy,
  readMacSystemProxy,
  primeMacSystemProxy,
  withSystemProxyEnv,
  resetSystemProxyCacheForTests
};
