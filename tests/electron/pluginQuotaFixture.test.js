'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');

test('the GUI fixture bootstraps its target host without launching Electron or changing release metadata', t => {
  const root = path.resolve(__dirname, '../..'), script = path.join(root, 'scripts/test-quota-alerts.cjs');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-quota-fixture-bootstrap-'));
  const scriptRequire = createRequire(script), metadata = scriptRequire('../package.json'), originalVersion = metadata.version;
  t.after(() => { metadata.version = originalVersion; fs.rmSync(scratch, { recursive: true, force: true }); });
  let ready = false, profile;
  const electron = {
    app: { setPath(name, value) { assert.equal(name, 'userData'); profile = value; }, commandLine: { appendSwitch() {} }, on() {},
      whenReady() { ready = true; return new Promise(() => {}); } },
    BrowserWindow() { assert.fail('Node preflight must not create a window'); },
    protocol: { registerSchemesAsPrivileged() {} }
  };
  vm.runInNewContext(fs.readFileSync(script, 'utf8'), {
    require: id => id === 'electron' ? electron : id === 'node:fs' ? { ...fs, mkdtempSync: () => scratch } : scriptRequire(id),
    __dirname: path.dirname(script), console, setTimeout: () => 0, clearTimeout() {}, process: { argv: [] }
  }, { filename: script });
  assert.equal(ready, true, 'package compatibility must not abort before the GUI entry point');
  assert.equal(profile, path.join(scratch, 'profile'));
  assert.equal(metadata.version, '0.82.0');
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, originalVersion);
  const archive = fs.readFileSync(path.join(scratch, 'quota-alerts.tmplugin'));
  const { parsePackage } = scriptRequire('../src/electron/plugins/package');
  assert.equal(parsePackage(archive).rawManifest.engines.tokenMonitor, '>=0.82.0');
  metadata.version = '0.81.0';
  assert.throws(() => parsePackage(archive), /incompatible Token Monitor version/, 'production compatibility checks remain enforced');
});
