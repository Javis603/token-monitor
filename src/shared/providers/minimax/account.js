'use strict';

// Minimax limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'minimax',
  fetch: 'fetchMinimaxLimits',
  fields: [
    {
      key: 'minimaxApiKey',
      kind: 'credential',
      storePath: ['providers', 'minimax', 'apiKey'],
      resolve: 'minimaxToken',
      resolveStyle: 'explicit'
    }
  ],
  status: {
    credential: 'minimaxApiKey',
    configuredKey: 'minimaxApiKeyConfigured',
    sourceKey: 'minimaxApiKeySource',
    pendingKey: 'minimaxPendingCheckSince'
  },
  form: {
    kind: 'singleCredential',
    field: 'minimaxApiKey',
    input: 'input',
    titleKey: 'settings.minimax.title',
    openKey: 'settings.minimax.openBrowser',
    clearKey: 'settings.minimax.clearApiKey',
    placeholderKey: 'settings.minimax.apiKeyPlaceholder',
    saveKey: 'settings.minimax.saveApiKey',
    emptyKey: 'settings.minimax.statusNotSet',
    failedKey: 'settings.minimax.saveFailed',
    noteKey: 'settings.minimax.note',
    // The CN landing page: the renderer overrides this with the region the last
    // successful poll resolved to.
    url: 'https://platform.minimaxi.com/user-center/payment/token-plan'
  },
  urlPolicy: [
    { hosts: ['platform.minimaxi.com'] },
    { hosts: ['platform.minimax.io'] }
  ]
};
