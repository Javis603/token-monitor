// @ts-check
'use strict';

// Codex limits account wiring. Leaf module: no requires.
/** @satisfies {import('../../limits/accounts').AccountDeclaration} */
module.exports = {
  id: 'codex',
  fetch: 'fetchCodexLimits',
  accountRefresh: true,
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
