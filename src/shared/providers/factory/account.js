// @ts-check
'use strict';

// Factory Droid limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'factory',
  accountSlots: true,
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.factory.note' },
    { id: 'droid-env', kind: 'file', relation: 'alternative', labelKey: 'settings.limits.sources.file', descriptionKey: 'settings.limits.sources.fileDescription' }
  ],
  fetch: 'fetchFactoryLimits',
  fields: [
    {
      key: 'factoryApiKey',
      kind: 'credential',
      storePath: ['providers', 'factory', 'apiKey'],
      resolve: 'factoryAccountEnvKey',
      normalize: 'secret'
    }
  ],
  discover: (env, limits) => limits.resolveFactoryAutomaticApiKey({}, { env }),
  discoveredAccounts: (_env, limits, deps) => limits.discoverAccountSlots(deps),
  status: {
    credential: 'factoryApiKey',
    configuredKey: 'factoryCredentialConfigured',
    sourceKey: 'factoryCredentialSource',
    pendingKey: 'factoryPendingCheckSince'
  },
  form: {
    field: 'factoryApiKey',
    input: 'input',
    titleKey: 'settings.factory.title',
    openKey: 'settings.factory.openBrowser',
    clearKey: 'settings.factory.clearApiKey',
    placeholderKey: 'settings.factory.apiKeyPlaceholder',
    saveKey: 'settings.factory.saveApiKey',
    emptyKey: 'settings.factory.statusNotSet',
    failedKey: 'settings.factory.saveFailed',
    noteKey: 'settings.factory.note',
    messages: {
      rejected: 'settings.factory.validationInvalid'
    },
    url: 'https://app.factory.ai/settings/api-keys'
  },
  // Deliberately asymmetric with cline on the source label only: a discovered
  // key marks the account configured either way, but the pill still says which
  // lane it came from.
  accountStatus: ({ settings, discovered }) => ({
    factoryCredentialConfigured: Boolean(settings?.factoryApiKey || discovered?.apiKey),
    factoryCredentialSource: settings?.factoryApiKey ? 'settings' : (discovered?.source ?? '')
  }),
  urlPolicy: [
    { hosts: ['app.factory.ai'], pathPrefixes: ['/settings/api-keys'] }
  ]
});
