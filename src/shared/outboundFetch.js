'use strict';

/**
 * Outbound HTTP helpers that honor standard proxy env vars.
 *
 * Node's global `fetch` (undici) does not apply HTTP(S)_PROXY by default, so
 * requests to hosts only reachable via a local proxy (common for grok.com in
 * some networks) hang until timeout. This module builds a fetch function that:
 *   - uses undici EnvHttpProxyAgent when proxy env vars are set
 *   - honors NO_PROXY and lowercase-over-uppercase env precedence
 *   - falls back to globalThis.fetch only when no proxy is configured
 *
 * No app settings / hard-coded proxy addresses — env only (CLI/systemd/shell).
 */

const { EnvHttpProxyAgent, fetch: undiciFetch } = require('undici');

function cleanProxyUrl(value) {
  if (typeof value !== 'string') return '';
  let raw = value.trim();
  if (!raw) return '';
  if (
    (raw.startsWith('"') && raw.endsWith('"'))
    || (raw.startsWith("'") && raw.endsWith("'"))
  ) {
    raw = raw.slice(1, -1).trim();
  }
  return raw;
}

/**
 * Resolve standard proxy env configuration. Lowercase variables win over
 * uppercase variants, matching undici/curl behavior. ALL_PROXY remains a
 * final fallback because it is commonly used by CLI environments.
 */
function proxyEnvValue(env, lowercaseName, uppercaseName) {
  return cleanProxyUrl(env && env[lowercaseName])
    || cleanProxyUrl(env && env[uppercaseName]);
}

function resolveProxyConfig(env = process.env) {
  // Normalize explicitly so callers can inject an env object, add ALL_PROXY,
  // and strip shell-style quotes instead of making undici read process.env.
  const allProxy = proxyEnvValue(env, 'all_proxy', 'ALL_PROXY');
  const httpProxy = proxyEnvValue(env, 'http_proxy', 'HTTP_PROXY') || allProxy;
  const httpsProxy = proxyEnvValue(env, 'https_proxy', 'HTTPS_PROXY') || httpProxy;
  const noProxy = proxyEnvValue(env, 'no_proxy', 'NO_PROXY');
  return { httpProxy, httpsProxy, noProxy };
}

function resolveProxyUrl(env = process.env) {
  return resolveProxyConfig(env).httpsProxy;
}

function globalFetch() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error('global fetch is not available');
}

// Reuse one env-aware agent per proxy configuration so TLS sockets can be
// pooled across collector ticks.
const agentCache = new Map();

function getProxyAgent(proxyConfig, EnvHttpProxyAgentCtor) {
  const key = JSON.stringify(proxyConfig);
  const hit = agentCache.get(key);
  if (hit && hit.Ctor === EnvHttpProxyAgentCtor) return hit.agent;
  const agent = new EnvHttpProxyAgentCtor(proxyConfig);
  agentCache.set(key, { Ctor: EnvHttpProxyAgentCtor, agent });
  return agent;
}

/**
 * Build a fetch implementation for outbound HTTPS requests.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetch?: typeof fetch, EnvHttpProxyAgent?: new (options: object) => unknown, undiciFetch?: typeof fetch }} [deps]
 * @returns {typeof fetch}
 */
function createOutboundFetch(env = process.env, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;

  const proxyConfig = resolveProxyConfig(env);
  if (!proxyConfig.httpProxy && !proxyConfig.httpsProxy) return globalFetch();

  const EnvHttpProxyAgentCtor = deps.EnvHttpProxyAgent || EnvHttpProxyAgent;
  const fetchFn = deps.undiciFetch || undiciFetch;
  // A configured-but-invalid proxy must fail closed. Silently falling back to
  // a direct request would violate operator intent and obscure configuration
  // errors on networks where direct access is forbidden.
  const agent = getProxyAgent(proxyConfig, EnvHttpProxyAgentCtor);

  return (input, init = {}) => {
    const options = init && typeof init === 'object' ? { ...init } : {};
    if (options.dispatcher == null) options.dispatcher = agent;
    // undici prefers Uint8Array bodies over Node Buffer views in some paths.
    if (Buffer.isBuffer(options.body)) {
      options.body = new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength);
    }
    return fetchFn(input, options);
  };
}

/** Clear cached ProxyAgents (tests / hot env proxy changes). */
function resetOutboundFetchCache() {
  agentCache.clear();
}

module.exports = {
  cleanProxyUrl,
  resolveProxyConfig,
  resolveProxyUrl,
  createOutboundFetch,
  resetOutboundFetchCache
};
