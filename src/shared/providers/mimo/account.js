// @ts-check
'use strict';

// Xiaomi MiMo limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'mimo',
  sources: [
    { id: 'web', kind: 'web', relation: 'alternative', products: ['console'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.mimo.description' },
    { id: 'local', kind: 'desktop', relation: 'complement', products: ['console', 'membership'], labelKey: 'settings.limits.sources.desktop', descriptionKey: 'settings.limits.sources.desktopDescription' }
  ],
  fetch: 'fetchMimoLimits',
  fields: [
    {
      key: 'mimoManagedAccounts',
      kind: 'managed',
      contextOverride: true,
      persist: 'never',
      initial: []
    }
  ]
});
