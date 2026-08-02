'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const {
  normalizeMacDistributionChannel,
  normalizeWidgetURLScheme,
  validateAppGroupForDistribution,
  validateAppGroupSyntax
} = require('./macos-widget-config');
const {
  profileIsRequired,
  profilePath,
  validateProvisioningProfiles
} = require('./macos-provisioning');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'native', 'macos', 'TokenMonitorWidget.xcodeproj');
const OUTPUT = path.join(ROOT, 'build', 'macos-widget');
const DERIVED_DATA = path.join(OUTPUT, 'DerivedData');
const PACKAGE_JSON = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
const DEFAULT_APP_ID = String(PACKAGE_JSON.build?.appId || 'com.example.tokenmonitor').trim();
const DEFAULT_APP_GROUP = 'group.com.example.tokenmonitor';
const DEFAULT_WIDGET_BUNDLE_ID = `${DEFAULT_APP_ID}.widget`;
const DEFAULT_URL_SCHEME = 'token-monitor';
const DEFAULT_WIDGET_KIND = 'com.tokenmonitor.dashboard';
const WIDGET_UI_VERSION = 19;
const WIDGET_SCHEMA_VERSION = 6;
const WIDGET_ARCHITECTURES = Object.freeze({
  arm64: Object.freeze({ name: 'arm64', xcodeArch: 'arm64', swiftArch: 'arm64' }),
  x64: Object.freeze({ name: 'x64', xcodeArch: 'x86_64', swiftArch: 'x86_64' })
});

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json version is not a valid semantic version');
  }
  return version;
}

function widgetVersions(version = packageVersion()) {
  const match = String(version).match(/^(\d+\.\d+\.\d+)(?:[-+][0-9A-Za-z.-]+)?$/);
  if (!match) throw new Error('package.json version is not a valid semantic version');
  return {
    packageVersion: String(version),
    marketingVersion: match[1],
    bundleVersion: match[1]
  };
}

function configuredIdentifier(name, fallback) {
  const value = String(process.env[name] || fallback).trim();
  if (!/^[A-Za-z0-9.-]+$/.test(value)) throw new Error(`${name} contains unsupported characters`);
  return value;
}

function gitRevision() {
  const result = spawnSync('git', ['rev-parse', '--short=12', 'HEAD'], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.status !== 0) return 'unknown';
  return String(result.stdout || '').trim() || 'unknown';
}

function buildTimestamp(now = new Date()) {
  return now.toISOString().replace(/\.\d{3}Z$/, 'Z');
}

function resolveWidgetArchitecture(value = process.env.TOKEN_MONITOR_WIDGET_ARCH || process.arch) {
  const raw = String(value || '').trim().toLowerCase();
  const architecture = WIDGET_ARCHITECTURES[raw];
  if (!architecture) {
    throw new Error(`TOKEN_MONITOR_WIDGET_ARCH must be one of: ${Object.keys(WIDGET_ARCHITECTURES).join(', ')} (received ${raw || 'empty'})`);
  }
  return architecture;
}

function lipoArchitectures(filePath) {
  const result = spawnSync('lipo', ['-archs', filePath], {
    cwd: ROOT,
    encoding: 'utf8'
  });
  if (result.error || result.status !== 0) {
    throw new Error(`lipo -archs failed for ${filePath}: ${result.error?.message || result.stderr || result.status}`);
  }
  return String(result.stdout || '').trim().split(/\s+/).filter(Boolean).sort();
}

function assertWidgetArchitecture(extension, helperBinary, architecture) {
  const expected = [architecture.xcodeArch].sort();
  for (const filePath of [path.join(extension, 'Contents', 'MacOS', 'TokenMonitorWidget'), helperBinary]) {
    const actual = lipoArchitectures(filePath);
    if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
      throw new Error(`Widget architecture mismatch for ${filePath}: expected ${expected.join(',')}, got ${actual.join(',') || 'none'}`);
    }
  }
}

function validateDistributionIdentifiers({
  appGroup,
  bundleId,
  appId = DEFAULT_APP_ID,
  distributionBuild,
  developmentTeam = process.env.DEVELOPMENT_TEAM
}) {
  if (!distributionBuild) {
    validateAppGroupSyntax(appGroup);
    return;
  }
  if (!process.env.TOKEN_MONITOR_APP_GROUP || /^group\.com\.example\./i.test(appGroup)) {
    throw new Error('TOKEN_MONITOR_APP_GROUP must be explicitly configured for a distribution build');
  }
  if (!process.env.TOKEN_MONITOR_WIDGET_BUNDLE_ID || /^com\.example\./i.test(bundleId)) {
    throw new Error('TOKEN_MONITOR_WIDGET_BUNDLE_ID must be explicitly configured for a distribution build');
  }
  if (!bundleId.startsWith(`${appId}.`)) {
    throw new Error(`TOKEN_MONITOR_WIDGET_BUNDLE_ID must be in the ${appId}. namespace`);
  }
  validateAppGroupForDistribution(appGroup, developmentTeam);
}

function xmlEscape(value) {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

function entitlementPlist(appGroup, extension = false) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${extension ? '  <key>com.apple.security.app-sandbox</key>\n  <true/>\n' : `  <key>com.apple.security.cs.allow-jit</key>
  <true/>
  <key>com.apple.security.cs.allow-unsigned-executable-memory</key>
  <true/>
  <key>com.apple.security.cs.disable-library-validation</key>
  <true/>
`}  <key>com.apple.security.application-groups</key>
  <array>
    <string>${xmlEscape(appGroup)}</string>
  </array>
</dict>
</plist>
`;
}

function emptyEntitlementPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict/>
</plist>
`;
}

function xcconfigLine(key, value) {
  return `${key} = ${String(value).replaceAll('\n', '')}`;
}

function sanitizedBuildOutput(text) {
  return String(text || '')
    .replace(/TOKEN_MONITOR_APP_GROUP = .+/g, 'TOKEN_MONITOR_APP_GROUP = [redacted]')
    .replace(/TOKEN_MONITOR_WIDGET_BUNDLE_ID = .+/g, 'TOKEN_MONITOR_WIDGET_BUNDLE_ID = [redacted]')
    .replace(/--bundle-identifier [^ ]+/g, '--bundle-identifier [redacted]')
    .replace(/bundle-identifier [^ ]+/g, 'bundle-identifier [redacted]');
}

function main() {
  if (process.platform !== 'darwin') {
    console.log('[mac-widget] skipped: xcodebuild is only available on macOS');
    return;
  }

  const appGroup = configuredIdentifier('TOKEN_MONITOR_APP_GROUP', DEFAULT_APP_GROUP);
  const bundleId = configuredIdentifier('TOKEN_MONITOR_WIDGET_BUNDLE_ID', DEFAULT_WIDGET_BUNDLE_ID);
  const urlScheme = normalizeWidgetURLScheme(process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME, DEFAULT_URL_SCHEME);
  const widgetKind = configuredIdentifier('TOKEN_MONITOR_WIDGET_KIND', DEFAULT_WIDGET_KIND);
  const architecture = resolveWidgetArchitecture();
  const revision = String(process.env.TOKEN_MONITOR_WIDGET_GIT_REVISION || gitRevision()).trim();
  const timestamp = String(process.env.TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP || buildTimestamp()).trim();
  const versions = widgetVersions();
  const appId = DEFAULT_APP_ID;
  const distributionBuild = process.env.TOKEN_MONITOR_WIDGET_DISTRIBUTION === '1';
  const localDevelopmentSigning = process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING === '1';
  const developmentTeam = String(process.env.DEVELOPMENT_TEAM || '').trim();
  validateDistributionIdentifiers({ appGroup, bundleId, appId, distributionBuild, developmentTeam });
  const distributionChannel = distributionBuild
    ? normalizeMacDistributionChannel(process.env.TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL)
    : null;
  const appProfilePath = profilePath(process.env, 'TOKEN_MONITOR_APP_PROVISIONING_PROFILE');
  const widgetProfilePath = profilePath(process.env, 'TOKEN_MONITOR_WIDGET_PROVISIONING_PROFILE');
  if (profileIsRequired({ distributionBuild, localDevelopmentSigning, appGroup })) {
    validateProvisioningProfiles({
      appProfilePath,
      widgetProfilePath,
      appBundleId: appId,
      widgetBundleId: bundleId,
      appGroup,
      developmentTeam,
      distributionChannel
    });
  }
  if (localDevelopmentSigning && !distributionBuild) {
    console.log('[mac-widget] Local ad-hoc preview does not validate production App Group authorization.');
  }
  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const xcconfigPath = path.join(OUTPUT, 'local-widget-build.xcconfig');
  fs.writeFileSync(xcconfigPath, `${[
    xcconfigLine('CURRENT_PROJECT_VERSION', versions.bundleVersion),
    xcconfigLine('MARKETING_VERSION', versions.marketingVersion),
    xcconfigLine('TOKEN_MONITOR_BUNDLE_VERSION', versions.bundleVersion),
    xcconfigLine('TOKEN_MONITOR_MARKETING_VERSION', versions.marketingVersion),
    xcconfigLine('TOKEN_MONITOR_PACKAGE_VERSION', versions.packageVersion),
    xcconfigLine('TOKEN_MONITOR_APP_GROUP', appGroup),
    xcconfigLine('TOKEN_MONITOR_WIDGET_BUNDLE_ID', bundleId),
    xcconfigLine('TOKEN_MONITOR_WIDGET_URL_SCHEME', urlScheme),
    xcconfigLine('TOKEN_MONITOR_WIDGET_KIND', widgetKind),
    xcconfigLine('TOKEN_MONITOR_WIDGET_ARCH', architecture.name),
    xcconfigLine('TOKEN_MONITOR_WIDGET_GIT_REVISION', revision),
    xcconfigLine('TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP', timestamp),
    xcconfigLine('DEVELOPMENT_TEAM', developmentTeam)
  ].join('\n')}\n`, { mode: 0o600 });

  const args = [
    '-project', PROJECT,
    '-scheme', 'TokenMonitorWidget',
    '-configuration', 'Release',
    '-derivedDataPath', DERIVED_DATA,
    '-xcconfig', xcconfigPath,
    'build',
    'CODE_SIGNING_ALLOWED=NO',
    `ARCHS=${architecture.xcodeArch}`,
    'ONLY_ACTIVE_ARCH=YES'
  ];
  const result = spawnSync('xcodebuild', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    process.stdout.write(sanitizedBuildOutput(result.stdout));
    process.stderr.write(sanitizedBuildOutput(result.stderr));
    throw new Error(`xcodebuild exited with status ${result.status}`);
  }

  const builtExtension = path.join(DERIVED_DATA, 'Build', 'Products', 'Release', 'TokenMonitorWidget.appex');
  const stagedExtension = path.join(OUTPUT, 'TokenMonitorWidget.appex');
  const helperSource = path.join(ROOT, 'scripts', 'TokenMonitorWidgetReloader.swift');
  const helperBinary = path.join(OUTPUT, 'TokenMonitorWidgetReloader');
  if (!fs.existsSync(builtExtension)) throw new Error(`Widget extension not found: ${builtExtension}`);
  fs.cpSync(builtExtension, stagedExtension, { recursive: true });
  const helperResult = spawnSync('swiftc', [
    '-O',
    '-target', `${architecture.swiftArch}-apple-macos14.0`,
    '-o', helperBinary,
    helperSource
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (helperResult.error) throw helperResult.error;
  if (helperResult.status !== 0) {
    process.stdout.write(sanitizedBuildOutput(helperResult.stdout));
    process.stderr.write(sanitizedBuildOutput(helperResult.stderr));
    throw new Error(`swiftc exited with status ${helperResult.status}`);
  }
  assertWidgetArchitecture(stagedExtension, helperBinary, architecture);
  if (profileIsRequired({ distributionBuild, localDevelopmentSigning, appGroup })) {
    const stagedAppProfile = path.join(OUTPUT, 'TokenMonitor.provisionprofile');
    const stagedWidgetProfile = path.join(OUTPUT, 'TokenMonitorWidget.provisionprofile');
    fs.copyFileSync(appProfilePath, stagedAppProfile);
    fs.copyFileSync(widgetProfilePath, stagedWidgetProfile);
    fs.chmodSync(stagedAppProfile, 0o600);
    fs.chmodSync(stagedWidgetProfile, 0o600);
  }
  fs.writeFileSync(path.join(OUTPUT, 'TokenMonitor.entitlements'), entitlementPlist(appGroup));
  fs.writeFileSync(path.join(OUTPUT, 'TokenMonitorWidget.entitlements'), entitlementPlist(appGroup, true));
  fs.writeFileSync(path.join(OUTPUT, 'TokenMonitorWidgetReloader.entitlements'), emptyEntitlementPlist());
  fs.writeFileSync(path.join(OUTPUT, 'widget-config.json'), `${JSON.stringify({
    schemaVersion: 1,
    appGroup,
    urlScheme,
    widgetKind,
    widgetUIVersion: WIDGET_UI_VERSION,
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    gitRevision: revision,
    buildTimestamp: timestamp,
    packageVersion: versions.packageVersion,
    marketingVersion: versions.marketingVersion,
    bundleVersion: versions.bundleVersion,
    snapshotFileName: 'snapshot.json'
  }, null, 2)}\n`);
  console.log(`[mac-widget] staged ${path.relative(ROOT, stagedExtension)} and ${path.relative(ROOT, helperBinary)} (${widgetKind}, ${revision}, ${timestamp})`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_APP_GROUP,
  DEFAULT_WIDGET_BUNDLE_ID,
  WIDGET_ARCHITECTURES,
  assertWidgetArchitecture,
  packageVersion,
  widgetVersions,
  resolveWidgetArchitecture,
  validateDistributionIdentifiers
};
