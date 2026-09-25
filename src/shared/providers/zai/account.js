'use strict';

// Z.ai / GLM limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'zai',
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
    return discovery.entitled && discovery.credential ? discovery : null;
  },
  status: {
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
    // unchecked. Anything else (API-only, unentitled plan) is not an auto
    // quota source.
    zcodeLoginDetected: Boolean(discovered)
  }),
  urlPolicy: [
    { hosts: ['z.ai', 'www.z.ai'] },
    { hosts: ['bigmodel.cn', 'www.bigmodel.cn'] }
  ]
};
