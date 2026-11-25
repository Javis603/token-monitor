// @ts-check
'use strict';

// CodingPass limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'codingpass',
  accountSlots: true,
  serverAccountKey: 'isCodingpassServerAccountKey',
  sources: [
    { id: 'web', kind: 'web', relation: 'single', products: ['codingpass'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' }
  ],
  fetch: 'fetchCodingpassLimits',
  fields: [
    {
      key: 'codingpassCookie',
      kind: 'credential',
      storePath: ['providers', 'codingpass', 'cookie'],
      resolve: 'codingpassCookie',
      normalize: { fn: 'normalizeCodingpassCookieHeader', style: 'value' },
      envFallback: ['TOKEN_MONITOR_CODINGPASS_COOKIE', 'CODINGPASS_COOKIE'],
      project: 'set'
    }
  ],
  status: {
    credential: 'codingpassCookie',
    configuredKey: 'codingpassCookieConfigured',
    sourceKey: 'codingpassCookieSource',
    pendingKey: 'codingpassPendingCheckSince'
  },
  form: {
    field: 'codingpassCookie',
    input: 'textarea',
    titleKey: 'settings.codingpass.title',
    openKey: 'settings.codingpass.openBrowser',
    clearKey: 'settings.codingpass.clearCookie',
    placeholderKey: 'settings.codingpass.cookiePlaceholder',
    saveKey: 'settings.codingpass.saveCookie',
    emptyKey: 'settings.codingpass.statusNotSet',
    failedKey: 'settings.codingpass.saveFailed',
    steps: [
      'settings.codingpass.step1',
      'settings.codingpass.step2',
      ['settings.codingpass.step3Before', { code: 'usage' }, 'settings.codingpass.step3After'],
      'settings.codingpass.step4'
    ],
    url: 'https://codingpass.ai/app'
  },
  urlPolicy: [
    { hosts: ['codingpass.ai'], exactPaths: ['/app'] }
  ]
});
