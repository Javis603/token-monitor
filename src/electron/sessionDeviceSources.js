'use strict';

const { deviceLabel } = require('./renderer/deviceBreakdown');

// Presentation only: keep provenance out of the accounting/wire session shape.
// Resolve against the captured snapshot before IPC drops device session maps.
function projectSessionDeviceSessions(sessions, devices, periodNames) {
  if (!sessions) return sessions;
  const owners = new Map();
  for (const device of devices || []) {
    for (const name of periodNames) {
      for (const key of Object.keys((device[name] || device.periods?.[name])?.sessions || {})) {
        if (!Object.hasOwn(sessions, key)) continue;
        const previous = owners.get(key);
        if (previous === null) continue;
        owners.set(key, previous && previous.deviceId !== device.deviceId ? null : device);
      }
    }
  }
  return Object.fromEntries(Object.entries(sessions).map(([key, session]) => {
    const device = owners.get(key);
    return [key, device ? { ...session, sourceDevice: {
      deviceId: device.deviceId, name: deviceLabel(device), platform: device.platform || '', deviceKind: device.deviceKind || 'computer'
    } } : session];
  }));
}

function projectSessionDeviceStats(stats, localDeviceId) {
  if (!stats) return stats;
  const devices = stats.devices || [];
  const periods = Object.fromEntries(Object.entries(stats.periods || {}).map(([name, period]) => [name,
    period.sessions ? { ...period, sessions: projectSessionDeviceSessions(period.sessions, devices, [name]) } : period
  ]));
  const local = devices.find(device => device.deviceId === localDeviceId);
  const nativeSessions = local && stats.nativeSessions
    ? Object.fromEntries(Object.entries(stats.nativeSessions).map(([name, sessions]) => [name,
      Object.fromEntries(Object.entries(sessions).map(([key, session]) => [key, {
        ...session, sourceDevice: { deviceId: local.deviceId, name: deviceLabel(local), platform: local.platform || '', deviceKind: local.deviceKind || 'computer' }
      }]))
    ])) : stats.nativeSessions;
  return { ...stats, periods, ...(nativeSessions ? { nativeSessions } : {}) };
}

module.exports = { projectSessionDeviceSessions, projectSessionDeviceStats };
