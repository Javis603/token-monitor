// @ts-check
'use strict';

// OpenCode limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'opencode',
  sources: [
    { id: 'api', kind: 'apiKey', relation: 'alternative', products: ['go'], labelKey: 'settings.limits.sources.apiKey', descriptionKey: 'settings.limits.sources.apiKeyDescription' },
    { id: 'web', kind: 'web', relation: 'complement', products: ['go', 'zen'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.opencodeWebDescription' },
    { id: 'local', kind: 'file', relation: 'alternative', products: ['go'], labelKey: 'settings.limits.sources.file', descriptionKey: 'settings.limits.sources.opencodeLocalDescription' }
  ],
  fetch: 'fetchOpenCodeLimits',
  fields: [
    {
      key: 'opencodeCookie',
      kind: 'credential',
      storePath: ['providers', 'opencode', 'cookie'],
      envFallback: ['TOKEN_MONITOR_OPENCODE_COOKIE'],
      persist: 'spread',
      project: 'set'
    },
    {
      key: 'opencodeProfiles',
      kind: 'profiles',
      storePath: ['providers', 'opencode', 'profiles'],
      configDefault: {},
      persist: 'spread',
      project: 'redact'
    }
  ],
  extraSettingKeys: ['opencodeLocalLimitsEnabled'],
  urlPolicy: [
    { hosts: ['opencode.ai', 'www.opencode.ai'] }
  ]
});
