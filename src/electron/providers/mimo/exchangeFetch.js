'use strict';

const { ProxyAgent, fetch: undiciFetch } = require('undici');
const { createOutboundFetch, resolveProxyConfig } = require('../../../shared/outboundFetch');

// Chromium answers with an ordered PAC route list: a direct route or one or
// more proxies followed by fallbacks. Preserve that order so an unreachable
// proxy behaves like Chromium instead of turning a valid `; DIRECT` fallback
// into an outage.
function parseProxyRoute(value) {
  if (!value || /^DIRECT$/i.test(value)) return { kind: 'direct', proxyUrl: '' };
  const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(value);
  if (!match) return { kind: 'unsupported', proxyUrl: '' };
  // `HTTPS host:port` means TLS to the proxy itself, which undici spells with an
  // `https://` proxy URL. Reading it as plain `http://` would fail against a
  // TLS-only proxy and look like an outage rather than a proxy problem.
  const scheme = /^HTTPS$/i.test(match[1]) ? 'https' : 'http';
  return { kind: 'http', proxyUrl: `${scheme}://${match[2]}` };
}

function parseProxyResolveResults(value) {
  const entries = String(value || '').split(';').map((entry) => entry.trim()).filter(Boolean);
  return (entries.length ? entries : ['DIRECT']).map(parseProxyRoute);
}

function parseProxyResolveResult(value) {
  return parseProxyResolveResults(value)[0];
}

// The exchange's transport in the widget. It cannot be the runtime's own fetch:
// Chromium answers a `redirect: 'manual'` request with `net::ERR_ABORTED`, and a
// Chromium *session* is no substitute either — its cookie policy withholds every
// cookie on the https→http hop this chain's callback makes, so it cannot walk the
// chain at all (measured). The walk therefore keeps its own jar in shared code and
// takes its requests from here. Explicit proxy environment settings win; without
// those, each hop follows the route Chromium resolves from the system/PAC proxy.
function createMimoExchangeFetch({
  session,
  fetch: fetchImpl = undiciFetch,
  env = process.env,
  envFetch
} = {}) {
  const configured = resolveProxyConfig(env);
  if (configured.httpProxy || configured.httpsProxy) {
    return envFetch || createOutboundFetch(env);
  }
  const agents = new Map();
  const agentFor = (proxyUrl) => {
    if (!agents.has(proxyUrl)) agents.set(proxyUrl, new ProxyAgent(proxyUrl));
    return agents.get(proxyUrl);
  };
  return async function mimoExchangeFetch(url, init = {}) {
    const routes = parseProxyResolveResults(await session.resolveProxy(String(url)));
    let lastError = null;
    // One resolution per hop, deliberately: the proxy can differ per host under
    // a PAC script. Network failures advance through Chromium's ordered fallback
    // list; an HTTP response is the origin's answer and is returned immediately.
    for (const route of routes) {
      if (route.kind === 'unsupported') {
        lastError = new Error('MiMo exchange cannot use the resolved proxy');
        continue;
      }
      try {
        return await fetchImpl(url, route.proxyUrl ? { ...init, dispatcher: agentFor(route.proxyUrl) } : init);
      } catch (error) {
        if (init.signal?.aborted) throw error;
        lastError = error;
      }
    }
    throw lastError || new Error('MiMo exchange has no usable proxy route');
  };
}

module.exports = { createMimoExchangeFetch, parseProxyResolveResult, parseProxyResolveResults };
