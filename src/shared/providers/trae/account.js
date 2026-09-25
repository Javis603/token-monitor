'use strict';

// Trae CN limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'trae',
  fetch: 'fetchTraeLimits',
  fields: [
    {
      key: 'traeAccessToken',
      kind: 'credential',
      storePath: ['providers', 'trae', 'accessToken'],
      resolve: 'traeAccessToken',
      envFallback: ['TOKEN_MONITOR_TRAE_ACCESS_TOKEN', 'TRAE_ACCESS_TOKEN'],
      project: 'set'
    },
    {
      key: 'traeDeviceId',
      kind: 'credential',
      storePath: ['providers', 'trae', 'deviceId'],
      resolve: 'traeDeviceId',
      envFallback: ['TOKEN_MONITOR_TRAE_DEVICE_ID', 'TRAE_DEVICE_ID'],
      project: 'set'
    }
  ],
  status: {
    credential: 'traeAccessToken',
    configuredKey: 'traeAccessTokenConfigured',
    sourceKey: 'traeAccessTokenSource',
    pendingKey: 'traePendingCheckSince'
  },
  urlPolicy: [
    { hosts: ['trae.cn', 'www.trae.cn'] }
  ]
};
