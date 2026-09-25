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
  form: {
    titleKey: 'settings.trae.title',
    openKey: 'settings.trae.openBrowser',
    clearKey: 'settings.trae.clearCredentials',
    saveKey: 'settings.trae.saveCredentials',
    emptyKey: 'settings.trae.statusNotSet',
    failedKey: 'settings.trae.saveFailed',
    fields: [
      { key: 'traeAccessToken', input: 'password', labelKey: 'settings.trae.token', placeholder: 'Cloud-IDE-Token', required: true },
      { key: 'traeDeviceId', input: 'text', labelKey: 'settings.trae.deviceId', placeholderKey: 'settings.trae.deviceIdPlaceholder' }
    ],
    manual: [
      {
        steps: [
          'settings.trae.step1',
          ['settings.trae.step2Before', { text: 'www.trae.cn.' }],
          ['settings.trae.step3Before', { code: 'Cloud-IDE-Token' }, 'settings.trae.step3After'],
          'settings.trae.step4'
        ]
      },
      { field: 'traeAccessToken' },
      { field: 'traeDeviceId' },
      { note: 'settings.trae.deviceIdNote' }
    ],
    openUrl: { url: 'https://www.trae.cn' },
    messages: { required: 'settings.trae.missingAuthorization' }
  },
  urlPolicy: [
    { hosts: ['trae.cn', 'www.trae.cn'] }
  ]
};
