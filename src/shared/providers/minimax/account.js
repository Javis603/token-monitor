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
    },
    {
      key: 'minimaxApiRegion',
      kind: 'setting',
      normalize: { fn: 'minimaxRegion', style: 'options' },
      // limitsAccountConfig resolves settings -> envFallback -> configDefault.
      // Without the env names declared here the config layer never sees them and
      // hands the probe a hard 'auto', which then shadows minimaxRegion's own
      // env lane — the headless agent would silently ignore the variable.
      envFallback: ['TOKEN_MONITOR_MINIMAX_API_REGION', 'MINIMAX_API_REGION', 'MINIMAX_API_HOST'],
      configDefault: 'auto',
      persist: 'renormalize',
      persistFallback: 'auto',
      project: (value, limits) => limits.minimaxRegion({ minimaxApiRegion: value }, {}),
      // The env names below repeat the envFallback list above and the chain in
      // limits.js minimaxRegion(); keep the three in step.
      initial: (env, limits) => limits.minimaxRegion({
        minimaxApiRegion: env.TOKEN_MONITOR_MINIMAX_API_REGION || env.MINIMAX_API_REGION || env.MINIMAX_API_HOST
      }, {})
    }
  ],
  status: {
    credential: 'minimaxApiKey',
    configuredKey: 'minimaxApiKeyConfigured',
    sourceKey: 'minimaxApiKeySource',
    pendingKey: 'minimaxPendingCheckSince'
  },
  form: {
    titleKey: 'settings.minimax.title',
    openKey: 'settings.minimax.openBrowser',
    clearKey: 'settings.minimax.clearApiKey',
    saveKey: 'settings.minimax.saveApiKey',
    emptyKey: 'settings.minimax.statusNotSet',
    failedKey: 'settings.minimax.saveFailed',
    fields: [
      {
        key: 'minimaxApiRegion',
        input: 'select',
        labelKey: 'settings.minimax.apiRegion',
        options: [
          { value: 'auto', labelKey: 'settings.minimax.regionAuto' },
          { value: 'cn', labelKey: 'settings.minimax.regionCn' },
          { value: 'intl', labelKey: 'settings.minimax.regionIntl' }
        ],
        saveOnChange: true
      },
      { key: 'minimaxApiKey', input: 'password', placeholderKey: 'settings.minimax.apiKeyPlaceholder', required: true }
    ],
    // The region stays reachable once a key is saved: an account whose key is
    // fine but whose auto-probe keeps flapping needs the switch after linking.
    top: [{ field: 'minimaxApiRegion' }],
    manual: [{ note: 'settings.minimax.note' }, { field: 'minimaxApiKey' }],
    // Follows the region the probe resolved to, which an explicit pin fixes to
    // the chosen host; the CN platform page until the first poll resolves one.
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
