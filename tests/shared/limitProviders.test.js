'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const fs = require('node:fs');
const path = require('node:path');

const {
  LIMIT_PROVIDER_CATALOG,
  LIMIT_PROVIDER_IDS,
  LIMIT_PROVIDER_LABELS,
  limitProvidersForDetectedClients
} = require('../../src/shared/limitProviders');
const { parseLimitProviders } = require('../../src/shared/limitCollector');

const rootDir = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), 'utf8');

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

test('initial limit providers map only corresponding Collection client aliases', () => {
  assert.deepEqual(
    limitProvidersForDetectedClients({
      clients: {
        dsh: { source: { state: 'detected' } },
        qodercn: { source: { state: 'detected' } },
        zcode: { source: { state: 'detected' } },
        micode: { source: { state: 'detected' } }
      }
    }),
    ['mimo', 'zai', 'qoder']
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

test('every provider has a display label', () => {
  for (const { id, label } of LIMIT_PROVIDER_CATALOG) {
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `${id} needs a label`);
    assert.equal(LIMIT_PROVIDER_LABELS[id], label, `${id} label map should agree with the catalog`);
  }
  assert.deepEqual(Object.keys(LIMIT_PROVIDER_LABELS), [...LIMIT_PROVIDER_IDS]);
});

// settingsLabel is optional and renames the provider across every configuration
// and subscription surface at once (see the module comment). An entry carrying
// one identical to its label is dead weight that reads like a distinction.
test('settingsLabel is only present where it differs from the label', () => {
  for (const { id, label, settingsLabel } of LIMIT_PROVIDER_CATALOG) {
    if (settingsLabel === undefined) continue;
    assert.equal(typeof settingsLabel, 'string');
    assert.notEqual(settingsLabel, label, `${id} settingsLabel duplicates its label`);
  }
});

// The catalog only binds the renderer while the renderer actually reads it.
// Re-inlining a literal in app.js would leave every assertion here passing
// against a list nothing renders.
test('the renderer derives its provider list from this catalog', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  assert.match(app, /const LIMIT_PROVIDERS = window\.TokenMonitorLimitProviders\.LIMIT_PROVIDER_CATALOG;/);
  assert.doesNotMatch(app, /const LIMIT_PROVIDERS = \[/);

  const html = read('src', 'electron', 'renderer', 'index.html');
  const tag = html.indexOf('<script src="../../shared/limitProviders.js"></script>');
  assert.notEqual(tag, -1, 'index.html should load the provider catalog');
  assert.ok(tag < html.indexOf('<script src="app.js"></script>'), 'it must load before app.js');
});
