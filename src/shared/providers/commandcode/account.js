'use strict';

// Command Code limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'commandcode',
  fetch: 'fetchCommandcodeLimits',
  fields: [
    {
      key: 'commandcodeCookie',
      kind: 'credential',
      storePath: ['providers', 'commandcode', 'cookie'],
      resolve: 'commandcodeCookie',
      project: 'set'
    }
  ],
  status: {
    credential: 'commandcodeCookie',
    configuredKey: 'commandcodeCookieConfigured',
    sourceKey: 'commandcodeCookieSource',
    pendingKey: 'commandcodePendingCheckSince'
  },
  form: {
    field: 'commandcodeCookie',
    input: 'textarea',
    titleKey: 'settings.commandcode.title',
    openKey: 'settings.commandcode.openBrowser',
    clearKey: 'settings.commandcode.clearCookie',
    placeholderKey: 'settings.commandcode.cookiePlaceholder',
    saveKey: 'settings.commandcode.saveCookie',
    emptyKey: 'settings.commandcode.statusNotSet',
    failedKey: 'settings.commandcode.saveFailed',
    steps: [
      'settings.commandcode.step1',
      'settings.commandcode.step2',
      'settings.commandcode.step3',
      'settings.commandcode.step4'
    ],
    // Resolves to /<username>/settings/usage even when signed out.
    url: 'https://commandcode.ai/settings/usage'
  },
  urlPolicy: [
    { hosts: ['commandcode.ai', 'www.commandcode.ai'] }
  ]
};
