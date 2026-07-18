'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'native', 'macos', 'TokenMonitorWidget.xcodeproj');
const OUTPUT = path.join(ROOT, 'build', 'macos-widget');
const DERIVED_DATA = path.join(OUTPUT, 'DerivedData');
const DEFAULT_APP_GROUP = 'group.com.example.tokenmonitor';
const DEFAULT_WIDGET_BUNDLE_ID = 'com.javis.tokenmonitor.widget';
const DEFAULT_URL_SCHEME = 'token-monitor';
const DEFAULT_WIDGET_KIND = 'com.tokenmonitor.dashboard';
const WIDGET_UI_VERSION = 19;
const WIDGET_SCHEMA_VERSION = 5;

function packageVersion() {
  const packageJson = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  const version = String(packageJson.version || '').trim();
  if (!/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(version)) {
    throw new Error('package.json version is not a valid semantic version');
  }
  return version;
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

function validateDistributionIdentifiers({ appGroup, bundleId, distributionBuild }) {
  if (!distributionBuild) return;
  if (!process.env.TOKEN_MONITOR_APP_GROUP || /^group\.com\.example\./i.test(appGroup)) {
    throw new Error('TOKEN_MONITOR_APP_GROUP must be explicitly configured for a distribution build');
  }
  if (!process.env.TOKEN_MONITOR_WIDGET_BUNDLE_ID || /^com\.example\./i.test(bundleId)) {
    throw new Error('TOKEN_MONITOR_WIDGET_BUNDLE_ID must be explicitly configured for a distribution build');
  }
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
  const urlScheme = configuredIdentifier('TOKEN_MONITOR_WIDGET_URL_SCHEME', DEFAULT_URL_SCHEME);
  const widgetKind = configuredIdentifier('TOKEN_MONITOR_WIDGET_KIND', DEFAULT_WIDGET_KIND);
  const revision = String(process.env.TOKEN_MONITOR_WIDGET_GIT_REVISION || gitRevision()).trim();
  const timestamp = String(process.env.TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP || buildTimestamp()).trim();
  const currentProjectVersion = packageVersion();
  const distributionBuild = process.env.TOKEN_MONITOR_WIDGET_DISTRIBUTION === '1';
  validateDistributionIdentifiers({ appGroup, bundleId, distributionBuild });
  const developmentTeam = String(process.env.DEVELOPMENT_TEAM || '').trim();
  if (developmentTeam && !/^[A-Z0-9]+$/.test(developmentTeam)) {
    throw new Error('DEVELOPMENT_TEAM contains unsupported characters');
  }

  fs.rmSync(OUTPUT, { recursive: true, force: true });
  fs.mkdirSync(OUTPUT, { recursive: true });
  const xcconfigPath = path.join(OUTPUT, 'local-widget-build.xcconfig');
  fs.writeFileSync(xcconfigPath, `${[
    xcconfigLine('CURRENT_PROJECT_VERSION', currentProjectVersion),
    xcconfigLine('MARKETING_VERSION', currentProjectVersion),
    xcconfigLine('TOKEN_MONITOR_PACKAGE_VERSION', currentProjectVersion),
    xcconfigLine('TOKEN_MONITOR_APP_GROUP', appGroup),
    xcconfigLine('TOKEN_MONITOR_WIDGET_BUNDLE_ID', bundleId),
    xcconfigLine('TOKEN_MONITOR_WIDGET_URL_SCHEME', urlScheme),
    xcconfigLine('TOKEN_MONITOR_WIDGET_KIND', widgetKind),
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
    'ARCHS=arm64',
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
    '-target', 'arm64-apple-macos14.0',
    '-o', helperBinary,
    helperSource
  ], { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  if (helperResult.error) throw helperResult.error;
  if (helperResult.status !== 0) {
    process.stdout.write(sanitizedBuildOutput(helperResult.stdout));
    process.stderr.write(sanitizedBuildOutput(helperResult.stderr));
    throw new Error(`swiftc exited with status ${helperResult.status}`);
  }
  fs.writeFileSync(path.join(OUTPUT, 'TokenMonitor.entitlements'), entitlementPlist(appGroup));
  fs.writeFileSync(path.join(OUTPUT, 'TokenMonitorWidget.entitlements'), entitlementPlist(appGroup, true));
  fs.writeFileSync(path.join(OUTPUT, 'widget-config.json'), `${JSON.stringify({
    schemaVersion: 1,
    appGroup,
    urlScheme,
    widgetKind,
    widgetUIVersion: WIDGET_UI_VERSION,
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    gitRevision: revision,
    buildTimestamp: timestamp,
    bundleVersion: currentProjectVersion,
    snapshotFileName: 'snapshot.json'
  }, null, 2)}\n`);
  console.log(`[mac-widget] staged ${path.relative(ROOT, stagedExtension)} and ${path.relative(ROOT, helperBinary)} (${widgetKind}, ${revision}, ${timestamp})`);
}

if (require.main === module) main();

module.exports = {
  DEFAULT_APP_GROUP,
  DEFAULT_WIDGET_BUNDLE_ID,
  packageVersion,
  validateDistributionIdentifiers
};
