// @ts-check
'use strict';

// Kimi limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'kimi',
  accountSlots: true,
  accountCredentialKeys: ['kimiApiKey', 'kimiWebAccessToken'],
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', products: ['kimi'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.kimi.apiKeyNote' },
    { id: 'web', kind: 'web', relation: 'complement', products: ['kimi'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.kimi.webTokenNote' }
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
  // Code is primary; Web complements missing quota windows within the same slot.
  form: {
    titleKey: 'settings.kimi.title', openKey: 'settings.kimi.openBrowser',
    clearKey: 'settings.kimi.clearApiKey', saveKey: 'settings.kimi.saveApiKey',
    emptyKey: 'settings.kimi.statusNotSet', failedKey: 'settings.kimi.saveFailed',
    openUrl: { url: 'https://www.kimi.com/code/console' },
    fields: [
      { input: 'password', key: 'kimiApiKey', labelKey: 'settings.kimi.apiKeyLabel', placeholderKey: 'settings.kimi.apiKeyPlaceholder' },
      { input: 'password', key: 'kimiWebAccessToken', labelKey: 'settings.kimi.webTokenLabel', placeholderKey: 'settings.kimi.webTokenPlaceholder' }
    ],
    manual: [{ note: 'settings.kimi.apiKeyNote' }, { field: 'kimiApiKey' },
      { note: 'settings.kimi.webTokenNote' },
      { steps: ['settings.kimi.step1', 'settings.kimi.step2', 'settings.kimi.step3', 'settings.kimi.step4'] }, { field: 'kimiWebAccessToken' }]
  },
  urlPolicy: [
    { hosts: ['kimi.com', 'www.kimi.com'], pathPrefixes: ['/code'] }
  ]
});
