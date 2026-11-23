// @ts-check
'use strict';

// Stable server identities survive missing credentials and refresh rotation.
module.exports = { preserveAccount: true, preserveStaleAccount: () => true };
