'use strict';

// OpenDesign limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'opendesign',
  fetch: 'fetchOpendesignLimits',
  fields: [
    {
      key: 'opendesignCookie',
      kind: 'credential',
      storePath: ['providers', 'opendesign', 'cookie'],
      resolve: 'opendesignCookie',
      normalize: { fn: 'normalizeOpendesignCookieHeader', style: 'value' },
      envFallback: ['TOKEN_MONITOR_OPENDESIGN_COOKIE', 'OPENDESIGN_COOKIE'],
      project: 'set'
    }
  ],
  status: {
    credential: 'opendesignCookie',
    configuredKey: 'opendesignCookieConfigured',
    sourceKey: 'opendesignCookieSource',
    pendingKey: 'opendesignPendingCheckSince'
  },
  form: {
    field: 'opendesignCookie',
    input: 'textarea',
    titleKey: 'settings.opendesign.title',
    openKey: 'settings.opendesign.openBrowser',
    clearKey: 'settings.opendesign.clearCookie',
    placeholderKey: 'settings.opendesign.cookiePlaceholder',
    saveKey: 'settings.opendesign.saveCookie',
    emptyKey: 'settings.opendesign.statusNotSet',
    failedKey: 'settings.opendesign.saveFailed',
    steps: [
      'settings.opendesign.step1',
      'settings.opendesign.step2',
      ['settings.opendesign.step3Before', { code: 'coding-plan-usage' },
        'settings.opendesign.step3Host', { code: 'amr-api.open-design.ai' }, 'settings.opendesign.step3After'],
      'settings.opendesign.step4'
    ],
    url: 'https://open-design.ai/cloud/dashboard'
  },
  urlPolicy: [
    { hosts: ['open-design.ai'], pathPrefixes: ['/cloud/'] }
  ]
};
