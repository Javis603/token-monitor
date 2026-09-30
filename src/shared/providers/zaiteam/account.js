'use strict';

// GLM Team limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'zaiteam',
  fetch: 'fetchZaiTeamLimits',
  fields: [
    {
      key: 'zaiTeamApiKey',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'apiKey'],
      resolve: 'zaiTeamToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'zaiTeamOrganizationId',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'organizationId'],
      normalize: 'trim',
      project: 'set'
    },
    {
      key: 'zaiTeamProjectId',
      kind: 'credential',
      storePath: ['providers', 'zaiTeam', 'projectId'],
      normalize: 'trim',
      project: 'set'
    }
  ],
  status: {
    credential: 'zaiTeamApiKey',
    configuredKey: 'zaiTeamApiKeyConfigured',
    sourceKey: 'zaiTeamApiKeySource',
    pendingKey: 'zaiteamPendingCheckSince'
  },
  form: {
    titleKey: 'settings.zaiteam.title',
    openKey: 'settings.zaiteam.openBrowser',
    clearKey: 'settings.zaiteam.clearApiKey',
    saveKey: 'settings.zaiteam.saveCredentials',
    emptyKey: 'settings.zaiteam.statusNotSet',
    failedKey: 'settings.zaiteam.saveFailed',
    fields: [
      {
        key: 'zaiTeamApiKey',
        input: 'password',
        labelKey: 'settings.zaiteam.apiKey',
        placeholderKey: 'settings.zaiteam.apiKeyPlaceholder',
        required: true
      },
      {
        key: 'zaiTeamOrganizationId',
        input: 'text',
        labelKey: 'settings.zaiteam.organizationId',
        placeholderKey: 'settings.zaiteam.organizationIdPlaceholder',
        required: true
      },
      {
        key: 'zaiTeamProjectId',
        input: 'text',
        labelKey: 'settings.zaiteam.projectId',
        placeholderKey: 'settings.zaiteam.projectIdPlaceholder',
        required: true
      }
    ],
    top: [{ note: 'settings.zaiteam.regionNote' }],
    manual: [
      { note: 'settings.zaiteam.note' },
      { steps: ['settings.zaiteam.step1', 'settings.zaiteam.step2', 'settings.zaiteam.step3', 'settings.zaiteam.step4'] },
      { field: 'zaiTeamApiKey' },
      { field: 'zaiTeamOrganizationId' },
      { field: 'zaiTeamProjectId' }
    ],
    openUrl: { url: 'https://bigmodel.cn/coding-plan/team/usage-stats' }
  },
  urlPolicy: [
    { hosts: ['bigmodel.cn', 'www.bigmodel.cn'], pathPrefixes: ['/coding-plan'] }
  ]
};
