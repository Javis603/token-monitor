'use strict';

// Volcengine limits account wiring. Leaf module: no requires.
const normalizeVolcengineRegion = (value) => String(value || '').trim().toLowerCase();

module.exports = {
  id: 'volcengine',
  fetch: 'fetchVolcengineLimits',
  fields: [
    {
      key: 'volcengineAccessKeyId',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'accessKeyId'],
      normalize: 'secret',
      project: 'set'
    },
    {
      key: 'volcengineSecretAccessKey',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'secretAccessKey'],
      normalize: 'secret'
    },
    {
      key: 'volcengineRegion',
      kind: 'setting',
      normalize: normalizeVolcengineRegion
    },
    {
      key: 'volcengineAgentAccessKeyId',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'agentAccessKeyId'],
      normalize: 'secret',
      project: 'set'
    },
    {
      key: 'volcengineAgentSecretAccessKey',
      kind: 'credential',
      storePath: ['providers', 'volcengine', 'agentSecretAccessKey'],
      normalize: 'secret'
    },
    {
      key: 'volcengineAgentRegion',
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
  // Volcengine keeps its own panel (an optional second account for the Agent
  // Plan with its own clear) and borrows only the shared save path.
  form: {
    kind: 'custom',
    fields: [
      { key: 'volcengineAccessKeyId', required: true },
      { key: 'volcengineSecretAccessKey' },
      { key: 'volcengineRegion' },
      { key: 'volcengineAgentAccessKeyId' },
      { key: 'volcengineAgentSecretAccessKey' },
      { key: 'volcengineAgentRegion' }
    ]
  },
  urlPolicy: [
    { hosts: ['www.volcengine.com', 'console.volcengine.com'] }
  ]
};
