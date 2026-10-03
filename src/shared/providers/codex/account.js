'use strict';

// Codex limits account wiring. Leaf module: no requires.
module.exports = {
  id: 'codex',
  fetch: 'fetchCodexLimits',
  fields: [
    {
      key: 'codexManagedAccounts',
      kind: 'managed',
      contextOverride: true,
      persist: 'never',
      initial: []
    }
  ],
  urlPolicy: [
    { hosts: ['codex-resets.com'], exactPaths: ['', '/'] }
  ]
};
