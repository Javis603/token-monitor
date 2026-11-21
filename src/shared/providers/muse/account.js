// @ts-check
'use strict';

// Leaf declaration: credential storage reads this without loading the probe.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'muse',
  accountSlots: true,
  sources: [
    { id: 'cli', kind: 'cli', relation: 'complement', products: ['code'], labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' },
    { id: 'web', kind: 'web', relation: 'complement', products: ['web'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' }
  ],
  fetch: 'fetchMuseLimits',
  fields: [{
    key: 'museWebCookie', kind: 'credential',
    storePath: ['providers', 'muse', 'webCookie'],
    resolve: 'museWebCookie',
    normalize: { fn: 'normalizeMuseWebCookieHeader', style: 'value' },
    envFallback: ['TOKEN_MONITOR_MUSE_WEB_COOKIE', 'MUSE_WEB_COOKIE'],
    project: 'set'
  }],
  status: {
    credential: 'museWebCookie', configuredKey: 'museWebCookieConfigured',
    sourceKey: 'museWebCookieSource', pendingKey: 'museWebPendingCheckSince'
  },
  form: {
    fields: [{ key: 'museWebCookie', input: 'textarea', placeholderKey: 'settings.muse.cookiePlaceholder', required: true }],
    titleKey: 'settings.muse.title', openKey: 'settings.muse.openBrowser',
    clearKey: 'settings.muse.clearCookie', placeholderKey: 'settings.muse.cookiePlaceholder',
    saveKey: 'settings.muse.saveCookie', emptyKey: 'settings.muse.statusNotSet',
    failedKey: 'settings.muse.saveFailed',
    messages: { invalidFormat: 'settings.muse.invalidFormat', rejected: 'settings.muse.rejected' },
    manual: [{ steps: ['settings.muse.step1', 'settings.muse.step2', 'settings.muse.step3', 'settings.muse.step4'] }, { field: 'museWebCookie' }],
    openUrl: { url: 'https://muse.ai/?settings_tab=general' }
  },
  urlPolicy: [{ hosts: ['muse.ai'] }]
});
