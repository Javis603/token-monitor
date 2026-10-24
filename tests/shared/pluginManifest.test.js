'use strict';

const assert = require('node:assert/strict');
const test = require('node:test');

const { normalizeManifest, apiMajor } = require('../../src/shared/plugins/manifest');
const builtin = require('../../src/electron/plugins/builtin/system-monitor/manifest.json');
const example = require('../../docs/plugins/examples/token-pulse/manifest.json');

function base(extra = {}) {
  return {
    id: 'demo',
    version: '1.0.0',
    tmApi: '^1',
    name: 'Demo',
    permissions: ['sys.cpu'],
    views: [{ id: 'cpu', title: 'CPU', surfaces: ['home'], layout: { type: 'stat', value: { $: 'sys.cpu', fmt: 'percent' } } }],
    ...extra
  };
}

test('shipped and example manifests validate without errors', () => {
  for (const manifest of [builtin, example]) {
    const result = normalizeManifest(manifest, { source: 'builtin' });
    assert.equal(result.ok, true, result.errors.join('\n'));
    assert.deepEqual(result.errors, []);
  }
});

test('tmApi accepts major 1 spellings and rejects other majors', () => {
  assert.equal(apiMajor('^1'), 1);
  assert.equal(apiMajor('1.x'), 1);
  assert.equal(apiMajor(1), 1);
  assert.equal(normalizeManifest(base({ tmApi: '^2' })).ok, false);
  assert.equal(normalizeManifest(base({ tmApi: undefined })).ok, false);
});

test('ids, versions and names are required and constrained', () => {
  assert.equal(normalizeManifest(base({ id: 'Bad Id' })).ok, false);
  assert.equal(normalizeManifest(base({ id: 'x' })).ok, false);
  assert.equal(normalizeManifest(base({ version: 'one' })).ok, false);
  assert.equal(normalizeManifest(base({ name: '' })).ok, false);
});

test('main must stay inside the plugin folder', () => {
  for (const main of ['../escape.js', '/abs/main.js', 'a/../../b.js', 'main.ts', 'dir/../main.js']) {
    assert.equal(normalizeManifest(base({ main })).ok, false, main);
  }
  assert.equal(normalizeManifest(base({ main: 'src/main.js' })).ok, true);
});

test('a view that reads a source without the matching permission is dropped', () => {
  const result = normalizeManifest(base({ permissions: [] }));
  assert.equal(result.ok, false);
  assert.match(result.errors.join('\n'), /reads sys\.cpu without the matching permission/);
});

test('unknown permissions are reported and never granted', () => {
  const result = normalizeManifest(base({ permissions: ['sys.cpu', 'fs.read', 'credentials'] }));
  assert.equal(result.ok, true);
  assert.deepEqual(result.manifest.permissions, ['sys.cpu']);
  assert.match(result.errors.join('\n'), /unknown permission "fs\.read"/);
});

test('network needs code and an explicit host list; hosts are names, not URLs', () => {
  const withoutCode = normalizeManifest(base({ permissions: ['sys.cpu', 'network'], network: { hosts: ['example.com'] } }));
  assert.deepEqual(withoutCode.manifest.permissions, ['sys.cpu']);
  assert.deepEqual(withoutCode.manifest.network.hosts, []);
  const withCode = normalizeManifest(base({
    main: 'main.js',
    permissions: ['sys.cpu', 'network'],
    network: { hosts: ['API.example.com', '*.example.org', 'https://evil.test/x', '127.0.0.1', 'localhost'] }
  }));
  assert.deepEqual(withCode.manifest.network.hosts, ['*.example.org', 'api.example.com']);
  assert.equal(withCode.errors.filter((error) => error.startsWith('network.hosts')).length, 3);
});

test('metrics belong to code plugins and views may only bind declared metrics', () => {
  const declarative = normalizeManifest(base({ metrics: [{ id: 'x', kind: 'number' }] }));
  assert.match(declarative.errors.join('\n'), /metrics are published by main code/);
  const undeclared = normalizeManifest(base({
    main: 'main.js',
    metrics: [{ id: 'load', kind: 'number' }],
    views: [{ id: 'v', title: 'V', surfaces: ['home'], layout: { type: 'stat', value: { $: '@other' } } }]
  }));
  assert.match(undeclared.errors.join('\n'), /metric "other" is not declared/);
});

test('alerts need notify and numeric, permitted sources', () => {
  const alert = { id: 'hot', title: 'Hot', message: 'At {value}', source: { $: 'sys.cpu' }, op: '>=', value: 90, forSeconds: 30 };
  const noNotify = normalizeManifest(base({ alerts: [alert] }));
  assert.equal(noNotify.manifest.alerts.length, 0);
  assert.match(noNotify.errors.join('\n'), /alerts need the notify permission/);
  const ok = normalizeManifest(base({ permissions: ['sys.cpu', 'notify'], alerts: [alert, { ...alert, id: 'series', source: { $: 'sys.cpu', history: 10 } }] }));
  assert.deepEqual(ok.manifest.alerts.map((entry) => [entry.id, entry.forMs, entry.cooldownMs]), [['hot', 30000, 30 * 60 * 1000]]);
});

test('skins keep only #rrggbb colours on known keys', () => {
  const result = normalizeManifest(base({
    skins: [{ id: 'night', name: 'Night', colors: { accent: '#ABCDEF', bg: 'url(x)', text: 'red', glow: '#ffffff' }, vendorColors: { claude: '#123456', bad: 'blue' } }]
  }));
  assert.deepEqual(result.manifest.skins[0].colors, { accent: '#abcdef' });
  assert.deepEqual(result.manifest.skins[0].vendorColors, { claude: '#123456' });
});

test('display strings drop control and bidi override characters', () => {
  const result = normalizeManifest(base({ name: { en: 'Safe‮exe.txt', 'zh-TW': '名稱' } }));
  assert.equal(result.manifest.name.en, 'Safe exe.txt');
  assert.equal(result.manifest.name['zh-TW'], '名稱');
});
