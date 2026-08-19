'use strict';

const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const {
  DEFAULT_WIDGET_URL_SCHEME,
  normalizeMacDistributionChannel,
  normalizeWidgetURLScheme,
  validateAppGroupForDistribution,
  validateAppGroupSyntax
} = require('./macos-widget-config');
const { profileIsRequired } = require('./macos-provisioning');

function widgetEnabled(env = process.env) {
  return String(env.TOKEN_MONITOR_WIDGET_ENABLED || '').trim() === '1';
}

function widgetArtifactPaths(root) {
  const output = path.join(root, 'build', 'macos-widget');
  const extension = path.join(output, 'TokenMonitorWidget.appex');
  return {
    output,
    entitlements: path.join(output, 'TokenMonitor.entitlements'),
    extension,
    extensionExecutable: path.join(extension, 'Contents', 'MacOS', 'TokenMonitorWidget'),
    config: path.join(output, 'widget-config.json'),
    reloader: path.join(output, 'TokenMonitorWidgetReloader'),
    extensionEntitlements: path.join(output, 'TokenMonitorWidget.entitlements'),
    reloaderEntitlements: path.join(output, 'TokenMonitorWidgetReloader.entitlements'),
    appProvisioningProfile: path.join(output, 'TokenMonitor.provisionprofile'),
    widgetProvisioningProfile: path.join(output, 'TokenMonitorWidget.provisionprofile')
  };
}

function assertWidgetArtifacts(root, options = {}) {
  const env = options.env || process.env;
  const paths = widgetArtifactPaths(root);
  const required = [
    ['entitlements', paths.entitlements],
    ['Widget extension', paths.extension],
    ['Widget extension executable', paths.extensionExecutable],
    ['Widget config', paths.config],
    ['Widget reloader', paths.reloader],
    ['Widget extension entitlements', paths.extensionEntitlements],
    ['Widget reloader entitlements', paths.reloaderEntitlements]
  ];
  const appGroup = String(env.TOKEN_MONITOR_APP_GROUP || 'group.com.example.tokenmonitor').trim();
  const distributionBuild = String(env.TOKEN_MONITOR_WIDGET_DISTRIBUTION || '').trim() === '1';
  const developmentTeam = String(env.DEVELOPMENT_TEAM || '').trim();
  if (distributionBuild) validateAppGroupForDistribution(appGroup, developmentTeam);
  else validateAppGroupSyntax(appGroup);
  if (distributionBuild) normalizeMacDistributionChannel(env.TOKEN_MONITOR_MAC_DISTRIBUTION_CHANNEL);
  if (profileIsRequired({
    distributionBuild,
    localDevelopmentSigning: String(env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING || '').trim() === '1',
    appGroup
  })) {
    required.push(
      ['main app provisioning profile', paths.appProvisioningProfile],
      ['Widget provisioning profile', paths.widgetProvisioningProfile]
    );
  }
  const missing = required.filter(([, filePath]) => {
    try {
      return !fs.existsSync(filePath) || (filePath === paths.extension && !fs.statSync(filePath).isDirectory());
    } catch (_) {
      return true;
    }
  });
  if (missing.length > 0) {
    throw new Error(
      `TOKEN_MONITOR_WIDGET_ENABLED=1 but Widget artifacts are missing before electron-builder: ${missing.map(([label, filePath]) => `${label} (${path.relative(root, filePath)})`).join(', ')}. Run npm run build:mac-widget first.`
    );
  }
  return paths;
}

function resolveWidgetUrlScheme(env = process.env, root = path.resolve(__dirname, '..')) {
  let value = String(env.TOKEN_MONITOR_WIDGET_URL_SCHEME || '').trim();
  if (!value) {
    try {
      const config = JSON.parse(fs.readFileSync(widgetArtifactPaths(root).config, 'utf8'));
      value = String(config.urlScheme || '').trim();
    } catch (_) {}
  }
  return normalizeWidgetURLScheme(value, DEFAULT_WIDGET_URL_SCHEME);
}

function envFlag(env, key) {
  const value = String(env?.[key] || '').trim();
  return value !== '' && value !== '0' && value.toLowerCase() !== 'false';
}

function parseCodesigningIdentities(output) {
  const text = String(output || '');
  const validSection = text.split(/Valid identities only/i)[1] || text;
  return [...validSection.matchAll(/^\s*\d+\)\s+[0-9A-F]+\s+"([^"]+)"/gim)].map((match) => match[1]);
}

function listCodesigningIdentities() {
  try {
    return parseCodesigningIdentities(execFileSync('security', ['find-identity', '-v', '-p', 'codesigning'], {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'pipe']
    }));
  } catch (_) {
    return [];
  }
}

function hasDeveloperIdApplication(identities) {
  return (Array.isArray(identities) ? identities : []).some((name) => (
    /Developer ID Application\b/i.test(String(name || ''))
  ));
}

// forceCodeSigning is on so an unsigned .app never ships. electron-builder treats
// "no identity found" as a hard error; local `dist:mac` on a machine without a
// Developer ID would otherwise abort after packaging. Ad-hoc (`-`) is the same
// identity the Widget local preview already uses. CI and CSC_* stay fail-closed
// so a missing release certificate cannot silently produce an ad-hoc artifact.
function resolveMacSigningIdentity(baseMac = {}, env = process.env, options = {}) {
  if (baseMac.identity != null && String(baseMac.identity).trim() !== '') return String(baseMac.identity).trim();
  if (envFlag(env, 'TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING')) return '-';
  if (String(env.CSC_LINK || '').trim() || String(env.CSC_NAME || '').trim()) return undefined;
  if (envFlag(env, 'CI')) return undefined;
  const platform = options.platform || process.platform;
  const list = options.listCodesigningIdentities || (platform === 'darwin' ? listCodesigningIdentities : null);
  if (typeof list !== 'function') return undefined;
  return hasDeveloperIdApplication(list()) ? undefined : '-';
}

function widgetMacBuildConfig(baseMac = {}, options = {}) {
  const env = options.env || process.env;
  const root = options.root || path.resolve(__dirname, '..');
  const base = { ...baseMac };
  if (!widgetEnabled(env)) return base;

  const conflictingKeys = ['entitlements', 'sign'].filter((key) => base[key] !== undefined);
  if (conflictingKeys.length > 0) {
    throw new Error(`Widget packaging owns ${conflictingKeys.join(' and ')}; compose the existing macOS configuration explicitly instead of replacing it.`);
  }

  assertWidgetArtifacts(root, { env });
  const urlScheme = resolveWidgetUrlScheme(env, root);
  const localDevelopmentSigning = String(env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING || '').trim() === '1';
  const extraFiles = Array.isArray(base.extraFiles)
    ? base.extraFiles
    : (base.extraFiles === undefined ? [] : [base.extraFiles]);
  const extraResources = Array.isArray(base.extraResources)
    ? base.extraResources
    : (base.extraResources === undefined ? [] : [base.extraResources]);
  return {
    ...base,
    ...(localDevelopmentSigning ? { identity: '-' } : {}),
    entitlements: 'build/macos-widget/TokenMonitor.entitlements',
    sign: 'scripts/sign-macos-with-widget.js',
    extraFiles: [
      ...extraFiles,
      {
        from: 'build/macos-widget/TokenMonitorWidget.appex',
        to: 'PlugIns/TokenMonitorWidget.appex'
      }
    ],
    extraResources: [
      ...extraResources,
      {
        from: 'build/macos-widget/widget-config.json',
        to: 'token-monitor-widget.json'
      },
      {
        from: 'build/macos-widget/TokenMonitorWidgetReloader',
        to: 'TokenMonitorWidgetReloader'
      }
    ],
    extendInfo: {
      ...(base.extendInfo || {}),
      CFBundleURLTypes: [
        ...(Array.isArray(base.extendInfo?.CFBundleURLTypes)
          ? base.extendInfo.CFBundleURLTypes
          : []),
        {
          CFBundleURLName: 'token-monitor-widget',
          CFBundleURLSchemes: [urlScheme]
        }
      ]
    }
  };
}

function createBuilderConfig({
  baseConfig,
  env = process.env,
  root = path.resolve(__dirname, '..'),
  platform,
  listCodesigningIdentities: listIdentities
} = {}) {
  const source = baseConfig || {};
  const mac = widgetMacBuildConfig(source.mac, { env, root });
  const identity = resolveMacSigningIdentity(mac, env, {
    platform,
    listCodesigningIdentities: listIdentities
  });
  return {
    ...source,
    mac: identity === undefined ? mac : { ...mac, identity }
  };
}

if (require.main === module && widgetEnabled()) {
  assertWidgetArtifacts(path.resolve(__dirname, '..'), { env: process.env });
}

module.exports = {
  DEFAULT_WIDGET_URL_SCHEME,
  assertWidgetArtifacts,
  createBuilderConfig,
  parseCodesigningIdentities,
  resolveMacSigningIdentity,
  resolveWidgetUrlScheme,
  widgetArtifactPaths,
  widgetEnabled,
  widgetMacBuildConfig
};
