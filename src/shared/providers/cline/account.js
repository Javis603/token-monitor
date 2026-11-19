// @ts-check
'use strict';

// Cline limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'cline',
  sourceSelection: { sources: ['api', 'local'], slotSources: { credentials: { clineApiKey: 'api' }, discovered: 'local' } },
  accountSlots: true,
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', products: ['cline'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.cline.note' },
    { id: 'local', kind: 'file', relation: 'alternative', products: ['cline'], labelKey: 'settings.limits.sources.file', descriptionKey: 'settings.limits.sources.fileDescription' }
  ],
  fetch: 'fetchClineLimits',
  fields: [
    {
      key: 'clineApiKey',
      kind: 'credential',
      storePath: ['providers', 'cline', 'apiKey'],
      resolve: 'clineApiKey',
      normalize: 'secret'
    }
  ],
  // A discovered sign-in counts as configured the way zai counts its ZCode
  // login: otherwise the pill reads "Not configured" on the machine this
  // provider is built for. The source label then says which lane it is.
  discover: (env, limits) => limits.resolveClineAutomaticCredential(env),
  discoveredAccounts: (_env, limits, deps) => limits.discoverAccountSlots(deps),
  status: {
    credential: 'clineApiKey',
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
});
