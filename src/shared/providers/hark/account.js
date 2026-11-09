'use strict';

// Leaf declaration: credential storage reads this without loading the probe.
module.exports = {
  id: 'hark',
  fetch: 'fetchHarkLimits',
  fields: [{
    key: 'harkCookie',
    kind: 'credential',
    storePath: ['providers', 'hark', 'cookie'],
    resolve: 'harkCookie',
    envFallback: ['TOKEN_MONITOR_HARK_COOKIE', 'HARK_COOKIE'],
    project: 'set'
  }],
  status: {
    credential: 'harkCookie',
    configuredKey: 'harkCookieConfigured',
    sourceKey: 'harkCookieSource',
    pendingKey: 'harkPendingCheckSince'
  },
  form: {
    field: 'harkCookie',
    input: 'textarea',
    titleKey: 'settings.hark.title',
    openKey: 'settings.hark.openBrowser',
    clearKey: 'settings.hark.clearToken',
    placeholderKey: 'settings.hark.tokenPlaceholder',
    saveKey: 'settings.hark.saveToken',
    emptyKey: 'settings.hark.statusNotSet',
    failedKey: 'settings.hark.saveFailed',
    steps: ['settings.hark.step1', 'settings.hark.step2', 'settings.hark.step3', 'settings.hark.step4'],
    url: 'https://hark.com/'
  },
  urlPolicy: [{ hosts: ['hark.com'], exactPaths: ['/'] }]
};
