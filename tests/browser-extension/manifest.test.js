'use strict';

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

const extensionDir = path.join(__dirname, '..', '..', 'browser-extension');

test('Manifest V3 injects only into the supported AI web apps', () => {
  const manifest = JSON.parse(fs.readFileSync(path.join(extensionDir, 'manifest.json'), 'utf8'));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.background.service_worker, 'background.js');
  assert.deepEqual(manifest.content_scripts[0].matches, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*'
  ]);
  assert.deepEqual(manifest.host_permissions, [
    'https://chatgpt.com/*',
    'https://chat.openai.com/*'
  ]);
  assert.ok(manifest.optional_host_permissions.includes('http://*/*'));
  assert.equal(manifest.permissions.includes('cookies'), false);
  assert.equal(manifest.permissions.includes('history'), false);
  assert.equal(manifest.content_scripts[0].matches.includes('https://claude.ai/*'), false);
});

test('background keeps fence tokens out of persistent or synced extension storage', () => {
  const source = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
  assert.doesNotMatch(source, /storage\.sync/);
  const writes = Array.from(source.matchAll(/storage\.local\.set\(([^\n]+)/g), (match) => match[1]);
  assert.ok(writes.length > 0);
  assert.ok(writes.every((write) => !/fenceToken/.test(write)));
  assert.match(source, /storage\.session\.set/);
  assert.match(source, /fenceToken: pendingLease\.fenceToken/);
  assert.doesNotMatch(source, /setInterval\(/);
  const pendingIndex = source.indexOf('pending.set(key, pendingLease)');
  const persistedIndex = source.indexOf('await persistSessionState()', pendingIndex);
  const postIndex = source.indexOf("hubRequest(config, '/api/occupancy/leases'", pendingIndex);
  assert.ok(pendingIndex >= 0 && persistedIndex > pendingIndex && postIndex > persistedIndex);
});

test('periodic content reports drive real Hub heartbeats without mojibake', () => {
  const background = fs.readFileSync(path.join(extensionDir, 'background.js'), 'utf8');
  const content = fs.readFileSync(path.join(extensionDir, 'content.js'), 'utf8');
  const readme = fs.readFileSync(path.join(extensionDir, 'README.md'), 'utf8');
  const options = fs.readFileSync(path.join(extensionDir, 'options.html'), 'utf8');
  assert.match(content, /setInterval\(\(\) => report\(true\), 15_000\)/);
  assert.match(background, /if \(desired && leases\.has\(key\)\) await heartbeatLease/);
  assert.match(readme, /192\.168\.1\.10:17321/);
  assert.match(options, /192\.168\.1\.10:17321/);
  for (const text of [content, readme]) {
    assert.doesNotMatch(text, /[鑷鍗犵閲婃斁鎵嬭繛閿欙�]/u);
  }
});
