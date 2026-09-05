'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');
const { LIMIT_PROVIDER_IDS } = require('../../src/shared/limitProviders');
const {
  LIMIT_PROVIDER_PRESENTATION,
  LIMIT_PROVIDER_LABELS
} = require('../../src/shared/limitProviderLabels');

const rootDir = path.join(__dirname, '..', '..');
const read = (...parts) => fs.readFileSync(path.join(rootDir, ...parts), 'utf8');

// Order-sensitive on purpose. The ids here are not an independent list: this
// array is what the renderer spreads into DEFAULT_LIMIT_PROVIDER_ORDER, so its
// order IS the new-install provider order, which limitProviders.js owns. A
// sorted comparison would accept a reordering that silently changes what a
// fresh install writes to settings.
test('the presentation list mirrors canonical provider identity exactly', () => {
  assert.deepEqual(
    LIMIT_PROVIDER_PRESENTATION.map((provider) => provider.id),
    [...LIMIT_PROVIDER_IDS]
  );
});

test('every provider has a display label', () => {
  for (const { id, label } of LIMIT_PROVIDER_PRESENTATION) {
    assert.equal(typeof label, 'string');
    assert.ok(label.trim().length > 0, `${id} needs a label`);
    assert.equal(LIMIT_PROVIDER_LABELS[id], label, `${id} label map should agree with the list`);
  }
  assert.deepEqual(Object.keys(LIMIT_PROVIDER_LABELS), [...LIMIT_PROVIDER_IDS]);
});

// settingsLabel is optional and overrides the name in the AI Tool Limits
// settings list only. An entry carrying one identical to its label is dead
// weight that reads like a deliberate distinction.
test('settingsLabel is only present where it differs from the label', () => {
  for (const { id, label, settingsLabel } of LIMIT_PROVIDER_PRESENTATION) {
    if (settingsLabel === undefined) continue;
    assert.equal(typeof settingsLabel, 'string');
    assert.notEqual(settingsLabel, label, `${id} settingsLabel duplicates its label`);
  }
});

// The guards above only bind the renderer while the renderer actually reads
// this module. Re-inlining a literal in app.js would leave every assertion here
// passing against a list nothing renders.
test('the renderer derives its provider list from this module', () => {
  const app = read('src', 'electron', 'renderer', 'app.js');
  assert.match(
    app,
    /const LIMIT_PROVIDERS = window\.TokenMonitorLimitProviderLabels\.LIMIT_PROVIDER_PRESENTATION;/
  );
  assert.doesNotMatch(app, /const LIMIT_PROVIDERS = \[/);

  const html = read('src', 'electron', 'renderer', 'index.html');
  const labelsTag = html.indexOf('<script src="../../shared/limitProviderLabels.js"></script>');
  assert.notEqual(labelsTag, -1, 'index.html should load the shared labels module');
  assert.ok(labelsTag < html.indexOf('<script src="app.js"></script>'), 'it must load before app.js');
});

// The Hub never reads these labels, and limitProviders.js is hashed into the
// portable Hub core (scripts/hub-build-manifest.js). Vendoring this module into
// the Worker would make renaming a provider bump the core build id and tell
// self-hosted Hubs to redeploy for a change their runtime cannot observe.
test('the labels stay out of the portable Hub core', () => {
  const { WORKER_SHARED_MODULES } = require('../../scripts/hub-build-manifest');
  assert.ok(!WORKER_SHARED_MODULES.includes('limitProviderLabels.js'));
  assert.ok(!fs.existsSync(path.join(rootDir, 'worker', 'src', 'shared', 'limitProviderLabels.js')));
  assert.doesNotMatch(read('src', 'shared', 'limitProviders.js'), /limitProviderLabels/);
});
