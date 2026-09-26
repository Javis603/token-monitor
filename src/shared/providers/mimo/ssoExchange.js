'use strict';

const { throwIfAborted } = require('../../abortSignal');
const { createMimoHttpRequest } = require('./httpRequest');

// Both chains observed live are four hops. The cap is here so a server answering
// a redirect loop cannot hold a probe open; it is not a hop budget to spend.
const MIMO_EXCHANGE_MAX_HOPS = 8;

// Two outcomes, because the lane acts on exactly two: a refused credential is
// the user's to fix and must never be retried, while everything else is an
// attempt that failed and may be retried without asking them anything.
const MIMO_EXCHANGE_STATUSES = Object.freeze({
  rejected: 'rejected',
  unavailable: 'unavailable'
});

// Xiaomi's own rejection codes, taken from the app's own classifier. `46109` is
// the one that matters: it is not an HTTP status, so an account can be refused
// with a perfectly ordinary 200 and the status alone would read it as an answer.
const MIMO_REJECTED_CODES = Object.freeze([403, 46109]);

function hostMatches(host, domain) {
  return host === domain || host.endsWith(`.${domain}`);
}

// `Domain` is the only attribute either chain's cookies actually carry that
// changes what gets sent; every observed cookie is `Path=/` over https, so the
// rest of the attribute grammar would be machinery this flow cannot exercise.
function parseSetCookie(line) {
  const parts = String(line || '').split(';');
  const first = parts.shift() || '';
  const separator = first.indexOf('=');
  if (separator <= 0) return null;
  const cookie = {
    name: first.slice(0, separator).trim(),
    value: first.slice(separator + 1).trim(),
    domain: '',
    hostOnly: true
  };
  for (const attribute of parts) {
    const trimmed = attribute.trim();
    if (!/^domain=/i.test(trimmed)) continue;
    const domain = trimmed.slice(trimmed.indexOf('=') + 1).trim().replace(/^\./, '').toLowerCase();
    if (!domain) continue;
    cookie.domain = domain;
    cookie.hostOnly = false;
  }
  return cookie;
}

// A jar for one exchange, and only as much of one as the flow needs: domain
// scoping, so a cookie minted for the service host is never replayed at the
// account host or the other way round. That is the one property the chains
// depend on, and it is the one a browser's own jar would enforce here.
function createMimoCookieJar() {
  const cookies = [];

  function store(cookie, url) {
    const domain = cookie.domain || url.hostname.toLowerCase();
    const entry = { name: cookie.name, value: cookie.value, domain, hostOnly: cookie.hostOnly };
    const index = cookies.findIndex((existing) => existing.name === entry.name && existing.domain === domain);
    if (index >= 0) cookies[index] = entry;
    else cookies.push(entry);
  }

  return {
    // For a cookie the caller already holds rather than one the wire set. It is
    // host-only to `url`, which is what the account cookie is in practice: the
    // chain only presents it to `.account.xiaomi.com` itself.
    set(name, value, url) {
      store({ name, value, domain: '', hostOnly: true }, url);
    },
    absorb(setCookieLines, url) {
      for (const line of setCookieLines || []) {
        const cookie = parseSetCookie(line);
        if (cookie) store(cookie, url);
      }
    },
    headerFor(url) {
      const host = url.hostname.toLowerCase();
      const sent = [];
      for (const cookie of cookies) {
        if (cookie.hostOnly ? cookie.domain !== host : !hostMatches(host, cookie.domain)) continue;
        sent.push(`${cookie.name}=${cookie.value}`);
      }
      return sent.join('; ');
    }
  };
}

function seedJar(jar, cookie, url) {
  for (const pair of String(cookie || '').split(';')) {
    const separator = pair.indexOf('=');
    if (separator <= 0) continue;
    jar.set(pair.slice(0, separator).trim(), pair.slice(separator + 1).trim(), url);
  }
  return jar;
}

function createAccountJar(accountCookie, host = 'https://account.xiaomi.com/') {
  // Scoped to the account host, which is the only hop that presents it. Setting
  // it against the service URL would leave the chain without the cookie that
  // drives it.
  return seedJar(createMimoCookieJar(), accountCookie, new URL(host));
}

// Success is exactly the app's rule: `code === 0` *and* a non-empty
// `data.userId`. Everything else is not a session, and the caller decides what
// kind of not-a-session it was from where the chain stopped.
function readMimoAccountStatus(status, text) {
  let envelope;
  try {
    envelope = JSON.parse(text);
  } catch (_) {
    envelope = null;
  }
  const userId = envelope?.data?.userId;
  if (!envelope || envelope.code !== 0 || userId == null || String(userId) === '') return { ok: false };
  return {
    ok: true,
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

// Walks a chain of hops to its final answer, carrying the jar and the caller's
// signal. The two lanes reach their session differently — the membership chain
// redirects, the console one answers 401 and names a login URL in the body — so
// how to take the next hop is the caller's rule and this loop owns only the
// walking, the cookie jar and the cancellation.
async function walkMimoChain({ entryUrl, jar, requestFn, signal, maxHops, nextHop }) {
  let url = entryUrl;
  for (let hop = 0; hop < maxHops; hop += 1) {
    const cookieHeader = jar.headerFor(url);
    let response;
    try {
      response = await requestFn(url.href, {
        method: 'GET',
        headers: cookieHeader ? { Cookie: cookieHeader } : {},
        signal
      });
    } catch {
      throwIfAborted(signal);
      return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
    }
    throwIfAborted(signal);

    const headers = response.headers || {};
    const setCookie = typeof headers.getSetCookie === 'function' ? headers.getSetCookie() : [];
    jar.absorb(setCookie, url);

    const status = Number(response.status);
    if (status >= 300 && status < 400) {
      const location = typeof headers.get === 'function' ? headers.get('location') : '';
      if (!location) return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
      try {
        url = new URL(location, url);
      } catch {
        return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
      }
      continue;
    }

    const text = await response.text().catch(() => '');
    // The shared transport hands an aborted read back as an ordinary failure, so
    // the signal has to be asked again before the answer is acted on — and here
    // is where that check carries, because a cancellation during the body read
    // has nothing else left to notice it.
    throwIfAborted(signal);

    const hopUrl = nextHop ? nextHop({ status, text, url }) : '';
    if (hopUrl) {
      try {
        url = new URL(hopUrl, url);
      } catch {
        return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
      }
      continue;
    }
    return { ok: true, url, status, text };
  }
  return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
}

// Both chains end the same way, and these three rules are the whole of it. A
// rejection is the credential being refused wherever the walk stopped — `46109`
// is not an HTTP status, and an expired service session answers 401 from the
// service host itself — and a walk that stopped somewhere other than where it
// started never came back, which is what a refused account cookie looks like: it
// lands on the account host's own login page rather than answering from the
// service. Everything else is the answer, and reading it is the one part the two
// chains do differently.
function finishMimoChain(walked, entryUrl, readAnswer) {
  if (mimoRejectionCode(walked.status, walked.text) || walked.status === 401) {
    return { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected };
  }
  if (walked.url.hostname.toLowerCase() !== entryUrl.hostname.toLowerCase()) {
    return { ok: false, status: MIMO_EXCHANGE_STATUSES.rejected };
  }
  return readAnswer(walked) || { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
}

// The account's own verdict on the membership chain, taken the way the app takes
// it. undici has no cookie jar and the app's own probe lets the transport follow,
// so following is this function's job: a single hop would return the 302 as the
// answer.
//
// The account cookie is spent here and the service cookies it mints live only in
// this jar. Nothing is written back to the partition, and no cookie leaves the
// function except the header the caller's own request carries.
async function exchangeMimoServiceSession(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const maxHops = Number.isFinite(options.maxHops) ? options.maxHops : MIMO_EXCHANGE_MAX_HOPS;

  let entryUrl;
  try {
    entryUrl = new URL(`${baseUrl}/user/xiaomi/me`);
  } catch (_) {
    return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
  }

  const jar = createAccountJar(options.accountCookie);
  // A service cookie the caller already holds is usable as it stands: seeded at
  // the service host, the walk reaches the account answer on its first hop.
  seedJar(jar, options.serviceCookie, entryUrl);
  throwIfAborted(options.signal);

  const walked = await walkMimoChain({
    entryUrl,
    jar,
    requestFn: options.request || createMimoHttpRequest(),
    signal: options.signal,
    maxHops
  });
  if (!walked.ok) return walked;
  return finishMimoChain(walked, entryUrl, (end) => {
    const verdict = readMimoAccountStatus(end.status, end.text);
    return verdict.ok
      ? { ok: true, userId: verdict.userId, region: verdict.region, cookieHeader: jar.headerFor(end.url) }
      : null;
  });
}

// The console lane's chain does not redirect: the endpoint answers 401 and names
// the login URL it wants visited, so that URL is the next hop.
function consoleLoginHop({ status, text }) {
  if (status !== 401) return '';
  try {
    const loginUrl = JSON.parse(text)?.loginUrl;
    return typeof loginUrl === 'string' ? loginUrl : '';
  } catch {
    return '';
  }
}

// The console session, minted the way the console mints it: ask an endpoint,
// follow the login URL it names, and come back to the endpoint that answers. The
// `sid` differs from the membership chain's, which is why the two are separate
// walks over one walker.
async function exchangeMimoConsoleSession(options = {}) {
  const baseUrl = String(options.baseUrl || '').replace(/\/+$/, '');
  const maxHops = Number.isFinite(options.maxHops) ? options.maxHops : MIMO_EXCHANGE_MAX_HOPS;
  const entryPath = options.entryPath || '/balance';

  let entryUrl;
  try {
    entryUrl = new URL(`${baseUrl}${entryPath}`);
  } catch (_) {
    return { ok: false, status: MIMO_EXCHANGE_STATUSES.unavailable };
  }

  const jar = createAccountJar(options.accountCookie);
  throwIfAborted(options.signal);

  const walked = await walkMimoChain({
    entryUrl,
    jar,
    requestFn: options.request || createMimoHttpRequest(),
    signal: options.signal,
    maxHops,
    nextHop: consoleLoginHop
  });
  if (!walked.ok) return walked;
  return finishMimoChain(walked, entryUrl, (end) => {
    try {
      const envelope = JSON.parse(end.text);
      return envelope && envelope.code === 0 ? { ok: true, cookieHeader: jar.headerFor(end.url) } : null;
    } catch {
      return null;
    }
  });
}

module.exports = {
  MIMO_EXCHANGE_STATUSES,
  createMimoCookieJar,
  exchangeMimoConsoleSession,
  exchangeMimoServiceSession,
  readMimoAccountStatus
};
