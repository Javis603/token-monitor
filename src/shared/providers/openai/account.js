'use strict';

// OpenAI subscription-credit account. Leaf module: no requires.
module.exports = {
  id: 'openai',
  fetch: 'fetchOpenaiLimits',
  fields: [
    {
      key: 'openaiAdminKey',
      kind: 'credential',
      storePath: ['providers', 'openai', 'apiKey'],
      resolve: 'openaiAdminKey',
      resolveStyle: 'explicit',
      envFallback: ['TOKEN_MONITOR_OPENAI_ADMIN_KEY', 'OPENAI_ADMIN_KEY']
    },
    {
      key: 'openaiPlan',
      kind: 'setting',
      normalize: { fn: 'normalizeOpenaiPlan', style: 'value' },
      envFallback: ['TOKEN_MONITOR_OPENAI_SUBSCRIPTION_PLAN', 'OPENAI_SUBSCRIPTION_PLAN']
    },
    {
      key: 'openaiRenewalDate',
      kind: 'setting',
      normalize: { fn: 'normalizeOpenaiRenewalDate', style: 'value' },
      envFallback: ['TOKEN_MONITOR_OPENAI_SUBSCRIPTION_RENEWAL', 'OPENAI_SUBSCRIPTION_RENEWAL']
    }
  ],
  status: {
    credential: 'openaiAdminKey',
    configuredKey: 'openaiAdminKeyConfigured',
    sourceKey: 'openaiAdminKeySource',
    pendingKey: 'openaiPendingCheckSince'
  },
  form: {
    titleKey: 'settings.openai.title',
    openKey: 'settings.openai.openBrowser',
    clearKey: 'settings.openai.clearApiKey',
    saveKey: 'settings.openai.saveApiKey',
    emptyKey: 'settings.openai.statusNotSet',
    failedKey: 'settings.openai.saveFailed',
    fields: [
      {
        key: 'openaiPlan',
        input: 'select',
        labelKey: 'settings.openai.plan',
        options: [
          { value: '', labelKey: 'settings.openai.planChoose' },
          { value: 'pro5x', labelKey: 'settings.openai.planPro5x' },
          { value: 'pro20x', labelKey: 'settings.openai.planPro20x' },
          { value: 'pro50x', labelKey: 'settings.openai.planPro50x' }
        ],
        required: true,
        saveOnChange: true
      },
      {
        key: 'openaiRenewalDate',
        input: 'text',
        labelKey: 'settings.openai.renewal',
        placeholderKey: 'settings.openai.renewalPlaceholder',
        required: true,
        secret: false,
        prefill: true,
        saveOnChange: true
      },
      { key: 'openaiAdminKey', input: 'password', placeholderKey: 'settings.openai.apiKeyPlaceholder', required: true }
    ],
    top: [{ field: 'openaiPlan' }, { field: 'openaiRenewalDate' }],
    manual: [{ note: 'settings.openai.note' }, { field: 'openaiAdminKey' }],
    openUrl: { url: 'https://platform.openai.com/settings/organization/billing' }
  },
  urlPolicy: [
    { hosts: ['platform.openai.com'], pathPrefixes: ['/settings/organization/billing'] }
  ]
};
