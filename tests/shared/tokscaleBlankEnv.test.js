'use strict';

// Tokscale reads some XDG roots with a bare std::env::var(...), where ANY
// present value wins — including "" and "   ". Token Monitor resolves the same
// roots with nonBlankEnvPath(), so a blank value makes the watcher/health root
// and the scan root disagree. These tests pin the reconciliation: the blank key
// is dropped from the subprocess environment so tokscale falls back to the root
// Token Monitor already resolved.

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');

const {
  clientSourceRoots,
  clientWatchCandidates,
  tokscaleEnvWithBlanksDropped
} = require('../../src/shared/collector');
const { installSourceEnvGuard } = require('../helpers/sourceEnv');

// These are exactly the keys the helper is allowed to touch. XDG_CACHE_HOME is
// absent on purpose: it goes through the `dirs` crate, which already follows the
// spec. TOKSCALE_CONFIG_DIR is absent because both sides already agree on it —
// an empty value is unset, while any non-empty value (whitespace included) is
// an override — so there is nothing to reconcile.
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

// Tokscale's effective home is not always the Win32 profile: paths.rs
// home_dir() prefers an absolute native $HOME on Windows, and a normal scan
// passes no --home so the scanner receives exactly that value. Deriving the XDG
// fallback from os.homedir() therefore pointed the watcher and the health check
// at the profile while the scan read the $HOME tree — usage collected from one
// directory, source health observing another. These pin the fix.
test('the XDG fallback follows an absolute native HOME on Windows, like the scan does', () => {
  const profile = 'C:\\Users\\me';
  const portable = 'D:\\portable-home';
  const options = { homeDir: profile, env: { HOME: portable }, platform: 'win32' };
  // path.join, not path.win32.join: the collector builds roots with the host
  // module while branching on the `platform` option, which is the convention the
  // existing Cursor/Antigravity Windows cases follow.
  const expected = path.join(portable, '.local', 'share', 'amp', 'threads');

  assert.equal(clientSourceRoots('amp', options).amp[0].dir, expected);
  assert.deepEqual(clientWatchCandidates('amp', options).amp, [expected], 'the watcher must observe the scanned tree');

  // The other PathRoot::XdgData clients hang off the same fallback, so they move
  // together rather than only Amp being corrected.
  assert.equal(
    clientSourceRoots('opencode', options).opencode[0].dir,
    path.join(portable, '.local', 'share', 'opencode')
  );

  // A drive-relative or POSIX-shaped HOME is not a path Win32 can use, so the
  // profile still wins — the same rule home_dir() applies.
  for (const unusable of ['C:temp', '/home/user', '   ']) {
    assert.equal(
      clientSourceRoots('amp', { ...options, env: { HOME: unusable } }).amp[0].dir,
      path.join(profile, '.local', 'share', 'amp', 'threads'),
      `HOME=${JSON.stringify(unusable)} must not win over the profile`
    );
  }

  // An explicit XDG_DATA_HOME still outranks the home entirely, and it is read
  // from the caller's env rather than process.env like every other resolver here.
  assert.equal(
    clientSourceRoots('amp', {
      ...options,
      env: { HOME: portable, XDG_DATA_HOME: 'E:\\xdg' }
    }).amp[0].dir,
    path.join('E:\\xdg', 'amp', 'threads')
  );

  // Non-Windows platforms ignore HOME for the profile, matching home_dir().
  assert.equal(
    clientSourceRoots('amp', { homeDir: '/home/u', env: { HOME: '/elsewhere' }, platform: 'linux' }).amp[0].dir,
    path.join('/home/u', '.local', 'share', 'amp', 'threads')
  );
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

test('Windows deletes a blank key regardless of the casing the OS reported', () => {
  // Windows env names are case-insensitive and `{ ...process.env }` keeps the
  // casing Node was handed, so a canonical-spelling lookup would miss
  // `Xdg_Data_Home` and leak the blank value into the child. The Windows runner
  // is the only place this can regress, so it is pinned here rather than left to
  // the CI matrix.
  const env = { Path: 'C:\\Windows', Xdg_Data_Home: '   ', HOME: '/home/u' };
  const result = tokscaleEnvWithBlanksDropped(env, 'win32');

  assert.equal(Object.keys(result).some((name) => name.toLowerCase() === 'xdg_data_home'), false);
  // The mixed-case PATH spelling every Windows shell sets must survive.
  assert.equal(result.Path, 'C:\\Windows');
  assert.equal(result.HOME, '/home/u');

  // A non-blank value in any casing is kept.
  const kept = tokscaleEnvWithBlanksDropped({ Xdg_Data_Home: 'C:\\custom' }, 'win32');
  assert.equal(kept.Xdg_Data_Home, 'C:\\custom');
});

test('POSIX keeps a mixed-case key rather than treating it as the XDG variable', () => {
  // Names are case-sensitive on POSIX, so `Xdg_Data_Home` is a different
  // variable and must not be deleted — the narrower rule is the correct one.
  const env = { Xdg_Data_Home: '   ', PATH: '/usr/bin' };
  assert.equal(tokscaleEnvWithBlanksDropped(env, 'linux'), env);
  assert.equal(tokscaleEnvWithBlanksDropped(env, 'darwin'), env);
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
  // Built with path.join so the expectation is native-separator correct: the
  // collector resolves through node:path, so a hardcoded POSIX string fails on
  // Windows for a reason that has nothing to do with the behaviour under test.
  const home = path.join(path.sep, 'tmp', 'amp-blank-consistency');
  const expected = path.join(home, '.local', 'share', 'amp', 'threads');
  for (const blank of ['', '   ', '\t']) {
    process.env.XDG_DATA_HOME = blank;
    const roots = clientSourceRoots('amp', { homeDir: home, platform: 'linux' }).amp;
    assert.deepEqual(roots, [{ id: 'amp-threads', dir: expected }]);
    assert.deepEqual(clientWatchCandidates('amp', { homeDir: home, platform: 'linux' }).amp, [expected]);
  }
});

test('an injected env wins over process.env for the XDG data root', () => {
  // Every resolver in clientSourceRoots() takes the caller's env, so a root that
  // read process.env instead would resolve somewhere the caller never asked for
  // — and the source health check would then disagree with the watcher and the
  // scan. Start with two deliberately different values so the assertion proves
  // which environment won.
  assert.equal(process.env.XDG_DATA_HOME, undefined, 'guard should have cleared the real variable');
  process.env.XDG_DATA_HOME = '/tmp/process-xdg';

  const options = {
    homeDir: '/tmp/injected-home',
    platform: 'linux',
    env: { HOME: '/tmp/injected-home', XDG_DATA_HOME: '/tmp/injected-xdg' }
  };

  assert.equal(
    clientSourceRoots('amp', options).amp[0].dir,
    path.join('/tmp/injected-xdg', 'amp', 'threads')
  );
  assert.deepEqual(
    clientWatchCandidates('amp', options).amp,
    [path.join('/tmp/injected-xdg', 'amp', 'threads')]
  );

  // The other PathRoot::XdgData clients read the same injected value rather than
  // silently falling back to the home.
  assert.equal(
    clientSourceRoots('opencode', options).opencode[0].dir,
    path.join('/tmp/injected-xdg', 'opencode')
  );

  // A blank injected XDG value is still unset, and must not leak the real
  // environment's non-blank value back in.
  const blankInjected = { ...options, env: { HOME: '/tmp/injected-home', XDG_DATA_HOME: '   ' } };
  assert.equal(
    clientSourceRoots('amp', blankInjected).amp[0].dir,
    path.join('/tmp/injected-home', '.local', 'share', 'amp', 'threads')
  );
});
