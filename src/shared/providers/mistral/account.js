'use strict';

module.exports = {
  id: 'mistral',
  fetch: 'fetchMistralLimits',
  fields: [{
    key: 'mistralCookie', kind: 'credential', storePath: ['providers', 'mistral', 'cookie'],
    resolve: 'mistralCookie', envFallback: ['TOKEN_MONITOR_MISTRAL_COOKIE', 'MISTRAL_COOKIE'], project: 'set'
  }],
  status: {
    credential: 'mistralCookie', configuredKey: 'mistralCookieConfigured',
    sourceKey: 'mistralCookieSource', pendingKey: 'mistralPendingCheckSince'
  },
  form: {
    fields: [{ key: 'mistralCookie', input: 'textarea', placeholderKey: 'settings.mistral.cookiePlaceholder', required: true }],
    titleKey: 'settings.mistral.title', openKey: 'settings.mistral.openBrowser',
    clearKey: 'settings.mistral.clearCookie', placeholderKey: 'settings.mistral.cookiePlaceholder',
    saveKey: 'settings.mistral.saveCookie', emptyKey: 'settings.mistral.statusNotSet',
    failedKey: 'settings.mistral.saveFailed',
    manual: [
      { note: 'settings.mistral.note' },
      { steps: ['settings.mistral.step1', 'settings.mistral.step2', 'settings.mistral.step3'] },
      { field: 'mistralCookie' }
    ],
    openUrl: { url: 'https://admin.mistral.ai/subscription' }
  },
  urlPolicy: [{ hosts: ['admin.mistral.ai'], exactPaths: ['/subscription'] }]
};
