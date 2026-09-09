'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { signApp } = require('@electron/osx-sign');
const {
  normalizeMacDistributionChannel,
  normalizeWidgetURLScheme,
  validateAppGroupForDistribution,
  validateAppGroupSyntax
} = require('./macos-widget-config');
const { copyProvisioningProfiles, profileIsRequired } = require('./macos-provisioning');

const execFileAsync = promisify(execFile);

const LOCAL_ELECTRON_HELPER_ENTITLEMENTS = Object.freeze([
  'com.apple.security.cs.allow-jit',
  'com.apple.security.cs.allow-unsigned-executable-memory',
  'com.apple.security.cs.disable-library-validation'
]);

function localElectronHelperEntitlements() {
  const keys = LOCAL_ELECTRON_HELPER_ENTITLEMENTS
    .map((key) => `  <key>${key}</key>\n  <true/>`)
    .join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
${keys}
</dict>
</plist>
`;
}

function localElectronHelperPaths(app) {
  const appName = path.basename(app, '.app');
  const frameworks = path.join(app, 'Contents', 'Frameworks');
  return ['', ' (GPU)', ' (Plugin)', ' (Renderer)']
    .map((suffix) => path.join(frameworks, `${appName} Helper${suffix}.app`));
}

function localElectronHelperSignArgs({ identity, entitlements, keychain, helper }) {
  const args = ['--force', '--sign', identity, '--entitlements', entitlements];
  if (keychain) args.push('--keychain', keychain);
  args.push(helper);
  return args;
}

async function signLocalElectronHelpers(options, entitlements) {
  for (const helper of localElectronHelperPaths(options.app)) {
    await execFileAsync('codesign', localElectronHelperSignArgs({
      identity: options.identity,
      entitlements,
      keychain: options.keychain,
      helper
    }));
  }
}

function reloaderEntitlementsPath() {
  return path.resolve(
    __dirname,
    '..',
    'build',
    'macos-widget',
    'TokenMonitorWidgetReloader.entitlements'
  );
}

function widgetEntitlementsPath() {
  return path.resolve(
    __dirname,
    '..',
    'build',
    'macos-widget',
    'TokenMonitorWidget.entitlements'
  );
}

function widgetExtensionPath(app) {
  return path.join(app, 'Contents', 'PlugIns', 'TokenMonitorWidget.appex');
}

function reloaderSigningOptions(options) {
  const reloaderPath = path.join(options.app, 'Contents', 'Resources', 'TokenMonitorWidgetReloader');
  const originalOptionsForFile = options.optionsForFile;
  return {
    ...options,
    async optionsForFile(filePath) {
      const fileOptions = originalOptionsForFile
        ? await originalOptionsForFile(filePath)
        : {};
      if (path.resolve(filePath) === path.resolve(reloaderPath)) {
        return { ...fileOptions, entitlements: reloaderEntitlementsPath() };
      }
      return fileOptions;
    }
  };
}

function extensionSignArgs({ identity, entitlementsPath, keychain, localDevelopmentSigning }) {
  const args = ['--force', '--sign', identity, '--entitlements', entitlementsPath];
  if (identity !== '-' && !localDevelopmentSigning) {
    args.push('--options', 'runtime', '--timestamp');
  }
  if (keychain) args.push('--keychain', keychain);
  return args;
}

function appSignOptions(options, localDevelopmentSigning) {
  if (!localDevelopmentSigning) return options;
  const originalOptionsForFile = options.optionsForFile;
  const originalIgnore = Array.isArray(options.ignore) ? options.ignore : [];
  let loggedLocalOptions = false;
  return {
    ...options,
    hardenedRuntime: false,
    timestamp: 'none',
    // @electron/osx-sign follows the Electron framework's Versions/Current
    // symlink as if it were another directory. That makes the ad-hoc preview
    // sign the same physical resources once through Versions/A and again
    // through Versions/Current, which intermittently fails with EPERM. The
    // canonical version tree is already signed, so skip only the alias path.
    ignore: [
      ...originalIgnore,
      (filePath) => String(filePath).split(path.sep).includes('Current')
        && String(filePath).includes(`${path.sep}Versions${path.sep}Current${path.sep}`)
    ],
    async optionsForFile(filePath) {
      const fileOptions = originalOptionsForFile
        ? await originalOptionsForFile(filePath)
        : {};
      if (!loggedLocalOptions) {
        console.log('[mac-widget] local development signing disables runtime and timestamp');
        loggedLocalOptions = true;
      }
      return {
        ...fileOptions,
        hardenedRuntime: false,
        timestamp: 'none'
      };
    }
  };
}

function localCodesignWrapperScript() {
  return `#!/bin/bash
set -euo pipefail
filtered=()
skip_runtime=false
for argument in "$@"; do
  if [[ "$skip_runtime" == true ]]; then
    skip_runtime=false
    [[ "$argument" == "runtime" ]] && continue
  fi
  case "$argument" in
    --timestamp|--timestamp=*) filtered+=("--timestamp=none"); continue ;;
    --options) skip_runtime=true; continue ;;
    --options=runtime) continue ;;
    *) filtered+=("$argument") ;;
  esac
done
exec /usr/bin/codesign "\${filtered[@]}"
`;
}

function localMainAppSignArgs({ identity, entitlements, keychain, app }) {
  const args = ['--force', '--sign', identity, '--entitlements', entitlements];
  if (keychain) args.push('--keychain', keychain);
  args.push(app);
  return args;
}

function formalMainAppSignArgs({ identity, entitlements, keychain, app }) {
  const args = ['--force', '--sign', identity, '--entitlements', entitlements, '--options', 'runtime', '--timestamp'];
  if (keychain) args.push('--keychain', keychain);
  args.push(app);
  return args;
}

function reloaderSignArgs({ identity, entitlements, keychain, app, localDevelopmentSigning }) {
  const args = ['--force', '--sign', identity, '--entitlements', entitlements];
  if (identity !== '-' && !localDevelopmentSigning) args.push('--options', 'runtime', '--timestamp');
  if (keychain) args.push('--keychain', keychain);
  args.push(path.join(app, 'Contents', 'Resources', 'TokenMonitorWidgetReloader'));
  return args;
}

async function signReloaderAndContainer(options, localDevelopmentSigning) {
  const mainFileOptions = options.optionsForFile
    ? await options.optionsForFile(options.app)
    : {};
  if (!mainFileOptions.entitlements) {
    throw new Error('macOS main app entitlements are unavailable after Widget signing');
  }
  await execFileAsync('codesign', [
    ...extensionSignArgs({
      identity: options.identity,
      entitlementsPath: widgetEntitlementsPath(),
      keychain: options.keychain,
      localDevelopmentSigning
    }),
    widgetExtensionPath(options.app)
  ]);
  await execFileAsync('codesign', reloaderSignArgs({
    identity: options.identity,
    entitlements: reloaderEntitlementsPath(),
    keychain: options.keychain,
    app: options.app,
    localDevelopmentSigning
  }));
  await execFileAsync('codesign', (localDevelopmentSigning ? localMainAppSignArgs : formalMainAppSignArgs)({
    identity: options.identity,
    entitlements: mainFileOptions.entitlements,
    keychain: options.keychain,
    app: options.app
  }));
}

async function signAppForMode(options, localDevelopmentSigning) {
  const signingOptions = reloaderSigningOptions(options);
  if (!localDevelopmentSigning) {
    await signApp(signingOptions);
    await signReloaderAndContainer(signingOptions, false);
    return;
  }

  const wrapperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'token-monitor-codesign-'));
  const wrapperPath = path.join(wrapperDirectory, 'codesign');
  const localHelperEntitlementsPath = path.join(wrapperDirectory, 'local-electron-helper.entitlements.plist');
  const originalPath = process.env.PATH;
  try {
    await fs.writeFile(wrapperPath, localCodesignWrapperScript(), { mode: 0o700 });
    await fs.writeFile(localHelperEntitlementsPath, localElectronHelperEntitlements(), { mode: 0o600 });
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath || ''}`;
    await signApp(signingOptions);
    await signLocalElectronHelpers(signingOptions, localHelperEntitlementsPath);
    await signReloaderAndContainer(signingOptions, true);
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(wrapperDirectory, { recursive: true, force: true });
  }
}

function widgetURLScheme() {
  const value = String(process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME || '').trim();
  if (!value) return null;
  return normalizeWidgetURLScheme(value);
}

module.exports = async function signMacAppWithWidget(options) {
  const extensionPath = widgetExtensionPath(options.app);
  const entitlementsPath = widgetEntitlementsPath();
  const identity = String(options.identity || '').trim();
  if (!identity) throw new Error('macOS signing identity is unavailable for Widget extension');
  const localDevelopmentSigning = process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING === '1';
  const appGroup = String(process.env.TOKEN_MONITOR_APP_GROUP || 'group.com.example.tokenmonitor').trim();
  const distributionBuild = process.env.TOKEN_MONITOR_WIDGET_DISTRIBUTION === '1';
  const developmentTeam = String(process.env.DEVELOPMENT_TEAM || '').trim();
  if (distributionBuild) validateAppGroupForDistribution(appGroup, developmentTeam);
  else validateAppGroupSyntax(appGroup);
  if (distributionBuild) normalizeMacDistributionChannel(process.env.TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL);
  if (profileIsRequired({ distributionBuild, localDevelopmentSigning, appGroup })) {
    const output = path.resolve(__dirname, '..', 'build', 'macos-widget');
    const appProfilePath = path.join(output, 'TokenMonitor.provisionprofile');
    const widgetProfilePath = path.join(output, 'TokenMonitorWidget.provisionprofile');
    if (!fsSyncExists(appProfilePath) || !fsSyncExists(widgetProfilePath)) {
      throw new Error('Production Widget signing requires staged app and Widget provisioning profiles');
    }
    await copyProvisioningProfiles({
      appProfilePath,
      widgetProfilePath,
      appPath: options.app,
      extensionPath
    });
  }
  const args = extensionSignArgs({
    identity,
    entitlementsPath,
    keychain: options.keychain,
    localDevelopmentSigning
  });
  args.push(extensionPath);
  await execFileAsync('codesign', args);
  await signAppForMode(appSignOptions(options, localDevelopmentSigning), localDevelopmentSigning);
};

function fsSyncExists(filePath) {
  try {
    return require('node:fs').existsSync(filePath);
  } catch (_) {
    return false;
  }
}

module.exports.extensionSignArgs = extensionSignArgs;
module.exports.appSignOptions = appSignOptions;
module.exports.localCodesignWrapperScript = localCodesignWrapperScript;
module.exports.localMainAppSignArgs = localMainAppSignArgs;
module.exports.formalMainAppSignArgs = formalMainAppSignArgs;
module.exports.localElectronHelperEntitlements = localElectronHelperEntitlements;
module.exports.localElectronHelperPaths = localElectronHelperPaths;
module.exports.localElectronHelperSignArgs = localElectronHelperSignArgs;
module.exports.reloaderSignArgs = reloaderSignArgs;
module.exports.widgetURLScheme = widgetURLScheme;
