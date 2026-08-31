'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  LIMIT_PROVIDER_IDS,
  limitProvidersForDetectedClients
} = require('../../src/shared/limitProviders');
const { parseLimitProviders } = require('../../src/shared/limitCollector');

test('initial limit providers follow detected clients in stable provider order', () => {
  assert.deepEqual(
    limitProvidersForDetectedClients({
      clients: {
        cursor: { source: { state: 'detected' } },
        claude: { source: { state: 'detected' } },
        hermes: { source: { state: 'detected' } },
        codex: { source: { state: 'missing' } },
        unknown: { source: { state: 'detected' } }
      }
    }),
    ['claude', 'cursor']
  );
});

test('initial limit providers stay empty when discovery finds no local source', () => {
  assert.deepEqual(
    limitProvidersForDetectedClients({
      clients: {
        codex: { source: { state: 'missing' } },
        cursor: { source: { state: 'missing' } }
      }
    }),
    []
  );
  assert.deepEqual(limitProvidersForDetectedClients(), []);
  assert.equal(new Set(limitProvidersForDetectedClients({ clients: {} })).size, 0);
  assert.ok(LIMIT_PROVIDER_IDS.includes('claude'));
});

test('other health data cannot make a missing source eligible for initial limits', () => {
  assert.deepEqual(limitProvidersForDetectedClients({
    clients: {
      claude: {
        source: { state: 'missing' },
        data: { liveTokens: 50 }
      },
      codex: { source: { state: 'detected' }, data: { liveTokens: 0 } }
    }
  }), ['codex']);
});

test('only an omitted provider selection defaults to all providers', () => {
  assert.deepEqual(parseLimitProviders(), LIMIT_PROVIDER_IDS);
  assert.deepEqual(parseLimitProviders(''), []);
  assert.deepEqual(parseLimitProviders([]), []);
});
