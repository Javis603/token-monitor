'use strict';

// QwenWork limits account wiring. Leaf module: no requires.
//
// The primary credential is the device-flow session this app owns: the account
// signs in through the QwenWork browser page, and the access/refresh pair is
// stored under the provider's credential path. A QwenWork sign-in that magpie
// already keeps fresh, or an explicit environment token, remains a fallback so
// an existing install keeps working without signing in again.
module.exports = {
  id: 'qwenwork',
  fetch: 'fetchQwenworkLimits',
  fields: [
    {
      key: 'qwenworkSession',
      kind: 'credential',
      storePath: ['providers', 'qwenwork', 'session'],
      rendererOmit: true,
      initial: null
    }
  ],
  discover: (env, limits) => limits.discoverQwenworkSignIn(env),
  accountStatus: ({ settings, discovered }) => ({
    qwenworkSessionConfigured: Boolean(settings?.qwenworkSession || discovered?.source),
    qwenworkSessionSource: settings?.qwenworkSession ? 'settings' : (discovered?.source || '')
  })
};
