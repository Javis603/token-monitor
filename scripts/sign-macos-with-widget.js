'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { promisify } = require('node:util');
const { signApp } = require('@electron/osx-sign');

const execFileAsync = promisify(execFile);

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
  let loggedLocalOptions = false;
  return {
    ...options,
    hardenedRuntime: false,
    timestamp: 'none',
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
for argument in "$@"; do
  case "$argument" in
    --timestamp|--timestamp=*) continue ;;
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

async function signAppForMode(options, localDevelopmentSigning) {
  if (!localDevelopmentSigning) {
    await signApp(options);
    return;
  }

  const wrapperDirectory = await fs.mkdtemp(path.join(os.tmpdir(), 'token-monitor-codesign-'));
  const wrapperPath = path.join(wrapperDirectory, 'codesign');
  const originalPath = process.env.PATH;
  try {
    await fs.writeFile(wrapperPath, localCodesignWrapperScript(), { mode: 0o700 });
    process.env.PATH = `${wrapperDirectory}${path.delimiter}${originalPath || ''}`;
    await signApp(options);
    const mainFileOptions = options.optionsForFile
      ? await options.optionsForFile(options.app)
      : {};
    if (!mainFileOptions.entitlements) {
      throw new Error('macOS main app entitlements are unavailable for local development signing');
    }
    await execFileAsync('codesign', localMainAppSignArgs({
      identity: options.identity,
      entitlements: mainFileOptions.entitlements,
      keychain: options.keychain,
      app: options.app
    }));
  } finally {
    process.env.PATH = originalPath;
    await fs.rm(wrapperDirectory, { recursive: true, force: true });
  }
}

function widgetURLScheme() {
  const value = String(process.env.TOKEN_MONITOR_WIDGET_URL_SCHEME || '').trim();
  if (!value) return null;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(value)) {
    throw new Error('TOKEN_MONITOR_WIDGET_URL_SCHEME contains unsupported characters');
  }
  return value;
}

module.exports = async function signMacAppWithWidget(options) {
  const extensionPath = path.join(
    options.app,
    'Contents',
    'PlugIns',
    'TokenMonitorWidget.appex'
  );
  const entitlementsPath = path.resolve(
    __dirname,
    '..',
    'build',
    'macos-widget',
    'TokenMonitorWidget.entitlements'
  );
  const identity = String(options.identity || '').trim();
  if (!identity) throw new Error('macOS signing identity is unavailable for Widget extension');
  const localDevelopmentSigning = process.env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING === '1';
  const urlScheme = widgetURLScheme();
  if (urlScheme) {
    await execFileAsync('plutil', [
      '-replace', 'CFBundleURLTypes.0.CFBundleURLSchemes.0',
      '-string', urlScheme,
      path.join(options.app, 'Contents', 'Info.plist')
    ]);
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

module.exports.extensionSignArgs = extensionSignArgs;
module.exports.appSignOptions = appSignOptions;
module.exports.localCodesignWrapperScript = localCodesignWrapperScript;
module.exports.localMainAppSignArgs = localMainAppSignArgs;
module.exports.widgetURLScheme = widgetURLScheme;
