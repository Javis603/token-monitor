'use strict';

const packageJson = require('../../package.json');

function appVersion() {
  return String(packageJson.version || '0.0.0');
}

module.exports = {
  appVersion
};
