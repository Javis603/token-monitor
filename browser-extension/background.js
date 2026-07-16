'use strict';

/* global chrome */

const HEARTBEAT_MS = 15_000;
const LEASE_TTL_MS = 45_000;
const CONFIG_KEY = 'tokenMonitorOccupancyConfig';
const SESSION_STATE_KEY = 'tokenMonitorOccupancySessionState';

const leases = new Map();
const pending = new Map();
const detections = new Map();
const overrides = new Map();
const operations = new Map();
let sessionWrite = Promise.resolve();
let hydration;

function siteFromUrl(value) {
  let url;
  try { url = new URL(String(value || '')); } catch (_) { return null; }
  const hostname = url.hostname.toLowerCase();
  if (hostname === 'chatgpt.com') {
    return { provider: 'chatgpt', mappingKey: 'chatgptCom', hostname };
  }
  if (hostname === 'chat.openai.com') {
    return { provider: 'chatgpt', mappingKey: 'chatOpenaiCom', hostname };
  }
  return null;
}

function normalizeHubUrl(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  let parsed;
  try { parsed = new URL(text); } catch (_) { return ''; }
  if (!['http:', 'https:'].includes(parsed.protocol)) return '';
  parsed.pathname = parsed.pathname.replace(/\/+$/, '');
  parsed.search = '';
  parsed.hash = '';
  return parsed.toString().replace(/\/$/, '');
}

function leaseKey(tabId, provider) {
  return `${Number(tabId)}:${String(provider || '')}`;
}

function buildLeasePayload({ accountId, deviceId, deviceName, idempotencyKey, fenceToken }) {
  return {
    accountId,
    deviceId,
    deviceName: deviceName || '',
    taskLabel: 'ChatGPT web generation',
    source: 'detector',
    confidence: 0.7,
    ttlMs: LEASE_TTL_MS,
    idempotencyKey,
    fenceToken
  };
}

function effectiveActive(detected, override) {
  if (override === 'force-on') return true;
  if (override === 'force-off') return false;
  return Boolean(detected);
}

function authHeaders(secret) {
  return {
    'content-type': 'application/json',
    ...(secret ? { authorization: `Bearer ${secret}` } : {})
  };
}

function parseLeaseResponse(payload, expectedFenceToken = '') {
  const lease = payload?.lease || payload || {};
  const leaseId = String(lease.id || payload?.leaseId || '').trim();
  const fenceToken = String(lease.fenceToken || payload?.fenceToken || '').trim();
  if (!leaseId || !fenceToken) throw new Error('Hub returned an invalid lease response');
  if (expectedFenceToken && fenceToken !== expectedFenceToken) throw new Error('Hub returned an unexpected fence token');
  return { leaseId, fenceToken };
}

function newPendingLease({ accountId, provider, tabId }, cryptoImpl = crypto) {
  const nonce = cryptoImpl.randomUUID();
  return {
    accountId,
    tabId,
    provider,
    idempotencyKey: `browser:${tabId}:${provider}:${nonce}`,
    fenceToken: `${cryptoImpl.randomUUID()}${cryptoImpl.randomUUID()}`
  };
}

async function hubRequest(config, path, init = {}) {
  const hubUrl = normalizeHubUrl(config.hubUrl);
  if (!hubUrl) throw new Error('Hub URL is not configured');
  const response = await fetch(`${hubUrl}${path}`, {
    ...init,
    headers: { ...authHeaders(config.secret), ...(init.headers || {}) }
  });
  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(payload.message || payload.error || `Hub request failed (${response.status})`);
    error.status = response.status;
    error.code = payload.error || '';
    throw error;
  }
  return payload;
}

function readConfig() {
  return new Promise((resolve) => {
    chrome.storage.local.get(CONFIG_KEY, (result) => resolve(result[CONFIG_KEY] || {}));
  });
}

function persistSessionState() {
  const snapshot = {
    leases: Array.from(leases.values(), (lease) => ({
      leaseId: lease.leaseId,
      fenceToken: lease.fenceToken,
      tabId: lease.tabId,
      site: lease.site,
      accountId: lease.accountId
    })),
    pending: Array.from(pending.entries()),
    detections: Array.from(detections.entries()),
    overrides: Array.from(overrides.entries())
  };
  sessionWrite = sessionWrite.catch(() => {}).then(() => (
    chrome.storage.session.set({ [SESSION_STATE_KEY]: snapshot })
  ));
  return sessionWrite;
}

async function hydrateSessionState() {
  const result = await chrome.storage.session.get(SESSION_STATE_KEY);
  const stored = result[SESSION_STATE_KEY] || {};
  for (const lease of Array.isArray(stored.leases) ? stored.leases : []) {
    const tabId = Number(lease?.tabId);
    const site = lease?.site;
    if (!Number.isInteger(tabId) || !site?.provider || !site?.mappingKey || !lease?.leaseId || !lease?.fenceToken) continue;
    leases.set(leaseKey(tabId, site.provider), { ...lease, tabId, site });
  }
  for (const entry of Array.isArray(stored.pending) ? stored.pending : []) {
    const value = entry?.[1];
    if (Array.isArray(entry) && typeof entry[0] === 'string' && value?.idempotencyKey && value?.fenceToken) {
      pending.set(entry[0], value);
    }
  }
  for (const entry of Array.isArray(stored.detections) ? stored.detections : []) {
    if (Array.isArray(entry) && typeof entry[0] === 'string') detections.set(entry[0], Boolean(entry[1]));
  }
  for (const entry of Array.isArray(stored.overrides) ? stored.overrides : []) {
    if (Array.isArray(entry) && typeof entry[0] === 'string' && ['force-on', 'force-off'].includes(entry[1])) {
      overrides.set(entry[0], entry[1]);
    }
  }
}

function ensureHydrated() {
  if (!hydration) hydration = hydrateSessionState();
  return hydration;
}

function accountIdFor(config, site) {
  return String(config.accountIds?.[site.mappingKey] || '').trim();
}

function sendTabStatus(tabId, status) {
  const presentation = status.error
    ? { text: '!', color: '#777777', state: 'error' }
    : status.active
      ? { text: 'ON', color: '#d93025', state: 'active' }
      : { text: '', color: '#188038', state: 'idle' };
  chrome.action.setBadgeBackgroundColor({ tabId, color: presentation.color }).catch(() => {});
  chrome.action.setBadgeText({ tabId, text: presentation.text }).catch(() => {});
  chrome.tabs.sendMessage(tabId, {
    type: 'token-monitor-occupancy-status',
    state: presentation.state,
    active: Boolean(status.active),
    override: status.override || '',
    message: status.error ? String(status.error.message || status.error) : (status.message || '')
  }).catch(() => {});
}

function serializeOperation(key, operation) {
  const previous = operations.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(operation);
  operations.set(key, next);
  next.finally(() => {
    if (operations.get(key) === next) operations.delete(key);
  }).catch(() => {});
  return next;
}

async function acquire(tabId, site) {
  const key = leaseKey(tabId, site.provider);
  if (leases.has(key)) return leases.get(key);
  const config = await readConfig();
  const accountId = accountIdFor(config, site);
  if (!accountId) throw new Error(`No account is mapped for ${site.hostname}`);
  if (!String(config.deviceId || '').trim()) throw new Error('Device ID is not configured');
  let pendingLease = pending.get(key);
  if (!pendingLease || pendingLease.accountId !== accountId) {
    pendingLease = newPendingLease({
      accountId,
      provider: site.provider,
      tabId
    });
    pending.set(key, pendingLease);
    // Persist before the POST so a lost response can retry with the same fence.
    await persistSessionState();
  }
  const payload = await hubRequest(config, '/api/occupancy/leases', {
    method: 'POST',
    body: JSON.stringify(buildLeasePayload({
      accountId,
      deviceId: String(config.deviceId).trim(),
      deviceName: String(config.deviceName || '').trim(),
      tabId,
      idempotencyKey: pendingLease.idempotencyKey,
      fenceToken: pendingLease.fenceToken
    }))
  });
  const token = parseLeaseResponse(payload, pendingLease.fenceToken);
  const lease = { ...token, tabId, site, accountId, config };
  leases.set(key, lease);
  pending.delete(key);
  await persistSessionState();
  return lease;
}

async function release(tabId, provider, reason = 'generation_finished') {
  const key = leaseKey(tabId, provider);
  const lease = leases.get(key);
  pending.delete(key);
  if (!lease) {
    await persistSessionState();
    return;
  }
  leases.delete(key);
  await persistSessionState();
  const config = lease.config || await readConfig();
  await hubRequest(config, `/api/occupancy/leases/${encodeURIComponent(lease.leaseId)}`, {
    method: 'DELETE',
    body: JSON.stringify({ fenceToken: lease.fenceToken, reason })
  });
}

async function heartbeatLease(key, lease) {
  try {
    const config = lease.config || await readConfig();
    await hubRequest(config, `/api/occupancy/leases/${encodeURIComponent(lease.leaseId)}/heartbeat`, {
      method: 'POST',
      body: JSON.stringify({ fenceToken: lease.fenceToken, ttlMs: LEASE_TTL_MS })
    });
  } catch (error) {
    if (error.status === 404 || error.code === 'fence_token_invalid') {
      leases.delete(key);
      await persistSessionState();
    }
    throw error;
  }
}

async function reconcile(tabId, site) {
  const key = leaseKey(tabId, site.provider);
  const desired = effectiveActive(detections.get(key), overrides.get(key));
  try {
    if (desired && leases.has(key)) await heartbeatLease(key, leases.get(key));
    else if (desired) await acquire(tabId, site);
    else await release(tabId, site.provider);
    sendTabStatus(tabId, {
      active: leases.has(key),
      override: overrides.get(key),
      message: overrides.has(key) ? 'Manual override' : 'Automatic detection'
    });
  } catch (error) {
    sendTabStatus(tabId, { active: leases.has(key), override: overrides.get(key), error });
  }
}

async function handleDetection(message, sender) {
  await ensureHydrated();
  const tabId = sender.tab?.id;
  const site = siteFromUrl(sender.tab?.url || message.url);
  if (!Number.isInteger(tabId) || !site || message.provider !== site.provider) return;
  const key = leaseKey(tabId, site.provider);
  const previous = detections.get(key);
  detections.set(key, Boolean(message.active));
  if (!message.active && previous === true && overrides.get(key) === 'force-off') {
    overrides.delete(key);
    await persistSessionState();
  }
  await serializeOperation(key, () => reconcile(tabId, site));
}

async function handleOverride(message, sender) {
  await ensureHydrated();
  const tabId = sender.tab?.id;
  const site = siteFromUrl(sender.tab?.url || message.url);
  if (!Number.isInteger(tabId) || !site) return;
  const key = leaseKey(tabId, site.provider);
  if (message.action === 'acquire') overrides.set(key, 'force-on');
  else if (message.action === 'release') overrides.set(key, 'force-off');
  else if (message.action === 'auto') overrides.delete(key);
  else return;
  await persistSessionState();
  await serializeOperation(key, () => reconcile(tabId, site));
}

async function clearTab(tabId, reason) {
  await ensureHydrated();
  const matching = new Set();
  for (const key of [...leases.keys(), ...pending.keys(), ...detections.keys(), ...overrides.keys()]) {
    if (key.startsWith(`${tabId}:`)) matching.add(key);
  }
  await Promise.all(Array.from(matching, async (key) => {
    const provider = key.slice(key.indexOf(':') + 1);
    try {
      await serializeOperation(key, () => release(tabId, provider, reason));
    } finally {
      detections.delete(key);
      overrides.delete(key);
    }
  }));
  await persistSessionState();
}

function registerBackground() {
  hydration = hydrateSessionState();
  chrome.runtime.onInstalled.addListener(async () => {
    const config = await readConfig();
    if (!config.deviceId) {
      const deviceId = crypto.randomUUID ? crypto.randomUUID() : `browser-${Date.now()}`;
      await chrome.storage.local.set({ [CONFIG_KEY]: { ...config, deviceId } });
    }
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    const work = message?.type === 'token-monitor-occupancy-detection'
      ? handleDetection(message, sender)
      : message?.type === 'token-monitor-occupancy-override'
        ? handleOverride(message, sender)
        : null;
    if (!work) return false;
    work.then(() => sendResponse({ ok: true })).catch((error) => sendResponse({ ok: false, error: error.message }));
    return true;
  });

  chrome.tabs.onRemoved.addListener((tabId) => { clearTab(tabId, 'tab_closed').catch(() => {}); });
  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === 'loading' || (changeInfo.url && !siteFromUrl(changeInfo.url))) {
      clearTab(tabId, 'navigation').catch(() => {});
    }
  });
}

if (typeof chrome !== 'undefined' && chrome.runtime?.onMessage) registerBackground();

if (typeof module === 'object' && module.exports) {
  module.exports = {
    HEARTBEAT_MS,
    LEASE_TTL_MS,
    CONFIG_KEY,
    SESSION_STATE_KEY,
    siteFromUrl,
    normalizeHubUrl,
    leaseKey,
    buildLeasePayload,
    effectiveActive,
    authHeaders,
    parseLeaseResponse,
    newPendingLease
  };
}
