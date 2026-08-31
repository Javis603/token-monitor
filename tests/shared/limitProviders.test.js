'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LIMIT_PROVIDER_IDS,
  limitProvidersForDetectedClients
} = require('../../src/shared/limitProviders');

test('initial limit providers follow detected clients in stable provider order', () => {
  assert.deepEqual(
    limitProvidersForDetectedClients({
      cursor: 'waiting',
      claude: 'active',
      hermes: 'active',
      codex: 'missing',
      unknown: 'active'
    }),
    ['claude', 'cursor']
  );
});

test('initial limit providers stay empty when discovery finds no local source', () => {
  assert.deepEqual(
    limitProvidersForDetectedClients({ codex: 'missing', cursor: 'missing' }),
    []
  );
  assert.deepEqual(limitProvidersForDetectedClients(), []);
  assert.equal(new Set(limitProvidersForDetectedClients({})).size, 0);
  assert.ok(LIMIT_PROVIDER_IDS.includes('claude'));
});
