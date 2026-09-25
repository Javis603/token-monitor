'use strict';

// Factory Droid limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'factory',
  fetch: 'fetchFactoryLimits',
  fields: [
    {
      key: 'factoryApiKey',
      kind: 'credential',
      storePath: ['providers', 'factory', 'apiKey'],
      normalize: 'secret'
    }
  ],
  discover: (env, limits) => limits.resolveFactoryAutomaticApiKey({}, { env }),
  status: {
    configuredKey: 'factoryCredentialConfigured',
    sourceKey: 'factoryCredentialSource',
    pendingKey: 'factoryPendingCheckSince'
  },
  form: {
    kind: 'singleCredential',
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
    validation: {
      invalidKey: 'settings.factory.validationInvalid'
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
};
