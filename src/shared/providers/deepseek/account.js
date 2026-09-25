'use strict';

// DeepSeek limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'deepseek',
  fetch: 'fetchDeepSeekLimits',
  fields: [
    {
      key: 'deepseekApiKey',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'apiKey'],
      resolve: 'deepseekToken',
      resolveStyle: 'explicit'
    }
  ],
  status: {
    credential: 'deepseekApiKey',
    configuredKey: 'deepseekApiKeyConfigured',
    sourceKey: 'deepseekApiKeySource',
    pendingKey: 'deepseekPendingCheckSince'
  },
  form: {
    kind: 'singleCredential',
    field: 'deepseekApiKey',
    input: 'input',
    titleKey: 'settings.deepseek.title',
    openKey: 'settings.deepseek.openBrowser',
    clearKey: 'settings.deepseek.clearApiKey',
    placeholderKey: 'settings.deepseek.apiKeyPlaceholder',
    saveKey: 'settings.deepseek.saveApiKey',
    emptyKey: 'settings.deepseek.statusNotSet',
    failedKey: 'settings.deepseek.saveFailed',
    noteKey: 'settings.deepseek.note',
    url: 'https://platform.deepseek.com/api_keys'
  },
  urlPolicy: [
    { hosts: ['platform.deepseek.com'], pathPrefixes: ['/api_keys'] }
  ]
};
