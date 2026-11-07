'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  createHubHttpClient,
  discoveryStatusPayload,
  hubIdentityView,
  hubLinkDestinationChanged,
  hubLinkDestinationKey,
  linksView,
  networkInterfaceSignature,
  normalizeDiscoveredHubs,
  normalizeHubLink,
  pairingStatusView,
  pairingView,
  resolveClientHubUrl
} = require('../../src/electron/lanLink');

const HUB_ID = '0123456789abcdef';
const OTHER_HUB_ID = 'fedcba9876543210';
const SECRET = 'super-secret-value';

function hub(overrides = {}) {
  return {
    hubId: HUB_ID,
    name: 'Studio Mac',
    port: 17321,
    addresses: ['192.168.1.5'],
    lastSeenAt: '2026-11-06T05:00:00.000Z',
    ...overrides
  };
}

function jsonResponse(status, body) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body
  };
}

test('hubLink normalization keeps only a stable id and display name', () => {
  assert.deepEqual(normalizeHubLink({ id: HUB_ID.toUpperCase(), name: '  Studio\n Mac  ' }), {
    id: HUB_ID,
    name: 'Studio Mac'
  });
  assert.equal(normalizeHubLink(null), null);
  assert.equal(normalizeHubLink({ id: 'not-a-hub-id', name: 'x' }), null);
  assert.equal(normalizeHubLink({ id: HUB_ID, name: 'x'.repeat(200) }).name.length, 60);
  assert.deepEqual(normalizeHubLink({ id: HUB_ID }), { id: HUB_ID, name: '' });
});

test('the binding is destination-specific: mode, URL and both secrets invalidate it', () => {
  const base = { hubMode: 'client', hubUrl: 'http://hub.local:17321', secret: 'one', hubHostSecret: 'host' };
  assert.equal(hubLinkDestinationChanged(base, { ...base }), false);
  assert.equal(hubLinkDestinationChanged(base, { ...base, note: 'unrelated' }), false);
  assert.equal(hubLinkDestinationChanged(base, { ...base, hubMode: 'host' }), true);
  assert.equal(hubLinkDestinationChanged(base, { ...base, hubUrl: 'http://other.local:17321' }), true);
  assert.equal(hubLinkDestinationChanged(base, { ...base, secret: 'two' }), true);
  assert.equal(hubLinkDestinationChanged(base, { ...base, hubHostSecret: 'regenerated' }), true);
  // A trailing slash is the same destination, matching the URL normalization
  // every request path already applies.
  assert.equal(hubLinkDestinationKey(base), hubLinkDestinationKey({ ...base, hubUrl: 'http://hub.local:17321  ' }));
});

test('discovery resolves the bound hub by id and falls back to the saved URL', () => {
  const saved = { hubMode: 'client', hubUrl: 'http://saved.local:17321', hubLink: { id: HUB_ID, name: 'Studio' } };
  assert.deepEqual(resolveClientHubUrl(saved, [hub()]), {
    url: 'http://192.168.1.5:17321',
    source: 'discovery',
    hub: normalizeDiscoveredHubs([hub()])[0]
  });
  // A different hub on the network must not hijack the connection.
  assert.deepEqual(resolveClientHubUrl(saved, [hub({ hubId: OTHER_HUB_ID })]), {
    url: 'http://saved.local:17321',
    source: 'saved',
    hub: null
  });
  // Expiry = no entry for the bound id.
  assert.equal(resolveClientHubUrl(saved, []).url, 'http://saved.local:17321');
  // No binding (Worker hub or a hub that never answered /api/link): saved URL.
  assert.deepEqual(resolveClientHubUrl({ hubMode: 'client', hubUrl: 'https://worker.example', hubLink: null }, [hub()]), {
    url: 'https://worker.example',
    source: 'saved',
    hub: null
  });
  assert.deepEqual(resolveClientHubUrl({ hubMode: 'client', hubLink: null }, [hub()]), {
    url: null,
    source: 'none',
    hub: null
  });
});

test('discovery accepts advertised ip:port candidates and prefers the first', () => {
  const hubs = normalizeDiscoveredHubs([hub({ addresses: ['192.168.1.5:17321', '192.168.1.6:17321'] })]);
  assert.deepEqual(hubs[0].addresses, ['192.168.1.5', '192.168.1.6']);
  assert.equal(resolveClientHubUrl({ hubMode: 'client', hubLink: { id: HUB_ID } }, [{ ...hub(), addresses: [] }]).url, null);
  assert.equal(normalizeDiscoveredHubs([hub({ hubId: 'bad' })]).length, 0);
  assert.equal(normalizeDiscoveredHubs([hub({ port: 0 })]).length, 0);
  assert.equal(normalizeDiscoveredHubs([hub({ addresses: ['10.0.0.1'] })]).length, 1);
});

test('network signature covers non-internal IPv4 interfaces deterministically', () => {
  const interfaces = {
    en0: [
      { address: '192.168.1.5', family: 'IPv4', internal: false },
      { address: 'fe80::1', family: 'IPv6', internal: false }
    ],
    lo0: [{ address: '127.0.0.1', family: 'IPv4', internal: true }],
    utun3: [{ address: '100.64.0.9', family: 4, internal: false }]
  };
  const signature = networkInterfaceSignature(interfaces);
  assert.match(signature, /^en0=192\.168\.1\.5\nutun3=100\.64\.0\.9$/);
  assert.equal(signature, networkInterfaceSignature({ ...interfaces }));
  assert.equal(networkInterfaceSignature({}), '');
  // A DHCP change must alter the signature so the poll can restart discovery.
  assert.notEqual(
    networkInterfaceSignature({ en0: [{ address: '192.168.1.99', family: 'IPv4', internal: false }] }),
    networkInterfaceSignature({ en0: [{ address: '192.168.1.5', family: 'IPv4', internal: false }] })
  );
});

test('pairing payloads are display-only and reject malformed codes', () => {
  const pairing = pairingView({
    code: '123456',
    expiresAt: '2026-11-06T05:05:00.000Z',
    ttlMs: 300000,
    link: 'tokenmonitor://pair?v=1&id=0123456789abcdef&code=123456',
    secret: SECRET
  });
  assert.deepEqual(pairing, {
    code: '123456',
    expiresAt: '2026-11-06T05:05:00.000Z',
    ttlMs: 300000,
    link: 'tokenmonitor://pair?v=1&id=0123456789abcdef&code=123456'
  });
  assert.equal(JSON.stringify(pairing).includes(SECRET), false);
  assert.equal(pairingView({ code: '12345' }), null);
  assert.equal(pairingView({ code: '123456' }).link, null);
  assert.equal(pairingView({ code: '123456', link: 'https://evil.example/pair' }).link, null);
  assert.deepEqual(pairingStatusView({ active: false }), { active: false });
  assert.deepEqual(pairingStatusView({ active: true, code: '123456', expiresAt: '2026-11-06T05:05:00.000Z' }), {
    active: true,
    code: '123456',
    expiresAt: '2026-11-06T05:05:00.000Z',
    ttlMs: null,
    link: null
  });
});

test('link and hub projections never forward device tokens or secrets', () => {
  const links = linksView([{
    id: 'android-3f2a',
    name: 'Pixel 9',
    platform: 'android',
    createdAt: '2026-11-06T04:00:00.000Z',
    lastSeenAt: '2026-11-06T05:00:00.000Z',
    token: 'tmk_should-never-cross',
    tokenHash: 'deadbeef'
  }]);
  assert.deepEqual(links, [{
    id: 'android-3f2a',
    name: 'Pixel 9',
    platform: 'android',
    createdAt: '2026-11-06T04:00:00.000Z',
    lastSeenAt: '2026-11-06T05:00:00.000Z'
  }]);
  assert.equal(JSON.stringify(links).includes('tmk_'), false);
  assert.deepEqual(hubIdentityView({ id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'], secret: SECRET }), {
    id: HUB_ID,
    name: 'Studio Mac',
    port: 17321,
    addresses: ['192.168.1.5']
  });
});

test('discovery status payload separates nearby hubs from the bound identity', () => {
  const payload = discoveryStatusPayload({
    hubs: [hub(), hub({ hubId: OTHER_HUB_ID, name: 'Office PC', addresses: ['192.168.1.9'] })],
    hubLink: { id: HUB_ID, name: 'Studio Mac' },
    resolvedUrl: 'http://192.168.1.5:17321',
    available: true
  });
  assert.equal(payload.bound.id, HUB_ID);
  assert.equal(payload.resolvedUrl, 'http://192.168.1.5:17321');
  assert.equal(payload.discovered, true);
  assert.equal(payload.available, true);
  assert.deepEqual(payload.hubs[0], {
    hubId: HUB_ID,
    name: 'Studio Mac',
    port: 17321,
    address: '192.168.1.5',
    url: 'http://192.168.1.5:17321',
    lastSeenAt: '2026-11-06T05:00:00.000Z'
  });
  assert.equal(discoveryStatusPayload({ hubs: [hub()], hubLink: null, resolvedUrl: null }).discovered, false);
  assert.equal(discoveryStatusPayload({ available: false }).available, false);
});

test('the hub HTTP client authenticates with the secret and degrades on missing endpoints', async () => {
  const calls = [];
  const client = createHubHttpClient({
    getConfig: () => ({ url: 'http://hub.local:17321/', secret: SECRET }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      return jsonResponse(200, {
        ok: true,
        pairing: { code: '123456', expiresAt: '2026-11-06T05:05:00.000Z', ttlMs: 300000, link: 'tokenmonitor://pair?v=1' },
        hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] }
      });
    }
  });
  const result = await client.startPairing();
  assert.equal(calls[0].url, 'http://hub.local:17321/api/pair/start');
  assert.equal(calls[0].options.method, 'POST');
  assert.equal(calls[0].options.headers.authorization, `Bearer ${SECRET}`);
  assert.deepEqual(result, {
    ok: true,
    pairing: {
      code: '123456',
      expiresAt: '2026-11-06T05:05:00.000Z',
      ttlMs: 300000,
      link: 'tokenmonitor://pair?v=1'
    },
    hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] }
  });
  assert.equal(JSON.stringify(result).includes(SECRET), false);

  const missing = createHubHttpClient({
    getConfig: () => ({ url: 'http://hub.local:17321', secret: SECRET }),
    fetchImpl: async () => jsonResponse(404, { error: 'not_found' })
  });
  assert.deepEqual(await missing.pairingStatus(), { ok: false, error: 'not_supported', status: 404 });
  assert.deepEqual(await missing.listLinks(), { ok: false, error: 'not_supported', status: 404 });
  assert.deepEqual(await missing.cancelPairing(), { ok: false, error: 'not_supported', status: 404 });

  const unauthorized = createHubHttpClient({
    getConfig: () => ({ url: 'http://hub.local:17321', secret: 'wrong' }),
    fetchImpl: async () => jsonResponse(401, { error: 'unauthorized' })
  });
  assert.deepEqual(await unauthorized.startPairing(), { ok: false, error: 'unauthorized', status: 401 });

  const offline = createHubHttpClient({
    getConfig: () => ({ url: 'http://hub.local:17321', secret: SECRET }),
    fetchImpl: async () => { throw Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' }); }
  });
  assert.deepEqual(await offline.listLinks(), { ok: false, error: 'unreachable' });

  const unconfigured = createHubHttpClient({ getConfig: () => ({ url: '', secret: '' }) });
  assert.deepEqual(await unconfigured.startPairing(), { ok: false, error: 'not_configured' });
});

test('link management calls use authenticated verbs on the documented routes', async () => {
  const calls = [];
  const client = createHubHttpClient({
    getConfig: () => ({ url: 'http://hub.local:17321', secret: SECRET }),
    fetchImpl: async (url, options) => {
      calls.push({ url, options });
      if (url.endsWith('/api/links')) return jsonResponse(200, { ok: true, links: [{ id: 'android-1', name: 'Pixel', platform: 'android' }] });
      if (url.endsWith('/api/link')) return jsonResponse(200, { ok: true, hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] }, role: 'admin', link: null });
      if (url.endsWith('/api/pair/status')) return jsonResponse(200, { ok: true, pairing: { active: false } });
      return jsonResponse(200, { ok: true, id: 'android-1' });
    }
  });
  assert.deepEqual(await client.listLinks(), {
    ok: true,
    links: [{ id: 'android-1', name: 'Pixel', platform: 'android', createdAt: null, lastSeenAt: null }]
  });
  assert.deepEqual(await client.getLink(), {
    ok: true,
    hub: { id: HUB_ID, name: 'Studio Mac', port: 17321, addresses: ['192.168.1.5'] },
    role: 'admin',
    link: null
  });
  assert.deepEqual(await client.pairingStatus(), { ok: true, pairing: { active: false } });
  assert.deepEqual(await client.revokeLink('android-1'), { ok: true, id: 'android-1' });
  const revoke = calls.find((call) => call.url.includes('/api/links/android-1'));
  assert.equal(revoke.options.method, 'DELETE');
  assert.equal(JSON.stringify(await client.getLink()).includes(SECRET), false);
  assert.deepEqual(await client.revokeLink(''), { ok: false, error: 'invalid_device_id' });
});
