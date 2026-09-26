'use strict';

const { ProxyAgent, fetch: undiciFetch } = require('undici');

// Chromium's answer for the proxy it would use for a host is a PAC result:
// `DIRECT`, or `PROXY host:port` (e.g. `PROXY 127.0.0.1:7890`). Only the first
// entry is taken, Chromium listing its fallbacks after it. A proxy type undici
// cannot speak is reported rather than skipped: falling back to a direct request
// would violate what the configured proxy is there for, the rule
// `createOutboundFetch` states.
function parseProxyResolveResult(value) {
  const first = String(value || '').split(';').map((entry) => entry.trim()).find(Boolean) || '';
  if (!first || /^DIRECT$/i.test(first)) return { kind: 'direct', proxyUrl: '' };
  const match = /^(PROXY|HTTP|HTTPS)\s+(\S+)$/i.exec(first);
  if (!match) return { kind: 'unsupported', proxyUrl: '' };
  // `HTTPS host:port` means TLS to the proxy itself, which undici spells with an
  // `https://` proxy URL. Reading it as plain `http://` would fail against a
  // TLS-only proxy and look like an outage rather than a proxy problem.
  const scheme = /^HTTPS$/i.test(match[1]) ? 'https' : 'http';
  return { kind: 'http', proxyUrl: `${scheme}://${match[2]}` };
}

// The exchange's transport in the widget. It cannot be the runtime's own fetch:
// Chromium answers a `redirect: 'manual'` request with `net::ERR_ABORTED`, and a
// Chromium *session* is no substitute either — its cookie policy withholds every
// cookie on the https→http hop this chain's callback makes, so it cannot walk the
// chain at all (measured). The walk therefore keeps its own jar in shared code and
// takes its requests from here, routed the way every other widget call is: through
// whatever Chromium resolved for that host.
function createMimoExchangeFetch({ session, fetch: fetchImpl = undiciFetch } = {}) {
  const agents = new Map();
  const agentFor = (proxyUrl) => {
    if (!agents.has(proxyUrl)) agents.set(proxyUrl, new ProxyAgent(proxyUrl));
    return agents.get(proxyUrl);
  };
  return async function mimoExchangeFetch(url, init = {}) {
    const resolved = parseProxyResolveResult(await session.resolveProxy(String(url)));
    if (resolved.kind === 'unsupported') {
      throw new Error('MiMo exchange cannot use the resolved proxy');
    }
    // One resolution per hop, deliberately: the proxy can differ per host under a
    // PAC script, and the walk is at most a handful of requests.
    return fetchImpl(url, resolved.proxyUrl ? { ...init, dispatcher: agentFor(resolved.proxyUrl) } : init);
  };
}

module.exports = { createMimoExchangeFetch, parseProxyResolveResult };
