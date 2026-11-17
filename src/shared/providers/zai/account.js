// @ts-check
'use strict';

// Z.ai / GLM limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'zai',
  accountSlots: true,
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'complement', products: ['zai'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.zai.note' },
    { id: 'zcode', kind: 'desktop', relation: 'complement', products: ['zai'], labelKey: 'settings.limits.sources.desktop', descriptionKey: 'settings.limits.sources.desktopDescription' }
  ],
  fetch: 'fetchZaiLimits',
  fields: [
    {
      key: 'zaiApiKey',
      kind: 'credential',
      storePath: ['providers', 'zai', 'apiKey'],
      resolve: 'zaiToken',
      resolveStyle: 'explicit'
    },
    {
      key: 'zaiApiRegion',
      kind: 'setting',
      normalize: { fn: 'zaiRegion', style: 'options' },
      configDefault: 'global',
      persist: 'renormalize',
      persistFallback: 'global',
      project: (value, limits) => limits.zaiRegion({ zaiApiRegion: value || 'global' }, {}),
      initial: (env, limits) => limits.zaiRegion({
        zaiApiRegion: env.TOKEN_MONITOR_ZAI_API_REGION || env.ZAI_API_REGION || env.Z_AI_API_HOST || 'global'
      }, {})
    }
  ],
  // A locally logged-in ZCode install is a credential source for the GLM lane
  // even when no console key was entered. Discovery reads the ZCode data files
  // synchronously; settingsForRenderer renders at human interaction speed, so
  // the cost is bounded by how often that runs, not by any refresh loop.
  discover: (env, limits) => {
    const discovery = limits.discoverZcodeConnection();
    return (discovery.credential || discovery.billing?.credential) ? discovery : null;
  },
  discoveredAccounts: (_env, limits, deps) => limits.discoverAccountSlots(deps),
  status: {
    credential: 'zaiApiKey',
    configuredKey: 'zaiApiKeyConfigured',
    sourceKey: 'zaiApiKeySource',
    pendingKey: 'zaiPendingCheckSince'
  },
  accountStatus: ({ settings, env, discovered, limits }) => ({
    zaiApiKeyConfigured: Boolean(settings?.zaiApiKey || limits.zaiToken(env) || discovered),
    zaiApiKeySource: settings?.zaiApiKey
      ? 'settings'
      : limits.zaiToken(env)
        ? 'env'
        : discovered
          ? 'zcode-auto'
          : '',
    // "A usable local ZCode login exists" — advertised so the renderer shows
    // the auto-detect state instead of "disabled" when the provider is
    // unchecked. A usable billing-only login counts too; the server answers
    // entitlement for whichever lanes have credentials.
    zcodeLoginDetected: Boolean(discovered)
  }),
  form: {
    titleKey: 'settings.zai.title',
    openKey: 'settings.zai.openBrowser',
    clearKey: 'settings.zai.clearApiKey',
    saveKey: 'settings.zai.saveApiKey',
    emptyKey: 'settings.zai.statusNotSet',
    failedKey: 'settings.zai.saveFailed',
    fields: [
      {
        key: 'zaiApiRegion',
        input: 'select',
        labelKey: 'settings.zai.apiRegion',
        options: [
          { value: 'global', labelKey: 'settings.zai.regionGlobal' },
          { value: 'bigmodel-cn', labelKey: 'settings.zai.regionBigmodelCn' }
        ],
        saveOnChange: true
      },
      { key: 'zaiApiKey', input: 'password', placeholderKey: 'settings.zai.apiKeyPlaceholder', required: true }
    ],
    // The region stays reachable once linked: a ZCode-discovered login keeps
    // the pasted-key panel open, but a stored key hides it.
    top: [{ field: 'zaiApiRegion' }],
    manual: [{ note: 'settings.zai.note' }, { field: 'zaiApiKey' }],
    openUrl: {
      byField: 'zaiApiRegion',
      urls: {
        global: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan',
        'bigmodel-cn': 'https://bigmodel.cn/coding-plan/personal/usage'
      },
      default: 'https://z.ai/manage-apikey/coding-plan/personal/my-plan'
    }
  },
  urlPolicy: [
    { hosts: ['z.ai', 'www.z.ai'] },
    { hosts: ['bigmodel.cn', 'www.bigmodel.cn'] }
  ]
});
