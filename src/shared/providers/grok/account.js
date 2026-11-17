// @ts-check
'use strict';

// Grok limits account wiring. Leaf module: no requires.
// Grok has no settings-backed credential: it authenticates through the local
// X account material its limits module knows how to find, and it has no
// saved credential editor.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'grok',
  sourceSelection: { sources: ['rpc', 'web'] },
  sources: [
    { id: 'rpc', kind: 'cli', relation: 'alternative', products: ['grok'], labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' },
    { id: 'web', kind: 'web', relation: 'alternative', products: ['grok'], labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' }
  ],
  fetch: 'fetchGrokLimits',
  fields: [],
  resolveFetch: (deps, limits) => limits.resolveGrokFetch(deps)
});
