'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  appSignOptions,
  extensionSignArgs,
  localCodesignWrapperScript,
  localElectronHelperEntitlements,
  localElectronHelperPaths,
  localElectronHelperSignArgs,
  localMainAppSignArgs,
  widgetURLScheme
} = require('../../scripts/sign-macos-with-widget');

test('keeps release timestamp and hardened runtime signing defaults', () => {
  const options = { identity: 'Developer ID Application: Example', hardenedRuntime: true };

  assert.strictEqual(appSignOptions(options, false), options);
  assert.deepEqual(extensionSignArgs({
    identity: options.identity,
    entitlementsPath: '/tmp/widget.entitlements',
    keychain: '/tmp/test.keychain',
    localDevelopmentSigning: false
  }), [
    '--force', '--sign', options.identity,
    '--entitlements', '/tmp/widget.entitlements',
    '--options', 'runtime', '--timestamp',
    '--keychain', '/tmp/test.keychain'
  ]);
});

test('disables timestamp and hardened runtime only for local development signing', async () => {
  const options = {
    identity: 'Apple Development: Example',
    hardenedRuntime: true,
    optionsForFile: async () => ({ entitlements: '/tmp/inherit.entitlements' })
  };

  const localOptions = appSignOptions(options, true);
  assert.equal(localOptions.identity, options.identity);
  assert.equal(localOptions.hardenedRuntime, false);
  assert.equal(localOptions.timestamp, 'none');
  assert.equal(localOptions.ignore.length, 1);
  assert.equal(localOptions.ignore[0](path.join(
    path.sep,
    'tmp',
    'Electron Framework.framework',
    'Versions',
    'Current',
    'Resources',
    'locale.pak'
  )), true);
  assert.equal(localOptions.ignore[0](path.join(
    path.sep,
    'tmp',
    'Electron Framework.framework',
    'Versions',
    'A',
    'Resources',
    'locale.pak'
  )), false);
  assert.deepEqual(await localOptions.optionsForFile('/tmp/example'), {
    entitlements: '/tmp/inherit.entitlements',
    hardenedRuntime: false,
    timestamp: 'none'
  });
  assert.deepEqual(extensionSignArgs({
    identity: options.identity,
    entitlementsPath: '/tmp/widget.entitlements',
    localDevelopmentSigning: true
  }), [
    '--force', '--sign', options.identity,
    '--entitlements', '/tmp/widget.entitlements'
  ]);
  assert.equal(options.hardenedRuntime, true);
  assert.equal(options.timestamp, undefined);
});

test('local ad-hoc signing explicitly signs every Electron helper with preview entitlements', () => {
  const app = path.join(path.sep, 'tmp', 'Token Monitor.app');
  const helpers = localElectronHelperPaths(app);

  assert.deepEqual(helpers.map((helper) => path.basename(helper)), [
    'Token Monitor Helper.app',
    'Token Monitor Helper (GPU).app',
    'Token Monitor Helper (Plugin).app',
    'Token Monitor Helper (Renderer).app'
  ]);
  assert.deepEqual(localElectronHelperSignArgs({
    identity: '-',
    entitlements: '/tmp/local-helper.entitlements',
    helper: helpers[0]
  }), [
    '--force', '--sign', '-',
    '--entitlements', '/tmp/local-helper.entitlements',
    helpers[0]
  ]);
  const entitlements = localElectronHelperEntitlements();
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-jit/);
  assert.match(entitlements, /com\.apple\.security\.cs\.allow-unsigned-executable-memory/);
  assert.match(entitlements, /com\.apple\.security\.cs\.disable-library-validation/);
});

test('local codesign wrapper disables timestamp and hardened runtime without changing release signing', () => {
  const wrapper = localCodesignWrapperScript();

  assert.match(wrapper, /--timestamp\|--timestamp=\*/);
  assert.match(wrapper, /filtered\+=\("--timestamp=none"\)/);
  assert.match(wrapper, /--options\) skip_runtime=true/);
  assert.match(wrapper, /--options=runtime\) continue/);
  assert.match(wrapper, /exec \/usr\/bin\/codesign/);
});

test('local main app re-sign keeps its entitlement without release-only flags', () => {
  assert.deepEqual(localMainAppSignArgs({
    identity: 'Apple Development: Example',
    entitlements: '/tmp/main.entitlements',
    keychain: '/tmp/test.keychain',
    app: '/tmp/Token Monitor Widget Dev.app'
  }), [
    '--force', '--sign', 'Apple Development: Example',
    '--entitlements', '/tmp/main.entitlements',
    '--keychain', '/tmp/test.keychain',
    '/tmp/Token Monitor Widget Dev.app'
  ]);
});

test('accepts only a safe Widget URL scheme', () => {
  const previous = process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME;
  try {
    process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME = 'token-monitor-widget-dev';
    assert.equal(widgetURLScheme(), 'token-monitor-widget-dev');
    process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME = 'bad scheme';
    assert.throws(() => widgetURLScheme(), /unsupported characters/);
  } finally {
    if (previous === undefined) delete process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME;
    else process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME = previous;
  }
});
