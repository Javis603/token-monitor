'use strict';

// Kimi limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'kimi',
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
    },
    {
      key: 'kimiWebRefreshToken',
      kind: 'credential',
      storePath: ['providers', 'kimi', 'webRefreshToken'],
      resolve: 'kimiWebRefreshToken',
      resolveStyle: 'explicit',
      persist: 'spread'
    }
  ],
  // Three credential lanes (Code API key, web token, self-renewing refresh
  // session) projected per field, plus the desktop-app discovery and the
  // combined credential state the account pill reads.
  discover: (env, limits) => (limits.kimiDesktopStorePresent(env) ? { desktop: true } : null),
  status: {
    configuredKey: 'kimiCredentialConfigured',
    sourceKey: 'kimiCredentialSource',
    pendingKey: 'kimiPendingCheckSince'
  },
  accountStatus: ({ settings, env, discovered, limits }) => {
    const apiKey = settings?.kimiApiKey || limits.kimiToken(env);
    const webToken = settings?.kimiWebAccessToken || limits.kimiWebToken(env);
    const refreshToken = settings?.kimiWebRefreshToken || limits.kimiWebRefreshToken(env);
    const apiKeySource = settings?.kimiApiKey ? 'settings' : limits.kimiToken(env) ? 'env' : '';
    const webTokenSource = settings?.kimiWebAccessToken || settings?.kimiWebRefreshToken
      ? 'settings'
      : limits.kimiWebToken(env) || limits.kimiWebRefreshToken(env)
        ? 'env'
        : discovered
          ? 'desktop'
          : '';
    return {
      kimiApiKeyConfigured: Boolean(apiKey),
      kimiApiKeySource: apiKeySource,
      kimiWebAccessTokenConfigured: Boolean(webToken || refreshToken),
      kimiWebAccessTokenSource: webTokenSource,
      kimiCredentialConfigured: Boolean(webToken || refreshToken || apiKey || discovered),
      kimiCredentialSource: webTokenSource || apiKeySource
    };
  },
  // Kimi keeps its own panel (a primary Code API key and a Web-token fallback
  // that also accepts a self-renewing refresh token, each saved on its own) and
  // borrows only the shared save path.
  form: {
    kind: 'custom',
    fields: [{ key: 'kimiApiKey' }, { key: 'kimiWebAccessToken' }]
  },
  urlPolicy: [
    { hosts: ['kimi.com', 'www.kimi.com'], pathPrefixes: ['/code'] }
  ]
};
