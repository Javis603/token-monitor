// @ts-check
'use strict';

// Kiro limits account wiring. Leaf module: no requires.
// Kiro reads its quota by shelling out to the local CLI; there is no
// settings-backed credential and no settings panel.
module.exports = /** @satisfies {import('../../limits/accounts').AccountDeclaration} */ ({
  id: 'kiro',
  fetch: 'fetchKiroLimits',
  fields: []
});
