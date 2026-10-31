'use strict';

// Leaf declaration: credential storage reads this without loading the probe.
module.exports = {
  id: 'museai',
  fetch: 'fetchMuseaiLimits',
  fields: [{
    key: 'museaiCookie', kind: 'credential',
    storePath: ['providers', 'museai', 'cookie'],
    resolve: 'museaiCookie',
    normalize: { fn: 'normalizeMuseaiCookieHeader', style: 'value' },
    envFallback: ['TOKEN_MONITOR_MUSEAI_COOKIE', 'MUSEAI_COOKIE'],
    project: 'set'
  }],
  status: {
    credential: 'museaiCookie', configuredKey: 'museaiCookieConfigured',
    sourceKey: 'museaiCookieSource', pendingKey: 'museaiPendingCheckSince'
  },
  form: {
    fields: [{ key: 'museaiCookie', input: 'textarea', placeholderKey: 'settings.museai.cookiePlaceholder', required: true }],
    titleKey: 'settings.museai.title', openKey: 'settings.museai.openBrowser',
    clearKey: 'settings.museai.clearCookie', placeholderKey: 'settings.museai.cookiePlaceholder',
    saveKey: 'settings.museai.saveCookie', emptyKey: 'settings.museai.statusNotSet',
    failedKey: 'settings.museai.saveFailed',
    messages: { invalidFormat: 'settings.museai.invalidFormat', rejected: 'settings.museai.rejected' },
    manual: [{ note: 'settings.museai.note' }, { steps: ['settings.museai.step1', 'settings.museai.step2', 'settings.museai.step3'] }, { field: 'museaiCookie' }],
    openUrl: { url: 'https://muse.ai/?settings_tab=general' }
  },
  urlPolicy: [{ hosts: ['muse.ai'] }]
};
