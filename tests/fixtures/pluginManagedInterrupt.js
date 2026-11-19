'use strict';

// Exercise a real interrupted transaction without interpolating fixture data
// into JavaScript source. The parent sends the package and paths as stdin JSON.
const fs = require('node:fs');
const { createManagedPlugins } = require('../../src/electron/plugins/managed');
const { parsePackage } = require('../../src/electron/plugins/package');

const fixture = JSON.parse(fs.readFileSync(0, 'utf8'));
const api = createManagedPlugins({
  root: fixture.root,
  userDir: fixture.userDir,
  dataDir: fixture.dataDir,
  getSettings: () => ({ pluginStates: {} }),
  saveSettings() {},
  manager: { list: () => ({ plugins: [] }), beginMutation() {}, endMutation() {}, reload() {} },
  fault: step => { if (step === 'new-moved') process.exit(87); }
});
api.recover();
api.install(api.preview(parsePackage(fixture.package)).token);
