'use strict';

// Local-only application build, not an upstream release. Uses the installed
// Electron runtime and existing dependencies; no notarization or publishing.
const base = require('./electron-builder.config');
module.exports = {
  ...base,
  electronDist: 'node_modules/electron/dist',
  directories: { ...base.directories, output: 'dist/cloud-native' },
  npmRebuild: false,
  publish: null,
  extraMetadata: { version: '0.66.0-cloud.1', tokenMonitorBuild: { localCloudIntegration: true } },
  files: [...base.files, 'docs/licenses/planmeter.txt'],
  extraResources: [
    { from: 'scripts/codex-cloud-auto-watch.js', to: 'cloud-observer/scripts/codex-cloud-auto-watch.js' },
    { from: 'src/shared', to: 'cloud-observer/src/shared', filter: ['**/*.js', '**/*.json'] },
    { from: 'node_modules/undici', to: 'cloud-observer/node_modules/undici', filter: ['**/*'] },
    { from: 'docs/licenses/planmeter.txt', to: 'cloud-observer/PLANMETER-LICENSE.txt' }
  ],
  mac: { ...base.mac, identity: '-', forceCodeSigning: false, hardenedRuntime: true,
    entitlements: 'scripts/cloud-local.entitlements.plist',
    entitlementsInherit: 'scripts/cloud-local.entitlements.plist', notarize: false }
};
