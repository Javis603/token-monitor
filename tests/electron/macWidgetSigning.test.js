'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  appSignOptions,
  extensionSignArgs,
  localCodesignWrapperScript,
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

test('local codesign wrapper removes timestamp arguments without changing release signing', () => {
  const wrapper = localCodesignWrapperScript();

  assert.match(wrapper, /--timestamp\|--timestamp=\*/);
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
