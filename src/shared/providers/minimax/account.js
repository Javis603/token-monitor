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
      normalize: { fn: 'normalizeMinimaxRegionSetting', style: 'value' },
      envFallback: ['TOKEN_MONITOR_MINIMAX_API_REGION', 'MINIMAX_API_REGION', 'MINIMAX_API_HOST'],
      configDefault: 'auto',
      // Resolve an implicit choice at use time. Saving another setting must not
      // turn the default or env value into a permanent region override.
      initial: '',
      persist: 'renormalize',
      persistFallback: '',
      project: (value, limits, env) => limits.minimaxRegion({ minimaxApiRegion: value }, env)
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
        saveOnChange: true,
        submitWithCredential: false
      },
      { key: 'minimaxApiKey', input: 'password', placeholderKey: 'settings.minimax.apiKeyPlaceholder', required: true }
    ],
    // The region stays reachable once a key is saved: an account whose key is
    // fine but whose auto-probe keeps flapping needs the switch after linking.
    top: [{ field: 'minimaxApiRegion' }],
    manual: [{ note: 'settings.minimax.note' }, { field: 'minimaxApiKey' }],
    // Explicit choices follow the select even before the first probe. Auto
    // follows the last successful probe, with the historical CN fallback.
    openUrl: {
      byField: 'minimaxApiRegion',
      urls: {
        cn: 'https://platform.minimaxi.com/user-center/payment/token-plan',
        intl: 'https://platform.minimax.io/user-center/payment/token-plan'
      },
      byStatus: 'region',
      statusUrls: { en: 'https://platform.minimax.io/user-center/payment/token-plan' },
      default: 'https://platform.minimaxi.com/user-center/payment/token-plan'
    }
  },
  urlPolicy: [
    { hosts: ['platform.minimaxi.com'] },
    { hosts: ['platform.minimax.io'] }
  ]
};
