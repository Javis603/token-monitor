'use strict';

// Trae CN limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'trae',
  fetch: 'fetchTraeLimits',
  fields: [
    {
      key: 'traeCookie',
      kind: 'credential',
      storePath: ['providers', 'trae', 'cookie'],
      resolve: 'traeCookie',
      envFallback: ['TOKEN_MONITOR_TRAE_COOKIE', 'TRAE_COOKIE'],
      project: 'set'
    },
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
    configuredKey: 'traeAccessTokenConfigured',
    sourceKey: 'traeAccessTokenSource',
    pendingKey: 'traePendingCheckSince'
  },
  accountStatus: ({ settings, env, limits }) => {
    const cookie = limits.traeCookie(env, settings || {});
    const token = limits.traeAccessToken(env, settings || {});
    const cookieSource = settings?.traeCookie ? 'settings' : limits.traeCookie(env) ? 'env' : '';
    const tokenSource = settings?.traeAccessToken ? 'settings' : limits.traeAccessToken(env) ? 'env' : '';
    return {
      traeCookieConfigured: Boolean(cookie),
      traeTokenConfigured: Boolean(token),
      traeAccessTokenConfigured: Boolean(cookie || token),
      traeAccessTokenSource: cookieSource || tokenSource
    };
  },
  form: {
    titleKey: 'settings.trae.title',
    openKey: 'settings.trae.openBrowser',
    clearKey: 'settings.trae.clearCredentials',
    saveKey: 'settings.trae.saveCredentials',
    emptyKey: 'settings.trae.statusNotSet',
    failedKey: 'settings.trae.saveFailed',
    fields: [
      { key: 'traeCookie', input: 'textarea', labelKey: 'settings.trae.cookie', configuredKey: 'traeCookieConfigured', placeholder: 'sessionid=...' },
      { key: 'traeAccessToken', input: 'password', labelKey: 'settings.trae.token', configuredKey: 'traeTokenConfigured', placeholder: 'Cloud-IDE-Token' },
      { key: 'traeDeviceId', input: 'text', labelKey: 'settings.trae.deviceId', placeholderKey: 'settings.trae.deviceIdPlaceholder' }
    ],
    credentialChoice: {
      key: 'traeCredentialKind',
      labelKey: 'settings.common.credentialKind',
      fields: ['traeCookie', 'traeAccessToken']
    },
    manual: [
      { steps: ['settings.trae.step1', 'settings.trae.cookieStep2', 'settings.trae.cookieStep3', 'settings.trae.step4'], whenCredential: 'traeCookie' },
      { field: 'traeCookie', whenCredential: 'traeCookie' },
      {
        whenCredential: 'traeAccessToken',
        steps: [
          'settings.trae.step1',
          ['settings.trae.step2Before', { text: 'www.trae.cn.' }],
          ['settings.trae.step3Before', { code: 'Cloud-IDE-Token' }, 'settings.trae.step3After'],
          'settings.trae.step4'
        ]
      },
      { field: 'traeAccessToken', whenCredential: 'traeAccessToken' },
      { field: 'traeDeviceId', whenCredential: 'traeAccessToken' },
      { note: 'settings.trae.deviceIdNote', whenCredential: 'traeAccessToken' }
    ],
    openUrl: { url: 'https://www.trae.cn' },
    messages: { required: 'settings.trae.missingAuthorization' }
  },
  urlPolicy: [
    { hosts: ['trae.cn', 'www.trae.cn'] }
  ]
};
