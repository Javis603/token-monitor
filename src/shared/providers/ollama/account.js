'use strict';

// Ollama limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'ollama',
  fetch: 'fetchOllamaLimits',
  fields: [
    {
      key: 'ollamaApiKey',
      kind: 'credential',
      storePath: ['providers', 'ollama', 'apiKey'],
      resolve: 'ollamaApiKey',
      envFallback: ['TOKEN_MONITOR_OLLAMA_API_KEY', 'OLLAMA_API_KEY'],
      project: 'set'
    },
    {
      key: 'ollamaCookie',
      kind: 'credential',
      storePath: ['providers', 'ollama', 'cookie'],
      resolve: 'ollamaSessionCookie',
      project: 'set'
    }
  ],
  // Either lane configures the account; the API key is used when present.
  status: {
    configuredKey: 'ollamaCredentialsConfigured',
    sourceKey: 'ollamaCredentialsSource',
    pendingKey: 'ollamaPendingCheckSince'
  },
  accountStatus: ({ settings, env, limits }) => {
    const apiKey = limits.ollamaApiKey(env, settings || {});
    const cookie = limits.ollamaSessionCookie(env, settings || {});
    const apiKeySource = settings?.ollamaApiKey ? 'settings' : limits.ollamaApiKey(env) ? 'env' : '';
    const cookieSource = settings?.ollamaCookie ? 'settings' : limits.ollamaSessionCookie(env) ? 'env' : '';
    return {
      ollamaApiKeyConfigured: Boolean(apiKey),
      ollamaApiKeySource: apiKeySource,
      ollamaCookieConfigured: Boolean(cookie),
      ollamaCookieSource: cookieSource,
      ollamaCredentialsConfigured: Boolean(apiKey || cookie),
      ollamaCredentialsSource: apiKeySource || cookieSource
    };
  },
  form: {
    titleKey: 'settings.ollama.title',
    openKey: 'settings.ollama.openBrowser',
    clearKey: 'settings.ollama.clearCookie',
    saveKey: 'settings.ollama.saveCookie',
    emptyKey: 'settings.ollama.statusNotSet',
    failedKey: 'settings.ollama.saveFailed',
    fields: [
      {
        key: 'ollamaApiKey',
        input: 'password',
        configuredKey: 'ollamaApiKeyConfigured',
        ariaLabelKey: 'settings.ollama.apiKey',
        placeholderKey: 'settings.ollama.apiKeyPlaceholder'
      },
      {
        key: 'ollamaCookie',
        input: 'textarea',
        configuredKey: 'ollamaCookieConfigured',
        ariaLabelKey: 'settings.ollama.cookie',
        placeholderKey: 'settings.ollama.cookiePlaceholder'
      }
    ],
    credentialChoice: {
      key: 'ollamaCredentialKind',
      labelKey: 'settings.common.credentialKind',
      fields: ['ollamaApiKey', 'ollamaCookie']
    },
    manual: [
      { note: 'settings.ollama.apiKeyNote', whenCredential: 'ollamaApiKey' },
      { field: 'ollamaApiKey', whenCredential: 'ollamaApiKey' },
      { steps: ['settings.ollama.step1', 'settings.ollama.step2', 'settings.ollama.step3', 'settings.ollama.step4'], whenCredential: 'ollamaCookie' },
      { field: 'ollamaCookie', whenCredential: 'ollamaCookie' }
    ],
    openUrl: {
      byField: 'ollamaCredentialKind',
      urls: { ollamaApiKey: 'https://ollama.com/settings/keys', ollamaCookie: 'https://ollama.com/settings' },
      default: 'https://ollama.com/settings/keys'
    },
    messages: {
      rejected: 'settings.ollama.validationInvalid',
      required: 'settings.ollama.required'
    },
    // The cookie lane answers its next poll from a confirmed probe instead of
    // fetching the rate-limited settings page twice.
    rememberProbe: { fn: 'rememberOllamaValidation', field: 'ollamaCookie' }
  },
  urlPolicy: [
    { hosts: ['ollama.com', 'www.ollama.com'], exactPaths: ['/settings', '/settings/keys', '/signin'] }
  ]
};
