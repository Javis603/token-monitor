'use strict';

// Account declarations must remain require-free for renderer-safe projection.
module.exports = {
  id: 'minimax',
  fetch: 'fetchMinimaxLimits',
  fields: [
    { key: 'minimaxApiProfiles', kind: 'profiles',
      storePath: ['providers', 'minimax', 'profiles'], configDefault: {}, persist: 'never' },
    {
      key: 'minimaxApiKey',
      kind: 'credential',
      storePath: ['providers', 'minimax', 'apiKey'],
      resolve: 'minimaxToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'minimaxApiRegion',
      kind: 'setting',
      normalize: { fn: 'normalizeMinimaxRegionSetting', style: 'value' },
      envFallback: ['TOKEN_MONITOR_MINIMAX_API_REGION', 'MINIMAX_API_REGION', 'MINIMAX_API_HOST'],
      configDefault: 'auto',
      // An unrelated save must not turn an implicit region into a stored pin.
      initial: '',
      persist: 'renormalize',
      persistFallback: '',
      project: (value, limits, env) => limits.minimaxRegion({ minimaxApiRegion: value }, env)
    },
    {
      key: 'minimaxBillingMode',
      kind: 'setting',
      normalize: { fn: 'normalizeMinimaxBillingMode', style: 'value' },
      configDefault: 'token-plan',
      initial: 'token-plan',
      persist: 'renormalize',
      persistFallback: 'token-plan',
      project: (value, limits) => limits.normalizeMinimaxBillingMode(value)
    }
  ],
  status: {
    credential: 'minimaxApiKey',
    configuredKey: 'minimaxApiKeyConfigured',
    sourceKey: 'minimaxApiKeySource',
    pendingKey: 'minimaxPendingCheckSince'
  },
  accountStatus({ settings, env, limits }) {
    const accounts = limits.configuredMinimaxAccounts(settings, { env });
    return {
      minimaxApiKeyConfigured: accounts.length > 0,
      minimaxApiKeySource: accounts.some(account => account.name !== 'environment') ? 'settings' : accounts.length ? 'env' : ''
    };
  },
  form: {
    kind: 'custom',
    fields: [
      { key: 'minimaxApiKey' },
      { key: 'minimaxBillingMode', secret: false, submitWithCredential: false },
      { key: 'minimaxApiRegion', secret: false, submitWithCredential: false }
    ]
  },
  urlPolicy: [
    { hosts: ['platform.minimaxi.com'] },
    { hosts: ['platform.minimax.io'] }
  ]
};
