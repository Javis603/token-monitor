'use strict';

const packageJson = require('../package.json');
const { createBuilderConfig } = require('./macos-packaging');
const { resolveElectronVersionOverride } = require('./electron-builder-version');

// electron-builder downloads the framework selected by this top-level option.
// The release workflow sets the override only for the Linux artifact, so macOS
// and Windows continue to use the package.json Electron version.
const electronVersion = resolveElectronVersionOverride();

module.exports = createBuilderConfig({
  baseConfig: {
    ...packageJson.build,
    ...(electronVersion ? { electronVersion } : {})
  }
});
