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
    // Follow the region the last successful poll resolved to, so a global
    // (minimax.io) account lands on its own platform; the CN host until then.
    openUrl: {
      byStatus: 'region',
      urls: { en: 'https://platform.minimax.io/user-center/payment/token-plan' },
      default: 'https://platform.minimaxi.com/user-center/payment/token-plan'
    }
  },
  urlPolicy: [
    { hosts: ['platform.minimaxi.com'] },
    { hosts: ['platform.minimax.io'] }
  ]
};
