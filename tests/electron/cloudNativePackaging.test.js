'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const config = require('../../scripts/electron-builder.cloud-local.config');
const repo = path.resolve(__dirname, '../..');

test('local cloud build retains ordinary app source and never declares overlapping resource exclusions', () => {
  assert.ok(config.files.includes('src/shared/**/*'));
  assert.ok(config.files.includes('src/electron/**/*'));
  assert.ok(!(config.extraResources || []).some((r) => r.from === 'src/shared'));
  assert.equal(typeof config.afterPack, 'function');
  assert.equal(config.extraMetadata.version, '0.66.0-cloud.1');
  assert.equal(config.extraMetadata.tokenMonitorBuild.localCloudIntegration, true);
  assert.equal(config.publish, null);
});

test('post-pack observer copy preserves the app archive and includes runtime/license files', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tm-cloud-package-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const resources = path.join(root, 'Token Monitor.app/Contents/Resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(resources, 'app.asar'), 'original-app-archive');
  await config.afterPack({ appOutDir: root });
  assert.equal(fs.readFileSync(path.join(resources, 'app.asar'), 'utf8'), 'original-app-archive');
  const cloud = path.join(resources, 'cloud-observer');
  for (const relative of ['scripts/codex-cloud-auto-watch.js', 'src/shared/config.js', 'src/shared/providers/codex/cloudAutoWatch.js', 'node_modules/undici/package.json', 'docs/licenses/planmeter.txt']) {
    assert.deepEqual(fs.readFileSync(path.join(cloud, relative)), fs.readFileSync(path.join(repo, relative)));
  }
  assert.equal(fs.existsSync(path.join(cloud, '.codex')), false);
  assert.equal(fs.existsSync(path.join(cloud, 'auth.json')), false);
});

test('local cloud build disables automatic upstream replacement without rewriting settings', () => {
  const main = fs.readFileSync(path.join(repo, 'src/electron/main.js'), 'utf8');
  for (const name of ['maybeRunBackgroundUpdateCheck', 'startAppUpdateBackgroundChecks']) {
    assert.ok(main.includes(`function ${name}() {\n  if (require('../../package.json').tokenMonitorBuild?.localCloudIntegration === true) return;`));
  }
  assert.equal(config.mac.identity, '-');
  assert.equal(config.mac.notarize, false);
});
