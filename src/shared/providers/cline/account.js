'use strict';

// Cline limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'cline',
  fetch: 'fetchClineLimits',
  fields: [
    {
      key: 'clineApiKey',
      kind: 'credential',
      storePath: ['providers', 'cline', 'apiKey'],
      config: false,
      resolve: 'clineApiKey',
      normalize: 'secret'
    }
  ],
  // A discovered sign-in counts as configured the way zai counts its ZCode
  // login: otherwise the pill reads "Not configured" on the machine this
  // provider is built for. The source label then says which lane it is.
  discover: (env, limits) => limits.resolveClineAutomaticCredential(env),
  status: {
    configuredKey: 'clineCredentialConfigured',
    sourceKey: 'clineCredentialSource',
    pendingKey: 'clinePendingCheckSince'
  },
  form: {
    field: 'clineApiKey',
    input: 'input',
    titleKey: 'settings.cline.title',
    openKey: 'settings.cline.openBrowser',
    clearKey: 'settings.cline.clearApiKey',
    placeholderKey: 'settings.cline.apiKeyPlaceholder',
    ariaLabelKey: 'settings.cline.apiKeyLabel',
    saveKey: 'settings.cline.saveApiKey',
    emptyKey: 'settings.cline.statusNotSet',
    failedKey: 'settings.cline.saveFailed',
    noteKey: 'settings.cline.note',
    messages: {
      rejected: 'settings.cline.validationInvalid'
    },
    url: 'https://app.cline.bot/dashboard/account'
  },
  accountStatus: ({ settings, discovered }) => ({
    clineCredentialConfigured: Boolean(settings?.clineApiKey || discovered?.source),
    clineCredentialSource: settings?.clineApiKey ? 'settings' : (discovered?.source ?? '')
  }),
  urlPolicy: [
    { hosts: ['app.cline.bot'], pathPrefixes: ['/dashboard'] }
  ]
};
