'use strict';

(function exposeSyncDevicePanel(root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.TokenMonitorSyncDevicePanel = api;
})(typeof window !== 'undefined' ? window : null, function createSyncDevicePanelApi() {
  function hasOwn(object, key) {
    return Object.prototype.hasOwnProperty.call(object || {}, key);
  }

  function timestamp(value) {
    const ms = Date.parse(value || '');
    return Number.isFinite(ms) ? ms : null;
  }

  // In client mode the local entry is this machine's live record, so its own
  // receivedAt is the collection time. syncDisplayStats keeps the Hub's copy as
  // hubReceivedAt (null before the Hub has seen this device), and that is the
  // only time that says the upload actually landed.
  function syncedAt(device, isLocal) {
    if (isLocal && hasOwn(device, 'hubReceivedAt')) return device.hubReceivedAt || '';
    return device.receivedAt || device.updatedAt || '';
  }

  // This device first, then online devices by most recent sync, then offline ones.
  function deviceRows(devices, { localDeviceId = '' } = {}) {
    const localKey = String(localDeviceId || '').trim();
    const list = (Array.isArray(devices) ? devices : [])
      .filter((device) => String(device?.deviceId || '').trim());
    return list
      .map((device) => {
        const key = String(device.deviceId).trim();
        const isLocal = Boolean(localKey) && key === localKey;
        const stale = device.stale === true;
        return {
          key,
          name: String(device.displayName || key).trim(),
          hostname: String(device.hostname || '').trim(),
          platform: String(device.platform || ''),
          osName: String(device.osName || ''),
          osVersion: String(device.osVersion || ''),
          agentVersion: String(device.agentVersion || '').trim(),
          agentRuntime: String(device.agentRuntime || ''),
          syncedAt: syncedAt(device, isLocal),
          isLocal,
          stale,
          canRemove: stale && !isLocal
        };
      })
      .sort((a, b) => (
        Number(b.isLocal) - Number(a.isLocal)
        || Number(a.stale) - Number(b.stale)
        || (timestamp(b.syncedAt) ?? 0) - (timestamp(a.syncedAt) ?? 0)
        || a.key.localeCompare(b.key)
      ));
  }

  function deviceCounts(rows) {
    const list = Array.isArray(rows) ? rows : [];
    return { total: list.length, online: list.filter((row) => !row.stale).length };
  }

  // Client mode only. A client with no Hub URL runs the local collector (mode
  // 'local'), which is "not configured", not a failed connection.
  function clientConnectionState({ mode, streamConnected, failureReason } = {}) {
    if (mode !== 'sync') return 'notConfigured';
    if (streamConnected) return 'connected';
    return failureReason ? 'disconnected' : 'connecting';
  }

  return { clientConnectionState, deviceCounts, deviceRows };
});
