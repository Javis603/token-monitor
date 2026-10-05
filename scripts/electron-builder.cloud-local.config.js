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
  // extraResources exclusions remove matching source dirs from app.asar.
  // Copy the standalone observer after ordinary app packaging instead, so
  // main/preload keep their original shared modules and dependency closure.
  afterPack: async (context) => {
    const fs = require('node:fs');
    const path = require('node:path');
    const destination = path.join(context.appOutDir, 'Token Monitor.app/Contents/Resources/cloud-observer');
    const source = path.resolve(__dirname, '..');
    for (const name of ['scripts/codex-cloud-auto-watch.js', 'src/shared', 'node_modules/undici', 'docs/licenses/planmeter.txt']) {
      const target = path.join(destination, name);
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.cpSync(path.join(source, name), target, { recursive: true, dereference: false, errorOnExist: true });
    }
  },
  mac: { ...base.mac, identity: '-', forceCodeSigning: false, hardenedRuntime: true,
    entitlements: 'scripts/cloud-local.entitlements.plist',
    entitlementsInherit: 'scripts/cloud-local.entitlements.plist', notarize: false }
};
