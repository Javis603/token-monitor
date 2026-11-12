'use strict';

const os = require('node:os');
const { createLanBrowser } = require('./lanDiscoveryBridge');
const {
  discoveryStatusPayload,
  networkInterfaceSignature,
  normalizeDiscoveredHub,
  resolveClientHubUrl
} = require('./lanLink');

const DEFAULT_POLL_MS = 3000;

function sameHub(left, right) {
  if (!left || !right) return false;
  return left.port === right.port
    && left.name === right.name
    && left.addresses.join(',') === right.addresses.join(',');
}

// Owns the mDNS browser lifetime: browse while this desktop is in client mode,
// track the bound hub's currently resolved address, and restart discovery when
// the OS interface set changes (There is no interface-change event on Electron).
function createLanLinkRuntime({
  createBrowser = (handlers) => createLanBrowser(handlers),
  getSettings = () => ({}),
  networkSignature = () => networkInterfaceSignature(os.networkInterfaces()),
  pollMs = DEFAULT_POLL_MS,
  now = () => Date.now(),
  logger = console,
  onDiscoveryChange = () => {},
  onBoundChange = () => {},
  onNetworkChange = () => {}
} = {}) {
  const hubs = new Map();
  let browser = null;
  let running = false;
  let networkTimer = null;
  let networkKey = '';
  let boundUrl = null;
  let unavailable = false;

  function hubList() {
    return Array.from(hubs.values());
  }

  function safeSignature() {
    try {
      return String(networkSignature() || '');
    } catch (_) {
      return '';
    }
  }

  function status() {
    return discoveryStatusPayload({
      hubs: hubList(),
      hubLink: getSettings()?.hubLink,
      resolvedUrl: boundUrl,
      available: !unavailable
    });
  }

  function publish() {
    if (!running) return;
    try {
      onDiscoveryChange(status());
    } catch (error) {
      logger.warn?.(`[lan-link] discovery callback failed: ${error?.message || error}`);
    }
  }

  function resolved() {
    const settings = getSettings() || {};
    if (settings.hubMode !== 'client') return { url: null, source: 'none', hub: null };
    return resolveClientHubUrl(settings, hubList());
  }

  function recompute({ notify = true } = {}) {
    const next = resolved();
    const previousUrl = boundUrl;
    boundUrl = next.url;
    if (notify && previousUrl !== next.url) {
      try {
        onBoundChange({ url: next.url, previousUrl, hub: next.hub, source: next.source });
      } catch (error) {
        logger.warn?.(`[lan-link] address change callback failed: ${error?.message || error}`);
      }
    }
    return next;
  }

  function handleHub(value) {
    if (!running) return;
    const hub = normalizeDiscoveredHub(value);
    if (!hub) return;
    const existing = hubs.get(hub.hubId);
    const next = { ...hub, lastSeenAt: hub.lastSeenAt || new Date(now()).toISOString() };
    hubs.set(hub.hubId, next);
    // A re-query that repeats a known advertisement is not a change; ignore it
    // so an idle LAN does not wake the renderer every refresh.
    if (existing && sameHub(existing, next)) return;
    publish();
    recompute();
  }

  function handleExpire(hubId) {
    if (!running) return;
    const id = String(hubId || '').trim().toLowerCase();
    if (!hubs.delete(id)) return;
    publish();
    recompute();
  }

  function startBrowser() {
    if (browser) return true;
    let handle = null;
    try {
      handle = createBrowser({ onHub: handleHub, onExpire: handleExpire, logger });
    } catch (error) {
      logger.warn?.(`[lan-link] could not start LAN discovery: ${error?.message || error}`);
    }
    if (!handle || typeof handle.start !== 'function') {
      unavailable = true;
      return false;
    }
    try {
      handle.start();
    } catch (error) {
      logger.warn?.(`[lan-link] LAN discovery failed to start: ${error?.message || error}`);
      unavailable = true;
      return false;
    }
    browser = handle;
    unavailable = false;
    return true;
  }

  function stopBrowser() {
    const handle = browser;
    browser = null;
    hubs.clear();
    if (!handle) return;
    try {
      handle.stop?.();
    } catch (error) {
      logger.warn?.(`[lan-link] LAN discovery failed to stop: ${error?.message || error}`);
    }
  }

  function restartBrowser() {
    if (!running) return false;
    stopBrowser();
    const started = startBrowser();
    publish();
    recompute();
    return started;
  }

  function stopNetworkWatch() {
    if (!networkTimer) return;
    clearInterval(networkTimer);
    networkTimer = null;
    networkKey = '';
  }

  function startNetworkWatch() {
    if (networkTimer) return;
    networkKey = safeSignature();
    networkTimer = setInterval(() => {
      if (!running) {
        stopNetworkWatch();
        return;
      }
      const next = safeSignature();
      if (next === networkKey) return;
      networkKey = next;
      restartBrowser();
      try {
        onNetworkChange();
      } catch (error) {
        logger.warn?.(`[lan-link] network change callback failed: ${error?.message || error}`);
      }
    }, Math.max(250, Number(pollMs) || DEFAULT_POLL_MS));
    networkTimer.unref?.();
  }

  function start() {
    if (running) return false;
    if (getSettings()?.hubMode !== 'client') return false;
    running = true;
    startBrowser();
    startNetworkWatch();
    recompute({ notify: false });
    publish();
    return true;
  }

  function stop() {
    if (!running) return false;
    running = false;
    stopNetworkWatch();
    stopBrowser();
    boundUrl = null;
    unavailable = false;
    return true;
  }

  return {
    start,
    stop,
    isRunning: () => running,
    isAvailable: () => !unavailable,
    hubs: hubList,
    status,
    // The address discovery last resolved for the binding. It advances only
    // when a discovery event, a network change or an explicit caller recompute
    // says it did — never because a caller merely asked for the current URL.
    resolvedUrl: () => boundUrl,
    refresh: () => { try { browser?.refresh?.(); } catch (_) {} },
    recompute: (options) => recompute(options),
    restartBrowser
  };
}

module.exports = { createLanLinkRuntime, DEFAULT_POLL_MS };
