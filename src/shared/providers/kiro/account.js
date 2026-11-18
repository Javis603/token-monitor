// @ts-check
'use strict';

// Kiro limits account wiring. Leaf module: no requires.
// Kiro reads its quota by shelling out to the local CLI; there is no
// settings-backed credential or saved credential editor.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'kiro',
  sources: [
    { id: 'cli', kind: 'cli', relation: 'single', products: ['kiro'], labelKey: 'settings.limits.sources.cli', descriptionKey: 'settings.limits.sources.cliDescription' }
  ],
  fetch: 'fetchKiroLimits',
  fields: []
});
