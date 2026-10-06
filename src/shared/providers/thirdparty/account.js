'use strict';

// Third-party APIs limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'thirdparty',
  fetch: 'fetchThirdPartyLimits',
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
};
