'use strict';

// Grok limits account wiring. Leaf module: no requires.
// Grok has no settings-backed credential: it authenticates through the local
// X account material its limits module knows how to find, and it gets no
// settings panel.
module.exports = {
  id: 'grok',
  fetch: 'fetchGrokLimits',
  fields: [],
  resolveFetch: (deps, limits) => limits.resolveGrokFetch(deps)
};
