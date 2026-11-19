'use strict';

const packageJson = require('../package.json');
const { createBuilderConfig } = require('./macos-packaging');
const { resolveElectronVersionOverride } = require('./electron-builder-version');

// electron-builder downloads the framework selected by this top-level option.
// Releases use the package.json version on every platform. The optional Linux
// override remains available for builds that need a platform-specific runtime.
const electronVersion = resolveElectronVersionOverride();

module.exports = createBuilderConfig({
  baseConfig: {
    ...packageJson.build,
    ...(electronVersion ? { electronVersion } : {})
  }
});
