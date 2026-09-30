'use strict';

// OpenRouter limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'openrouter',
  fetch: 'fetchOpenRouterLimits',
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
};
