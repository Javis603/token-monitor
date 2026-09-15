'use strict';

const fs = require('node:fs');
const path = require('node:path');
const {
  isTeamPrefixedAppGroup,
  normalizeMacDistributionChannel,
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

function localWidgetSigningIdentity(env, appGroup) {
  const explicitIdentity = String(env.TOKEN_MONITOR_MAC_DEVELOPMENT_IDENTITY || '').trim();
  if (explicitIdentity) return explicitIdentity;

  const developmentTeam = String(env.DEVELOPMENT_TEAM || '').trim();
  const normalizedAppGroup = String(appGroup || '').trim();
  if (isTeamPrefixedAppGroup(normalizedAppGroup)) {
    if (developmentTeam && !normalizedAppGroup.startsWith(`${developmentTeam}.`)) {
      throw new Error('TOKEN_MONITOR_APP_GROUP prefix does not match DEVELOPMENT_TEAM');
    }
    return 'Apple Development';
  }
  return '-';
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
  const localDevelopmentSigning = String(env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING || '').trim() === '1';
  const appGroup = String(env.TOKEN_MONITOR_APP_GROUP || 'group.com.example.tokenmonitor').trim();
  const extraFiles = Array.isArray(base.extraFiles)
    ? base.extraFiles
    : (base.extraFiles === undefined ? [] : [base.extraFiles]);
  const extraResources = Array.isArray(base.extraResources)
    ? base.extraResources
    : (base.extraResources === undefined ? [] : [base.extraResources]);
  return {
    ...base,
    ...(localDevelopmentSigning ? { identity: localWidgetSigningIdentity(env, appGroup) } : {}),
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
    ]
  };
}

function createBuilderConfig({ baseConfig, env = process.env, root = path.resolve(__dirname, '..') } = {}) {
  const source = baseConfig || {};
  return {
    ...source,
    mac: widgetMacBuildConfig(source.mac, { env, root })
  };
}

if (require.main === module && widgetEnabled()) {
  assertWidgetArtifacts(path.resolve(__dirname, '..'), { env: process.env });
}

module.exports = {
  assertWidgetArtifacts,
  createBuilderConfig,
  localWidgetSigningIdentity,
  widgetArtifactPaths,
  widgetEnabled,
  widgetMacBuildConfig
};
