'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  parseGrokModelAliases,
  readGrokModelAliases
} = require('../../src/shared/providers/grok/modelAliases');

test('parseGrokModelAliases reads quoted and bare model route tables', () => {
  assert.deepEqual(parseGrokModelAliases(`
[models]
default = "grok-4.5"

[model."grok-4.5"]
model = "stealth/ox-alpha"

[model.grok-mini]
model = 'xai/grok-mini' # inline comment
`), {
    'grok-4.5': 'stealth/ox-alpha',
    'grok-mini': 'xai/grok-mini'
  });
});

test('readGrokModelAliases returns empty mappings for missing or malformed config', () => {
  assert.deepEqual(readGrokModelAliases({ configPath: 'missing' }, {
    readFileSync() { throw new Error('missing'); }
  }), {});
  assert.deepEqual(parseGrokModelAliases('[model."grok-4.5"]\nmodel = ["not", "a", "route"]'), {});
});
