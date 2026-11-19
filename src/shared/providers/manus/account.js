// @ts-check
'use strict';

// Leaf declaration: shared credential storage and forms bind these names.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'manus',
  sourceSelection: { sources: ['web', 'local'], slotSources: { credentials: { manusSessionToken: 'web' }, discovered: 'local' } },
  accountSlots: true,
  sources: [
    { id: 'web', kind: 'web', relation: 'alternative', products: ['manus'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' },
    { id: 'local', kind: 'desktop', relation: 'alternative', products: ['manus'], labelKey: 'settings.limits.sources.desktop', descriptionKey: 'settings.limits.sources.desktopDescription' }
  ],
  fetch: 'fetchManusLimits',
  fields: [{
    key: 'manusSessionToken',
    kind: 'credential',
    storePath: ['providers', 'manus', 'sessionToken'],
    resolve: 'manusSessionToken',
    normalize: { fn: 'normalizeManusSessionToken', style: 'value' },
    envFallback: ['TOKEN_MONITOR_MANUS_SESSION_TOKEN', 'MANUS_SESSION_TOKEN', 'MANUS_COOKIE'],
    project: 'set'
  }],
  discover: (_env, limits) => {
    try {
      return Boolean(limits.readManusDesktopSession());
    } catch (error) {
      return (/** @type {{status?: string}|null|undefined} */ (error))?.status === 'unavailable';
    }
  },
  accountStatus: ({ settings, env, discovered, limits }) => ({
    manusSessionTokenConfigured: Boolean(settings?.manusSessionToken || limits.manusSessionToken(env) || discovered),
    manusSessionTokenSource: settings?.manusSessionToken ? 'settings' : limits.manusSessionToken(env) ? 'env' : discovered ? 'manus-desktop' : ''
  }),
  discoveredAccounts: (_env, limits, deps) => limits.discoverAccountSlots(deps),
  status: {
    credential: 'manusSessionToken',
    configuredKey: 'manusSessionTokenConfigured',
    sourceKey: 'manusSessionTokenSource',
    pendingKey: 'manusPendingCheckSince'
  },
  form: {
    field: 'manusSessionToken',
    input: 'textarea',
    titleKey: 'settings.manus.title',
    openKey: 'settings.manus.openBrowser',
    clearKey: 'settings.manus.clearToken',
    placeholderKey: 'settings.manus.tokenPlaceholder',
    saveKey: 'settings.manus.saveToken',
    emptyKey: 'settings.manus.statusNotSet',
    failedKey: 'settings.manus.saveFailed',
    steps: ['settings.manus.step1', 'settings.manus.step2', 'settings.manus.step3', 'settings.manus.step4'],
    url: 'https://manus.im/'
  },
  urlPolicy: [{ hosts: ['manus.im'], exactPaths: ['/'] }]
});
