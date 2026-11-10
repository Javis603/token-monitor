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
  discover: (_env, limits) => {
    try {
      return Boolean(limits.readHarkDesktopSession());
    } catch (error) {
      return error?.status === 'unavailable';
    }
  },
  status: {
    credential: 'harkCookie',
    configuredKey: 'harkCookieConfigured',
    sourceKey: 'harkCookieSource',
    pendingKey: 'harkPendingCheckSince'
  },
  accountStatus: ({ settings, env, discovered, limits }) => ({
    harkCookieConfigured: Boolean(settings?.harkCookie || limits.harkCookie(env) || discovered),
    harkCookieSource: settings?.harkCookie ? 'settings' : limits.harkCookie(env) ? 'env' : discovered ? 'hark-desktop' : ''
  }),
  form: {
    titleKey: 'settings.hark.title',
    openKey: 'settings.hark.openBrowser',
    clearKey: 'settings.hark.clearToken',
    saveKey: 'settings.hark.saveToken',
    emptyKey: 'settings.hark.statusNotSet',
    failedKey: 'settings.hark.saveFailed',
    fields: [{
      key: 'harkCookie',
      input: 'textarea',
      placeholderKey: 'settings.hark.tokenPlaceholder',
      required: true
    }],
    manual: [
      { steps: ['settings.hark.step1', 'settings.hark.step2', 'settings.hark.step3', 'settings.hark.step4'] },
      { field: 'harkCookie' }
    ],
    messages: { rejected: 'settings.hark.statusInvalid' },
    openUrl: { url: 'https://hark.com/' }
  },
  urlPolicy: [{ hosts: ['hark.com'], exactPaths: ['/'] }]
};
