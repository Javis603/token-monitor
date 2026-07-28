'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { BROWSER_USER_AGENT } = require('../../src/shared/browserUserAgent');
const { fetchClaudeLimits } = require('../../src/shared/limitCollector');
const { fetchOllamaLimits } = require('../../src/shared/ollamaLimits');
const { fetchQoderLimits } = require('../../src/shared/qoderLimits');
const opencodeWeb = require('../../src/shared/opencodeWeb');

const root = path.join(__dirname, '..', '..');

// Files that deliberately send their own agent instead of the shared one.
// Changing what a live provider presents to its host is a behaviour change, so
// they stay listed here rather than being quietly folded in. `cursorProbe` is
// still on Chrome 120 while the shared agent is on 143 — exactly the drift the
// scan below exists to surface.
const OWN_AGENT_FILES = ['src/shared/cursorProbe.js', 'src/shared/mimoLimits.js'];
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

test('no source file hard-codes a browser user-agent outside the known set', () => {
  // Matching the shared string verbatim would only catch an identical copy,
  // which is the harmless kind. The damage comes from a provider pinning its own
  // Chrome version and silently rotting, so this matches any browser-shaped
  // literal and requires it to be declared.
  const owners = sourceFiles()
    .filter((file) => /'Mozilla\/5\.0[^']*'|"Mozilla\/5\.0[^"]*"/.test(file.text))
    .map((file) => file.name)
    .sort();

  assert.deepEqual(owners, [SHARED_AGENT_FILE, ...OWN_AGENT_FILES].sort());
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

test('Qoder sends the shared agent on the wire', async () => {
  const sent = await outboundUserAgent((fetch) => fetchQoderLimits(
    { qoderCookie: 'session=probe', qoderSite: 'cn' },
    { env: {}, fetch }
  ));
  assert.deepEqual([...new Set(sent)], [BROWSER_USER_AGENT]);
});
