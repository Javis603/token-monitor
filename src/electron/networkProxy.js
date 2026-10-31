'use strict';

const { BlockList, isIP } = require('node:net');
const { Agent, Dispatcher, EnvHttpProxyAgent } = require('undici');
const { cleanProxyUrl, resolveProxyConfig } = require('../shared/outboundFetch');

/**
 * App-scoped proxy for the widget's outbound provider traffic (#988).
 *
 * A Dock/Start Menu launch never inherits a shell's proxy env, and the OS
 * proxy is machine-wide, so neither lets a user route only Token Monitor
 * through a local proxy. The precedence follows the usual desktop-app shape
 * (VS Code's `http.proxy`): the setting wins, then the standard env vars, then
 * the OS proxy Chromium already follows. An empty setting is today's behavior.
 *
 * The setting is a complete override, not a layer over the env: while it is
 * set, the env proxy variables, NO_PROXY included, are ignored, and only the
 * bypass entries saved with it plus the platform's local-host rules apply. One
 * effective rule (`effectiveAppProxy`) feeds both network stacks: the Node-side
 * transport gets it through `AppProxyAgent`, and the default Chromium session
 * gets the same proxy and bypass list in Chromium's rule syntax, so
 * `net.fetch`/`net.request` callers and MiMo's `resolveProxy` route exactly
 * like undici does.
 *
 * Local hosts stay direct the way Chromium keeps them direct (its implicit
 * bypass rules, which exist because proxying a secure `localhost` origin hands
 * the proxy extra power). Chromium applies them natively; `AppProxyAgent`
 * applies the same classification on every dispatch, redirect hops included.
 * Classification is by literal host only: no DNS lookup, and private ranges
 * beyond loopback and link-local are not included.
 *
 * Credentials embedded in the URL are refused: Chromium's proxy rules cannot
 * carry them, and the value is a plain renderer-visible setting rather than a
 * credential-store entry. An authenticating proxy keeps using the env vars.
 */

const PROXY_ENV_KEYS = [
  'http_proxy', 'HTTP_PROXY',
  'https_proxy', 'HTTPS_PROXY',
  'all_proxy', 'ALL_PROXY',
  'no_proxy', 'NO_PROXY'
];
// RFC 6761 guarantees `.invalid` never resolves. An unusable proxy setting is
// routed here so both stacks refuse the request instead of going direct.
const BLOCKING_PROXY_URL = 'http://proxy.invalid:1';
const MAX_NO_PROXY_LENGTH = 2000;

// Chromium's implicit bypass rules (net/docs/proxy.md): loopback and
// link-local literals. BlockList also matches IPv4-mapped IPv6 against the
// IPv4 ranges, which is how Chromium treats `[::ffff:127.0.0.1]`.
const IMPLICIT_BYPASS_ADDRESSES = new BlockList();
IMPLICIT_BYPASS_ADDRESSES.addSubnet('127.0.0.0', 8, 'ipv4');
IMPLICIT_BYPASS_ADDRESSES.addSubnet('169.254.0.0', 16, 'ipv4');
IMPLICIT_BYPASS_ADDRESSES.addSubnet('::1', 128, 'ipv6');
IMPLICIT_BYPASS_ADDRESSES.addSubnet('fe80::', 10, 'ipv6');

/**
 * Whether Chromium would send a request for this URL host direct regardless of
 * the proxy rules: `localhost` and `*.localhost` (a trailing dot included),
 * loopback and link-local IP literals, and `loopback` on Windows.
 */
function isImplicitBypassHost(hostname, platform = process.platform) {
  let host = String(hostname || '').toLowerCase().replace(/\.$/, '');
  if (host.startsWith('[') && host.endsWith(']')) host = host.slice(1, -1);
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (platform === 'win32' && host === 'loopback') return true;
  const family = isIP(host);
  return family !== 0 && IMPLICIT_BYPASS_ADDRESSES.check(host, family === 6 ? 'ipv6' : 'ipv4');
}

function isImplicitBypassOrigin(origin, platform) {
  try {
    return isImplicitBypassHost(new URL(String(origin)).hostname, platform);
  } catch (_) {
    return false;
  }
}

/**
 * undici dispatcher for the app proxy: local hosts go to a direct Agent, the
 * rest to an EnvHttpProxyAgent built from explicit values only. Every proxy
 * field is passed, `noProxy` even when empty, because EnvHttpProxyAgent reads
 * process.env for any field left undefined and a shell's NO_PROXY or
 * HTTP(S)_PROXY must not leak back into the override. undici's fetch
 * dispatches each redirect hop separately, so the choice is remade per hop.
 */
class AppProxyAgent extends Dispatcher {
  constructor({ httpProxy, httpsProxy, noProxy, platform = process.platform } = {}) {
    super();
    if (!httpProxy || !httpsProxy) throw new TypeError('AppProxyAgent needs explicit proxy URLs');
    this.platform = platform;
    this.proxied = new EnvHttpProxyAgent({ httpProxy, httpsProxy, noProxy: String(noProxy ?? '') });
    this.direct = new Agent();
  }

  dispatch(options, handler) {
    const agent = isImplicitBypassOrigin(options.origin, this.platform) ? this.direct : this.proxied;
    return agent.dispatch(options, handler);
  }

  close(callback) {
    return settleBoth([this.proxied.close(), this.direct.close()], callback);
  }

  destroy(error, callback) {
    if (typeof error === 'function') {
      callback = error;
      error = null;
    }
    return settleBoth([this.proxied.destroy(error), this.direct.destroy(error)], callback);
  }
}

function settleBoth(promises, callback) {
  const settled = Promise.all(promises).then(() => {});
  if (typeof callback !== 'function') return settled;
  settled.then(() => callback(null), callback);
  return undefined;
}

// The bypass entries both stacks read the same way: `*`, or a host name or
// domain (an optional leading `.`/`*.` is the same as none: the domain and its
// subdomains), an IPv4 literal, or an IPv6 literal, each with an optional
// `:port`. CIDR ranges, schemes, `<local>`/`<-loopback>` and inner wildcards
// only mean something to Chromium, so they are refused rather than left to
// diverge between the stacks.
const HOST_NAME = /^[a-z0-9_-]+(?:\.[a-z0-9_-]+)*$/;

// The bracketed form a URL hostname takes, which is what undici compares
// against and what Chromium normalizes to (`[2001:0db8::0:1]` →
// `[2001:db8::1]`, `[::ffff:10.0.0.1]` → `[::ffff:a00:1]`). A zone ID passes
// isIP but cannot appear in a URL, so it can never match and is refused.
function canonicalIpv6(address) {
  if (isIP(address) !== 6) return '';
  try {
    return new URL(`http://[${address}]/`).hostname;
  } catch (_) {
    return '';
  }
}

function urlHostIsIp(name) {
  try {
    return isIP(new URL(`http://${name}/`).hostname) !== 0;
  } catch (_) {
    return true;
  }
}

function parseNoProxyEntry(raw) {
  const value = String(raw || '').trim().toLowerCase();
  if (!value) return null;
  if (value === '*') return { host: '*', port: '', ip: false };
  if (isIP(value) === 6) {
    const host = canonicalIpv6(value);
    return host ? { host, port: '', ip: true } : { error: true };
  }
  let rest = value;
  let port = '';
  const bracketed = /^\[([^\]]+)\](?::(\d+))?$/.exec(rest);
  if (bracketed) {
    rest = canonicalIpv6(bracketed[1]);
    if (!rest) return { error: true };
    port = bracketed[2] || '';
  } else {
    const withPort = /^(.+):(\d+)$/.exec(rest);
    if (withPort) {
      rest = withPort[1];
      port = withPort[2];
    }
    rest = rest.replace(/^\*?\./, '');
    const ipv4 = isIP(rest) === 4;
    // A name the URL parser turns into an IP (`10.0.0`, `0xc0000201`,
    // `0xC0.0.2.1`) would match by name in undici but by address in Chromium.
    if (!ipv4 && (!HOST_NAME.test(rest) || urlHostIsIp(rest))) return { error: true };
  }
  if (port && (Number(port) < 1 || Number(port) > 65535)) return { error: true };
  return { host: rest, port, ip: rest.startsWith('[') || isIP(rest) === 4 };
}

function parsedNoProxyEntries(value) {
  const seen = new Set();
  const entries = [];
  let invalid = false;
  for (const part of String(value || '').split(/[\s,;]+/)) {
    const entry = parseNoProxyEntry(part);
    if (!entry) continue;
    if (entry.error) {
      invalid = true;
      continue;
    }
    const key = `${entry.host}${entry.port ? `:${entry.port}` : ''}`;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push({ ...entry, key });
  }
  // undici honors `*` only as the entire value.
  return { entries: entries.some((entry) => entry.host === '*') ? [{ host: '*', port: '', ip: false, key: '*' }] : entries, invalid };
}

function noProxyError(value) {
  const parsed = parsedNoProxyEntries(value);
  if (parsed.invalid) return 'proxy_bypass_unsupported';
  return parsed.entries.map((entry) => entry.key).join(',').length > MAX_NO_PROXY_LENGTH
    ? 'proxy_bypass_too_long' : '';
}

/** The supported entries in their canonical form; anything else is dropped. */
function normalizeNoProxy(value) {
  const normalized = parsedNoProxyEntries(value).entries.map((entry) => entry.key).join(',');
  // Cutting a hostname can turn an unrelated suffix into a direct-route rule.
  if (normalized.length > MAX_NO_PROXY_LENGTH) throw new Error('proxy_bypass_too_long');
  return normalized;
}

function parseProxyUrl(value) {
  const raw = cleanProxyUrl(value);
  if (!raw) return { url: '', error: '' };
  // `127.0.0.1:7897` and `localhost:7897` are what people paste from a proxy
  // client; the second would otherwise parse as a `localhost:` scheme.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `http://${raw}`;
  let parsed;
  try {
    parsed = new URL(withScheme);
  } catch (_) {
    return { url: '', error: 'proxy_invalid_url' };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return { url: '', error: 'proxy_unsupported_scheme' };
  }
  if (parsed.username || parsed.password) return { url: '', error: 'proxy_credentials_unsupported' };
  if (!parsed.hostname || (parsed.pathname && parsed.pathname !== '/') || parsed.search || parsed.hash) {
    return { url: '', error: 'proxy_invalid_url' };
  }
  return { url: `${parsed.protocol}//${parsed.host}`, error: '' };
}

function proxyUrlError(value) {
  return parseProxyUrl(value).error;
}

function normalizeProxyUrl(value) {
  const { url, error } = parseProxyUrl(value);
  return error ? '' : url;
}

/**
 * The single effective app proxy, or `null` when the setting is empty and the
 * env/OS route applies unchanged. The bypass list is the setting's own
 * supported entries; a hand-edited unsupported entry is ignored by both stacks,
 * which errs toward the proxy. An unusable proxy URL resolves to the blocking
 * proxy rather than to a direct connection.
 */
function effectiveAppProxy(settings = {}) {
  const raw = cleanProxyUrl(settings.proxyUrl);
  if (!raw) return null;
  const { url, error } = parseProxyUrl(raw);
  return {
    url: error ? BLOCKING_PROXY_URL : url,
    invalid: Boolean(error),
    bypass: parsedNoProxyEntries(settings.noProxy).entries
  };
}

/**
 * Where the widget's provider traffic is routed from, for the settings form.
 * `invalid` is a hand-edited settings.json value the form would have refused;
 * requests are blocked while it stays.
 */
function networkProxySource(settings = {}, env = process.env) {
  const proxy = effectiveAppProxy(settings);
  if (proxy) return proxy.invalid ? 'invalid' : 'setting';
  const fromEnv = resolveProxyConfig(env);
  return fromEnv.httpProxy || fromEnv.httpsProxy ? 'environment' : 'system';
}

/**
 * What the Node-side transport should use: without a proxy setting the process
 * env untouched and no extra deps, which keeps the env-only behavior exactly;
 * with one, an env carrying only the setting (every inherited proxy variable
 * removed, `no_proxy` set even when empty) and the dispatcher that adds the
 * local-host rules.
 */
function outboundRouteForSettings(settings = {}, env = process.env) {
  const proxy = effectiveAppProxy(settings);
  if (!proxy) return { env, deps: {} };
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) delete next[key];
  next.http_proxy = proxy.url;
  next.https_proxy = proxy.url;
  next.no_proxy = proxy.bypass.map((entry) => entry.key).join(',');
  return { env: next, deps: { EnvHttpProxyAgent: AppProxyAgent } };
}

// undici matches a name against the host and every subdomain; Chromium matches
// `host` exactly and `*.host` as subdomains only, so a name needs both. An
// optional `:port` carries over. Chromium's implicit local-host rules are left
// in place (no `<-loopback>`).
function chromiumBypassRules(entries) {
  if (entries.some((entry) => entry.host === '*')) return '*';
  const rules = [];
  for (const entry of entries) {
    const port = entry.port ? `:${entry.port}` : '';
    rules.push(`${entry.host}${port}`);
    if (!entry.ip) rules.push(`*.${entry.host}${port}`);
  }
  return rules.join(',');
}

/**
 * The Chromium session config for the effective app proxy, or `null` when the
 * session should follow the OS. `{ mode: 'system' }` is what restores
 * Electron's own default once a configured proxy is cleared.
 */
function sessionProxyConfig(settings = {}) {
  const proxy = effectiveAppProxy(settings);
  if (!proxy) return null;
  return {
    mode: 'fixed_servers',
    proxyRules: proxy.url,
    proxyBypassRules: chromiumBypassRules(proxy.bypass)
  };
}

/**
 * Applies `getConfig()` to the session, one call at a time so a slower earlier
 * apply cannot land after a later one. Each step only counts once it
 * succeeds, so a failed `setProxy` or `closeAllConnections` is retried by the
 * next `apply()` even when the settings did not change. Resolves `true` when it
 * changed the session's route or closed the sockets left from the old one.
 */
function createSessionProxyApplier({ getSession, getConfig, log = () => {} }) {
  let appliedKey = '';
  // Set once a route is applied and cleared only when the pooled sockets opened
  // over the previous route are closed, so a failed close is retried too.
  let closePending = false;
  let queue = Promise.resolve();
  function apply() {
    const run = queue.then(async () => {
      const config = getConfig();
      const key = config ? JSON.stringify(config) : '';
      let changed = false;
      if (key !== appliedKey) {
        try {
          await getSession().setProxy(config || { mode: 'system' });
        } catch (error) {
          log(`[proxy] applying the session proxy failed: ${error.message}`);
          return false;
        }
        appliedKey = key;
        closePending = true;
        changed = true;
      }
      if (!closePending) return changed;
      try {
        await getSession().closeAllConnections();
        closePending = false;
        return true;
      } catch (error) {
        log(`[proxy] closing pooled connections failed: ${error.message}`);
        return changed;
      }
    });
    queue = run;
    return run;
  }
  async function ensureReady() {
    await apply();
    const config = getConfig();
    const key = config ? JSON.stringify(config) : '';
    // `apply()` reports whether anything changed, not whether the desired route
    // is ready. A failed apply/cleanup or a newer setting must block requests.
    if (key !== appliedKey || closePending) throw new Error('proxy_session_not_ready');
  }
  return { apply, ensureReady };
}

// Gate only protected Chromium transports. Local collection and Node routes
// can start independently; a failed session apply stays retryable on the next
// request/save. Aborting the wait must not send a request when it later clears.
function createProxyReadyFetch(fetchImpl, ensureReady) {
  return async function proxyReadyFetch(input, init = {}) {
    const signal = init.signal;
    signal?.throwIfAborted();
    let abort;
    try {
      const ready = ensureReady();
      if (signal) {
        await Promise.race([ready, new Promise((resolve, reject) => {
          abort = () => reject(signal.reason);
          signal.addEventListener('abort', abort, { once: true });
          if (signal.aborted) abort();
        })]);
      } else {
        await ready;
      }
      signal?.throwIfAborted();
      return fetchImpl(input, init);
    } finally {
      if (abort) signal.removeEventListener('abort', abort);
    }
  };
}

module.exports = {
  AppProxyAgent,
  createProxyReadyFetch,
  createSessionProxyApplier,
  effectiveAppProxy,
  isImplicitBypassHost,
  networkProxySource,
  noProxyError,
  normalizeNoProxy,
  normalizeProxyUrl,
  outboundRouteForSettings,
  proxyUrlError,
  sessionProxyConfig
};
