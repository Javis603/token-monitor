'use strict';

const assert = require('node:assert/strict');
const { SESSION_TEXT_KEYS } = require('../../src/shared/sessionTitlePrivacy');

// The caller owns the fixture, cache and source instrumentation. Keep the same
// read closure for every mode so unchanged-file caches cannot mask transitions.
function assertSessionTitleContract({ read, expectedTitle, expectedMetadata, assertPrivateRead }) {
  assert.equal(typeof assertPrivateRead, 'function', 'instrument private reads; output alone is not proof');
  for (const options of [{}, { resolveTitles: false }, { resolveTitles: true }]) {
    const metadata = read(options);
    const enabled = options.resolveTitles !== false;
    assert.ok(metadata && typeof metadata === 'object', 'reader returns metadata');
    if (enabled) assert.equal(metadata.title, expectedTitle, 'default and re-enabled titles resolve');
    else {
      assert.ok(metadata.title === undefined || metadata.title === '', 'disabled reader returns no title');
      assertPrivateRead(metadata);
    }
    for (const [field, expected] of Object.entries(expectedMetadata)) {
      assert.deepEqual(metadata[field], expected, `${field} survives title mode ${enabled ? 'on' : 'off'}`);
    }
    for (const alias of SESSION_TEXT_KEYS.filter((field) => field !== 'title')) {
      assert.equal(Object.hasOwn(metadata, alias), false, `normalize ${alias} to title at the adapter boundary`);
    }
  }
}

module.exports = { assertSessionTitleContract };
