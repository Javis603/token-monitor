// @ts-check
'use strict';

// Grok limits account wiring. Leaf module: no requires.
// Grok has no settings-backed credential: it authenticates through the local
// X account material its limits module knows how to find, and it gets no
// settings panel.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'grok',
  sources: [
    { id: 'rpc', kind: 'cli', relation: 'alternative', labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' },
    { id: 'web', kind: 'web', relation: 'alternative', labelKey: 'settings.limits.sources.web', descriptionKey: 'settings.limits.sources.webDescription' }
  ],
  fetch: 'fetchGrokLimits',
  fields: [],
  resolveFetch: (deps, limits) => limits.resolveGrokFetch(deps)
});
