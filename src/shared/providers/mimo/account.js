// @ts-check
'use strict';

// Xiaomi MiMo limits account wiring. Leaf module: no requires.
/** @satisfies {import('../../limits/accounts').AccountDeclaration} */
module.exports = {
  id: 'mimo',
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
};
