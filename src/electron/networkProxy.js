'use strict';

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
 * One effective rule (`effectiveAppProxy`) feeds both network stacks: the
 * Node-side transport reads it as the env shape outboundFetch.js already
 * understands, and the default Chromium session gets the same proxy and bypass
 * list rendered in Chromium's rule syntax, so `net.fetch`/`net.request`
 * callers and MiMo's `resolveProxy` route exactly like undici does.
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
// The loopback hosts a local Hub or self-hosted endpoint is reached by. undici
// matches NO_PROXY by host name and suffix only (no CIDR), so this is the whole
// loopback set the Node side can express: `localhost` also covers
// `*.localhost`, and IPv6 must be bracketed to match undici's host form.
// Chromium is told to drop its own wider implicit set (`<-loopback>`, e.g.
// 127.0.0.2) and use this one, so both stacks bypass the same hosts.
const LOOPBACK_BYPASS = ['localhost', '127.0.0.1', '[::1]'];
// RFC 6761 guarantees `.invalid` never resolves. An unusable proxy setting is
// routed here so both stacks refuse the request instead of going direct.
const BLOCKING_PROXY_URL = 'http://proxy.invalid:1';
const MAX_NO_PROXY_LENGTH = 2000;

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

// A bare IPv6 literal (`::1`) would be read by undici as host `:` port `1`.
function bracketIpv6(entry) {
  return !entry.startsWith('[') && (entry.match(/:/g) || []).length > 1 ? `[${entry}]` : entry;
}

// undici honors `*` only as the entire value, so a list containing it is
// collapsed to it; otherwise the wildcard would silently stop bypassing.
function noProxyEntries(value) {
  const seen = new Set();
  const entries = [];
  for (const part of String(value || '').split(/[\s,;]+/)) {
    const entry = bracketIpv6(part.trim());
    if (!entry || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    entries.push(entry);
  }
  return entries.includes('*') ? ['*'] : entries;
}

function normalizeNoProxy(value) {
  return noProxyEntries(value).join(',').slice(0, MAX_NO_PROXY_LENGTH);
}

/**
 * The single effective app proxy, or `null` when the setting is empty and the
 * env/OS route applies unchanged. The bypass list merges the setting with the
 * env NO_PROXY and the loopback hosts; an unusable setting resolves to the
 * blocking proxy rather than to a direct connection.
 */
function effectiveAppProxy(settings = {}, env = process.env) {
  const raw = cleanProxyUrl(settings.proxyUrl);
  if (!raw) return null;
  const { url, error } = parseProxyUrl(raw);
  return {
    url: error ? BLOCKING_PROXY_URL : url,
    invalid: Boolean(error),
    bypass: noProxyEntries([
      ...LOOPBACK_BYPASS,
      settings.noProxy,
      resolveProxyConfig(env).noProxy
    ].join(','))
  };
}

/**
 * Where the widget's provider traffic is routed from, for the settings form.
 * `invalid` is a hand-edited settings.json value the form would have refused;
 * requests are blocked while it stays.
 */
function networkProxySource(settings = {}, env = process.env) {
  const proxy = effectiveAppProxy(settings, env);
  if (proxy) return proxy.invalid ? 'invalid' : 'setting';
  const fromEnv = resolveProxyConfig(env);
  return fromEnv.httpProxy || fromEnv.httpsProxy ? 'environment' : 'system';
}

/**
 * The env the Node-side transport should read. Without a proxy setting this is
 * the process env untouched; with one, every proxy variable is replaced so a
 * stale shell value cannot win over the setting.
 */
function proxyEnvForSettings(settings = {}, env = process.env) {
  const proxy = effectiveAppProxy(settings, env);
  if (!proxy) return env;
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) delete next[key];
  next.http_proxy = proxy.url;
  next.https_proxy = proxy.url;
  next.no_proxy = proxy.bypass.join(',');
  return next;
}

// undici matches an entry against the host and every subdomain, ignoring a
// leading `.` or `*.`; Chromium matches `host` exactly and `*.host` as
// subdomains only, so a name needs both. An optional `:port` carries over.
function chromiumBypassRules(entries) {
  if (entries.includes('*')) return '*';
  const rules = ['<-loopback>'];
  for (const entry of entries) {
    const parsed = entry.match(/^(.+):(\d+)$/);
    const host = (parsed ? parsed[1] : entry).replace(/^\*?\./, '');
    const port = parsed ? `:${parsed[2]}` : '';
    rules.push(`${host}${port}`);
    if (!host.startsWith('[') && !/^\d{1,3}(?:\.\d{1,3}){3}(?:\/\d+)?$/.test(host)) rules.push(`*.${host}${port}`);
  }
  return rules.join(',');
}

/**
 * The Chromium session config for the effective app proxy, or `null` when the
 * session should follow the OS. `{ mode: 'system' }` is what restores
 * Electron's own default once a configured proxy is cleared.
 */
function sessionProxyConfig(settings = {}, env = process.env) {
  const proxy = effectiveAppProxy(settings, env);
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
  return { apply };
}

module.exports = {
  createSessionProxyApplier,
  effectiveAppProxy,
  networkProxySource,
  normalizeNoProxy,
  normalizeProxyUrl,
  proxyEnvForSettings,
  proxyUrlError,
  sessionProxyConfig
};
