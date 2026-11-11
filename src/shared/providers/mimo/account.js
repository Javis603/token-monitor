'use strict';

// Xiaomi MiMo limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'mimo',
  fetch: 'fetchMimoLimits',
  accountRefresh: true,
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
