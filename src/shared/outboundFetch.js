'use strict';

/**
 * Outbound HTTP helpers that honor standard proxy env vars.
 *
 * Node's global `fetch` (undici) does not apply HTTP(S)_PROXY by default, so
 * requests to hosts only reachable via a local proxy (common for grok.com in
 * some networks) hang until timeout. This module builds a fetch function that:
 *   - uses undici ProxyAgent when HTTPS_PROXY / HTTP_PROXY / ALL_PROXY is set
 *   - falls back to globalThis.fetch when no proxy is set or undici is missing
 *
 * No app settings / hard-coded proxy addresses — env only (CLI/systemd/shell).
 */

let undici = null;
try {
  undici = require('undici');
} catch (_) {
  undici = null;
}

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
 * Resolve a proxy URL from env, following the common Node/curl precedence for
 * HTTPS targets: HTTPS_PROXY → HTTP_PROXY → ALL_PROXY (case-insensitive).
 */
function resolveProxyUrl(env = process.env) {
  const names = [
    'HTTPS_PROXY', 'https_proxy',
    'HTTP_PROXY', 'http_proxy',
    'ALL_PROXY', 'all_proxy'
  ];
  for (const name of names) {
    const value = cleanProxyUrl(env && env[name]);
    if (value) return value;
  }
  return '';
}

function globalFetch() {
  if (typeof globalThis.fetch === 'function') {
    return globalThis.fetch.bind(globalThis);
  }
  throw new Error('global fetch is not available');
}

// Reuse one ProxyAgent per proxy URL so TLS sockets can be pooled across ticks.
const agentCache = new Map();

function getProxyAgent(proxyUrl, ProxyAgentCtor) {
  const key = String(proxyUrl);
  const hit = agentCache.get(key);
  if (hit && hit.Ctor === ProxyAgentCtor) return hit.agent;
  const agent = new ProxyAgentCtor(proxyUrl);
  agentCache.set(key, { Ctor: ProxyAgentCtor, agent });
  return agent;
}

/**
 * Build a fetch implementation for outbound HTTPS requests.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @param {{ fetch?: typeof fetch, ProxyAgent?: new (url: string) => unknown, undiciFetch?: typeof fetch }} [deps]
 * @returns {typeof fetch}
 */
function createOutboundFetch(env = process.env, deps = {}) {
  if (typeof deps.fetch === 'function') return deps.fetch;

  const proxyUrl = resolveProxyUrl(env);
  if (!proxyUrl) return globalFetch();

  const ProxyAgentCtor = deps.ProxyAgent
    || (undici && typeof undici.ProxyAgent === 'function' ? undici.ProxyAgent : null);
  const undiciFetch = deps.undiciFetch
    || (undici && typeof undici.fetch === 'function' ? undici.fetch : null);

  if (!ProxyAgentCtor || !undiciFetch) return globalFetch();

  let agent;
  try {
    agent = getProxyAgent(proxyUrl, ProxyAgentCtor);
  } catch (_) {
    return globalFetch();
  }

  return (input, init = {}) => {
    const options = init && typeof init === 'object' ? { ...init } : {};
    if (options.dispatcher == null) options.dispatcher = agent;
    // undici prefers Uint8Array bodies over Node Buffer views in some paths.
    if (Buffer.isBuffer(options.body)) {
      options.body = new Uint8Array(options.body.buffer, options.body.byteOffset, options.body.byteLength);
    }
    return undiciFetch(input, options);
  };
}

/** Clear cached ProxyAgents (tests / hot env proxy changes). */
function resetOutboundFetchCache() {
  agentCache.clear();
}

module.exports = {
  cleanProxyUrl,
  resolveProxyUrl,
  createOutboundFetch,
  resetOutboundFetchCache
};
