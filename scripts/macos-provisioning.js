'use strict';

const fs = require('node:fs');
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

// `security cms -D` emits the profile as an XML property list, and a real
// profile carries top-level NSDate and NSData values (CreationDate,
// DeveloperCertificates) that `plutil`'s JSON converters reject outright.
// Parsing that XML directly keeps validation independent of the host plutil
// build: `plutil -extract ... json` succeeds on some macOS versions and
// silently yields nothing on others, which previously made a valid profile
// look like it had no Team ID.
function parsePlistXml(xml) {
  const source = String(xml)
    .replace(/<\?xml[\s\S]*?\?>/g, '')
    .replace(/<!DOCTYPE[^>]*>/g, '')
    .replace(/<!--[\s\S]*?-->/g, '');
  let position = 0;

  const skipWhitespace = () => {
    while (position < source.length && /\s/.test(source[position])) position += 1;
  };

  const readUntil = (closing) => {
    const index = source.indexOf(closing, position);
    if (index === -1) throw new Error(`plist XML: missing ${closing}`);
    const text = source.slice(position, index);
    position = index + closing.length;
    return text;
  };

  const decodeEntities = (text) => text
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, '&');

  const readElement = () => {
    skipWhitespace();
    if (source[position] !== '<') throw new Error('plist XML: expected element');
    const end = source.indexOf('>', position);
    if (end === -1) throw new Error('plist XML: unterminated element');
    let name = source.slice(position + 1, end).trim();
    position = end + 1;
    const selfClosing = name.endsWith('/');
    if (selfClosing) name = name.slice(0, -1).trim();
    // Drop any attributes (`<plist version="1.0">`) so only the tag name stays.
    name = name.split(/[\s/]/, 1)[0];
    if (selfClosing) {
      if (name === 'true') return true;
      if (name === 'false') return false;
      return null;
    }
    switch (name) {
      case 'true':
        return true;
      case 'false':
        return false;
      case 'string':
      case 'key':
        return decodeEntities(readUntil(`</${name}>`));
      case 'integer':
        return Number.parseInt(readUntil('</integer>').trim(), 10);
      case 'real':
        return Number.parseFloat(readUntil('</real>').trim());
      case 'data':
        return readUntil('</data>').replace(/\s+/g, '');
      case 'date':
        return readUntil('</date>').trim();
      case 'dict': {
        const result = {};
        for (;;) {
          skipWhitespace();
          if (source.startsWith('</dict>', position)) {
            position += '</dict>'.length;
            return result;
          }
          const key = readElement();
          result[String(key)] = readElement();
        }
      }
      case 'array': {
        const result = [];
        for (;;) {
          skipWhitespace();
          if (source.startsWith('</array>', position)) {
            position += '</array>'.length;
            return result;
          }
          result.push(readElement());
        }
      }
      case 'plist': {
        const value = readElement();
        skipWhitespace();
        if (source.startsWith('</plist>', position)) position += '</plist>'.length;
        return value;
      }
      default:
        return readUntil(`</${name}>`);
    }
  };

  return readElement();
}

function readPlistXml(filePath, execFileSyncImpl = execFileSync) {
  const text = fs.readFileSync(filePath).toString('utf8');
  if (/^\s*(?:<\?xml|<plist)/.test(text)) return parsePlistXml(text);
  // A binary or otherwise non-XML plist: normalize it to XML first. XML can
  // represent NSDate and NSData, so this conversion never drops a field.
  const converted = execFileSyncImpl('plutil', ['-convert', 'xml1', '-o', '-', filePath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return parsePlistXml(converted);
}

function readProvisioningProfile(filePath, options = {}) {
  const resolvedPath = String(filePath || '').trim();
  if (!resolvedPath || !fs.existsSync(resolvedPath)) {
    throw new Error(`Provisioning profile is missing: ${resolvedPath || '(empty path)'}`);
  }
  if (options.profileReader) return options.profileReader(resolvedPath);
  const execFileSyncImpl = options.execFileSync || execFileSync;
  if (options.plainPlist || path.extname(resolvedPath).toLowerCase() === '.plist') {
    return parseProvisioningProfileDocument(readPlistXml(resolvedPath, execFileSyncImpl));
  }

  const decoded = execFileSyncImpl('security', ['cms', '-D', '-i', resolvedPath], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });
  return parseProvisioningProfileDocument(parsePlistXml(decoded));
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
  parsePlistXml,
  profileIsRequired,
  profilePath,
  readProvisioningProfile,
  validateProvisioningProfile,
  validateProvisioningProfiles
};
