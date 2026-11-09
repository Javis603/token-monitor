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
    field: 'harkCookie',
    input: 'textarea',
    titleKey: 'settings.hark.title',
    openKey: 'settings.hark.openBrowser',
    clearKey: 'settings.hark.clearToken',
    placeholderKey: 'settings.hark.tokenPlaceholder',
    saveKey: 'settings.hark.saveToken',
    emptyKey: 'settings.hark.statusNotSet',
    failedKey: 'settings.hark.saveFailed',
    noteKey: 'settings.hark.cookieHint',
    messages: { rejected: 'settings.hark.statusInvalid' },
    url: 'https://hark.com/'
  },
  urlPolicy: [{ hosts: ['hark.com'], exactPaths: ['/'] }]
};
