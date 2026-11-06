'use strict';

// Desktop half of LAN link v1: identity/URL resolution, the authenticated hub
// pairing client and the renderer projections. Everything here is pure or takes
// its transport from the caller so it can be unit-tested without Electron.

const HUB_ID_PATTERN = /^[a-f0-9]{16}$/;
const HUB_NAME_MAX = 60;
const LINK_NAME_MAX = 80;
const HUB_ADDRESS_MAX = 4;
const PAIRING_CODE_PATTERN = /^\d{6}$/;

function singleLine(value) {
  return String(value ?? '').replace(/[\r\n\t]+/g, ' ').replace(/\s+/g, ' ').trim();
}

function normalizeHubLink(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim().toLowerCase();
  if (!HUB_ID_PATTERN.test(id)) return null;
  return { id, name: singleLine(value.name).slice(0, HUB_NAME_MAX) };
}

function hubLinkDestinationKey(sourceSettings = {}) {
  return JSON.stringify([
    String(sourceSettings?.hubMode || ''),
    String(sourceSettings?.hubUrl || '').trim(),
    String(sourceSettings?.secret || ''),
    String(sourceSettings?.hubHostSecret || '')
  ]);
}

// The binding names a destination, so any edit to how this desktop reaches the
// hub invalidates it. A discovered-address change does not: the hubId still
// matches and that is exactly the case auto-connect exists for.
function hubLinkDestinationChanged(previous, next) {
  return hubLinkDestinationKey(previous) !== hubLinkDestinationKey(next);
}

function isIpv4(value) {
  const parts = String(value || '').split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

// The advertiser advertises `addrs=<ip:port>,...` while the browser payload is
// `addresses: string[]`. Accept either so a small difference in the module's
// projection cannot break URL resolution.
function normalizeHubAddressHost(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const withoutBrackets = raw.startsWith('[') ? raw.slice(0, raw.indexOf(']') + 1) : raw;
  const host = withoutBrackets.startsWith('[')
    ? withoutBrackets.slice(1, -1)
    : withoutBrackets.split(':')[0];
  return isIpv4(host) ? host : '';
}

function normalizeDiscoveredHub(value) {
  if (!value || typeof value !== 'object') return null;
  const hubId = String(value.hubId || '').trim().toLowerCase();
  if (!HUB_ID_PATTERN.test(hubId)) return null;
  const port = Number(value.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
  const addresses = [];
  for (const entry of Array.isArray(value.addresses) ? value.addresses : []) {
    const host = normalizeHubAddressHost(entry);
    if (host && !addresses.includes(host)) addresses.push(host);
    if (addresses.length >= HUB_ADDRESS_MAX) break;
  }
  if (addresses.length === 0) return null;
  return {
    hubId,
    name: singleLine(value.name).slice(0, HUB_NAME_MAX) || hubId,
    port,
    addresses,
    lastSeenAt: typeof value.lastSeenAt === 'string' ? value.lastSeenAt : null
  };
}

function normalizeDiscoveredHubs(values) {
  const hubs = [];
  const seen = new Set();
  for (const value of Array.isArray(values) ? values : []) {
    const hub = normalizeDiscoveredHub(value);
    if (!hub || seen.has(hub.hubId)) continue;
    seen.add(hub.hubId);
    hubs.push(hub);
  }
  return hubs;
}

function discoveredHubUrl(hub) {
  const host = hub?.addresses?.[0];
  if (!host) return null;
  return `http://${host}:${hub.port}`;
}

// Client mode prefers the address discovery currently reports for the bound
// hub. Without a binding — or while the hub is not on the network — the saved
// URL stays authoritative, which also keeps Worker hubs working unchanged.
function resolveClientHubUrl(sourceSettings = {}, hubs = []) {
  const savedUrl = String(sourceSettings?.hubUrl || '').trim() || null;
  const link = normalizeHubLink(sourceSettings?.hubLink);
  if (link) {
    const match = normalizeDiscoveredHubs(hubs).find((hub) => hub.hubId === link.id);
    const url = match ? discoveredHubUrl(match) : null;
    if (url) return { url, source: 'discovery', hub: match };
  }
  return { url: savedUrl, source: savedUrl ? 'saved' : 'none', hub: null };
}

// DHCP and Wi-Fi changes have no Electron event. The signature covers exactly
// what discovery depends on: non-internal IPv4 interface addresses.
function networkInterfaceSignature(interfaces) {
  const rows = [];
  for (const name of Object.keys(interfaces || {}).sort()) {
    for (const entry of interfaces[name] || []) {
      if (!entry || entry.internal) continue;
      const family = typeof entry.family === 'string' ? entry.family : entry.family === 4 ? 'IPv4' : 'IPv6';
      if (family !== 'IPv4') continue;
      const address = String(entry.address || '');
      if (!address) continue;
      rows.push(`${name}=${address}`);
    }
  }
  return rows.sort().join('\n');
}

function normalizeAddressList(values) {
  const addresses = [];
  for (const value of Array.isArray(values) ? values : []) {
    const address = singleLine(value);
    if (address && !addresses.includes(address)) addresses.push(address);
  }
  return addresses;
}

// Renderer projection of the hub identity. Never carries a secret, token or
// full URL with credentials; the UI only needs the display name and port.
function hubIdentityView(value) {
  if (!value || typeof value !== 'object') return null;
  const id = String(value.id || '').trim().toLowerCase();
  const port = Number(value.port);
  const identity = {
    id: HUB_ID_PATTERN.test(id) ? id : '',
    name: singleLine(value.name).slice(0, HUB_NAME_MAX),
    port: Number.isInteger(port) && port >= 1 && port <= 65535 ? port : null,
    addresses: normalizeAddressList(value.addresses)
  };
  if (!identity.id && !identity.name && !identity.port) return null;
  return identity;
}

function normalizeIsoTimestamp(value) {
  if (typeof value !== 'string' || !value.trim()) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function pairingView(value) {
  if (!value || typeof value !== 'object') return null;
  const code = String(value.code || '').trim();
  if (!PAIRING_CODE_PATTERN.test(code)) return null;
  const ttl = Number(value.ttlMs);
  const link = typeof value.link === 'string' && /^tokenmonitor:\/\/pair\?/.test(value.link) ? value.link : null;
  return {
    code,
    expiresAt: normalizeIsoTimestamp(value.expiresAt),
    ttlMs: Number.isFinite(ttl) && ttl > 0 ? Math.min(ttl, 24 * 60 * 60 * 1000) : null,
    link
  };
}

function pairingStatusView(value) {
  if (!value || typeof value !== 'object' || value.active !== true) return { active: false };
  const pairing = pairingView(value);
  if (!pairing) return { active: false };
  return { active: true, ...pairing };
}

function linksView(values) {
  return (Array.isArray(values) ? values : []).map((value) => {
    if (!value || typeof value !== 'object') return null;
    const id = String(value.id || '').trim();
    if (!id) return null;
    return {
      id,
      name: singleLine(value.name).slice(0, LINK_NAME_MAX) || id,
      platform: singleLine(value.platform).slice(0, 32) || 'unknown',
      createdAt: normalizeIsoTimestamp(value.createdAt),
      lastSeenAt: normalizeIsoTimestamp(value.lastSeenAt)
    };
  }).filter(Boolean);
}

// Renderer payload for the discovery surfaces: nearby hubs (address only, no
// credentials) plus what the bound link currently resolves to.
function discoveryStatusPayload({ hubs = [], hubLink = null, resolvedUrl = null, available = true } = {}) {
  const normalized = normalizeDiscoveredHubs(hubs);
  const bound = normalizeHubLink(hubLink);
  const matched = bound ? normalized.find((hub) => hub.hubId === bound.id) || null : null;
  return {
    hubs: normalized.map((hub) => ({
      hubId: hub.hubId,
      name: hub.name,
      port: hub.port,
      address: hub.addresses[0],
      url: discoveredHubUrl(hub),
      lastSeenAt: hub.lastSeenAt
    })),
    bound,
    resolvedUrl: singleLine(resolvedUrl).slice(0, 2048) || null,
    discovered: Boolean(matched),
    available: available !== false
  };
}

async function readJsonResponse(response) {
  try {
    return await response.json();
  } catch (_) {
    return null;
  }
}

function payloadErrorCode(payload) {
  const code = typeof payload?.error === 'string' ? payload.error.trim() : '';
  return code || '';
}

// Authenticated calls to the hub's pairing/link endpoints. Used by client mode
// and as the fallback for an embedded hub whose object does not expose the
// in-process pairing methods. Returns plain result records; the raw response
// body (which may include credentials like a device token on other routes) is
// never returned to renderer-facing callers.
function createHubHttpClient({ getConfig = () => ({ url: null, secret: '' }), fetchImpl = fetch, timeoutMs = 5000 } = {}) {
  async function request(method, path, body) {
    const config = getConfig() || {};
    const base = String(config.url || '').trim().replace(/\/$/, '');
    if (!base) return { ok: false, error: 'not_configured' };
    const headers = { accept: 'application/json' };
    if (config.secret) headers.authorization = `Bearer ${config.secret}`;
    if (body !== undefined) headers['content-type'] = 'application/json';
    let response;
    try {
      response = await fetchImpl(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        ...(timeoutMs > 0 && typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function'
          ? { signal: AbortSignal.timeout(timeoutMs) }
          : {})
      });
    } catch (error) {
      const name = error?.name || '';
      return { ok: false, error: name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable' };
    }
    const status = Number(response?.status) || 0;
    const payload = await readJsonResponse(response);
    if (status === 404) return { ok: false, error: 'not_supported', status };
    if (!response?.ok) {
      return { ok: false, error: payloadErrorCode(payload) || `http_${status}`, status };
    }
    if (!payload || typeof payload !== 'object') return { ok: false, error: 'invalid_response', status };
    return { ok: payload.ok !== false, status, payload };
  }

  return {
    async startPairing() {
      const result = await request('POST', '/api/pair/start');
      if (!result.ok) return result;
      return {
        ok: true,
        pairing: pairingView(result.payload.pairing),
        hub: hubIdentityView(result.payload.hub)
      };
    },
    async pairingStatus() {
      const result = await request('GET', '/api/pair/status');
      if (!result.ok) return result;
      return { ok: true, pairing: pairingStatusView(result.payload.pairing) };
    },
    async cancelPairing() {
      const result = await request('POST', '/api/pair/cancel');
      if (!result.ok) return result;
      return { ok: true };
    },
    async listLinks() {
      const result = await request('GET', '/api/links');
      if (!result.ok) return result;
      return { ok: true, links: linksView(result.payload.links) };
    },
    async revokeLink(deviceId) {
      const id = String(deviceId || '').trim();
      if (!id) return { ok: false, error: 'invalid_device_id' };
      const result = await request('DELETE', `/api/links/${encodeURIComponent(id)}`);
      if (!result.ok) return result;
      return { ok: true, id: String(result.payload.id || id) };
    },
    async getLink() {
      const result = await request('GET', '/api/link');
      if (!result.ok) return result;
      return {
        ok: true,
        hub: hubIdentityView(result.payload.hub),
        role: result.payload.role === 'device' ? 'device' : 'admin',
        link: linksView(result.payload.link ? [result.payload.link] : [])[0] || null
      };
    }
  };
}

module.exports = {
  PAIRING_CODE_PATTERN,
  createHubHttpClient,
  discoveryStatusPayload,
  discoveredHubUrl,
  hubIdentityView,
  hubLinkDestinationChanged,
  hubLinkDestinationKey,
  linksView,
  networkInterfaceSignature,
  normalizeDiscoveredHub,
  normalizeDiscoveredHubs,
  normalizeHubAddressHost,
  normalizeHubLink,
  pairingStatusView,
  pairingView,
  resolveClientHubUrl
};
