// @ts-check
'use strict';

// Volcengine limits account wiring. Leaf module: no requires.
/** @param {unknown} value */
const normalizeVolcengineRegion = (value) => String(value || '').trim().toLowerCase();

module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'volcengine',
  accountSlots: true,
  accountCredentialKeys: ['volcengineAccessKeyId', 'volcengineApiKey'],
  accountCredentialReady: (values, key) => key !== 'volcengineAccessKeyId'
    || !/^AKLT/i.test(values[key]) || Boolean(values.volcengineSecretAccessKey),
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', products: ['coding-plan', 'ark', 'agent-plan'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.limits.sources.apiKeyDescription' },
    { id: 'cli', kind: 'cli', relation: 'alternative', products: ['coding-plan', 'agent-plan'], labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' }
  ],
  fetch: 'fetchVolcengineLimits',
  fields: [
    { key: 'volcengineApiKey', kind: 'credential', storePath: ['providers', 'volcengine', 'apiKey'],
      resolve: 'volcengineArkKey', normalize: 'secret' },
    {
      key: 'volcengineAccessKeyId',
      resolve: 'volcenginePrimaryKey',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'accessKeyId'],
      normalize: 'secret',
      project: 'set'
    },
    {
      key: 'volcengineSecretAccessKey',
      resolve: 'volcenginePrimarySecret',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'secretAccessKey'],
      normalize: 'secret'
    },
    {
      key: 'volcengineRegion',
      envFallback: ['VOLCENGINE_REGION', 'VOLCENGINE_REGION_ID', 'VOLC_REGION', 'DOUBAO_REGION'],
      kind: 'setting',
      normalize: normalizeVolcengineRegion
    },
    {
      key: 'volcengineAgentAccessKeyId',
      envFallback: ['VOLCENGINE_AGENT_ACCESS_KEY_ID', 'VOLC_AGENT_ACCESS_KEY_ID'],
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'agentAccessKeyId'],
      normalize: 'secret',
      project: 'set'
    },
    {
      key: 'volcengineAgentSecretAccessKey',
      envFallback: ['VOLCENGINE_AGENT_SECRET_ACCESS_KEY', 'VOLC_AGENT_SECRET_ACCESS_KEY'],
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'agentSecretAccessKey'],
      normalize: 'secret'
    },
    {
      key: 'volcengineAgentRegion',
      envFallback: ['VOLCENGINE_AGENT_REGION'],
      kind: 'setting',
      normalize: normalizeVolcengineRegion
    }
  ],
  // Two credential lanes (console + agent) resolved as a pair by
  // volcengineCredentials(env, options): the settings lane is the resolver run
  // over settings, the env lane over the environment.
  status: {
    configuredKey: 'volcengineCredentialsConfigured',
    sourceKey: 'volcengineCredentialsSource',
    pendingKey: 'volcenginePendingCheckSince'
  },
  accountStatus: ({ settings, env, limits }) => ({
    volcengineCredentialsConfigured: Boolean(limits.volcengineCredentials(env, settings || {})),
    volcengineCredentialsSource: limits.volcengineCredentials({}, settings || {})
      ? 'settings'
      : limits.volcengineCredentials(env)
        ? 'env'
        : ''
  }),
  // The shared form keeps the optional Agent credentials with their owner.
  form: {
    titleKey: 'settings.volcengine.title', openKey: 'settings.volcengine.openBrowser',
    clearKey: 'settings.volcengine.clearCredentials', saveKey: 'settings.volcengine.saveCredentials',
    emptyKey: 'settings.volcengine.statusNotSet', failedKey: 'settings.volcengine.saveFailed',
    openUrl: { url: 'https://console.volcengine.com/ark' },
    fields: [
      { input: 'password', key: 'volcengineAccessKeyId', labelKey: 'settings.volcengine.accessKeyId', placeholderKey: 'settings.volcengine.accessKeyPlaceholder' },
      { input: 'password', key: 'volcengineApiKey', labelKey: 'settings.limits.sources.apiKey' },
      { input: 'password', key: 'volcengineSecretAccessKey', labelKey: 'settings.volcengine.secretAccessKey', placeholderKey: 'settings.volcengine.secretKeyPlaceholder' },
      { input: 'text', secret: false, key: 'volcengineRegion', labelKey: 'settings.volcengine.region', placeholderKey: 'settings.volcengine.regionPlaceholder' },
      { input: 'password', key: 'volcengineAgentAccessKeyId', labelKey: 'settings.volcengine.agentAccessKeyId', placeholderKey: 'settings.volcengine.agentAccessKeyPlaceholder' },
      { input: 'password', key: 'volcengineAgentSecretAccessKey', labelKey: 'settings.volcengine.agentSecretAccessKey', placeholderKey: 'settings.volcengine.secretKeyPlaceholder' },
      { input: 'text', secret: false, key: 'volcengineAgentRegion', labelKey: 'settings.volcengine.agentRegion', placeholderKey: 'settings.volcengine.regionPlaceholder' }
    ],
    manual: [{ note: 'settings.volcengine.note' }, { field: 'volcengineAccessKeyId' }, { field: 'volcengineApiKey' }, { field: 'volcengineSecretAccessKey' }, { field: 'volcengineRegion' }, { field: 'volcengineAgentAccessKeyId' }, { field: 'volcengineAgentSecretAccessKey' }, { field: 'volcengineAgentRegion' }]
  },
  urlPolicy: [
    { hosts: ['www.volcengine.com', 'console.volcengine.com'] }
  ]
});
