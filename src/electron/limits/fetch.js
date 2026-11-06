'use strict';

const { createOutboundFetch, resolveProxyConfig } = require('../../shared/outboundFetch');

/**
 * Outbound transport for the widget's provider calls.
 *
 * Chromium's network stack (unlike Node's undici-based global fetch) honors the
 * OS proxy configuration with zero setup, which matters because a GUI app
 * launched from the Dock/Start Menu never inherits a shell's HTTP_PROXY /
 * HTTPS_PROXY env vars in the first place.
 *
 * `credentials: 'omit'` is forced rather than defaulted: net.fetch issues from
 * the default session, so anything else persists a provider's Set-Cookie into
 * userData and then *replaces* an explicit Cookie header with whatever that jar
 * holds — one stray cookie strands every cookie-backed provider on
 * `unauthorized`, and re-pasting the credential cannot clear it.
 *
 * `cache: 'no-store'` is forced for the same reason: the default session owns
 * an HTTP cache that Node's fetch never had, and a quota poll answered from it
 * would report a figure the provider has already moved past.
 *
 * Chromium also cancels a request whose explicit Referer is cross-origin and
 * carries a path (net::ERR_BLOCKED_BY_CLIENT). No provider needs that today —
 * their Referer headers are same-origin or a bare origin — so the default
 * referrer policy stands, and a provider that ever needs a looser one passes
 * `referrerPolicy` itself.
 */
function createElectronNetFetch(net) {
  return function electronNetFetch(input, init = {}) {
    return net.fetch(input, { ...init, credentials: 'omit', cache: 'no-store' });
  };
}

/**
 * Transport policy belongs to the runtime, not to a provider: one branch is
 * chosen for every call that resolves through `deps.fetch`, instead of each
 * provider deciding for itself. An explicitly configured proxy env wins over
 * the OS setting (and the app proxy setting, which replaces the env proxy
 * variables while set, wins over both), which keeps the documented env
 * behavior working — lowercase precedence, ALL_PROXY, NO_PROXY, failing closed
 * on an invalid proxy, and credentials embedded in the proxy URL, which
 * Chromium's proxy rules do not accept.
 *
 * The branch is chosen per request from `getRoute()`, because the app-scoped
 * proxy setting (networkProxy.js) can change while long-lived callers still
 * hold the fetch they were constructed with. A route is the env to read plus
 * the outboundFetch deps for it (the app proxy's dispatcher; none for env).
 *
 * @param {{ net: { fetch: typeof fetch }, env?: NodeJS.ProcessEnv, getRoute?: () => { env: NodeJS.ProcessEnv, deps?: object } }} options
 * @returns {typeof fetch}
 */
function createElectronLimitsFetch({ net, env = process.env, getRoute = () => ({ env, deps: {} }) } = {}) {
  const netFetch = createElectronNetFetch(net);
  return async function electronLimitsFetch(input, init) {
    const route = getRoute();
    const proxy = resolveProxyConfig(route.env);
    const transport = proxy.httpProxy || proxy.httpsProxy ? createOutboundFetch(route.env, route.deps || {}) : netFetch;
    return transport(input, init);
  };
}

module.exports = { createElectronLimitsFetch, createElectronNetFetch };
