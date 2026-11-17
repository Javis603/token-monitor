// @ts-check
'use strict';

// OpenRouter limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'openrouter',
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'single', products: ['openrouter'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.limits.sources.apiKeyDescription' }
  ],
  fetch: 'fetchOpenRouterLimits',
  accountSlots: true,
  fields: [
    { key: 'openrouterApiKey', kind: 'credential', storePath: ['providers', 'openrouter', 'apiKey'], resolve: 'openrouterToken', resolveStyle: 'explicit' },
    {
      key: 'openrouterProfiles',
      kind: 'setting',
      rendererOmit: true,
      config: false,
      storePath: ['providers', 'openrouter', 'profiles'],
      configDefault: {},
      persist: 'never',
      watch: false
    }
  ],
  status: { credential: 'openrouterApiKey', configuredKey: 'openrouterApiKeyConfigured', sourceKey: 'openrouterApiKeySource', pendingKey: 'openrouterPendingCheckSince' },
  form: {
    titleKey: 'settings.openrouter.title', openKey: 'settings.openrouter.openBrowser',
    clearKey: 'settings.slots.remove', saveKey: 'settings.openrouter.saveProfile', emptyKey: 'settings.openrouter.statusNotSet',
    failedKey: 'settings.openrouter.saveFailedShort',
    fields: [{ key: 'openrouterApiKey', input: 'password', placeholderKey: 'settings.openrouter.apiKeyPlaceholder', required: true }],
    manual: [{ note: 'settings.openrouter.note' }, { field: 'openrouterApiKey' }],
    openUrl: { url: 'https://openrouter.ai/settings/keys' }
  },
  envProbe: {
    key: 'openrouterEnvConfigured',
    fn: (env, limits) => Boolean(limits.openrouterToken(env))
  },
  urlPolicy: [
    { hosts: ['openrouter.ai'], pathPrefixes: ['/settings/keys'] }
  ]
});
