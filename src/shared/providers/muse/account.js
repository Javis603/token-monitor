'use strict';

// Muse owns sign-in and credential refresh; quota reads need no stored secret.
module.exports = {
  id: 'muse',
  fetch: 'fetchMuseLimits',
  fields: []
};
