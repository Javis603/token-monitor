'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { runtimeFixture } = require('../helpers/trustedPlugin');
const { registerPluginScheme } = require('../../src/electron/plugins/runtime');
test('trusted asset scheme retains Electron security rather than disabling it globally', () => {
  let schemes; registerPluginScheme({ registerSchemesAsPrivileged: value => { schemes = value; } });
  assert.equal(schemes.length, 1); assert.equal(schemes[0].scheme, 'tm-plugin'); assert.equal(schemes[0].privileges.bypassCSP, undefined);
});
for (const [file, content] of [['installed.json', '{broken'], ['installed.json', '42'], ['installed.json', '{"demo":null}'], ['transaction.json', '{broken'], ['transaction.json', 'null'], ['transaction.json', '{"id":"demo","phase":"prepared"}']]) test(`unreadable ${file} preserves recovery files and prevents package mutations`, async t => {
  const f = await runtimeFixture(t, { beforeStart(dir) {
    fs.mkdirSync(path.join(dir, 'plugin-manager/transaction/stage'), {recursive:true});
    fs.writeFileSync(path.join(dir, 'plugin-manager', file), content);
    fs.writeFileSync(path.join(dir, 'plugin-manager/transaction/stage/keep'), 'evidence');
  } });
  assert.equal(f.invoke('plugins:list').management.available, false);
  for (const [name, args] of [['plugins:install',['unknown']], ['plugins:rollback',['demo']], ['plugins:uninstall',['demo']], ['plugins:import',['directory']]]) {
    await assert.rejects(async () => f.invoke(name,...args), /management unavailable/i);
  }
  assert.equal(fs.readFileSync(path.join(f.dir,'plugin-manager',file),'utf8'),content);
  assert.equal(fs.readFileSync(path.join(f.dir,'plugin-manager/transaction/stage/keep'),'utf8'),'evidence');
  assert.equal(f.children.length,0);
});
