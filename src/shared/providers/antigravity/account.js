// @ts-check
'use strict';

// Antigravity limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'antigravity',
  accountSlots: true,
  accountSlotOwner: true,
  sources: [
    { id: 'rpc', kind: 'desktop', relation: 'complement', products: ['antigravity'], labelKey: 'settings.limits.sources.desktop', descriptionKey: 'settings.limits.sources.desktopDescription' },
    { id: 'oauth', kind: 'oauth', relation: 'complement', products: ['antigravity'], labelKey: 'settings.limits.sources.oauth', descriptionKey: 'settings.limits.sources.oauthDescription' }
  ],
  form: { kind: 'custom', fields: [] },
  fetch: 'fetchAntigravityLimits',
  fields: [
    {
      key: 'antigravityManagedAccounts',
      kind: 'managed',
      contextOverride: true,
      persist: 'never',
      // Account membership changes flow through their own IPC and never scope a
      // provider refresh from a settings write.
      watch: false,
      initial: []
    }
  ]
});
