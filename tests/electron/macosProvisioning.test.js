'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  classifyAppGroup,
  isTeamPrefixedAppGroup,
  parseProvisioningProfileDocument,
  profileIsRequired,
  validateProvisioningProfile,
  validateProvisioningProfiles
} = require('../../scripts/macos-provisioning');
const { validateAppGroup } = require('../../src/shared/macWidgetConfig');

const fixtureRoot = path.join(__dirname, '..', 'fixtures', 'macos');
const appPath = path.join(fixtureRoot, 'good-app.plist');
const widgetPath = path.join(fixtureRoot, 'good-widget.plist');
const APP_GROUP = 'group.com.example.tokenmonitor';

function fixtureProfiles() {
  return {
    app: {
      applicationIdentifier: 'ABCDE12345.com.example.tokenmonitor',
      teamIdentifier: 'ABCDE12345',
      applicationGroups: [APP_GROUP],
      expirationDate: new Date('2030-01-01T00:00:00Z'),
      getTaskAllow: false,
      provisionsAllDevices: true,
      hasProvisionedDevices: false
    },
    widget: {
      applicationIdentifier: 'ABCDE12345.com.example.tokenmonitor.widget',
      teamIdentifier: 'ABCDE12345',
      applicationGroups: [APP_GROUP],
      expirationDate: new Date('2030-01-01T00:00:00Z'),
      getTaskAllow: false,
      provisionsAllDevices: true,
      hasProvisionedDevices: false
    }
  };
}

test('reads fixture provisioning profiles on macOS', { skip: process.platform !== 'darwin' }, () => {
  const { readProvisioningProfile } = require('../../scripts/macos-provisioning');
  assert.equal(readProvisioningProfile(appPath, { plainPlist: true }).teamIdentifier, 'ABCDE12345');
  assert.equal(readProvisioningProfile(widgetPath, { plainPlist: true }).applicationIdentifier, 'ABCDE12345.com.example.tokenmonitor.widget');
});

test('validates fixture app and Widget profiles for the production App Group', () => {
  const result = validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    developmentTeam: 'ABCDE12345',
    profileReader: (filePath) => filePath === appPath ? fixtureProfiles().app : fixtureProfiles().widget
  });
  assert.equal(result.appProfile.teamIdentifier, 'ABCDE12345');
  assert.deepEqual(result.widgetProfile.applicationGroups, [APP_GROUP]);
});

test('classifies and validates the two supported App Group formats', () => {
  assert.equal(classifyAppGroup(APP_GROUP), 'group-profile');
  assert.equal(classifyAppGroup('ABCDE12345.com.example.tokenmonitor'), 'team-prefixed');
  assert.equal(classifyAppGroup('com.javis.tokenmonitor.shared'), 'invalid');
  assert.equal(classifyAppGroup('SHORT.com.example.tokenmonitor'), 'invalid');
  assert.equal(classifyAppGroup('ABCDEFGHIJK.com.example.tokenmonitor'), 'invalid');
  assert.equal(classifyAppGroup('../../credentials'), 'invalid');
  assert.doesNotThrow(() => validateAppGroup('ABCDE12345.com.example.tokenmonitor'));
  assert.throws(() => validateAppGroup(
    'ABCDE12345.com.example.tokenmonitor', { developmentTeam: 'ZZZZZ99999' }
  ), /does not match DEVELOPMENT_TEAM/);
  assert.throws(() => validateAppGroup(
    'ABCDE12345.com.example.tokenmonitor', { requireMatchingTeamPrefix: true }
  ), /DEVELOPMENT_TEAM is required/);
});

test('requires profiles for group.* but not for a Team-prefixed App Group', () => {
  assert.equal(profileIsRequired({ distributionBuild: true, localDevelopmentSigning: false, appGroup: APP_GROUP }), true);
  assert.equal(profileIsRequired({ distributionBuild: true, localDevelopmentSigning: false, appGroup: 'ABCDE12345.com.example.tokenmonitor' }), false);
  assert.equal(isTeamPrefixedAppGroup('ABCDE12345.com.example.tokenmonitor'), true);
  assert.equal(isTeamPrefixedAppGroup('ABCD.com.example.tokenmonitor'), false);
});

test('rejects a missing group authorization', () => {
  const profile = fixtureProfiles().app;
  assert.throws(() => validateProvisioningProfile({ ...profile, applicationGroups: [] }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /does not authorize App Group/);
});

test('rejects bundle and Team mismatches', () => {
  const { app, widget } = fixtureProfiles();
  assert.throws(() => validateProvisioningProfile(app, {
    role: 'app', bundleId: 'com.other.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /bundle identifier/);
  assert.throws(() => validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    developmentTeam: 'ABCDE12345',
    profileReader: (filePath) => filePath === appPath ? app : {
      ...widget,
      teamIdentifier: 'ZZZZZ99999',
      applicationIdentifier: 'ZZZZZ99999.com.example.tokenmonitor.widget'
    }
  }), /does not match DEVELOPMENT_TEAM/);
});

test('rejects expired and development profiles', () => {
  const profile = fixtureProfiles().app;
  assert.throws(() => validateProvisioningProfile({ ...profile, expirationDate: new Date('2000-01-01T00:00:00Z') }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /expired/);
  assert.throws(() => validateProvisioningProfile({ ...profile, getTaskAllow: true }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /development profile/);
});

test('rejects non-Developer ID provisioning profile channels', () => {
  const profile = fixtureProfiles().app;
  const widgetProfile = fixtureProfiles().widget;
  assert.equal(parseProvisioningProfileDocument({ ProvisionedDevices: [] }).hasProvisionedDevices, true);
  assert.throws(() => validateProvisioningProfile({
    ...profile, provisionsAllDevices: false
  }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /Developer ID distribution profile.*ProvisionsAllDevices/);
  assert.throws(() => validateProvisioningProfile({
    ...widgetProfile, hasProvisionedDevices: true
  }, {
    role: 'extension', bundleId: 'com.example.tokenmonitor.widget', appGroup: APP_GROUP, developmentTeam: 'ABCDE12345'
  }), /Developer ID distribution profile.*ProvisionedDevices/);
  assert.throws(() => validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    developmentTeam: 'ABCDE12345',
    distributionChannel: 'mac-app-store',
    profileReader: (filePath) => filePath === appPath ? profile : fixtureProfiles().widget
  }), /TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL/);
});

test('requires a matching explicit Team ID for provisioning profiles when supplied', () => {
  const profile = fixtureProfiles().app;
  assert.throws(() => validateProvisioningProfile(profile, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP, developmentTeam: 'ZZZZZ99999'
  }), /does not match DEVELOPMENT_TEAM/);
});

test('requires an explicit Team ID for production provisioning validation', () => {
  assert.throws(() => validateProvisioningProfile(fixtureProfiles().app, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP
  }), /DEVELOPMENT_TEAM is required/);
});

test('rejects app and extension profiles that authorize different groups', () => {
  const { app, widget } = fixtureProfiles();
  assert.throws(() => validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    developmentTeam: 'ABCDE12345',
    profileReader: (filePath) => filePath === appPath ? app : { ...widget, applicationGroups: ['group.other'] }
  }), /does not authorize App Group/);
});
