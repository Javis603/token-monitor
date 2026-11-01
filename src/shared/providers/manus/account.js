'use strict';

// Leaf declaration: shared credential storage and forms bind these names.
module.exports = {
  id: 'manus',
  fetch: 'fetchManusLimits',
  fields: [{
    key: 'manusSessionToken',
    kind: 'credential',
    storePath: ['providers', 'manus', 'sessionToken'],
    resolve: 'manusSessionToken',
    normalize: { fn: 'normalizeManusSessionToken', style: 'value' },
    envFallback: ['TOKEN_MONITOR_MANUS_SESSION_TOKEN', 'MANUS_SESSION_TOKEN', 'MANUS_COOKIE'],
    project: 'set'
  }],
  status: {
    credential: 'manusSessionToken',
    configuredKey: 'manusSessionTokenConfigured',
    sourceKey: 'manusSessionTokenSource',
    pendingKey: 'manusPendingCheckSince'
  },
  form: {
    field: 'manusSessionToken',
    input: 'textarea',
    titleKey: 'settings.manus.title',
    openKey: 'settings.manus.openBrowser',
    clearKey: 'settings.manus.clearToken',
    placeholderKey: 'settings.manus.tokenPlaceholder',
    saveKey: 'settings.manus.saveToken',
    emptyKey: 'settings.manus.statusNotSet',
    failedKey: 'settings.manus.saveFailed',
    steps: ['settings.manus.step1', 'settings.manus.step2', 'settings.manus.step3', 'settings.manus.step4'],
    url: 'https://manus.im/'
  },
  urlPolicy: [{ hosts: ['manus.im'], exactPaths: ['/'] }]
};
