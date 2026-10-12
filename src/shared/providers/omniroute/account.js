'use strict';

// OmniRoute limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'omniroute',
  fetch: 'fetchOmniRouteLimits',
  fields: [
    {
      key: 'omnirouteBaseUrl',
      kind: 'setting',
      configDefault: 'http://localhost:20128',
      envFallback: ['TOKEN_MONITOR_OMNIROUTE_BASE_URL', 'OMNIROUTE_BASE_URL'],
      normalize: 'trim'
    },
    {
      key: 'omnirouteToken',
      kind: 'credential',
      storePath: ['providers', 'omniroute', 'token'],
      resolve: 'omnirouteToken',
      envFallback: ['TOKEN_MONITOR_OMNIROUTE_TOKEN', 'OMNIROUTE_TOKEN', 'OMNIROUTE_API_KEY'],
      normalize: 'secret',
      project: 'set'
    }
  ],
  status: {
    credential: 'omnirouteToken',
    configuredKey: 'omnirouteTokenConfigured',
    sourceKey: 'omnirouteTokenSource',
    pendingKey: 'omniroutePendingCheckSince'
  },
  form: {
    titleKey: 'settings.omniroute.title',
    openKey: 'settings.omniroute.openBrowser',
    clearKey: 'settings.omniroute.clearToken',
    saveKey: 'settings.omniroute.saveToken',
    emptyKey: 'settings.omniroute.statusNotSet',
    failedKey: 'settings.omniroute.saveFailed',
    fields: [
      {
        key: 'omnirouteBaseUrl',
        input: 'text',
        placeholderKey: 'settings.omniroute.baseUrlPlaceholder',
        prefill: true,
        required: false
      },
      {
        key: 'omnirouteToken',
        input: 'password',
        placeholderKey: 'settings.omniroute.tokenPlaceholder',
        required: true
      }
    ],
    top: [
      { field: 'omnirouteBaseUrl' }
    ],
    manual: [
      {
        steps: [
          'settings.omniroute.step1',
          'settings.omniroute.step2',
          'settings.omniroute.step3'
        ]
      },
      { field: 'omnirouteToken' }
    ],
    openUrl: { url: 'https://omniroute.online/docs' }
  },
  urlPolicy: [
    { hosts: ['omniroute.online', 'omniroute.im'], pathPrefixes: ['/docs'] }
  ]
};
