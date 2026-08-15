'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const { createElectronLimitsFetch } = require('../../src/electron/limitsFetch');
const { resetOutboundFetchCache } = require('../../src/shared/outboundFetch');

function recordingNet() {
  const calls = [];
  return {
    calls,
    net: {
      fetch: (url, init) => {
        calls.push({ url, init });
        return 'net-fetch-result';
      }
    }
  };
}

test('the Electron transport sends provider requests through net.fetch', async () => {
  const { calls, net } = recordingNet();
  const fetchFn = createElectronLimitsFetch({ net, env: {} });

  assert.equal(await fetchFn('https://example.com/usage', { headers: { a: '1' } }), 'net-fetch-result');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://example.com/usage');
  assert.deepEqual(calls[0].init.headers, { a: '1' });
});

// net.fetch issues from the default session, so anything other than 'omit'
// lets that session's cookie jar replace a provider-managed Cookie header —
// which no amount of re-pasting the credential can undo. It is an invariant of
// this transport, not a default a caller may relax.
// The default session also owns an HTTP cache that Node's fetch never had, so
// a quota poll could be answered from it with a figure the provider has moved
// past. Both invariants sit after the caller's init for that reason.
test('the Electron transport never lets a caller re-enable session credentials or caching', async () => {
  const { calls, net } = recordingNet();
  const fetchFn = createElectronLimitsFetch({ net, env: {} });

  await fetchFn('https://example.com/usage', { credentials: 'include', cache: 'force-cache' });
  await fetchFn('https://example.com/usage');

  assert.deepEqual(calls.map((call) => call.init.credentials), ['omit', 'omit']);
  assert.deepEqual(calls.map((call) => call.init.cache), ['no-store', 'no-store']);
});

// Every provider's Referer is same-origin or a bare origin today, which the
// default referrer policy allows; a provider needing a looser one asks for it
// rather than the transport relaxing the policy for everybody.
test('the Electron transport leaves the referrer policy to the caller', async () => {
  const { calls, net } = recordingNet();
  const fetchFn = createElectronLimitsFetch({ net, env: {} });

  await fetchFn('https://example.com/usage');
  await fetchFn('https://example.com/usage', { referrerPolicy: 'unsafe-url' });

  assert.deepEqual(calls.map((call) => call.init.referrerPolicy), [undefined, 'unsafe-url']);
});

// Without this branch the widget would silently drop the env proxy semantics
// that outboundFetch.js documents — including failing closed on a proxy that
// is configured but unreachable, which the dead port below stands in for.
test('an explicitly configured proxy env stays ahead of the system proxy', async () => {
  for (const env of [{}, { HTTPS_PROXY: '' }, { NO_PROXY: 'example.com' }]) {
    const { calls, net } = recordingNet();
    const fetchFn = createElectronLimitsFetch({ net, env });
    assert.equal(await fetchFn('https://example.com/usage'), 'net-fetch-result');
    assert.equal(calls.length, 1, `${JSON.stringify(env)} should reach Chromium`);
  }

  for (const env of [
    { HTTPS_PROXY: 'http://127.0.0.1:1' },
    { http_proxy: 'http://127.0.0.1:1' },
    { ALL_PROXY: 'http://127.0.0.1:1' },
    { HTTP_PROXY: '"http://127.0.0.1:1"' }
  ]) {
    resetOutboundFetchCache();
    const { calls, net } = recordingNet();
    const fetchFn = createElectronLimitsFetch({ net, env });
    await assert.rejects(() => fetchFn('http://example.invalid/usage'));
    assert.equal(calls.length, 0, `${JSON.stringify(env)} must not fall back to Chromium`);
  }
});

// The account-settings probes decide whether a credential can be saved at all,
// so a probe left on the global fetch refuses to save an account on exactly the
// machines this transport exists for.
test('every widget provider probe takes the runtime transport', () => {
  const main = fs.readFileSync(path.join(__dirname, '..', '..', 'src', 'electron', 'main.js'), 'utf8');

  assert.match(main, /function electronLimitsFetch\(\) \{\s*return createElectronLimitsFetch\(\{ net, env: process\.env \}\);/);
  assert.match(main, /fetch: electronLimitsFetch\(\)/);
  assert.match(main, /opencodeGoApi\.fetchGoApi\(apiKey, \{\s*fetch: electronLimitsFetch\(\)/);
  // Every settings-side validation that can refuse to save a credential.
  for (const call of [
    /opencodeWeb\.fetchGoWeb\([^,]+, electronProviderDeps\(\)\)/,
    /opencodeWeb\.fetchZen\([^,]+, electronProviderDeps\(\)\)/,
    /fetchOllamaLimits\([^,]+, electronProviderDeps\(/,
    /fetchMimoLimits\([^;]+electronProviderDeps\(\)\)/,
    /fetchOpenRouterAccount\([^,]+, [^,]+, electronProviderDeps\(/,
    /fetchThirdPartyAccount\(\{[^}]*\}, electronProviderDeps\(/,
    /listCodexWorkspaces\(auth, electronProviderDeps\(/
  ]) {
    assert.match(main, call);
  }
});
