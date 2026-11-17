// @ts-check
'use strict';

// DeepSeek limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'deepseek',
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'complement', products: ['deepseek'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.deepseek.note' },
    { id: 'web', kind: 'web', relation: 'complement', products: ['deepseek'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.deepseek.webTokenNote' }
  ],
  accountSlots: true,
  fetch: 'fetchDeepSeekLimits',
  fields: [
    {
      key: 'deepseekApiKey',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'apiKey'],
      resolve: 'deepseekToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'deepseekWebToken',
      kind: 'credential',
      storePath: ['providers', 'deepseek', 'webToken'],
      normalize: { fn: 'normalizeDeepseekWebToken', style: 'value' }
    }
  ],
  status: {
    credential: 'deepseekApiKey',
    configuredKey: 'deepseekApiKeyConfigured',
    sourceKey: 'deepseekApiKeySource',
    pendingKey: 'deepseekPendingCheckSince'
  },
  form: {
    titleKey: 'settings.deepseek.title',
    openKey: 'settings.deepseek.openBrowser',
    clearKey: 'settings.deepseek.clearApiKey',
    saveKey: 'settings.deepseek.saveApiKey',
    emptyKey: 'settings.deepseek.statusNotSet',
    failedKey: 'settings.deepseek.saveFailed',
    fields: [
      { key: 'deepseekApiKey', input: 'password', placeholderKey: 'settings.deepseek.apiKeyPlaceholder', required: true },
      { key: 'deepseekWebToken', input: 'password', labelKey: 'settings.deepseek.webTokenLabel' }
    ],
    manual: [
      { note: 'settings.deepseek.note' }, { field: 'deepseekApiKey' },
      { note: 'settings.deepseek.webTokenNote' }, { field: 'deepseekWebToken' }
    ],
    openUrl: { url: 'https://platform.deepseek.com/api_keys' }
  },
  urlPolicy: [
    { hosts: ['platform.deepseek.com'], pathPrefixes: ['/api_keys'] }
  ]
});
