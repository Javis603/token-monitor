'use strict';

const assert = require('node:assert/strict');
const path = require('node:path');
const test = require('node:test');
const {
  isTeamPrefixedAppGroup,
  profileIsRequired,
  validateProvisioningProfile,
  validateProvisioningProfiles
} = require('../../scripts/macos-provisioning');

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
      getTaskAllow: false
    },
    widget: {
      applicationIdentifier: 'ABCDE12345.com.example.tokenmonitor.widget',
      teamIdentifier: 'ABCDE12345',
      applicationGroups: [APP_GROUP],
      expirationDate: new Date('2030-01-01T00:00:00Z'),
      getTaskAllow: false
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
    profileReader: (filePath) => filePath === appPath ? fixtureProfiles().app : fixtureProfiles().widget
  });
  assert.equal(result.appProfile.teamIdentifier, 'ABCDE12345');
  assert.deepEqual(result.widgetProfile.applicationGroups, [APP_GROUP]);
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
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP
  }), /does not authorize App Group/);
});

test('rejects bundle and Team mismatches', () => {
  const { app, widget } = fixtureProfiles();
  assert.throws(() => validateProvisioningProfile(app, {
    role: 'app', bundleId: 'com.other.tokenmonitor', appGroup: APP_GROUP
  }), /bundle identifier/);
  assert.throws(() => validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    profileReader: (filePath) => filePath === appPath ? app : {
      ...widget,
      teamIdentifier: 'ZZZZZ99999',
      applicationIdentifier: 'ZZZZZ99999.com.example.tokenmonitor.widget'
    }
  }), /different Team IDs/);
});

test('rejects expired and development profiles', () => {
  const profile = fixtureProfiles().app;
  assert.throws(() => validateProvisioningProfile({ ...profile, expirationDate: new Date('2000-01-01T00:00:00Z') }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP
  }), /expired/);
  assert.throws(() => validateProvisioningProfile({ ...profile, getTaskAllow: true }, {
    role: 'app', bundleId: 'com.example.tokenmonitor', appGroup: APP_GROUP
  }), /development profile/);
});

test('rejects app and extension profiles that authorize different groups', () => {
  const { app, widget } = fixtureProfiles();
  assert.throws(() => validateProvisioningProfiles({
    appProfilePath: appPath,
    widgetProfilePath: widgetPath,
    appBundleId: 'com.example.tokenmonitor',
    widgetBundleId: 'com.example.tokenmonitor.widget',
    appGroup: APP_GROUP,
    profileReader: (filePath) => filePath === appPath ? app : { ...widget, applicationGroups: ['group.other'] }
  }), /does not authorize App Group/);
});
