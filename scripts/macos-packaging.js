'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_WIDGET_URL_SCHEME = 'token-monitor';

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
    extensionEntitlements: path.join(output, 'TokenMonitorWidget.entitlements')
  };
}

function assertWidgetArtifacts(root) {
  const paths = widgetArtifactPaths(root);
  const required = [
    ['entitlements', paths.entitlements],
    ['Widget extension', paths.extension],
    ['Widget extension executable', paths.extensionExecutable],
    ['Widget config', paths.config],
    ['Widget reloader', paths.reloader],
    ['Widget extension entitlements', paths.extensionEntitlements]
  ];
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
  if (!value) value = DEFAULT_WIDGET_URL_SCHEME;
  if (!/^[A-Za-z][A-Za-z0-9+.-]*$/.test(value)) {
    throw new Error('TOKEN_MONITOR_WIDGET_URL_SCHEME contains unsupported characters');
  }
  return value;
}

function widgetMacBuildConfig(baseMac = {}, options = {}) {
  const env = options.env || process.env;
  const root = options.root || path.resolve(__dirname, '..');
  const baseWithoutWidget = { ...baseMac };
  delete baseWithoutWidget.entitlements;
  delete baseWithoutWidget.sign;
  delete baseWithoutWidget.extraFiles;
  delete baseWithoutWidget.extraResources;
  if (!widgetEnabled(env)) return baseWithoutWidget;

  assertWidgetArtifacts(root);
  const urlScheme = resolveWidgetUrlScheme(env, root);
  const localDevelopmentSigning = String(env.TOKEN_MONITOR_LOCAL_DEVELOPMENT_SIGNING || '').trim() === '1';
  return {
    ...baseWithoutWidget,
    ...(localDevelopmentSigning ? { identity: '-' } : {}),
    entitlements: 'build/macos-widget/TokenMonitor.entitlements',
    sign: 'scripts/sign-macos-with-widget.js',
    extraFiles: [{
      from: 'build/macos-widget/TokenMonitorWidget.appex',
      to: 'PlugIns/TokenMonitorWidget.appex'
    }],
    extraResources: [
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
      ...(baseWithoutWidget.extendInfo || {}),
      CFBundleURLTypes: [{
        CFBundleURLName: 'token-monitor-widget',
        CFBundleURLSchemes: [urlScheme]
      }]
    }
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
  assertWidgetArtifacts(path.resolve(__dirname, '..'));
}

module.exports = {
  DEFAULT_WIDGET_URL_SCHEME,
  assertWidgetArtifacts,
  createBuilderConfig,
  resolveWidgetUrlScheme,
  widgetArtifactPaths,
  widgetEnabled,
  widgetMacBuildConfig
};
