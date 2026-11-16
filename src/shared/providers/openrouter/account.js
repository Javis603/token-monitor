// @ts-check
'use strict';

// OpenRouter limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'openrouter',
  fetch: 'fetchOpenRouterLimits',
  accountRefresh: true,
  fields: [
    {
      key: 'openrouterProfiles',
      kind: 'profiles',
      storePath: ['providers', 'openrouter', 'profiles'],
      configDefault: {},
      persist: 'never',
      project: 'redact'
    }
  ],
  envProbe: {
    key: 'openrouterEnvConfigured',
    fn: (env, limits) => Boolean(limits.openrouterToken(env))
  },
  urlPolicy: [
    { hosts: ['openrouter.ai'], pathPrefixes: ['/settings/keys'] }
  ]
});
