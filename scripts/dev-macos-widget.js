'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const signMacAppWithWidget = require('./sign-macos-with-widget');
const {
  DEFAULT_WIDGET_BUNDLE_ID,
  DEFAULT_WIDGET_KIND,
  WIDGET_SCHEMA_VERSION,
  WIDGET_UI_VERSION,
  buildTimestamp,
  gitRevision,
  packageVersion,
  widgetVersions
} = require('./build-macos-widget');
const { widgetArtifactPaths } = require('./macos-packaging');
const { verifyTeamAppGroupSignature } = require('./verify-macos-widget-app');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = path.join(ROOT, 'native', 'macos', 'TokenMonitorWidget.xcodeproj');
const DEV_OUTPUT = path.join(ROOT, 'build', 'macos-widget-dev');
const DERIVED_DATA = path.join(DEV_OUTPUT, 'DerivedData');
const BUILD_CONFIGURATION = 'Debug';
const DEFAULT_APP_NAME = 'Token Monitor.app';

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: ROOT,
    encoding: 'utf8',
    env: options.env || process.env,
    stdio: options.stdio || ['ignore', 'pipe', 'pipe']
  });
  if (result.error) throw result.error;
  if (result.status !== 0 && !options.allowFailure) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    throw new Error(`${command} exited with status ${result.status}`);
  }
  return result;
}

function resolveDeveloperDirectory(env = process.env) {
  const explicit = String(env.DEVELOPER_DIR || '').trim();
  if (explicit) return explicit;
  const bundledXcode = '/Applications/Xcode.app/Contents/Developer';
  if (fs.existsSync(path.join(bundledXcode, 'usr', 'bin', 'xcodebuild'))) return bundledXcode;
  return '';
}

function parseArguments(argv) {
  const result = {};
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--app') {
      result.app = argv[index + 1];
      index += 1;
    } else if (argument === '--identity') {
      result.identity = argv[index + 1];
      index += 1;
    } else {
      throw new Error(`Unknown argument: ${argument}`);
    }
  }
  return result;
}

function findApps(directory, depth = 0) {
  if (depth > 4 || !fs.existsSync(directory)) return [];
  const apps = [];
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    const candidate = path.join(directory, entry.name);
    if (entry.isDirectory() && entry.name === DEFAULT_APP_NAME) {
      apps.push(candidate);
    } else if (entry.isDirectory()) {
      apps.push(...findApps(candidate, depth + 1));
    }
  }
  return apps;
}

function resolveAppPath(value) {
  if (value) {
    const explicit = path.resolve(value);
    if (!fs.existsSync(explicit)) throw new Error(`Packaged app not found: ${explicit}`);
    return explicit;
  }
  const apps = findApps(path.join(ROOT, 'dist'));
  if (apps.length === 1) return apps[0];
  if (apps.length === 0) {
    throw new Error('No packaged Token Monitor.app found. Run npm run pack:mac:widget once.');
  }
  throw new Error(`More than one packaged app was found. Pass --app with one of:\n${apps.join('\n')}`);
}

function readWidgetConfig(appPath) {
  const configPath = path.join(appPath, 'Contents', 'Resources', 'token-monitor-widget.json');
  const config = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const envBundleId = String(process.env.TOKEN_MONITOR_WIDGET_BUNDLE_ID || '').trim();
  const configBundleId = String(config.widgetBundleId || '').trim();
  return {
    appGroup: String(config.appGroup || '').trim(),
    bundleId: resolveWidgetBundleId({
      envValue: envBundleId,
      configValue: configBundleId,
      extensionValue: envBundleId || configBundleId ? '' : extensionBundleIdentifier(appPath)
    }),
    widgetKind: String(config.widgetKind || DEFAULT_WIDGET_KIND).trim(),
    packageVersion: String(config.packageVersion || config.marketingVersion || '').trim(),
    marketingVersion: String(config.marketingVersion || config.packageVersion || '').trim()
  };
}

function resolveWidgetBundleId({ envValue, configValue, extensionValue } = {}) {
  return String(envValue || configValue || extensionValue || DEFAULT_WIDGET_BUNDLE_ID).trim();
}

function extensionBundleIdentifier(appPath, options = {}) {
  const infoPath = path.join(
    appPath,
    'Contents', 'PlugIns', 'TokenMonitorWidget.appex', 'Contents', 'Info.plist'
  );
  const existsSync = options.existsSync || fs.existsSync;
  if (!existsSync(infoPath)) return '';
  const spawn = options.spawnSync || spawnSync;
  const result = spawn('/usr/bin/plutil', [
    '-extract', 'CFBundleIdentifier', 'raw', '-o', '-', infoPath
  ], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  return result.status === 0 ? String(result.stdout || '').trim() : '';
}

function updatedWidgetConfig(config, metadata, options = {}) {
  const updated = {
    ...config,
    widgetBundleId: String(options.widgetBundleId || config.widgetBundleId || '').trim() || undefined,
    widgetUIVersion: WIDGET_UI_VERSION,
    widgetSchemaVersion: WIDGET_SCHEMA_VERSION,
    widgetBundleVersion: String(WIDGET_UI_VERSION),
    gitRevision: metadata.revision,
    buildTimestamp: metadata.timestamp
  };
  delete updated.urlScheme;
  return updated;
}

function refreshPackagedWidgetConfig(appPath, metadata, config) {
  const configPath = path.join(appPath, 'Contents', 'Resources', 'token-monitor-widget.json');
  const current = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const temporaryPath = `${configPath}.tmp`;
  fs.writeFileSync(temporaryPath, `${JSON.stringify(updatedWidgetConfig(current, metadata, {
    widgetBundleId: config.bundleId
  }), null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(temporaryPath, configPath);
}

function developmentTeamForAppGroup(appGroup) {
  const match = String(appGroup || '').match(/^([A-Z0-9]{10})\./);
  if (!match) {
    throw new Error(`Fast Widget deployment requires a Team-prefixed App Group, received: ${appGroup || '(empty)'}`);
  }
  return match[1];
}

function availableDevelopmentIdentities(output) {
  return String(output || '')
    .split('\n')
    .map((line) => line.match(/^\s*\d+\)\s+[0-9A-F]+\s+"(Apple Development:[^"]+)"/i)?.[1])
    .filter(Boolean);
}

function resolveDevelopmentIdentity(explicitIdentity) {
  if (explicitIdentity) return explicitIdentity;
  if (process.env.TOKEN_MONITOR_MAC_DEVELOPMENT_IDENTITY) {
    return String(process.env.TOKEN_MONITOR_MAC_DEVELOPMENT_IDENTITY).trim();
  }
  const identities = availableDevelopmentIdentities(
    run('security', ['find-identity', '-v', '-p', 'codesigning']).stdout
  );
  if (identities.length === 1) return identities[0];
  if (identities.length === 0) {
    throw new Error('No valid Apple Development signing identity was found.');
  }
  throw new Error('More than one Apple Development identity was found. Pass --identity to choose one.');
}

function xcconfigContents({
  appGroup,
  bundleId,
  widgetKind,
  developmentTeam,
  revision,
  timestamp,
  packageVersion: targetPackageVersion,
  marketingVersion: targetMarketingVersion
}) {
  const versions = widgetVersions(packageVersion());
  const effectivePackageVersion = targetPackageVersion || versions.packageVersion;
  const effectiveMarketingVersion = targetMarketingVersion || versions.marketingVersion;
  const values = {
    CURRENT_PROJECT_VERSION: String(WIDGET_UI_VERSION),
    MARKETING_VERSION: effectiveMarketingVersion,
    TOKEN_MONITOR_BUNDLE_VERSION: String(WIDGET_UI_VERSION),
    TOKEN_MONITOR_MARKETING_VERSION: effectiveMarketingVersion,
    TOKEN_MONITOR_PACKAGE_VERSION: effectivePackageVersion,
    TOKEN_MONITOR_APP_GROUP: appGroup,
    TOKEN_MONITOR_WIDGET_BUNDLE_ID: bundleId,
    TOKEN_MONITOR_WIDGET_KIND: widgetKind,
    TOKEN_MONITOR_WIDGET_SCHEMA_VERSION: String(WIDGET_SCHEMA_VERSION),
    TOKEN_MONITOR_WIDGET_UI_VERSION: String(WIDGET_UI_VERSION),
    TOKEN_MONITOR_WIDGET_ARCH: 'arm64',
    TOKEN_MONITOR_WIDGET_GIT_REVISION: revision,
    TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP: timestamp,
    DEVELOPMENT_TEAM: developmentTeam
  };
  return `${Object.entries(values).map(([key, value]) => `${key} = ${String(value).replaceAll('\n', '')}`).join('\n')}\n`;
}

function ensureSigningArtifacts() {
  const artifacts = widgetArtifactPaths(ROOT);
  for (const filePath of [artifacts.entitlements, artifacts.extensionEntitlements, artifacts.reloaderEntitlements, artifacts.reloader]) {
    if (!fs.existsSync(filePath)) {
      throw new Error(`Widget signing artifact is missing: ${path.relative(ROOT, filePath)}. Run npm run pack:mac:widget once.`);
    }
  }
  return artifacts;
}

function buildWidget(config, developmentTeam, metadata) {
  fs.mkdirSync(DEV_OUTPUT, { recursive: true });
  const fallbackVersions = widgetVersions(packageVersion());
  const targetPackageVersion = config.packageVersion || fallbackVersions.packageVersion;
  const targetMarketingVersion = config.marketingVersion || fallbackVersions.marketingVersion;
  const xcconfigPath = path.join(DEV_OUTPUT, 'development.xcconfig');
  fs.writeFileSync(xcconfigPath, xcconfigContents({
    ...config,
    packageVersion: targetPackageVersion,
    marketingVersion: targetMarketingVersion,
    developmentTeam,
    ...metadata
  }), { mode: 0o600 });
  const developerDirectory = resolveDeveloperDirectory();
  const extension = path.join(
    DERIVED_DATA,
    'Build',
    'Products',
    BUILD_CONFIGURATION,
    'TokenMonitorWidget.appex'
  );
  // Xcode does not always invalidate a generated Info.plist when only the
  // injected xcconfig values change. Recreate the product bundle while keeping
  // DerivedData's compiled Swift objects so fast deployment remains incremental.
  fs.rmSync(extension, { recursive: true, force: true });
  run('xcodebuild', [
    '-project', PROJECT,
    '-scheme', 'TokenMonitorWidget',
    '-configuration', BUILD_CONFIGURATION,
    '-destination', 'platform=macOS,arch=arm64',
    '-derivedDataPath', DERIVED_DATA,
    '-xcconfig', xcconfigPath,
    '-allowProvisioningUpdates',
    'build',
    'CODE_SIGNING_ALLOWED=YES',
    'CODE_SIGN_STYLE=Automatic',
    'CODE_SIGN_IDENTITY=Apple Development',
    `DEVELOPMENT_TEAM=${developmentTeam}`,
    `TOKEN_MONITOR_PACKAGE_VERSION=${targetPackageVersion}`,
    `TOKEN_MONITOR_MARKETING_VERSION=${targetMarketingVersion}`,
    `TOKEN_MONITOR_WIDGET_SCHEMA_VERSION=${WIDGET_SCHEMA_VERSION}`,
    `TOKEN_MONITOR_WIDGET_UI_VERSION=${WIDGET_UI_VERSION}`,
    `TOKEN_MONITOR_WIDGET_GIT_REVISION=${metadata.revision}`,
    `TOKEN_MONITOR_WIDGET_BUILD_TIMESTAMP=${metadata.timestamp}`,
    'ARCHS=arm64',
    'ONLY_ACTIVE_ARCH=YES'
  ], {
    env: developerDirectory
      ? { ...process.env, DEVELOPER_DIR: developerDirectory }
      : process.env
  });
  if (!fs.existsSync(extension)) throw new Error(`Built Widget extension not found: ${extension}`);
  return extension;
}

function stopRunningWidgetProcesses() {
  run('pkill', ['-x', 'Token Monitor'], { allowFailure: true });
  run('pkill', ['-x', 'TokenMonitorWidget'], { allowFailure: true });
}

function installExtension(source, appPath) {
  const destination = path.join(appPath, 'Contents', 'PlugIns', 'TokenMonitorWidget.appex');
  fs.rmSync(destination, { recursive: true, force: true });
  fs.cpSync(source, destination, { recursive: true });
  return destination;
}

function teamIdentifierFromCodesignOutput(output) {
  return String(output || '').match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || '';
}

function signedTeamIdentifier(bundlePath) {
  const result = run('codesign', ['-dv', '--verbose=4', bundlePath], { allowFailure: true });
  return teamIdentifierFromCodesignOutput(`${result.stdout || ''}\n${result.stderr || ''}`);
}

function hostLaunchEnvironment(env = process.env) {
  const launchEnvironment = { ...env };
  delete launchEnvironment.ELECTRON_RUN_AS_NODE;
  return launchEnvironment;
}

function signChangedContainer({ appPath, identity, artifacts }) {
  run('codesign', [
    '--force',
    '--sign', identity,
    '--entitlements', artifacts.entitlements,
    '--timestamp=none',
    appPath
  ]);
  run('codesign', ['--verify', '--deep', '--strict', '--verbose=2', appPath]);
}

async function signApp({ appPath, identity, config, developmentTeam, artifacts }) {
  if (signedTeamIdentifier(appPath) === developmentTeam) {
    signChangedContainer({ appPath, identity, artifacts });
    return 'incremental';
  }
  const previousLocalSigning = process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING;
  const previousAppGroup = process.env.TOKEN_MONITOR_APP_GROUP;
  const previousDevelopmentTeam = process.env.DEVELOPMENT_TEAM;
  try {
    process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING = '1';
    process.env.TOKEN_MONITOR_APP_GROUP = config.appGroup;
    process.env.DEVELOPMENT_TEAM = developmentTeam;
    await signMacAppWithWidget({
      app: appPath,
      identity,
      platform: 'darwin',
      type: 'development',
      hardenedRuntime: false,
      timestamp: 'none',
      preAutoEntitlements: false,
      preEmbedProvisioningProfile: false,
      optionsForFile(filePath) {
        return path.resolve(filePath) === path.resolve(appPath)
          ? { entitlements: artifacts.entitlements }
          : {};
      }
    });
    return 'full';
  } finally {
    if (previousLocalSigning === undefined) delete process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING;
    else process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING = previousLocalSigning;
    if (previousAppGroup === undefined) delete process.env.TOKEN_MONITOR_APP_GROUP;
    else process.env.TOKEN_MONITOR_APP_GROUP = previousAppGroup;
    if (previousDevelopmentTeam === undefined) delete process.env.DEVELOPMENT_TEAM;
    else process.env.DEVELOPMENT_TEAM = previousDevelopmentTeam;
  }
}

function registerAndLaunch(appPath, config) {
  const reloader = path.join(appPath, 'Contents', 'Resources', 'TokenMonitorWidgetReloader');
  run(reloader, ['--mode', 'register-host']);
  // ELECTRON_RUN_AS_NODE is useful for the packaged tokscale shim, but letting
  // LaunchServices inherit it makes Electron execute the host as plain Node.
  run('open', [appPath], { env: hostLaunchEnvironment() });
  run(reloader, [config.widgetKind]);
}

async function main(argv = process.argv.slice(2)) {
  if (process.platform !== 'darwin') throw new Error('Fast Widget deployment is available only on macOS.');
  const startedAt = Date.now();
  const args = parseArguments(argv);
  const appPath = resolveAppPath(args.app);
  const config = readWidgetConfig(appPath);
  const developmentTeam = developmentTeamForAppGroup(config.appGroup);
  const identity = resolveDevelopmentIdentity(args.identity);
  const artifacts = ensureSigningArtifacts();
  const metadata = {
    revision: gitRevision(),
    timestamp: buildTimestamp()
  };

  console.log(`[mac-widget-dev] incrementally building Widget for ${path.relative(ROOT, appPath)}`);
  const buildStartedAt = Date.now();
  const extension = buildWidget(config, developmentTeam, metadata);
  const buildElapsed = Date.now() - buildStartedAt;
  stopRunningWidgetProcesses();
  const installedExtension = installExtension(extension, appPath);
  refreshPackagedWidgetConfig(appPath, metadata, config);
  console.log(`[mac-widget-dev] signing app and extension with ${identity}`);
  const signingStartedAt = Date.now();
  const signingMode = await signApp({ appPath, identity, config, developmentTeam, artifacts });
  const signingElapsed = Date.now() - signingStartedAt;
  verifyTeamAppGroupSignature({
    appPath,
    extensionPath: installedExtension,
    appGroup: config.appGroup
  });
  registerAndLaunch(appPath, config);
  console.log(
    `[mac-widget-dev] deployed and relaunched in ${((Date.now() - startedAt) / 1000).toFixed(1)}s `
    + `(build ${(buildElapsed / 1000).toFixed(1)}s, ${signingMode} signing ${(signingElapsed / 1000).toFixed(1)}s)`
  );
}

if (require.main === module) {
  main().catch((error) => {
    console.error(`[mac-widget-dev] ${error.message || error}`);
    process.exitCode = 1;
  });
}

module.exports = {
  availableDevelopmentIdentities,
  developmentTeamForAppGroup,
  findApps,
  hostLaunchEnvironment,
  parseArguments,
  extensionBundleIdentifier,
  readWidgetConfig,
  resolveDeveloperDirectory,
  resolveAppPath,
  resolveWidgetBundleId,
  teamIdentifierFromCodesignOutput,
  updatedWidgetConfig,
  xcconfigContents
};
