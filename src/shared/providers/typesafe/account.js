'use strict';

// TypeSafe limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'typesafe',
  fetch: 'fetchTypesafeLimits',
  fields: [
    {
      key: 'typesafeCookie',
      kind: 'credential',
      storePath: ['providers', 'typesafe', 'cookie'],
      resolve: 'typesafeCookie',
      envFallback: ['TOKEN_MONITOR_TYPESAFE_COOKIE', 'TYPESAFE_COOKIE'],
      project: 'set'
    }
  ],
  status: {
    credential: 'typesafeCookie',
    configuredKey: 'typesafeCookieConfigured',
    sourceKey: 'typesafeCookieSource',
    pendingKey: 'typesafePendingCheckSince'
  },
  form: {
    field: 'typesafeCookie',
    input: 'textarea',
    titleKey: 'settings.typesafe.title',
    openKey: 'settings.typesafe.openBrowser',
    clearKey: 'settings.typesafe.clearCookie',
    placeholderKey: 'settings.typesafe.cookiePlaceholder',
    saveKey: 'settings.typesafe.saveCookie',
    emptyKey: 'settings.typesafe.statusNotSet',
    failedKey: 'settings.typesafe.saveFailed',
    steps: [
      'settings.typesafe.step1',
      'settings.typesafe.step2',
      'settings.typesafe.step3',
      'settings.typesafe.step4'
    ],
    url: 'https://console.typesafe.ai/settings/billing'
  },
  urlPolicy: [
    { hosts: ['console.typesafe.ai'], exactPaths: ['/settings/billing'] }
  ]
};
