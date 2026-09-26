'use strict';

const { throwIfAborted } = require('../../abortSignal');
const { errorWithStatus } = require('../../limits/providerHelpers');
const { mimoExchangeRequestHeaders } = require('./browserHeaders');

// Both chains observed live are four hops. The cap only stops a redirect loop
// from holding a probe open; it is not a hop budget to spend.
const MIMO_EXCHANGE_MAX_HOPS = 8;

// Xiaomi's own rejection codes, from the app's classifier. `46109` matters: it is
// not an HTTP status, so a refusal can arrive as an ordinary 200.
const MIMO_REJECTED_CODES = Object.freeze([403, 46109]);

// The hosts the login flow navigates to. The app classifies every URL its login
// window visits against this list, and the one URL the console hands back is
// followed, so it is checked before it is visited.
const MIMO_LOGIN_DOMAINS = Object.freeze(['xiaomi.com', 'mi.com', 'miui.com']);

// A minted service cookie belongs to the service host and the ones the account
// host sets on the way belong to it, so absorbing is scoped.
const MIMO_COOKIE_DOMAINS = Object.freeze(['xiaomimimo.com', 'xiaomi.com', 'mi.com', 'miui.com']);

// The walk answers in its own three words; a limits row needs the vocabulary the
// runtime ranks on, and both lanes translate here so neither invents its own.
const MIMO_EXCHANGE_STATUSES = Object.freeze({
  rejected: 'rejected',
  rateLimited: 'rate-limited',
  unavailable: 'unavailable'
});

function mimoExchangeStatus(status) {
  if (status === MIMO_EXCHANGE_STATUSES.rejected) return 'unauthorized';
  if (status === MIMO_EXCHANGE_STATUSES.rateLimited) return 'sourceRateLimited';
  return 'unavailable';
}

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

function allowedLoginUrl(value, base) {
  let url;
  try {
    url = new URL(String(value || ''), base);
  } catch (_) {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  if (url.protocol !== 'https:') return null;
  const host = url.hostname.toLowerCase();
  return MIMO_LOGIN_DOMAINS.some((domain) => hostMatches(host, domain)) ? url : null;
}

// Every redirect stays inside the service that started the exchange or Xiaomi's
// login domains. The one protocol exception is the service host's observed HTTP
// callback; account cookies are Secure and the jar therefore sends none on it.
function allowedExchangeUrl(value, base, serviceUrl) {
  let url;
  try {
    url = new URL(String(value || ''), base);
  } catch (_) {
    return null;
  }
  if (url.username || url.password || url.port) return null;
  const host = url.hostname.toLowerCase();
  const serviceHost = serviceUrl?.hostname?.toLowerCase() || '';
  if (host === serviceHost) {
    if (url.protocol === 'https:') return url;
    if (url.protocol === 'http:' && (url.pathname === '/sts' || url.pathname === '/api/sts')) return url;
    return null;
  }
  return url.protocol === 'https:'
    && MIMO_LOGIN_DOMAINS.some((domain) => hostMatches(host, domain))
    ? url
    : null;
}

// A jar for one exchange, enforcing host, Domain and Secure on every hop.
function createMimoCookieJar() {
  const cookies = [];

  function store(entry, url) {
    const domain = entry.domain || url.hostname.toLowerCase();
    if (!hostMatches(url.hostname.toLowerCase(), domain)) return;
    if (!MIMO_COOKIE_DOMAINS.some((root) => hostMatches(domain, root))) return;
    const stored = { ...entry, domain };
    const index = cookies.findIndex((existing) => existing.name === stored.name && existing.domain === domain);
    if (index >= 0) cookies[index] = stored;
    else cookies.push(stored);
  }

  function parse(line) {
    const parts = String(line || '').split(';');
    const first = parts.shift() || '';
    const separator = first.indexOf('=');
    if (separator <= 0) return null;
    const entry = {
      name: first.slice(0, separator).trim(),
      value: first.slice(separator + 1).trim(),
      domain: '',
      hostOnly: true,
      secure: false
    };
    for (const attribute of parts) {
      const trimmed = attribute.trim();
      if (/^secure$/i.test(trimmed)) entry.secure = true;
      else if (/^domain=/i.test(trimmed)) {
        const domain = trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^\./, '').toLowerCase();
        if (domain) {
          entry.domain = domain;
          entry.hostOnly = false;
        }
      }
    }
    return entry;
  }

  return {
    // A raw `Cookie:` value carries no attributes, so a credential that arrived
    // over HTTPS is kept on HTTPS here.
    seed(cookieHeader, url) {
      for (const pair of String(cookieHeader || '').split(';')) {
        const separator = pair.indexOf('=');
        if (separator <= 0) continue;
        store({
          name: pair.slice(0, separator).trim(),
          value: pair.slice(separator + 1).trim(),
          domain: '',
          hostOnly: true,
          secure: true
        }, url);
      }
    },
    absorb(setCookieLines, url) {
      for (const line of setCookieLines || []) {
        const entry = parse(line);
        if (entry) store(entry, url);
      }
    },
    headerFor(url) {
      const host = url.hostname.toLowerCase();
      const sent = [];
      for (const cookie of cookies) {
        if (cookie.hostOnly ? cookie.domain !== host : !hostMatches(host, cookie.domain)) continue;
        if (cookie.secure && url.protocol !== 'https:') continue;
        sent.push(`${cookie.name}=${cookie.value}`);
      }
      return sent.join('; ');
    }
  };
}

// One hop, following nothing: the status, the Location and this hop's own
// Set-Cookie lines. undici's fetch can do that and Chromium's cannot, which is
// exactly the difference `deps.mimoExchangeFetch` exists to cover — a runtime
// hands the walk a fetch that can, and this jar then needs nothing from it.
function createJarExchange(fetchFn, seed = {}) {
  const jar = createMimoCookieJar();
  const entryUrl = new URL(seed.accountHost || 'https://account.xiaomi.com/');
  const serviceUrl = seed.serviceUrl ? new URL(seed.serviceUrl) : null;
  jar.seed(seed.accountCookie, entryUrl);
  if (seed.serviceUrl) jar.seed(seed.serviceCookie, new URL(seed.serviceUrl));

  return {
    async request(url) {
      let current = new URL(url);
      let hops = 0;
      for (;;) {
        if (hops++ >= MIMO_EXCHANGE_MAX_HOPS) throw errorWithStatus('unavailable', 'MiMo exchange did not settle');
        const cookieHeader = jar.headerFor(current);
        const response = await fetchFn(current.href, {
          method: 'GET',
          headers: mimoExchangeRequestHeaders(cookieHeader, current),
          redirect: 'manual',
          // Every hop is the caller's to cancel: a device-runtime abort or a probe
          // deadline must stop the walk, not wait for it.
          signal: seed.signal
        });
        const headers = response.headers || {};
        const setCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
        jar.absorb(setCookie, current);
        const status = Number(response.status);
        if (status >= 300 && status < 400) {
          const location = typeof headers.get === 'function' ? headers.get('location') : '';
          if (!location) throw errorWithStatus('unavailable', 'MiMo exchange answered a redirect with no target');
          const next = allowedExchangeUrl(location, current, serviceUrl);
          if (!next) throw errorWithStatus('unavailable', 'MiMo exchange redirected outside its allowed hosts');
          current = next;
          continue;
        }
        return { status, text: await response.text(), url: current };
      }
    },
    cookiesFor(url) {
      return jar.headerFor(new URL(url));
    }
  };
}

// The walk's own transport. `deps.fetch` is the runtime's, and every runtime but
// the widget's Chromium branch can walk with it — Chromium cancels a
// `redirect: 'manual'` request — so the widget supplies `deps.mimoExchangeFetch`
// instead: the same request shape, routed the way the rest of the widget's calls
// are. The cookie jar is this module's either way.
function openMimoExchange(deps = {}, seed = {}) {
  return createJarExchange(deps.mimoExchangeFetch || deps.fetch || globalThis.fetch, seed);
}

function readAccountStatus(status, text) {
  if (status !== 200) return null;
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (_) {
    return null;
  }
  const userId = envelope?.data?.userId;
  if (!envelope || envelope.code !== 0 || userId == null || String(userId) === '') return null;
  return {
    userId: String(userId),
    region: typeof envelope.data.region === 'string' ? envelope.data.region : ''
  };
}

function mimoRejectionCode(status, text) {
  let bodyCode;
  try {
    bodyCode = JSON.parse(text)?.code;
  } catch (_) {
    bodyCode = undefined;
  }
  if (typeof bodyCode === 'number' && MIMO_REJECTED_CODES.includes(bodyCode)) return bodyCode;
  return MIMO_REJECTED_CODES.includes(status) ? status : 0;
}

// The console answers 401 and names the login URL to visit, rather than
// redirecting. Visiting it is what mints the session.
function readLoginUrl(status, text, base) {
  if (status !== 401) return null;
  try {
    return allowedLoginUrl(JSON.parse(text)?.loginUrl, base);
  } catch (_) {
    return null;
  }
}

function readConsoleStatus(status, text) {
  if (status !== 200) return null;
  try {
    return JSON.parse(text)?.code === 0 ? {} : null;
  } catch (_) {
    return null;
  }
}

// The account cookie is spent here, and nothing but the header the caller's own
// requests will carry leaves the function. `readAnswer` is the lane's success
// rule — the membership reader wants `data.userId`, the console wants
// `code === 0` — and the rest of the walk is the same for both.
async function mintMimoServiceSession(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const entry = String(options.entry || '');
  let entryUrl;
  try {
    entryUrl = new URL(`${baseUrl}${entry}`);
  } catch (_) {
    throw errorWithStatus('unavailable', 'MiMo service base URL is not usable');
  }
  const readAnswer = options.readAnswer || readAccountStatus;

  const exchange = openMimoExchange(options.deps, {
    accountCookie: options.accountCookie,
    serviceCookie: options.serviceCookie,
    serviceUrl: entryUrl.href,
    signal: options.deps?.signal
  });
  try {
    let walked = await exchange.request(entryUrl.href);
    throwIfAborted(options.deps?.signal);
    if (walked.status === 401) {
      const loginUrl = readLoginUrl(401, walked.text, entryUrl);
      if (!loginUrl) return { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected };
      walked = await exchange.request(loginUrl.href);
      throwIfAborted(options.deps?.signal);
      // The chain answers the endpoint that asked. Coming back for it is only
      // needed when it stopped somewhere else instead.
      if (!readAnswer(walked.status, walked.text)) {
        walked = await exchange.request(entryUrl.href);
        throwIfAborted(options.deps?.signal);
      }
    }

    if (walked.status === 429) return { ok: false, status: MIMO_EXCHANGE_STATUSES.rateLimited };
    if (mimoRejectionCode(walked.status, walked.text) || walked.status === 401) {
      return { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected };
    }
    // The chain only ends off the service host by going to the login page: what
    // an account cookie the service no longer accepts looks like.
    if (walked.url.hostname.toLowerCase() !== entryUrl.hostname.toLowerCase()) {
      return { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected };
    }
    const answer = readAnswer(walked.status, walked.text);
    if (!answer) return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
    return { ok: true, ...answer, cookieHeader: exchange.cookiesFor(entryUrl.href) };
  } catch (error) {
    throwIfAborted(options.deps?.signal);
    return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable, error };
  }
}

module.exports = {
  MIMO_EXCHANGE_STATUSES,
  mimoExchangeStatus,
  mintMimoServiceSession,
  readConsoleStatus
};
