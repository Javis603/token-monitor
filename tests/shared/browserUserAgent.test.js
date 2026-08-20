'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BROWSER_USER_AGENT } = require('../../src/shared/browserUserAgent');
const { fetchClaudeLimits } = require('../../src/shared/limitCollector');
const { fetchMimoLimits } = require('../../src/shared/mimoLimits');
const { fetchOllamaLimits } = require('../../src/shared/ollamaLimits');
const { fetchQoderLimits } = require('../../src/shared/qoderLimits');
const { fetchCommandcodeLimits } = require('../../src/shared/commandcodeLimits');
const cursorProbe = require('../../src/shared/cursorProbe');
const opencodeWeb = require('../../src/shared/opencodeWeb');

const root = path.join(__dirname, '..', '..');

const SHARED_AGENT_FILE = 'src/shared/browserUserAgent.js';

function jsFilesUnder(dir) {
  const out = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) out.push(...jsFilesUnder(full));
    else if (entry.name.endsWith('.js')) out.push(full);
  }
  return out;
}

function sourceFiles() {
  return jsFilesUnder(path.join(root, 'src'))
    .concat(jsFilesUnder(path.join(root, 'worker', 'src')))
    // Windows would otherwise report `src\shared\...` and never match.
    .map((file) => ({ name: path.relative(root, file).split(path.sep).join('/'), text: fs.readFileSync(file, 'utf8') }));
}

function headerValue(init, name) {
  const headers = init?.headers || {};
  const key = Object.keys(headers).find((candidate) => candidate.toLowerCase() === name);
  return key ? headers[key] : undefined;
}

const okResponse = {
  ok: true,
  status: 200,
  headers: { get: () => null, getSetCookie: () => [] },
  json: async () => ({}),
  text: async () => ''
};

// Each provider only has to reach its first outbound request; what it makes of
// the reply is another test's business.
async function outboundUserAgent(send) {
  const seen = [];
  const fetch = async (_url, init) => {
    seen.push(headerValue(init, 'user-agent'));
    return okResponse;
  };
  try {
    await send(fetch);
  } catch (_) { /* the reply is deliberately useless */ }
  assert.ok(seen.length > 0, 'provider should have made a request');
  return seen;
}

test('the shared browser user-agent reads as a current browser', () => {
  // The whole point is to not look like a script: Cloudflare challenges anything
  // that doesn't, so a well-meaning edit to an honest agent has to fail here.
  assert.match(BROWSER_USER_AGENT, /^Mozilla\/5\.0 /);
  assert.match(BROWSER_USER_AGENT, /Chrome\/\d+[\d.]* Safari\/[\d.]+$/);
  assert.doesNotMatch(BROWSER_USER_AGENT, /token-monitor/i);
});

test('no source file hard-codes a browser user-agent', () => {
  // Matching the shared string verbatim would only catch an identical copy,
  // which is the harmless kind. The damage comes from a provider pinning its own
  // Chrome version and silently rotting, so this matches any browser-shaped
  // literal: there is now exactly one place allowed to hold one. The opening
  // quote is enough to identify a literal, and covering all three kinds matters
  // because nothing in this repo enforces a quote style.
  const owners = sourceFiles()
    .filter((file) => /['"`]Mozilla\/5\.0/.test(file.text))
    .map((file) => file.name)
    .sort();

  assert.deepEqual(owners, [SHARED_AGENT_FILE]);
});

test('the shared agent is defined once and never copied verbatim', () => {
  const copies = sourceFiles()
    .filter((file) => file.text.includes(BROWSER_USER_AGENT))
    .map((file) => file.name);

  assert.deepEqual(copies, [SHARED_AGENT_FILE]);
});

test('Claude Web sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchClaudeLimits(
    { claudeWebCookie: 'sessionKey=sk-ant-probe' },
    { fetch, providerRuntimeState: new Map(), claudeIdentityCache: new Map() }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});

test('OpenCode Zen sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => opencodeWeb.fetchZen('sess=1', { fetch }));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});

test('OpenCode Go page sends the shared agent on the wire', async () => {
  // The Go dashboard builds its own headers rather than going through
  // `buildHeaders`, so the Zen case above does not cover it.
  const seen = [];
  const fetch = async (url, init) => {
    seen.push({ url: String(url), ua: headerValue(init, 'user-agent') });
    return String(url).includes(opencodeWeb.WORKSPACES_SERVER_ID)
      ? { ...okResponse, text: async () => '{"id":"wrk_PROBE"}' }
      : { ...okResponse, text: async () => '' };
  };
  try {
    await opencodeWeb.fetchGoWeb('sess=1', { fetch });
  } catch (_) { /* the reply is deliberately useless */ }

  const goRequest = seen.find((entry) => entry.url.endsWith('/go'));
  assert.ok(goRequest, 'the Go dashboard page should have been requested');
  assert.equal(goRequest.ua, BROWSER_USER_AGENT);
});

test('Ollama sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchOllamaLimits(
    { ollamaCookie: 'session=probe' },
    { env: {}, fetch }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});

test('MiMo sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchMimoLimits(
    {
      mimoManagedAccounts: [{
        id: 'mimo-probe',
        accountKey: 'sha256:mimo-probe',
        cookieHeader: 'userId=1; api-platform_serviceToken=probe',
        enabled: true
      }]
    },
    { fetch }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});

test('Cursor sends the shared agent on the wire', async () => {
  // cursorProbe talks through node:https rather than fetch, so its transport is
  // injected instead. A 401 is the cheapest reply that settles the request.
  let headers = null;
  const httpsLib = {
    request(options, onResponse) {
      headers = options.headers;
      queueMicrotask(() => onResponse({ statusCode: 401, on: () => {} }));
      const request = new EventEmitter();
      request.setTimeout = () => {};
      request.destroy = () => {};
      request.end = () => {};
      return request;
    }
  };

  await cursorProbe.requestJson(cursorProbe.AUTH_ME_URL, 'session-probe', { httpsLib });
  assert.ok(headers, 'the probe should have issued a request');
  assert.equal(headers['User-Agent'], BROWSER_USER_AGENT);
});

test('Qoder sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchQoderLimits(
    { qoderCookie: 'session=probe', qoderSite: 'cn' },
    { env: {}, fetch }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});

test('Command Code sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchCommandcodeLimits(
    { commandcodeCookie: '__Secure-commandcode_prod_.session_token=probe' },
    { env: {}, fetch }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});
