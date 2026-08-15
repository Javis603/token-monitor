'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');
const packageJson = require('../package.json');
const {
  isTeamPrefixedAppGroup,
  normalizeMacDistributionChannel,
  validateAppGroupForDistribution,
  validateAppGroupSyntax
} = require('../src/shared/macWidgetConfig');
const {
  readProvisioningProfile,
  profileIsRequired,
  validateProvisioningProfile
} = require('./macos-provisioning');

function fail(message) {
  throw new Error(`[mac-widget] packaged app verification failed: ${message}`);
}

function readPlist(filePath, execFileSyncImpl = execFileSync) {
  try {
    return JSON.parse(String(execFileSyncImpl('plutil', ['-convert', 'json', '-o', '-', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    })));
  } catch (error) {
    fail(`cannot read plist ${path.basename(filePath)}: ${error.message || error}`);
  }
}

function exactArchitectures(filePath, expected, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('lipo', ['-archs', filePath], { encoding: 'utf8' });
  if (result.status !== 0) fail(`lipo failed for ${path.basename(filePath)}`);
  const actual = String(result.stdout || '').trim().split(/\s+/).filter(Boolean).sort();
  if (actual.length !== 1 || actual[0] !== expected) {
    fail(`${path.basename(filePath)} contains ${actual.join(',') || 'no'} architectures; expected exactly ${expected}`);
  }
}

function codesignOutput(filePath, spawnSyncImpl = spawnSync) {
  const result = spawnSyncImpl('codesign', ['-d', '--entitlements', ':-', filePath], { encoding: 'utf8' });
  return `${result.stdout || ''}\n${result.stderr || ''}`;
}

function readCodesignMetadata(filePath, execFileSyncImpl = execFileSync, spawnSyncImpl = spawnSync) {
  let output;
  try {
    const result = execFileSyncImpl('codesign', ['-dv', '--verbose=4', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
    output = typeof result === 'object' && result !== null
      ? `${result.stdout || ''}\n${result.stderr || ''}`
      : String(result || '');
    // codesign writes -d diagnostics to stderr. The real execFileSync API only
    // returns stdout on success, so capture stderr explicitly when its output
    // was not exposed by an injected test double.
    if (!/^(?:TeamIdentifier|Authority|Identifier)=/m.test(output) && execFileSyncImpl === execFileSync) {
      const fallback = spawnSyncImpl('codesign', ['-dv', '--verbose=4', filePath], { encoding: 'utf8' });
      if (fallback.error || fallback.status !== 0) {
        fail(`cannot read code signature ${path.basename(filePath)}: ${fallback.error?.message || fallback.stderr || fallback.status}`);
      }
      output = `${fallback.stdout || ''}\n${fallback.stderr || ''}`;
    }
  } catch (error) {
    if (String(error?.message || '').startsWith('[mac-widget] packaged app verification failed:')) throw error;
    fail(`cannot read code signature ${path.basename(filePath)}: ${error.message || error}`);
  }
  const text = String(output || '');
  const teamIdentifier = text.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null;
  const identifier = text.match(/^Identifier=(.+)$/m)?.[1]?.trim() || null;
  const authorities = Array.from(text.matchAll(/^Authority=(.+)$/gm), (match) => match[1].trim());
  return { teamIdentifier, authorities, identifier };
}

function entitlementValues(xml, key) {
  const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = String(xml || '').match(new RegExp(
    `<key>${escapedKey}</key>\\s*<array>([\\s\\S]*?)</array>`
  ));
  if (!match) return [];
  return Array.from(match[1].matchAll(/<string>([\s\S]*?)<\/string>/g), (entry) => entry[1]);
}

function verifyCodesign(filePath, execFileSyncImpl = execFileSync) {
  try {
    execFileSyncImpl('codesign', ['--verify', '--deep', '--strict', '--verbose=2', filePath], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });
  } catch (_) {
    fail(`codesign verification failed for ${path.basename(filePath)}`);
  }
}

function hasEntitlement(xml, key, value) {
  const keyPattern = new RegExp(`<key>${key.replaceAll('.', '\\.')}</key>[\\s\\S]{0,240}?`);
  if (!keyPattern.test(xml)) return false;
  return value === undefined || entitlementValues(xml, key).includes(value);
}

function verifyAppGroupSources({ appGroup, config, extensionInfo, appEntitlements, extensionEntitlements }) {
  if (config.appGroup !== appGroup) {
    fail(`Widget config App Group ${config.appGroup || '(missing)'} does not match expected ${appGroup}`);
  }
  if (extensionInfo.TokenMonitorAppGroup !== appGroup) {
    fail(`Widget Info.plist App Group ${extensionInfo.TokenMonitorAppGroup || '(missing)'} does not match expected ${appGroup}`);
  }
  if (appEntitlements === undefined && extensionEntitlements === undefined) return;
  for (const [label, entitlements] of [
    ['main app', appEntitlements],
    ['Widget extension', extensionEntitlements]
  ]) {
    const groups = entitlementValues(entitlements, 'com.apple.security.application-groups');
    if (groups.length !== 1 || groups[0] !== appGroup) {
      fail(`${label} entitlements App Group ${groups.join(',') || '(missing)'} does not match expected ${appGroup}`);
    }
  }
}

function verifyFormalCodeSignature({ appPath, extensionPath, appGroup, developmentTeam, execFileSyncImpl, spawnSyncImpl }) {
  const appSignature = readCodesignMetadata(appPath, execFileSyncImpl, spawnSyncImpl);
  const widgetSignature = readCodesignMetadata(extensionPath, execFileSyncImpl, spawnSyncImpl);
  if (isTeamPrefixedAppGroup(appGroup) && appGroup.slice(0, 10) !== appSignature.teamIdentifier) {
    fail('Team-prefixed App Group does not match the actual signing TeamIdentifier');
  }
  if (appSignature.teamIdentifier !== widgetSignature.teamIdentifier) {
    fail('Widget extension TeamIdentifier differs from main app');
  }
  if (appSignature.teamIdentifier !== developmentTeam) {
    fail(`main app TeamIdentifier ${appSignature.teamIdentifier || '(missing)'} does not match DEVELOPMENT_TEAM ${developmentTeam}`);
  }
  if (widgetSignature.teamIdentifier !== developmentTeam) {
    fail(`Widget extension TeamIdentifier ${widgetSignature.teamIdentifier || '(missing)'} does not match DEVELOPMENT_TEAM ${developmentTeam}`);
  }
  if (!appSignature.authorities.some((authority) => authority.includes('Developer ID Application'))) {
    fail('main app code signature is missing a Developer ID Application authority');
  }
  if (!widgetSignature.authorities.some((authority) => authority.includes('Developer ID Application'))) {
    fail('Widget extension code signature is missing a Developer ID Application authority');
  }
  return { appSignature, widgetSignature };
}

function verifyWidgetAppStructure(appPath) {
  const contents = path.join(appPath, 'Contents');
  const extension = path.join(contents, 'PlugIns', 'TokenMonitorWidget.appex');
  const extensionExecutable = path.join(extension, 'Contents', 'MacOS', 'TokenMonitorWidget');
  const reloader = path.join(contents, 'Resources', 'TokenMonitorWidgetReloader');
  const configPath = path.join(contents, 'Resources', 'token-monitor-widget.json');
  for (const [label, filePath] of [
    ['app Contents', contents],
    ['Widget extension', extension],
    ['Widget extension executable', extensionExecutable],
    ['Widget reloader', reloader],
    ['Widget configuration', configPath]
  ]) {
    if (!fs.existsSync(filePath)) fail(`${label} is missing`);
  }
  const forbidden = [];
  function walk(directory) {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      if (['DerivedData', 'build', 'local-widget-build.xcconfig'].includes(entry.name)) forbidden.push(path.join(directory, entry.name));
      if (entry.isDirectory()) walk(path.join(directory, entry.name));
    }
  }
  walk(appPath);
  if (forbidden.length) fail(`build intermediates were packaged: ${forbidden.map((value) => path.basename(value)).join(', ')}`);
  return { contents, extension, extensionExecutable, reloader, configPath };
}

function verifyMacWidgetApp({
  appPath,
  targetArch,
  appId = packageJson.build.appId,
  appGroup,
  widgetBundleId,
  distributionBuild = false,
  localDevelopmentSigning = false,
  developmentTeam,
  distributionChannel,
  skipCodesign = false,
  execFileSyncImpl = execFileSync,
  spawnSyncImpl = spawnSync,
  profileReader
}) {
  const resolvedApp = path.resolve(String(appPath || '').trim());
  if (!resolvedApp.endsWith('.app')) fail('input must be a complete .app bundle');
  try {
    if (distributionBuild) validateAppGroupForDistribution(appGroup, developmentTeam);
    else validateAppGroupSyntax(appGroup);
    if (distributionBuild) normalizeMacDistributionChannel(distributionChannel);
  } catch (error) {
    fail(error.message);
  }
  const paths = verifyWidgetAppStructure(resolvedApp);
  const appInfo = readPlist(path.join(paths.contents, 'Info.plist'), execFileSyncImpl);
  const extensionInfo = readPlist(path.join(paths.extension, 'Contents', 'Info.plist'), execFileSyncImpl);
  const config = JSON.parse(fs.readFileSync(paths.configPath, 'utf8'));
  const expectedArch = targetArch === 'x64' ? 'x86_64' : targetArch;
  if (!['arm64', 'x86_64'].includes(expectedArch)) fail(`unsupported verification architecture ${targetArch}`);
  exactArchitectures(path.join(paths.contents, 'MacOS', appInfo.CFBundleExecutable || 'Token Monitor'), expectedArch, spawnSyncImpl);
  exactArchitectures(paths.extensionExecutable, expectedArch, spawnSyncImpl);
  exactArchitectures(paths.reloader, expectedArch, spawnSyncImpl);

  if (appInfo.CFBundleIdentifier !== appId) fail(`app bundle identifier does not match ${appId}`);
  if (widgetBundleId && extensionInfo.CFBundleIdentifier !== widgetBundleId) fail('Widget bundle identifier does not match configured value');
  verifyAppGroupSources({ appGroup, config, extensionInfo });
  if (extensionInfo.TMWidgetKind !== config.widgetKind) fail('Widget kind differs between Info.plist and widget config');
  if (extensionInfo.TokenMonitorURLScheme !== config.urlScheme) fail('Widget URL scheme differs between Info.plist and widget config');
  const urlTypes = Array.isArray(appInfo.CFBundleURLTypes) ? appInfo.CFBundleURLTypes : [];
  const schemes = urlTypes.flatMap((entry) => Array.isArray(entry.CFBundleURLSchemes) ? entry.CFBundleURLSchemes : []);
  if (!schemes.includes(config.urlScheme)) fail('packaged app is missing the Widget URL scheme');
  if (!/^\d+\.\d+(?:\.\d+)?$/.test(String(config.marketingVersion || ''))) fail('invalid marketing version');
  if (!/^\d+(?:\.\d+){0,2}$/.test(String(config.bundleVersion || ''))) fail('invalid bundle version');
  if (
    appInfo.CFBundleShortVersionString !== config.marketingVersion
    || appInfo.CFBundleVersion !== config.bundleVersion
    || extensionInfo.CFBundleShortVersionString !== config.marketingVersion
    || extensionInfo.CFBundleVersion !== config.bundleVersion
  ) {
    fail('app or Widget extension version fields differ from widget config');
  }

  if (!skipCodesign) {
    verifyCodesign(resolvedApp, execFileSyncImpl);
    verifyCodesign(paths.extension, execFileSyncImpl);
    verifyCodesign(paths.reloader, execFileSyncImpl);
    const appEntitlements = codesignOutput(resolvedApp, spawnSyncImpl);
    const extensionEntitlements = codesignOutput(paths.extension, spawnSyncImpl);
    const reloaderEntitlements = codesignOutput(paths.reloader, spawnSyncImpl);
    verifyAppGroupSources({ appGroup, config, extensionInfo, appEntitlements, extensionEntitlements });
    if (!hasEntitlement(appEntitlements, 'com.apple.security.cs.allow-jit')) fail('main app hardened-runtime entitlements were not preserved');
    if (!hasEntitlement(extensionEntitlements, 'com.apple.security.app-sandbox')) fail('Widget extension is missing App Sandbox entitlement');
    if (
      hasEntitlement(extensionEntitlements, 'com.apple.security.cs.allow-jit')
      || hasEntitlement(reloaderEntitlements, 'com.apple.security.cs.allow-jit')
      || hasEntitlement(reloaderEntitlements, 'com.apple.security.application-groups')
    ) fail('Widget extension or reloader contains forbidden entitlements');
    if (distributionBuild && !localDevelopmentSigning) {
      verifyFormalCodeSignature({
        appPath: resolvedApp,
        extensionPath: paths.extension,
        appGroup,
        developmentTeam,
        execFileSyncImpl,
        spawnSyncImpl
      });
    }
    if (distributionBuild && !localDevelopmentSigning) {
      try {
        execFileSyncImpl('spctl', ['--assess', '--type', 'execute', '--verbose', resolvedApp], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
      } catch (_) {
        fail('formal distribution app failed spctl assessment');
      }
    }
  }

  if (profileIsRequired({ distributionBuild, localDevelopmentSigning, appGroup })) {
    const appProfilePath = path.join(paths.contents, 'embedded.provisionprofile');
    const widgetProfilePath = path.join(paths.extension, 'Contents', 'embedded.provisionprofile');
    if (!fs.existsSync(appProfilePath) || !fs.existsSync(widgetProfilePath)) fail('production App Group build is missing embedded provisioning profiles');
    const readerOptions = profileReader ? { profileReader } : {};
    const appProfile = readProvisioningProfile(appProfilePath, readerOptions);
    const widgetProfile = readProvisioningProfile(widgetProfilePath, readerOptions);
    validateProvisioningProfile(appProfile, {
      role: 'app', bundleId: appId, appGroup, developmentTeam, distributionChannel
    });
    validateProvisioningProfile(widgetProfile, {
      role: 'extension', bundleId: widgetBundleId, appGroup, developmentTeam, distributionChannel
    });
    if (appProfile.teamIdentifier !== widgetProfile.teamIdentifier) {
      fail('embedded provisioning profiles use different Team IDs');
    }
  }
  return { appPath: resolvedApp, architecture: expectedArch, widgetKind: config.widgetKind, urlScheme: config.urlScheme };
}

if (require.main === module) {
  let appPath = process.argv[2];
  if (!appPath) {
    const candidates = [];
    function findApps(directory) {
      if (!fs.existsSync(directory)) return;
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const child = path.join(directory, entry.name);
        if (entry.isDirectory() && entry.name.endsWith('.app')) candidates.push(child);
        else if (entry.isDirectory()) findApps(child);
      }
    }
    findApps(path.resolve('dist'));
    if (candidates.length !== 1) fail('usage: node scripts/verify-macos-widget-app.js <path-to-app> (or exactly one .app under dist)');
    [appPath] = candidates;
  }
  verifyMacWidgetApp({
    appPath,
    targetArch: process.env.TOKEN_MONITOR_WIDGET_ARCH || process.arch,
    appGroup: process.env.TOKEN_MONITOR_APP_GROUP || 'group.com.example.tokenmonitor',
    widgetBundleId: process.env.TOKEN_MONITOR_WIDGET_BUNDLE_ID || 'com.javis.tokenmonitor.widget',
    distributionBuild: process.env.TOKEN_MONITOR_WIDGET_DISTRIBUTION === '1',
    localDevelopmentSigning: process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING === '1',
    developmentTeam: process.env.DEVELOPMENT_TEAM,
    distributionChannel: process.env.TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL
  });
  console.log(`[mac-widget] verified ${appPath}`);
}

module.exports = {
  exactArchitectures,
  entitlementValues,
  hasEntitlement,
  readCodesignMetadata,
  verifyAppGroupSources,
  verifyFormalCodeSignature,
  verifyMacWidgetApp,
  verifyWidgetAppStructure
};
