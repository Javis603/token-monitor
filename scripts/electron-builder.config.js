'use strict';

const packageJson = require('../package.json');
const { createBuilderConfig } = require('./macos-packaging');

module.exports = createBuilderConfig({ baseConfig: packageJson.build });
