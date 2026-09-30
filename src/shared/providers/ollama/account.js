'use strict';

// Ollama limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'ollama',
  fetch: 'fetchOllamaLimits',
  fields: [
    {
      key: 'ollamaCookie',
      kind: 'credential',
      storePath: ['providers', 'ollama', 'cookie'],
      resolve: 'ollamaSessionCookie',
      project: 'set'
    }
  ],
  status: {
    credential: 'ollamaCookie',
    configuredKey: 'ollamaCookieConfigured',
    sourceKey: 'ollamaCookieSource',
    pendingKey: 'ollamaPendingCheckSince'
  },
  form: {
    titleKey: 'settings.ollama.title',
    openKey: 'settings.ollama.openBrowser',
    clearKey: 'settings.ollama.clearCookie',
    saveKey: 'settings.ollama.saveCookie',
    emptyKey: 'settings.ollama.statusNotSet',
    failedKey: 'settings.ollama.saveFailed',
    fields: [
      { key: 'ollamaCookie', input: 'textarea', placeholderKey: 'settings.ollama.cookiePlaceholder', required: true }
    ],
    manual: [
      { steps: ['settings.ollama.step1', 'settings.ollama.step2', 'settings.ollama.step3', 'settings.ollama.step4'] },
      { field: 'ollamaCookie' }
    ],
    openUrl: { url: 'https://ollama.com/settings' },
    messages: { rejected: 'settings.ollama.validationInvalid' },
    // The first poll after a save answers from this check instead of fetching
    // the settings page a second time.
    rememberProbe: { fn: 'rememberOllamaValidation', field: 'ollamaCookie' }
  },
  urlPolicy: [
    { hosts: ['ollama.com', 'www.ollama.com'], exactPaths: ['/settings', '/signin'] }
  ]
};
