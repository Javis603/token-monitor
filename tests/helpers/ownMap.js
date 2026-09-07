'use strict';

// Production usage maps are Object.create(null). node:assert's deepEqual
// compares prototypes, so tests that only care about own keys need an
// ordinary-object view. Do not change production maps back to {}.
function ownMap(value) {
  return JSON.parse(JSON.stringify(value ?? {}));
}

module.exports = { ownMap };
