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
 * The setting is expressed as the same env shape outboundFetch.js already
 * understands, so it inherits that module's NO_PROXY handling and fails closed
 * exactly like a configured env proxy does. The same rule is applied to the
 * Chromium session so `net.fetch`/`net.request` callers and login windows agree
 * with the Node-side transport.
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
// Chromium bypasses loopback implicitly; undici does not, so the Node side has
// to say so for a local hub or a self-hosted provider endpoint.
const LOOPBACK_BYPASS = ['localhost', '127.0.0.1', '::1'];
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

function noProxyEntries(value) {
  const seen = new Set();
  const entries = [];
  for (const part of String(value || '').split(/[\s,;]+/)) {
    const entry = part.trim();
    if (!entry || seen.has(entry.toLowerCase())) continue;
    seen.add(entry.toLowerCase());
    entries.push(entry);
  }
  return entries;
}

function normalizeNoProxy(value) {
  return noProxyEntries(value).join(',').slice(0, MAX_NO_PROXY_LENGTH);
}

/**
 * Where the widget's provider traffic is routed from, for the settings form.
 * `invalid` is a hand-edited settings.json value the form would have refused.
 */
function networkProxySource(settings = {}, env = process.env) {
  if (cleanProxyUrl(settings.proxyUrl)) return proxyUrlError(settings.proxyUrl) ? 'invalid' : 'setting';
  const fromEnv = resolveProxyConfig(env);
  return fromEnv.httpProxy || fromEnv.httpsProxy ? 'environment' : 'system';
}

/**
 * The env the Node-side transport should read. Without a proxy setting this is
 * the process env untouched; with one, every proxy variable is replaced so a
 * stale shell value cannot win over the setting. An invalid setting is passed
 * through verbatim so the transport fails closed instead of going direct.
 */
function proxyEnvForSettings(settings = {}, env = process.env) {
  const raw = cleanProxyUrl(settings.proxyUrl);
  if (!raw) return env;
  const { url, error } = parseProxyUrl(raw);
  const next = { ...env };
  for (const key of PROXY_ENV_KEYS) delete next[key];
  const proxy = error ? raw : url;
  next.http_proxy = proxy;
  next.https_proxy = proxy;
  next.no_proxy = noProxyEntries([
    ...LOOPBACK_BYPASS,
    normalizeNoProxy(settings.noProxy),
    resolveProxyConfig(env).noProxy
  ].join(',')).join(',');
  return next;
}

/**
 * The Chromium session config for the setting, or `null` when the session
 * should follow the OS. `{ mode: 'system' }` is what restores Electron's own
 * default once a configured proxy is cleared.
 */
function sessionProxyConfig(settings = {}) {
  const url = normalizeProxyUrl(settings.proxyUrl);
  if (!url) return null;
  return {
    mode: 'fixed_servers',
    proxyRules: url,
    proxyBypassRules: normalizeNoProxy(settings.noProxy)
  };
}

module.exports = {
  networkProxySource,
  normalizeNoProxy,
  normalizeProxyUrl,
  proxyEnvForSettings,
  proxyUrlError,
  sessionProxyConfig
};
