// @ts-check
'use strict';

// Kimi limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'kimi',
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.kimi.apiKeyNote' },
    { id: 'web', kind: 'web', relation: 'complement', labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.kimi.webTokenNote' }
  ],
  fetch: 'fetchKimiLimits',
  fields: [
    {
      key: 'kimiApiKey',
      kind: 'credential',
      storePath: ['providers', 'kimi', 'apiKey'],
      resolve: 'kimiToken',
      resolveStyle: 'explicit',
      persist: 'spread'
    },
    {
      key: 'kimiWebAccessToken',
      kind: 'credential',
      storePath: ['providers', 'kimi', 'webAccessToken'],
      resolve: 'kimiWebToken',
      resolveStyle: 'explicit',
      persist: 'spread'
    }
  ],
  // Two credential lanes (console API key, web access token) projected per
  // field, plus the combined credential state the account pill reads.
  status: {
    configuredKey: 'kimiCredentialConfigured',
    sourceKey: 'kimiCredentialSource',
    pendingKey: 'kimiPendingCheckSince'
  },
  accountStatus: ({ settings, env, limits }) => {
    const apiKey = settings?.kimiApiKey || limits.kimiToken(env);
    const webToken = settings?.kimiWebAccessToken || limits.kimiWebToken(env);
    const apiKeySource = settings?.kimiApiKey ? 'settings' : limits.kimiToken(env) ? 'env' : '';
    const webTokenSource = settings?.kimiWebAccessToken ? 'settings' : limits.kimiWebToken(env) ? 'env' : '';
    return {
      kimiApiKeyConfigured: Boolean(apiKey),
      kimiApiKeySource: apiKeySource,
      kimiWebAccessTokenConfigured: Boolean(webToken),
      kimiWebAccessTokenSource: webTokenSource,
      kimiCredentialConfigured: Boolean(webToken || apiKey),
      kimiCredentialSource: webTokenSource || apiKeySource
    };
  },
  // Kimi keeps its own panel (a primary Code API key and a complementary Web token,
  // each saved on its own) and borrows only the shared save path.
  form: {
    kind: 'custom',
    fields: [{ key: 'kimiApiKey' }, { key: 'kimiWebAccessToken' }]
  },
  urlPolicy: [
    { hosts: ['kimi.com', 'www.kimi.com'], pathPrefixes: ['/code'] }
  ]
});
