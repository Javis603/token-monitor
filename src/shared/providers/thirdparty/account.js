// @ts-check
'use strict';

// Third-party APIs limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'thirdparty',
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'single', products: ['thirdparty'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.limits.sources.apiKeyDescription' }
  ],
  fetch: 'fetchThirdPartyLimits',
  accountRefresh: true,
  fields: [
    {
      key: 'thirdPartyProfiles',
      kind: 'profiles',
      storePath: ['providers', 'thirdparty', 'profiles'],
      configDefault: {},
      persist: 'never',
      project: 'redact'
    }
  ],
  envProbe: {
    key: 'thirdPartyEnvConfigured',
    fn: (env, limits) => limits.configuredAccounts({}, { env }).length > 0
  }
});
