'use strict';

// Antigravity limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'antigravity',
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
};
