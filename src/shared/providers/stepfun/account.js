'use strict';

module.exports = {
  id: 'stepfun',
  fetch: 'fetchStepfunLimits',
  fields: [{
    key: 'stepfunToken',
    kind: 'credential',
    storePath: ['providers', 'stepfun', 'token'],
    resolve: 'stepfunToken',
    envFallback: ['TOKEN_MONITOR_STEPFUN_TOKEN', 'STEPFUN_TOKEN'],
    project: 'set'
  }],
  status: {
    credential: 'stepfunToken',
    configuredKey: 'stepfunTokenConfigured',
    sourceKey: 'stepfunTokenSource',
    pendingKey: 'stepfunPendingCheckSince'
  },
  form: {
    field: 'stepfunToken',
    input: 'textarea',
    titleKey: 'settings.stepfun.title',
    openKey: 'settings.stepfun.openBrowser',
    clearKey: 'settings.stepfun.clearToken',
    placeholderKey: 'settings.stepfun.tokenPlaceholder',
    saveKey: 'settings.stepfun.saveToken',
    emptyKey: 'settings.stepfun.statusNotSet',
    failedKey: 'settings.stepfun.saveFailed',
    steps: [
      'settings.stepfun.step1',
      ['settings.stepfun.step2Before', { code: 'QueryStepPlanRateLimit' }, 'settings.stepfun.step2After'],
      'settings.stepfun.step3',
      'settings.stepfun.step4'
    ],
    url: 'https://platform.stepfun.com/plan-usage'
  },
  urlPolicy: [{ hosts: ['platform.stepfun.com'], exactPaths: ['/plan-usage'] }]
};
