'use strict';

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const test = require('node:test');

let trackingApi = {};
try {
  trackingApi = require('../../src/shared/clientTracking');
} catch (_) {}

const { DEFAULT_CLIENTS, KNOWN_CLIENTS, clientsCsvForSetting } = trackingApi;
const rootDir = path.join(__dirname, '..', '..');

function rendererClientIds() {
  const app = fs.readFileSync(path.join(rootDir, 'src/electron/renderer/app.js'), 'utf8');
  const block = app.slice(app.indexOf('const KNOWN_CLIENTS = ['), app.indexOf('const LIMIT_PROVIDERS'));
  return [...block.matchAll(/\{ id: '([^']+)'/g)].map((match) => match[1]);
}

function readmeTrackedClientIds() {
  const iconToClient = {
    deepseek: 'dsh',
    'hermes-agent': 'hermes',
    xai: 'grok',
    'mimo-code': 'micode',
    qoder: 'qodercn'
  };
  return fs.readFileSync(path.join(rootDir, 'README.md'), 'utf8')
    .split('\n')
    .filter((line) => line.startsWith('| <img'))
    .filter((line) => line.split('|').map((cell) => cell.trim())[4] === '✅')
    .map((line) => {
      const icon = line.match(/tools-icon\/([^".]+)\.[a-z]+"/i)?.[1] || '';
      return iconToClient[icon] || icon;
    });
}

test('clientsCsvForSetting uses defaults only for missing settings', () => {
  assert.equal(typeof DEFAULT_CLIENTS, 'string');
  assert.equal(typeof clientsCsvForSetting, 'function');
  assert.equal(clientsCsvForSetting(undefined), DEFAULT_CLIENTS);
  assert.equal(clientsCsvForSetting(null), DEFAULT_CLIENTS);
});

test('default tracked clients include current tokscale-supported tools', () => {
  const clients = DEFAULT_CLIENTS.split(',');
  for (const client of ['cline', 'kimi', 'qwen', 'grok', 'copilot', 'pi', 'zed', 'kilocode', 'commandcode', 'zcode', 'kiro', 'codebuddy', 'workbuddy', 'reasonix', 'dsh']) {
    assert.ok(clients.includes(client), `${client} should be tracked by default`);
  }
});

test('micode is intentionally NOT default-tracked (mimocode.db double-counts Claude imports)', () => {
  assert.ok(!DEFAULT_CLIENTS.split(',').includes('micode'),
    'micode must stay opt-in until tokscale dedups claude-import sessions');
});

test('KNOWN_CLIENTS is a superset of DEFAULT_CLIENTS and still includes opt-in micode', () => {
  // Display-preference normalization (hide/pin/reorder) keys off the KNOWN list, not
  // the default-tracked list — so an opt-in client like micode must stay here or its
  // prefs get silently dropped on save/read.
  const known = KNOWN_CLIENTS.split(',');
  assert.ok(known.includes('micode'), 'micode must remain a known client');
  assert.ok(known.includes('qodercn'), 'qodercn must remain a known client');
  for (const client of DEFAULT_CLIENTS.split(',')) {
    assert.ok(known.includes(client), `${client} (default-tracked) must also be known`);
  }
});

test('tracked client defaults, renderer, and README share one display order', () => {
  const known = KNOWN_CLIENTS.split(',');
  assert.deepEqual(rendererClientIds(), known);
  assert.deepEqual(readmeTrackedClientIds(), known);
  assert.deepEqual(DEFAULT_CLIENTS.split(','), known.filter((client) => !['micode', 'qodercn'].includes(client)));
});

test('default tracked clients are supported by tokscale or a native adapter', () => {
  // Proma and Qoder CN remain local compatibility adapters. Reasonix is supported by the
  // bundled Tokscale version and must be verified through its real client list.
  const locallyParsedClients = new Set(['proma', 'qodercn']);
  // vendor/tokscale.json's swap only applies at release-packaging time (release.yml,
  // vendor-tokscale.yml), not to the plain `npm ci` this test runs against — so a
  // client that override exists specifically to unlock isn't yet in the installed
  // binary's own --client list here, and that's expected, not a regression. Once the
  // override is removed (an official tokscale release ships it), this file goes away
  // too and the client falls back to needing genuine tokscale support like any other.
  let vendorBridgedClients = new Set();
  try {
    const vendorManifest = JSON.parse(fs.readFileSync(path.join(rootDir, 'vendor', 'tokscale.json'), 'utf8'));
    if (vendorManifest.bridgesClient) vendorBridgedClients = new Set([vendorManifest.bridgesClient]);
  } catch (_) {}
  const result = spawnSync(process.execPath, [require.resolve('tokscale/bin.js'), '--help'], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
  const help = `${result.stdout || ''}\n${result.stderr || ''}`;
  const possibleValues = help.match(/\[possible values: ([^\]]+)\]/);
  assert.ok(possibleValues, 'tokscale --help should list --client possible values');
  const supported = new Set(possibleValues[1].split(',').map((client) => client.trim()).filter(Boolean));
  const unsupported = DEFAULT_CLIENTS.split(',')
    .filter((client) => !supported.has(client) && !locallyParsedClients.has(client) && !vendorBridgedClients.has(client));
  assert.deepEqual(unsupported, []);
});

test('clientsCsvForSetting preserves explicit empty tracked-tool selection', () => {
  assert.equal(clientsCsvForSetting(''), '');
  assert.equal(clientsCsvForSetting('  '), '');
});

test('clientsCsvForSetting normalizes saved client csv values', () => {
  assert.equal(clientsCsvForSetting(' Claude , Codex,,hermes '), 'claude,codex,hermes');
});
