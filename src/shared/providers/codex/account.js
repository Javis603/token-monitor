// @ts-check
'use strict';

// Codex limits account wiring. Leaf module: no requires.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'codex',
  sourceSelection: { sources: ['oauth', 'app', 'cli'] },
  sources: [
    { id: 'oauth', kind: 'oauth', relation: 'alternative', products: ['codex'], labelKey: 'settings.limits.sources.oauth', descriptionKey: 'settings.limits.sources.oauthDescription' },
    { id: 'app', kind: 'desktop', relation: 'alternative', products: ['codex'], labelKey: 'settings.limits.sources.desktop', descriptionKey: 'settings.limits.sources.desktopDescription' },
    { id: 'cli', kind: 'cli', relation: 'alternative', products: ['codex'], labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' }
  ],
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
});
