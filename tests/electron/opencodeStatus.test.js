'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const vm = require('node:vm');
const web = require('../../src/shared/providers/opencode/web');

// Execute the actual IPC handler with synthetic runtime dependencies. Loading
// Electron main itself would launch the app and read real credentials.
function statusHandler({ profiles = {}, env = {}, fetch, apiStatus = 'ok' } = {}) {
  const main = fs.readFileSync(path.join(__dirname, '../../src/electron/main.js'), 'utf8');
  const start = main.indexOf("ipcMain.handle('opencode:status'");
  const end = main.indexOf("ipcMain.handle('opencode:getProfiles'", start);
  let handler;
  vm.runInNewContext(main.slice(start, end), {
    ipcMain: { handle: (_name, callback) => { handler = callback; } },
    Date, Object, Boolean, Promise,
    settings: { opencodeProfiles: profiles },
    process: { env },
    opencodeStatusCache: { value: null, at: 0 }, CURSOR_STATUS_TTL_MS: 1000,
    opencodeGoApi: { readGoApiKey: () => '' },
    opencodeProfiles: { ambientKeyFor: () => '' },
    opencodeAmbientKeyActive: () => false,
    opencodeWeb: web,
    electronProviderDeps: () => ({ fetch, env: {} }),
    probeOpenCodeApiKey: async () => ({ status: apiStatus })
  });
  return handler;
}

const cookie = '__Host-console_session=fixture';
function transport(url, init) {
  const body = new URL(url).pathname.endsWith('/orgs') ? [{ id: 'org_FIXTURE' }]
    : new URL(url).pathname.endsWith('/go/status') ? { access: null }
      : { billingMode: 'prepaid', mode: 'pay-as-you-go', balanceMicroCents: '0' };
  if (init.headers.Cookie.includes('broken-fixture')) throw new Error('net::ERR_CERT_AUTHORITY_INVALID');
  return Promise.resolve({ status: 200, text: async () => JSON.stringify(body) });
}

for (const brokenEnv of [false, true]) test(`one TLS-failed ${brokenEnv ? 'environment' : 'profile'} cookie cannot reject healthy settings accounts`, async () => {
  const handler = statusHandler({ profiles: {
    healthy: { enabled: true, cookie },
    ...(!brokenEnv ? { broken: { enabled: true, cookie: '__Host-console_session=broken-fixture' } } : {})
  }, env: brokenEnv ? { TOKEN_MONITOR_OPENCODE_COOKIE: '__Host-console_session=broken-fixture' } : {}, fetch: transport });
  const result = await handler();
  assert.equal(result.profiles.healthy.zen, true);
  assert.equal(result.profiles.healthy.balanceUsd, 0);
  const failed = result.profiles[brokenEnv ? 'env' : 'broken'];
  assert.equal(failed.error, 'unavailable');
  assert.equal(failed.linked, false);
});

test('a settings profile retains its valid Go API result when its Cookie has a TLS failure', async () => {
  const handler = statusHandler({ profiles: { combined: {
    enabled: true, cookie: '__Host-console_session=broken-fixture', apiKey: 'fixture-key'
  } }, fetch: transport });
  const result = await handler();
  assert.equal(result.profiles.combined.go, true);
  assert.equal(result.profiles.combined.expired, false);
  assert.equal(result.profiles.combined.zen, false);
});

test('settings source isolation still propagates cancellation', async () => {
  const reason = Object.assign(new Error('cancelled'), { name: 'AbortError' });
  const handler = statusHandler({ profiles: {
    account: { enabled: true, cookie }
  }, fetch: async () => { throw reason; } });
  await assert.rejects(handler(), error => error === reason);
});
