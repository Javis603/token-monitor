'use strict';

// Zed limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'zed',
  fetch: 'fetchZedLimits',
  fields: [
    {
      key: 'zedCookie',
      kind: 'credential',
      storePath: ['providers', 'zed', 'cookie'],
      resolve: 'zedCookie',
      envFallback: ['TOKEN_MONITOR_ZED_COOKIE', 'ZED_COOKIE'],
      project: 'set'
    }
  ],
  status: {
    credential: 'zedCookie',
    configuredKey: 'zedCookieConfigured',
    sourceKey: 'zedCookieSource',
    pendingKey: 'zedPendingCheckSince'
  },
  form: {
    field: 'zedCookie',
    input: 'textarea',
    titleKey: 'settings.zed.title',
    openKey: 'settings.zed.openBrowser',
    clearKey: 'settings.zed.clearCookie',
    placeholderKey: 'settings.zed.cookiePlaceholder',
    saveKey: 'settings.zed.saveCookie',
    emptyKey: 'settings.zed.statusNotSet',
    failedKey: 'settings.zed.saveFailed',
    steps: [
      'settings.zed.step1',
      'settings.zed.step2',
      'settings.zed.step3',
      'settings.zed.step4'
    ],
    url: 'https://dashboard.zed.dev/'
  },
  urlPolicy: [
    { hosts: ['dashboard.zed.dev'] }
  ]
};
