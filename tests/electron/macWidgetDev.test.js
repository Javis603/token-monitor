'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');
const {
  availableDevelopmentIdentities,
  developmentTeamForAppGroup,
  hostLaunchEnvironment,
  parseArguments,
  resolveDeveloperDirectory,
  teamIdentifierFromCodesignOutput,
  updatedWidgetConfig,
  xcconfigContents
} = require('../../scripts/dev-macos-widget');

test('launches the Electron host without inherited run-as-Node mode', () => {
  assert.deepEqual(hostLaunchEnvironment({
    ELECTRON_RUN_AS_NODE: '1',
    TOKEN_MONITOR_APP_GROUP: 'ABCDE12345.tokenmonitor'
  }), {
    TOKEN_MONITOR_APP_GROUP: 'ABCDE12345.tokenmonitor'
  });
});

test('parses the fast Widget deployment arguments', () => {
  assert.deepEqual(parseArguments([
    '--app', '/tmp/Token Monitor.app',
    '--identity', 'Apple Development: Example'
  ]), {
    app: '/tmp/Token Monitor.app',
    identity: 'Apple Development: Example'
  });
  assert.throws(() => parseArguments(['--unknown']), /Unknown argument/);
});

test('respects an explicit Xcode developer directory', () => {
  assert.equal(
    resolveDeveloperDirectory({ DEVELOPER_DIR: '/Custom/Xcode.app/Contents/Developer' }),
    '/Custom/Xcode.app/Contents/Developer'
  );
});

test('derives the Apple team from a Team-prefixed App Group', () => {
  assert.equal(developmentTeamForAppGroup('ABCDE12345.tokenmonitor'), 'ABCDE12345');
  assert.throws(() => developmentTeamForAppGroup('group.com.example.tokenmonitor'), /Team-prefixed/);
});

test('extracts only valid Apple Development identities', () => {
  const output = `
  1) 973348ECF43A7BD4548C50497129A91F4296FD83 "Apple Development: Example (AAAA111111)"
  2) 4D42F717B2003E8CFF35D0C0D3AA83CC587C32B6 "Developer ID Application: Example (BBBB222222)"
     2 valid identities found
  `;
  assert.deepEqual(availableDevelopmentIdentities(output), [
    'Apple Development: Example (AAAA111111)'
  ]);
});

test('extracts the TeamIdentifier from codesign diagnostics', () => {
  assert.equal(
    teamIdentifierFromCodesignOutput('Authority=Apple Development: Example\nTeamIdentifier=ABCDE12345\n'),
    'ABCDE12345'
  );
  assert.equal(teamIdentifierFromCodesignOutput('Signature=adhoc\nTeamIdentifier=not set\n'), 'not set');
});

test('writes an arm64 development xcconfig with the shared Team App Group', () => {
  const output = xcconfigContents({
    appGroup: 'ABCDE12345.tokenmonitor',
    bundleId: 'com.javis.tokenmonitor.widget',
    widgetKind: 'com.tokenmonitor.dashboard',
    urlScheme: 'token-monitor',
    developmentTeam: 'ABCDE12345',
    revision: 'abcdef123456',
    timestamp: '2026-09-13T14:00:00Z',
    packageVersion: '0.54.0',
    marketingVersion: '0.54.0'
  });
  assert.match(output, /TOKEN_MONITOR_APP_GROUP = ABCDE12345\.tokenmonitor/);
  assert.match(output, /TOKEN_MONITOR_WIDGET_BUNDLE_ID = com\.javis\.tokenmonitor\.widget/);
  assert.match(output, /TOKEN_MONITOR_WIDGET_ARCH = arm64/);
  assert.match(output, /TOKEN_MONITOR_WIDGET_SCHEMA_VERSION = 10/);
  assert.match(output, /TOKEN_MONITOR_WIDGET_GIT_REVISION = abcdef123456/);
  assert.match(output, /TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP = 2026-09-13T14:00:00Z/);
  assert.match(output, /DEVELOPMENT_TEAM = ABCDE12345/);
  assert.match(output, /TOKEN_MONITOR_MARKETING_VERSION = 0\.54\.0/);
  assert.match(output, /TOKEN_MONITOR_PACKAGE_VERSION = 0\.54\.0/);
});

test('keeps the packaged Widget descriptor aligned with the incremental UI build', () => {
  const updated = updatedWidgetConfig({
    widgetUIVersion: 1,
    widgetSchemaVersion: 1,
    widgetBundleVersion: '1',
    gitRevision: 'old',
    buildTimestamp: 'old',
    marketingVersion: '0.54.0'
  }, {
    revision: 'abcdef123456',
    timestamp: '2026-09-13T14:00:00Z'
  });
  assert.equal(updated.widgetUIVersion, 37);
  assert.equal(updated.widgetSchemaVersion, 10);
  assert.equal(updated.widgetBundleVersion, '37');
  assert.equal(updated.gitRevision, 'abcdef123456');
  assert.equal(updated.buildTimestamp, '2026-09-13T14:00:00Z');
  assert.equal(updated.marketingVersion, '0.54.0');
});
