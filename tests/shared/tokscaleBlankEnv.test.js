'use strict';

// Tokscale reads some XDG roots with a bare std::env::var(...), where ANY
// present value wins — including "" and "   ". Token Monitor resolves the same
// roots with nonBlankEnvPath(), so a blank value makes the watcher/health root
// and the scan root disagree. These tests pin the reconciliation: the blank key
// is dropped from the subprocess environment so tokscale falls back to the root
// Token Monitor already resolved.

const assert = require('node:assert/strict');
const test = require('node:test');

const {
  clientSourceRoots,
  clientWatchCandidates,
  tokscaleEnvWithBlanksDropped
} = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

// These are exactly the keys the helper is allowed to touch. XDG_CACHE_HOME is
// absent on purpose: it goes through the `dirs` crate, which already follows the
// spec. TOKSCALE_CONFIG_DIR is absent because both sides agree a blank value
// counts as set.
const BLANK_SENSITIVE_KEYS = ['XDG_DATA_HOME', 'XDG_CONFIG_HOME', 'TOKSCALE_HEADLESS_DIR'];

installSourceEnvGuard(test);

test('a blank value is dropped from the tokscale environment, a real one is kept', () => {
  const env = {
    PATH: '/usr/bin',
    XDG_DATA_HOME: '',
    XDG_CONFIG_HOME: '   ',
    TOKSCALE_HEADLESS_DIR: '\t',
    HOME: '/home/me'
  };
  const result = tokscaleEnvWithBlanksDropped(env);

  for (const key of BLANK_SENSITIVE_KEYS) {
    assert.equal(
      Object.prototype.hasOwnProperty.call(result, key),
      false,
      `${key} must be absent so tokscale takes its own fallback`
    );
  }
  // Everything else survives untouched, including keys that merely look related.
  assert.equal(result.PATH, '/usr/bin');
  assert.equal(result.HOME, '/home/me');

  const kept = tokscaleEnvWithBlanksDropped({ XDG_DATA_HOME: '/custom/share' });
  assert.equal(kept.XDG_DATA_HOME, '/custom/share', 'a real override must still reach the subprocess');
});

test('the helper returns the original object when nothing needs dropping', () => {
  // Identity matters: tokscaleCommand() hands process.env straight through on
  // the common path, and copying it on every spawn would be pure overhead.
  const env = { PATH: '/usr/bin', XDG_DATA_HOME: '/custom/share' };
  assert.equal(tokscaleEnvWithBlanksDropped(env), env);

  const empty = {};
  assert.equal(tokscaleEnvWithBlanksDropped(empty), empty);
});

test('non-string values are left alone rather than treated as blank', () => {
  // process.env values are strings or absent in practice, but the guard must not
  // delete a key it cannot reason about.
  const env = { XDG_DATA_HOME: undefined, XDG_CONFIG_HOME: null };
  assert.equal(tokscaleEnvWithBlanksDropped(env), env);
});

test('a blank key is dropped without disturbing the TOKSCALE_EXTRA_DIRS override', () => {
  // tokscaleCommand() adds TOKSCALE_EXTRA_DIRS before this runs, so the copy
  // must preserve it.
  const env = { TOKSCALE_EXTRA_DIRS: 'amp:/var/data/amp', XDG_DATA_HOME: '   ' };
  const result = tokscaleEnvWithBlanksDropped(env);
  assert.equal(result.TOKSCALE_EXTRA_DIRS, 'amp:/var/data/amp');
  assert.equal(Object.prototype.hasOwnProperty.call(result, 'XDG_DATA_HOME'), false);
  assert.equal(env.XDG_DATA_HOME, '   ', 'the caller\'s object must not be mutated');
});

// The reconciliation only matters if the two sides actually disagreed. This
// pins the disagreement so the helper cannot be dropped as unnecessary if the
// resolution code is ever refactored.
test('a blank XDG_DATA_HOME resolves a usable root for Token Monitor', () => {
  const home = '/tmp/amp-blank-consistency';
  for (const blank of ['', '   ', '\t']) {
    process.env.XDG_DATA_HOME = blank;
    const roots = clientSourceRoots('amp', { homeDir: home, platform: 'linux' }).amp;
    assert.deepEqual(roots, [{ id: 'amp-threads', dir: '/tmp/amp-blank-consistency/.local/share/amp/threads' }]);
    assert.deepEqual(
      clientWatchCandidates('amp', { homeDir: home, platform: 'linux' }).amp,
      ['/tmp/amp-blank-consistency/.local/share/amp/threads']
    );
  }
});

