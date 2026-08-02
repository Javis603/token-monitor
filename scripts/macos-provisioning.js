'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const {
  classifyAppGroup,
  isTeamPrefixedAppGroup,
  normalizeMacDistributionChannel,
  validateAppGroupForDistribution
} = require('../src/shared/macWidgetConfig');

function profilePath(env, name) {
  const value = String(env?.[name] || '').trim();
  return value || null;
}

function profileIsRequired({ distributionBuild, localDevelopmentSigning, appGroup }) {
  return Boolean(
    distributionBuild
    && !localDevelopmentSigning
    && classifyAppGroup(appGroup) === 'group-profile'
  );
}

function parseProvisioningProfileDocument(document) {
  const entitlements = document?.Entitlements && typeof document.Entitlements === 'object'
    ? document.Entitlements
    : {};
  const applicationIdentifier = String(
    entitlements['application-identifier']
      || entitlements['com.apple.application-identifier']
      || ''
  ).trim();
  const teamIdentifier = String(
    document?.TeamIdentifier?.[0]
      || entitlements['com.apple.developer.team-identifier']
      || applicationIdentifier.split('.')[0]
      || ''
  ).trim();
  const applicationGroups = Array.isArray(entitlements['com.apple.security.application-groups'])
    ? entitlements['com.apple.security.application-groups'].map((value) => String(value).trim()).filter(Boolean)
    : [];
  const getTaskAllow = entitlements['get-task-allow'] === true;
  return {
    applicationIdentifier,
    teamIdentifier,
    applicationGroups,
    expirationDate: document?.ExpirationDate ? new Date(document.ExpirationDate) : null,
    getTaskAllow,
    provisionsAllDevices: document?.ProvisionsAllDevices === true,
    hasProvisionedDevices: Object.hasOwn(document || {}, 'ProvisionedDevices')
  };
}

function readPlistJson(filePath, execFileSyncImpl = execFileSync) {
  // `plutil -convert json` rejects NSDate values instead of serializing them.
  // Provisioning profiles always contain ExpirationDate, so remove that one
  // value from a temporary copy and read it separately as ISO text.
  let expirationDate = null;
  try {
    expirationDate = String(execFileSyncImpl('plutil', [
      '-extract', 'ExpirationDate', 'raw', '-o', '-', filePath
    ], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })).trim() || null;
  } catch (_) {}

  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-plist-'));
  const temporaryPath = path.join(temporaryDirectory, 'profile.plist');
  try {
    fs.copyFileSync(filePath, temporaryPath);
    if (expirationDate) {
      execFileSyncImpl('plutil', ['-remove', 'ExpirationDate', temporaryPath], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe']
      });
    }
    const output = execFileSyncImpl('plutil', ['-convert', 'json', '-o', '-', temporaryPath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const document = JSON.parse(String(output));
    if (expirationDate) document.ExpirationDate = expirationDate;
    return document;
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function readProvisioningProfile(filePath, options = {}) {
  const resolvedPath = String(filePath || '').trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`Provisioning profile is missing: ${resolvedPath || '(empty path)'}`);
  }
  if (options.profileReader) return options.profileReader(resolvedPath);
  const execFileSyncImpl = options.execFileSync || execFileSync;
  if (options.plainPlist || path.extname(resolvedPath).toLowerCase() === '.plist') {
    return parseProvisioningProfileDocument(readPlistJson(resolvedPath, execFileSyncImpl));
  }

  const decoded = execFileSyncImpl('security', ['cms', '-D', '-i', resolvedPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  const temporaryDirectory = fs.mkdtempSync(path.join(os.tmpdir(), 'token-monitor-profile-'));
  const plistPath = path.join(temporaryDirectory, 'decoded.plist');
  try {
    fs.writeFileSync(plistPath, decoded, { mode: 0o600 });
    return parseProvisioningProfileDocument(readPlistJson(plistPath, execFileSyncImpl));
  } finally {
    fs.rmSync(temporaryDirectory, { recursive: true, force: true });
  }
}

function validateProvisioningProfile(profile, {
  role,
  bundleId,
  appGroup,
  now = new Date(),
  developmentTeam,
  distributionChannel
}) {
  const label = role === 'extension' ? 'Widget extension' : 'main app';
  if (!profile || typeof profile !== 'object') throw new Error(`${label} provisioning profile could not be decoded`);
  validateAppGroupForDistribution(appGroup, developmentTeam);
  normalizeMacDistributionChannel(distributionChannel);
  if (!/^[A-Z0-9]{10}$/.test(profile.teamIdentifier)) {
    throw new Error(`${label} provisioning profile has no valid Team ID`);
  }
  if (developmentTeam && profile.teamIdentifier !== developmentTeam) {
    throw new Error(`${label} provisioning profile Team ID does not match DEVELOPMENT_TEAM`);
  }
  const expectedApplicationIdentifier = `${profile.teamIdentifier}.${bundleId}`;
  if (profile.applicationIdentifier !== expectedApplicationIdentifier) {
    throw new Error(`${label} provisioning profile bundle identifier does not match ${bundleId}`);
  }
  if (!profile.applicationGroups.includes(appGroup)) {
    throw new Error(`${label} provisioning profile does not authorize App Group ${appGroup}`);
  }
  if (!(profile.expirationDate instanceof Date) || Number.isNaN(profile.expirationDate.getTime()) || profile.expirationDate <= new Date(now)) {
    throw new Error(`${label} provisioning profile is expired or has no valid expiration date`);
  }
  if (profile.getTaskAllow) {
    throw new Error(`${label} provisioning profile is a development profile; distribution requires a non-development profile`);
  }
  if (profile.provisionsAllDevices !== true) {
    throw new Error(`${label} provisioning profile is not a Developer ID distribution profile: ProvisionsAllDevices is false`);
  }
  if (profile.hasProvisionedDevices) {
    throw new Error(`${label} provisioning profile is not a Developer ID distribution profile: ProvisionedDevices is present`);
  }
  return profile;
}

function validateProvisioningProfiles({
  appProfilePath,
  widgetProfilePath,
  appBundleId,
  widgetBundleId,
  appGroup,
  now,
  profileReader,
  developmentTeam,
  distributionChannel
}) {
  validateAppGroupForDistribution(appGroup, developmentTeam);
  normalizeMacDistributionChannel(distributionChannel);
  if (!appProfilePath || !widgetProfilePath) {
    throw new Error('Production Widget distribution with a group.* App Group requires TOKEN_MONITOR_APP_PROVISIONING_PROFILE and TOKEN_MONITOR_WIDGET_PROVISIONING_PROFILE');
  }
  const readerOptions = profileReader ? { profileReader } : {};
  const appProfile = readProvisioningProfile(appProfilePath, readerOptions);
  const widgetProfile = readProvisioningProfile(widgetProfilePath, readerOptions);
  validateProvisioningProfile(appProfile, {
    role: 'app', bundleId: appBundleId, appGroup, now, developmentTeam, distributionChannel
  });
  validateProvisioningProfile(widgetProfile, {
    role: 'extension', bundleId: widgetBundleId, appGroup, now, developmentTeam, distributionChannel
  });
  if (appProfile.teamIdentifier !== widgetProfile.teamIdentifier) {
    throw new Error('Main app and Widget extension provisioning profiles use different Team IDs');
  }
  return { appProfile, widgetProfile };
}

async function copyProvisioningProfiles({ appProfilePath, widgetProfilePath, appPath, extensionPath, fsApi = require('node:fs/promises') }) {
  if (!appProfilePath || !widgetProfilePath) return false;
  await fsApi.copyFile(widgetProfilePath, path.join(extensionPath, 'Contents', 'embedded.provisionprofile'));
  await fsApi.copyFile(appProfilePath, path.join(appPath, 'Contents', 'embedded.provisionprofile'));
  return true;
}

module.exports = {
  classifyAppGroup,
  copyProvisioningProfiles,
  isTeamPrefixedAppGroup,
  parseProvisioningProfileDocument,
  profileIsRequired,
  profilePath,
  readProvisioningProfile,
  validateProvisioningProfile,
  validateProvisioningProfiles
};
